import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ClaudeParser } from '../src/agents/claude'
import { CodexParser, answerServerRequest, codexArgs, codexErrorMessage, parseCodexModels } from '../src/agents/codex'
import { CursorParser, cursorArgs, parseCursorModels } from '../src/agents/cursor'
import type { TurnInput } from '../src/agents/types'
import { cmdArg } from '../src/agents/util'
import { parseCookies } from '../src/server/auth'
import { validArtifactName } from '../src/server/artifacts'
import { injectHtml, relaxCsp, rewriteSetCookie, stripCookie } from '../src/server/inject'
import { createProxy, relaySite, relayTarget } from '../src/server/proxy'
import { LiveError, LiveManager, MarkerGuard, parseRequestText } from '../src/server/live'
import { supportedEffort } from '../src/server/gateway'
import { AgentRegistry } from '../src/agents'
import type { ElementDescribe } from '../src/shared/protocol'

const CONTROL = 'http://127.0.0.1:17991'

describe('relaxCsp', () => {
  it('adds self to script-src and the control origin to frame-src', () => {
    const r = relaxCsp("default-src 'none'; script-src https://cdn.example; frame-src 'none'", CONTROL)
    expect(r.csp).toContain("script-src https://cdn.example 'self'")
    expect(r.csp).toContain(`frame-src ${CONTROL}`)
    expect(r.csp).not.toContain("frame-src 'none'")
  })

  it('derives script-src and frame-src from default-src', () => {
    const r = relaxCsp("default-src 'self' https://a.test", CONTROL)
    expect(r.csp).toContain("script-src 'self' https://a.test")
    expect(r.csp).toContain(`frame-src 'self' https://a.test ${CONTROL}`)
  })

  it('reuses an existing nonce and warns on strict-dynamic without one', () => {
    expect(relaxCsp("script-src 'nonce-abc123' 'strict-dynamic'", CONTROL).nonce).toBe('abc123')
    expect(relaxCsp("script-src 'strict-dynamic' 'sha256-xyz'", CONTROL).warning).toMatch(/strict-dynamic/)
  })

  it("lets the page be framed by itself when frame-ancestors is 'none'", () => {
    expect(relaxCsp("frame-ancestors 'none'", CONTROL).csp).toBe("frame-ancestors 'self'")
  })
})

describe('injectHtml', () => {
  it('inserts the script first in <head>', () => {
    const out = injectHtml('<!doctype html><html><head><script>page()</script></head><body></body></html>', { controlOrigin: CONTROL })
    expect(out).toMatch(/<head><script src="\/__ph\/overlay.js" data-page-harness><\/script><script>page\(\)/)
  })

  it('creates <head> when missing and handles fragments', () => {
    expect(injectHtml('<html><body>x</body></html>', { controlOrigin: CONTROL })).toContain('<html><head><script src="/__ph/overlay.js"')
    expect(injectHtml('<p>x</p>', { controlOrigin: CONTROL })).toMatch(/^<script src="\/__ph\/overlay.js"/)
  })

  it('is idempotent and carries the nonce', () => {
    const once = injectHtml('<head></head>', { controlOrigin: CONTROL, nonce: 'n"1' })
    expect(once).toContain('nonce="n&quot;1"')
    expect(injectHtml(once, { controlOrigin: CONTROL })).toBe(once)
  })

  it('relaxes <meta http-equiv=Content-Security-Policy> and picks up its nonce', () => {
    const out = injectHtml(`<head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-m1'"></head>`, { controlOrigin: CONTROL })
    expect(out).toContain(`content="script-src 'nonce-m1' 'self'"`)
    expect(out).toContain('nonce="m1"')
  })
})

describe('cookies', () => {
  it('drops Domain/Secure for https targets and downgrades SameSite=None', () => {
    expect(rewriteSetCookie('__Host-sid=1; Path=/; Domain=example.com; Secure; SameSite=None; HttpOnly', true)).toBe('sid=1; Path=/; SameSite=Lax; HttpOnly')
    expect(rewriteSetCookie('a=1; Domain=x.test; Secure', false)).toBe('a=1; Secure')
  })

  it('strips only our cookie', () => {
    expect(stripCookie('a=1; __ph_17991=secret; b=2', '__ph_17991')).toBe('a=1; b=2')
    expect(stripCookie('__ph_17991=secret', '__ph_17991')).toBeUndefined()
  })
})

describe('internal auth helpers', () => {
  it('keeps malformed cookie values instead of throwing', () => {
    expect(parseCookies('a=%E0; b=%20x')).toEqual({ a: '%E0', b: ' x' })
  })

  it('quotes cmd.exe arguments and refuses ones it would expand', () => {
    expect(cmdArg('--model')).toBe('--model')
    expect(cmdArg('C:\\Program Files (x86)\\x')).toBe('"C:\\Program Files (x86)\\x"')
    expect(cmdArg('a & b')).toBe('"a & b"')
    expect(() => cmdArg('%PATH%')).toThrow()
    expect(() => cmdArg('a"b')).toThrow()
    expect(() => cmdArg('line\nbreak')).toThrow()
  })
})

describe('validArtifactName', () => {
  it.each(['report.md', 'Mockup v2 (final).html', '数据.json', 'a+b@2x.png'])('accepts %s', (n) => expect(validArtifactName(n)).toBe(true))
  it.each(['', '.env', '../x', 'a/b.md', 'a\\b.md', 'x..md', 'trail.', 'trail ', '-x', 'x'.repeat(121), 'a\nb'])('rejects %j', (n) =>
    expect(validArtifactName(n)).toBe(false),
  )
})

describe('ClaudeParser', () => {
  it('streams deltas, de-duplicates the final assistant message and maps tools', () => {
    const p = new ClaudeParser()
    const ev = [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'mcp__page-harness__write_artifact', input: {} }] } },
      { type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.01 },
    ].flatMap((o) => p.feed(o))
    expect(ev).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'thinking', delta: 'hmm' },
      { type: 'text', delta: 'Hi' },
      { type: 'tool', id: 't1', name: 'Edit', input: { file_path: 'a.ts' }, status: 'start', files: ['a.ts'] },
      { type: 'tool', id: 't1', name: 'Edit', status: 'done', output: 'ok' },
      { type: 'tool', id: 't2', name: 'write_artifact', input: {}, status: 'start', files: undefined },
      { type: 'done', sessionId: 's1', usage: { inputTokens: 15, outputTokens: 3, cachedTokens: 5, costUsd: 0.01 } },
    ])
  })

  it('reports errors from the result line', () => {
    expect(new ClaudeParser().feed({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' })).toEqual([{ type: 'error', message: 'error_max_turns', sessionId: 's' }])
  })
})

describe('CodexParser', () => {
  it('maps app-server notifications', () => {
    const p = new CodexParser()
    const ev = [
      ['item/agentMessage/delta', { itemId: 'a', delta: 'Hel' }],
      ['item/agentMessage/delta', { itemId: 'a', delta: 'lo' }],
      ['item/completed', { item: { id: 'a', type: 'agentMessage', text: 'Hello' } }],
      ['item/completed', { item: { id: 'r', type: 'reasoning', summary: ['plan'], content: [] } }],
      ['item/started', { item: { id: 'c', type: 'commandExecution', command: 'ls', cwd: '/p' } }],
      ['item/completed', { item: { id: 'c', type: 'commandExecution', command: 'ls', cwd: '/p', exitCode: 1, aggregatedOutput: 'nope' } }],
      ['item/completed', { item: { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: 'src/a.ts', diff: '+x' }] } }],
      ['item/completed', { item: { id: 'm', type: 'mcpToolCall', tool: 'page_state', arguments: {}, result: { content: [{ type: 'text', text: 'state' }] } } }],
      ['thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 7, outputTokens: 2, cachedInputTokens: 1 } } }],
    ].flatMap(([m, x]) => p.feed(m as string, x))
    expect(ev).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'thinking', delta: 'plan' },
      { type: 'tool', id: 'c', name: 'shell', input: { command: 'ls', cwd: '/p' }, status: 'start', output: undefined },
      { type: 'tool', id: 'c', name: 'shell', input: { command: 'ls', cwd: '/p' }, status: 'error', output: 'nope' },
      { type: 'tool', id: 'f', name: 'edit', input: { files: ['src/a.ts'] }, files: ['src/a.ts'], status: 'done', output: '+x' },
      { type: 'tool', id: 'm', name: 'page_state', input: {}, status: 'done', output: 'state' },
    ])
    expect(p.usage).toEqual({ inputTokens: 7, outputTokens: 2, cachedTokens: 1 })
  })

  it('auto-answers approvals and declines elicitation', () => {
    expect(answerServerRequest('item/commandExecution/requestApproval').result).toEqual({ decision: 'accept' })
    expect(answerServerRequest('mcpServer/elicitation/request').result).toEqual({ action: 'decline' })
    expect(answerServerRequest('unknown/x').error).toBeTruthy()
  })

  it('maps model/list, keeping the default and dropping hidden models', () => {
    expect(parseCodexModels({
      data: [
        {
          id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }],
          defaultReasoningEffort: 'low',
          serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
        },
        { id: 'secret', displayName: 'Secret', hidden: true },
        { id: 'gpt-5.5', displayName: '', hidden: false, isDefault: false, supportedReasoningEfforts: [] },
      ],
      nextCursor: null,
    })).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low', fastTier: { id: 'priority', description: '2x speed, increased usage' } },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
    ])
    expect(parseCodexModels(undefined)).toEqual([])
  })

  it('unwraps JSON-encoded API errors', () => {
    const raw = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'x' model is not supported." } })
    expect(codexErrorMessage(raw)).toBe("The 'x' model is not supported.")
    expect(codexErrorMessage('turn failed')).toBe('turn failed')
    expect(codexErrorMessage('{"other":1}')).toBe('{"other":1}')
  })
})

const turn = (over: Partial<TurnInput> = {}): TurnInput =>
  ({ chatId: 'c1', turnId: 't1', cwd: '/proj', prompt: 'hi', images: [], mcp: { name: 'page-harness', url: 'http://127.0.0.1:1/__ph/mcp', token: 'sekret-token-123' }, ...over }) as TurnInput

describe('CLI args', () => {
  it('never puts the MCP token on the codex command line', () => {
    const args = codexArgs(turn())
    expect(args.join(' ')).not.toContain('sekret-token-123')
    expect(args).toContain('mcp_servers.page_harness.bearer_token_env_var="PH_MCP_TOKEN"')
  })

  it('passes model and resume to cursor-agent', () => {
    const args = cursorArgs(turn({ model: 'gpt-5', resumeId: 'r1' }))
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5', '--resume', 'r1', '--workspace', '/proj']))
  })
})

describe('CursorParser', () => {
  it('handles partial-output deltas, tool calls and the result', () => {
    const p = new CursorParser()
    const ev = [
      { type: 'system', subtype: 'init', session_id: 'cs' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hel' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'lo' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'thinking', subtype: 'delta', text: 'think' },
      { type: 'tool_call', subtype: 'started', call_id: 'k', tool_call: { editToolCall: { args: { path: 'a.vue' } } } },
      { type: 'tool_call', subtype: 'completed', call_id: 'k', tool_call: { editToolCall: { args: { path: 'a.vue' }, result: { success: { message: 'edited' } } } } },
      { type: 'tool_call', subtype: 'started', call_id: 'm', tool_call: { mcpToolCall: { args: { name: 'page-harness-page_click', toolName: 'page_click', providerIdentifier: 'page-harness', args: { index: 3 } } } } },
      { type: 'tool_call', subtype: 'completed', call_id: 'm', tool_call: { mcpToolCall: { args: { toolName: 'page_click' }, result: { success: { content: [{ text: { text: 'clicked' } }], isError: false } } } } },
      { type: 'result', subtype: 'success', usage: { inputTokens: 4, outputTokens: 2 } },
    ].flatMap((o) => p.feed(o))
    expect(ev).toEqual([
      { type: 'session', sessionId: 'cs' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'thinking', delta: 'think' },
      { type: 'tool', id: 'k', name: 'edit', input: { path: 'a.vue' }, status: 'start', files: ['a.vue'] },
      { type: 'tool', id: 'k', name: 'edit', status: 'done', output: 'edited' },
      { type: 'tool', id: 'm', name: 'page_click', input: { index: 3 }, status: 'start', files: undefined },
      { type: 'tool', id: 'm', name: 'page_click', status: 'done', output: 'clicked' },
      { type: 'done', sessionId: 'cs', usage: { inputTokens: 4, outputTokens: 2 } },
    ])
  })
})

const target: ElementDescribe = {
  selector: 'h1.title',
  tagName: 'H1',
  classes: ['title'],
  text: 'Hello',
  outerHTML: '<h1 class="title">Hello</h1>',
  styles: {},
  url: 'http://localhost:3000/a?b=1',
}

describe('parseCursorModels', () => {
  it('reads ids, display names and the default marker', () => {
    const out = 'Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\nclaude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)\nbare-model\n\nTip: use --model <id>\n'
    expect(parseCursorModels(out)).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true },
      { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
      { id: 'claude-fable-5-thinking-high', label: 'Claude Fable 5 1M Thinking (NO ZDR)' },
      { id: 'bare-model', label: 'bare-model' },
    ])
  })
})

describe('LiveManager state machine', () => {
  const mk = () => new LiveManager(mkdtempSync(path.join(os.tmpdir(), 'ph-live-')))

  it('generate → ready → refine → ready → accept → accepted', () => {
    const m = mk()
    const plan = m.request('c', { op: 'generate', target, prompt: 'bolder', count: 9, url: target.url })!
    const s = m.get(plan.sid)!
    expect(s).toMatchObject({ status: 'generating', count: 4, path: '/a?b=1' })
    expect(parseRequestText(plan.agentText)).toMatchObject({ sid: plan.sid, op: 'generate', count: '4', outerHTML: target.outerHTML })
    expect(() => m.update('other', { sid: plan.sid, status: 'ready', variants: [{ index: 1, label: 'A' }] })).toThrow(LiveError)
    expect(() => m.update('c', { sid: plan.sid, status: 'ready', variants: [] })).toThrow(/report the candidates/)
    m.update('c', { sid: plan.sid, status: 'ready', variants: [{ index: 1, label: 'A' }, { index: 2, label: 'B' }, { index: 0, label: 'orig' }] })
    expect(m.get(plan.sid)!.variants.map((v) => v.index)).toEqual([1, 2])
    expect(() => m.request('c', { op: 'accept', sid: plan.sid, variant: 7 })).toThrow(/choose a candidate/)
    m.request('c', { op: 'refine', sid: plan.sid, variant: 2, prompt: 'softer' })
    expect(() => m.request('c', { op: 'accept', sid: plan.sid, variant: 1 })).toThrow(/not ready/)
    m.update('c', { sid: plan.sid, status: 'ready', variants: [{ index: 1, label: 'A' }, { index: 2, label: 'B2' }] })
    const acc = m.request('c', { op: 'accept', sid: plan.sid, variant: 2 })!
    expect(acc.agentText).toContain('variant label: B2')
    expect(m.update('c', { sid: plan.sid, status: 'done' })).toMatch(/Accepted/)
    expect(m.get(plan.sid)!.status).toBe('accepted')
    expect(m.open()).toHaveLength(0)
  })

  it('discarding a failure that left the source untouched closes it without an agent turn', () => {
    const m = mk()
    const a = m.request('c', { op: 'steer', prompt: 'blue' })!
    m.update('c', { sid: a.sid, status: 'failed', message: 'nope', partial: false })
    expect(m.request('c', { op: 'discard', sid: a.sid })).toBeNull()
    expect(m.get(a.sid)!.status).toBe('discarded')
    const b = m.request('c', { op: 'steer', prompt: 'red' })!
    m.update('c', { sid: b.sid, status: 'failed', message: 'half done' })
    expect(m.request('c', { op: 'discard', sid: b.sid })?.agentText).toContain('op: discard')
  })

  it('a turn ending mid-flight fails the session; retry & accept resumes it', () => {
    const m = mk()
    const { sid } = m.request('c', { op: 'generate', target })!
    m.update('c', { sid, status: 'ready', variants: [{ index: 1, label: 'A' }] })
    m.request('c', { op: 'accept', sid, variant: 1 })
    m.bindTurn(sid, 'T')
    m.turnEnded('T', 'done')
    expect(m.get(sid)).toMatchObject({ status: 'failed', error: expect.stringMatching(/without reporting/) })
    const r = m.request('c', { op: 'retry', sid, andAccept: true })!
    expect(r.summary).toMatch(/^↻ Live · accept #1/)
    expect(m.get(sid)!.status).toBe('accepting')
  })

  it('validates inputs and marks transient sessions failed after a restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ph-live-'))
    const m = new LiveManager(dir)
    expect(() => m.request('c', { op: 'generate' })).toThrow(/target/)
    expect(() => m.request('c', { op: 'insert', target, prompt: ' ' })).toThrow(/insert/)
    expect(() => m.request('c', { op: 'steer' })).toThrow(/page change/)
    expect(() => m.request('c', { op: 'discard', sid: 'nope' })).toThrow(/unknown/)
    const { sid } = m.request('c', { op: 'steer', prompt: 'darker' })!
    const again = new LiveManager(dir)
    expect(again.get(sid)).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
  })
})

describe('MarkerGuard', () => {
  it('reports markers added after the baseline, ignoring committed ones', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ph-guard-'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(path.join(dir, 'old.html'), '<div data-ph-live="Lold"></div>')
    git('add', '.')
    git('commit', '-qm', 'init')
    const g = new MarkerGuard(dir)
    await g.ensureBaseline()
    expect(await g.scan()).toEqual([])
    writeFileSync(path.join(dir, 'new.vue'), '<template><div data-ph-live="Lnew"></div></template>')
    expect(await g.scan()).toEqual([{ file: 'new.vue', sid: 'Lnew' }])
  })
})

describe('relay', () => {
  it('derives the registrable site of the target', () => {
    expect(relaySite(new URL('https://skillhub.cn/'))).toBe('skillhub.cn')
    expect(relaySite(new URL('https://www.example.com/'))).toBe('example.com')
    expect(relaySite(new URL('https://app.foo.co.uk/'))).toBe('foo.co.uk')
    expect(relaySite(new URL('https://a.b.com.cn/'))).toBe('b.com.cn')
    expect(relaySite(new URL('http://localhost:5173/'))).toBeNull()
    expect(relaySite(new URL('http://127.0.0.1:3000/'))).toBeNull()
    expect(relaySite(new URL('http://[::1]:3000/'))).toBeNull()
    expect(relaySite(new URL('https://alice.github.io/'))).toBe('alice.github.io')
    expect(relaySite(new URL('https://api.my-app.vercel.app/'))).toBe('my-app.vercel.app')
  })

  it('only relays to subdomains of the site', () => {
    expect(relayTarget('/__ph/relay/https/api.skillhub.cn/api/v1/x?a=1', 'skillhub.cn')?.href).toBe('https://api.skillhub.cn/api/v1/x?a=1')
    expect(relayTarget('/__ph/relay/http/skillhub.cn:8080', 'skillhub.cn')?.href).toBe('http://skillhub.cn:8080/')
    expect(relayTarget('/__ph/relay/https/evil.com/x', 'skillhub.cn')).toBeNull()
    expect(relayTarget('/__ph/relay/https/evilskillhub.cn/x', 'skillhub.cn')).toBeNull()
    expect(relayTarget('/__ph/relay/https/user@api.skillhub.cn/x', 'skillhub.cn')).toBeNull()
    expect(relayTarget('/__ph/relay/ftp/api.skillhub.cn/x', 'skillhub.cn')).toBeNull()
    expect(relayTarget('/__ph/relay/https/api.skillhub.cn/x', null)).toBeNull()
  })

  it('forwards x-forwarded-* only to local targets', async () => {
    const seen: http.IncomingHttpHeaders[] = []
    const up = http.createServer((req, res) => {
      seen.push(req.headers)
      res.end('ok')
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const port = (up.address() as AddressInfo).port
    const proxy = createProxy({ target: new URL(`http://127.0.0.1:${port}`), cookieName: 'ph', controlOrigin: () => '' })
    const front = http.createServer((req, res) => proxy.handle(req, res))
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
    const fport = (front.address() as AddressInfo).port
    await fetch(`http://127.0.0.1:${fport}/`, { headers: { 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' } })
    expect(seen[0]['x-forwarded-host']).toBe(`127.0.0.1:${fport}`)
    expect(seen[0]['x-forwarded-for']).toBeUndefined()
    expect(seen[0].forwarded).toBeUndefined()
    expect(proxy.site).toBeNull()
    front.close()
    up.close()
  })
})

describe('supportedEffort', () => {
  const models = [
    { id: 'auto', label: 'Auto', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { id: 'one', label: 'One', efforts: ['high'] },
    { id: 'plain', label: 'Plain' },
  ]
  it('keeps an effort the listed model offers', () => {
    expect(supportedEffort(models, 'auto', 'high')).toBe('high')
    expect(supportedEffort(models, undefined, 'medium')).toBe('medium') // the default model
  })
  it('passes the effort through when the list is empty or failed', () => {
    expect(supportedEffort([], 'gpt-6.1-sol', 'high')).toBe('high')
    expect(supportedEffort([], undefined, 'high')).toBe('high')
  })
  it('passes the effort through for a model that is not in the list', () => {
    expect(supportedEffort(models, 'custom-id', 'high')).toBe('high')
    expect(supportedEffort([{ id: 'x', label: 'X' }], undefined, 'low')).toBe('low') // no default listed
    expect(supportedEffort([{ id: 'gpt-5.5', label: 'GPT-5.5', fallback: true }], 'gpt-5.5', 'high')).toBe('high') // Codex stand-in
  })
  it('drops it when the listed model has no such level, or nothing to choose', () => {
    expect(supportedEffort(models, 'auto', 'max')).toBeUndefined()
    expect(supportedEffort(models, 'one', 'high')).toBeUndefined()
    expect(supportedEffort(models, 'plain', 'high')).toBeUndefined()
    expect(supportedEffort(models, 'auto', undefined)).toBeUndefined()
  })
})

describe('AgentRegistry model cache', () => {
  it('does not cache a failed (empty or stand-in) model list, so the next request retries', async () => {
    const r = new AgentRegistry()
    let calls = 0
    let result: Array<{ id: string; label: string; fallback?: boolean }> = []
    r.runners.set('stub', { id: 'stub', label: 'Stub', images: false, detect: async () => ({ ok: true }), listModels: async () => (calls++, result), run: () => { throw new Error('unused') } } as never)
    await r.detect()
    expect(await r.models('stub')).toEqual([])
    expect(r.cachedModels('stub')).toBeUndefined()
    result = [{ id: 'gpt-5.5', label: 'GPT-5.5', fallback: true }]
    await r.models('stub')
    expect(r.cachedModels('stub')).toBeUndefined()
    result = [{ id: 'm1', label: 'M1' }]
    await r.models('stub')
    expect(r.cachedModels('stub')).toEqual([{ id: 'm1', label: 'M1' }])
    await r.models('stub')
    expect(calls).toBe(3)
  })
})
