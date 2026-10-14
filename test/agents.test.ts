// CodeBuddy Code and OpenCode: detection, argument building, stream parsing and a full run against
// stand-in executables that replay recorded CLI output (see test/fixtures/README.md).
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry, AGENT_ORDER } from '../src/agents'
import { CodeBuddyParser, codebuddyArgs, createCodeBuddyRunner, parseCodeBuddyHelp } from '../src/agents/codebuddy'
import { OpenCodeParser, createOpenCodeRunner, opencodeArgs, opencodeConfig, opencodePrompt, parseOpenCodeModels } from '../src/agents/opencode'
import type { AgentEvent, TurnInput } from '../src/agents/types'
import { displayToolName } from '../src/agents/util'

const FIX = path.join(import.meta.dirname, 'fixtures')
const fixture = (name: string) => readFileSync(path.join(FIX, name), 'utf8')
const jsonl = (name: string) => fixture(name).split('\n').filter(Boolean).map((l) => JSON.parse(l))

const TOKEN = 'sekret-token-123'
const CWD = mkdtempSync(path.join(os.tmpdir(), 'ph-cwd-'))
const turn = (over: Partial<TurnInput> = {}): TurnInput => ({
  chatId: 'c1',
  turnId: 't1',
  cwd: CWD,
  prompt: 'make it bigger',
  system: 'You are inside page-harness.',
  images: [],
  mcp: { name: 'page-harness', url: 'http://127.0.0.1:1/__ph/mcp', token: TOKEN },
  ...over,
})

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Writes an executable node script into a fresh directory and returns its path. */
function fakeBin(name: string, body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ph-bin-'))
  const file = path.join(dir, name)
  writeFileSync(file, `#!${process.execPath}\n${body}`)
  chmodSync(file, 0o755)
  return file
}

/**
 * A stand-in agent CLI: records argv, the relevant env and stdin into <bin>.json, then prints a fixture.
 * `exit` sets the exit code; `stderr` is written before exiting.
 */
function replayBin(name: string, fixtureFile: string, opts: { exit?: number; stderr?: string; waitStdin?: boolean } = {}): { bin: string; record: () => any } {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'ph-rec-')), 'rec.json')
  const bin = fakeBin(
    name,
    `const fs = require('fs')
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
const done = () => {
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: {
    PH_MCP_TOKEN: process.env.PH_MCP_TOKEN, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT } }))
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FIX, fixtureFile))}, 'utf8'))
  ${opts.stderr ? `process.stderr.write(${JSON.stringify(opts.stderr)})` : ''}
  process.exitCode = ${opts.exit ?? 0}
}
${opts.waitStdin === false ? 'setTimeout(done, 50)' : "process.stdin.on('end', done)"}
`,
  )
  return { bin, record: () => JSON.parse(readFileSync(out, 'utf8')) }
}

describe('agent registry', () => {
  const saved = process.env.PATH
  afterEach(() => {
    process.env.PATH = saved
  })

  it('lists CodeBuddy and OpenCode after the original three', () => {
    expect(AGENT_ORDER).toEqual(['claude', 'codex', 'cursor', 'codebuddy', 'opencode'])
    const r = new AgentRegistry()
    expect([...r.runners.keys()]).toEqual(expect.arrayContaining(['codebuddy', 'opencode']))
    expect(r.get('codebuddy')?.label).toBe('CodeBuddy')
    expect(r.get('opencode')?.label).toBe('OpenCode')
  })

  it('detects the CLIs on PATH (codebuddy, cbc alias, opencode) and reports versions', async () => {
    const cb = fakeBin('cbc', "console.log('2.164.0')")
    const oc = fakeBin('opencode', "console.log('1.18.35')")
    process.env.PATH = [path.dirname(cb), path.dirname(oc)].join(path.delimiter)
    const list = await new AgentRegistry().detect()
    expect(list.find((a) => a.id === 'codebuddy')).toMatchObject({ available: true, version: '2.164.0', path: cb })
    expect(list.find((a) => a.id === 'opencode')).toMatchObject({ available: true, version: '1.18.35', path: oc })
    expect(list.find((a) => a.id === 'claude')).toMatchObject({ available: false })
  })

  it('reports them as missing when they are not installed, and honours --*-path overrides', async () => {
    process.env.PATH = mkdtempSync(path.join(os.tmpdir(), 'ph-empty-'))
    const r = new AgentRegistry()
    const list = await r.detect()
    expect(list.find((a) => a.id === 'codebuddy')?.available).toBe(false)
    expect(list.find((a) => a.id === 'opencode')?.available).toBe(false)
    expect(r.firstAvailable()).toBeUndefined()

    const cb = fakeBin('my-codebuddy', "console.log('9.9.9')")
    const r2 = new AgentRegistry({ paths: { codebuddy: cb } })
    await r2.detect()
    expect(r2.available('codebuddy')).toBe(true)
    expect(r2.firstAvailable()).toBe('codebuddy')
  })

  it('treats a failing --version as not available', async () => {
    const bad = fakeBin('opencode', "process.stderr.write('boom'); process.exit(3)")
    expect(await createOpenCodeRunner({ bin: bad }).detect()).toMatchObject({ ok: false, error: 'boom' })
  })
})

describe('displayToolName', () => {
  it('strips the MCP prefixes of every agent', () => {
    expect(displayToolName('mcp__page-harness__page_click')).toBe('page_click') // Claude Code, CodeBuddy
    expect(displayToolName('page-harness_page_title')).toBe('page_title') // OpenCode
    expect(displayToolName('page-harness.page_click')).toBe('page_click')
    expect(displayToolName('bash')).toBe('bash')
  })
})

describe('CodeBuddy', () => {
  it('builds headless args with MCP, model and resume, never --effort; the token stays off argv', () => {
    const args = codebuddyArgs(turn({ model: 'glm-5.3', effort: 'high', resumeId: 's1' }), '/tmp/mcp.json', ['--max-turns', '9'])
    expect(args.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'])
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--mcp-config', '/tmp/mcp.json', '--strict-mcp-config']))
    expect(args).toEqual(expect.arrayContaining(['--model', 'glm-5.3', '--resume', 's1']))
    // `--help` lists effort levels globally, not per model, so the flag is not sent even with a stale effort.
    expect(args).not.toContain('--effort')
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion,AskUserForStructuredInput')
    expect(args.slice(-2)).toEqual(['--max-turns', '9'])
    if (process.platform !== 'win32') expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You are inside page-harness.')
    expect(args.join(' ')).not.toContain(TOKEN)
    const bare = codebuddyArgs(turn(), '/tmp/mcp.json')
    for (const f of ['--model', '--effort', '--resume']) expect(bare).not.toContain(f)
  })

  it('reads models from the real --help output without inventing effort levels', () => {
    const models = parseCodeBuddyHelp(fixture('codebuddy-help.txt'))
    expect(models.length).toBeGreaterThan(10)
    expect(models[0]).toEqual({ id: 'default-model', label: 'Default model', isDefault: true })
    expect(models.filter((m) => m.efforts)).toEqual([])
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['gpt-5.5', 'glm-5.3', 'kimi-k2.6', 'hy3', 'deepseek-v4.1-flash']))
    expect(models.filter((m) => m.isDefault)).toHaveLength(1)
    expect(models.find((m) => m.id === 'fast-model')?.label).toBe('Fast model')
    expect(models.find((m) => m.id === 'glm-5.3')?.label).toBe('glm-5.3')
    expect(parseCodeBuddyHelp('Usage: codebuddy')).toEqual([])
  })

  it('parses a signed-in turn: deltas, thinking, MCP and file tools, usage (mocked fixture)', () => {
    const p = new CodeBuddyParser()
    const ev = jsonl('codebuddy-turn.mocked.jsonl').flatMap((o) => p.feed(o))
    const S = '01a12500-0000-7000-8000-00000000c0de'
    expect(ev).toEqual([
      { type: 'session', sessionId: S },
      { type: 'thinking', delta: 'Look at the title first.' },
      { type: 'text', delta: 'Making the ' },
      { type: 'text', delta: 'title bigger.' },
      { type: 'tool', id: 'tu_1', name: 'page_snapshot', input: { reason: 'see the page' }, status: 'start', files: undefined },
      { type: 'tool', id: 'tu_2', name: 'Edit', input: expect.objectContaining({ file_path: '/proj/index.html' }), status: 'start', files: ['/proj/index.html'] },
      { type: 'tool', id: 'tu_1', name: 'page_snapshot', status: 'done', output: '<h1>Cafe</h1>' },
      { type: 'tool', id: 'tu_2', name: 'Edit', status: 'done', output: 'The file /proj/index.html has been updated.' },
      { type: 'text', delta: 'Done.' },
      { type: 'done', sessionId: S, usage: { inputTokens: 1500, outputTokens: 80, cachedTokens: 300, costUsd: 0.0012 } },
    ])
  })

  it('reports the session once and turns the real not-signed-in result into a clear error', () => {
    const p = new CodeBuddyParser()
    const ev = jsonl('codebuddy-unauthenticated.jsonl').flatMap((o) => p.feed(o))
    expect(ev.filter((e) => e.type === 'session')).toEqual([{ type: 'session', sessionId: '01a12403-4a0d-7c15-ba07-5835ca9c7741' }])
    expect(ev.filter((e) => e.type === 'text')).toEqual([]) // the login notice is not shown as a reply
    const err = ev.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', sessionId: '01a12403-4a0d-7c15-ba07-5835ca9c7741' })
    expect((err as { message: string }).message).toMatch(/not signed in.*\/login/)
  })

  it('maps the real failed --resume line to an error, so the gateway starts a fresh session', () => {
    const p = new CodeBuddyParser()
    const ev = jsonl('codebuddy-resume-missing.jsonl').flatMap((o) => p.feed(o))
    expect(ev).toEqual([{ type: 'error', message: 'No conversation found with session ID: 01a12345-dead-beef-0000-000000000000', sessionId: undefined }])
  })

  it('runs a turn end to end: stream-json on stdin, token only in a private MCP file', async () => {
    const { bin, record } = replayBin('codebuddy', 'codebuddy-turn.mocked.jsonl', { waitStdin: false })
    const ev = await collect(createCodeBuddyRunner({ bin }).run(turn({ model: 'hy3' }), new AbortController().signal))
    expect(ev.at(-1)).toMatchObject({ type: 'done' })
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Making the title bigger.Done.')
    const rec = record()
    expect(rec.argv).toEqual(expect.arrayContaining(['--model', 'hy3']))
    expect(rec.argv.join(' ')).not.toContain(TOKEN)
    expect(rec.env.MCP_TOOL_TIMEOUT).toBe('1800000')
    expect(JSON.parse(rec.stdin.trim())).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'make it bigger' }] } })
    const cfgPath = rec.argv[rec.argv.indexOf('--mcp-config') + 1]
    expect(() => readFileSync(cfgPath)).toThrow() // removed after the turn
  })

  it('reports a crash with the stderr tail', async () => {
    const bin = fakeBin('codebuddy', "process.stderr.write('segfault-ish'); process.exit(2)")
    const ev = await collect(createCodeBuddyRunner({ bin }).run(turn(), new AbortController().signal))
    expect(ev).toEqual([{ type: 'error', message: 'segfault-ish', sessionId: undefined }])
  })

  describe('removes the token-bearing MCP config on every path', () => {
    const keys = ['TMPDIR', 'TMP', 'TEMP'] as const
    const saved = keys.map((k) => process.env[k])
    let tmp = ''
    beforeEach(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'ph-tmp-'))
      for (const k of keys) process.env[k] = tmp
    })
    afterEach(() => {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
    })
    const leftovers = () => readdirSync(tmp).filter((f) => f.startsWith('ph-codebuddy-'))

    it('when spawning the CLI throws', async () => {
      const bin = fakeBin('codebuddy', "console.log('unreachable')")
      // A NUL byte in argv makes child_process.spawn throw synchronously.
      const ev = await collect(createCodeBuddyRunner({ bin, extraArgs: ['--bad\0arg'] }).run(turn(), new AbortController().signal))
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/null bytes/) })
      expect(leftovers()).toEqual([])
    })

    it('when the CLI cannot be started', async () => {
      const ev = await collect(createCodeBuddyRunner({ bin: path.join(tmp, 'no-such-codebuddy') }).run(turn(), new AbortController().signal))
      expect(ev).toEqual([{ type: 'error', message: expect.stringMatching(/ENOENT/), sessionId: undefined }])
      expect(leftovers()).toEqual([])
    })

    it('when the turn was cancelled before the CLI started', async () => {
      const { bin } = replayBin('codebuddy', 'codebuddy-turn.mocked.jsonl', { waitStdin: false })
      const ac = new AbortController()
      ac.abort()
      expect(await collect(createCodeBuddyRunner({ bin }).run(turn(), ac.signal))).toEqual([{ type: 'error', message: 'cancelled' }])
      expect(leftovers()).toEqual([])
    })

    it('when the turn is cancelled mid-run', async () => {
      const bin = fakeBin('codebuddy', "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-mid' })); setInterval(() => {}, 1000)")
      const ac = new AbortController()
      const it = createCodeBuddyRunner({ bin }).run(turn(), ac.signal)
      const ev: AgentEvent[] = []
      for await (const e of it) {
        ev.push(e)
        if (e.type === 'session') {
          expect(leftovers()).toHaveLength(1)
          ac.abort()
        }
      }
      expect(ev.at(-1)).toEqual({ type: 'error', message: 'cancelled', sessionId: 's-mid' })
      expect(leftovers()).toEqual([])
    })
  })

  it('lists models through --help and caches them', async () => {
    const help = path.join(FIX, 'codebuddy-help.txt')
    const bin = fakeBin('codebuddy', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(help)}, 'utf8'))`)
    const r = createCodeBuddyRunner({ bin })
    const models = await r.listModels!()
    expect(models.find((m) => m.isDefault)?.id).toBe('default-model')
    expect(await r.listModels!()).toBe(models)
  })
})

describe('OpenCode', () => {
  it('builds `run --format json` args with model, variant, session and image files', () => {
    const args = opencodeArgs(turn({ model: 'opencode/big-pickle', effort: 'high', resumeId: 'ses_1', images: [{ path: '/up/a.png', mime: 'image/png' }] }))
    expect(args.slice(0, 5)).toEqual(['run', '--format', 'json', '--thinking', '--auto'])
    expect(args).toEqual(expect.arrayContaining(['--model', 'opencode/big-pickle', '--variant', 'high', '--session', 'ses_1', '--file', '/up/a.png']))
    expect(args.join(' ')).not.toContain(TOKEN)
    expect(args.join(' ')).not.toContain('make it bigger') // the prompt goes over stdin
    expect(opencodeArgs(turn())).toEqual(['run', '--format', 'json', '--thinking', '--auto'])
  })

  it('keeps extra args ahead of --file so positionals are not taken as files', () => {
    const imgs = [{ path: '/up/a.png', mime: 'image/png' }, { path: '/up/b.png', mime: 'image/png' }]
    expect(opencodeArgs(turn({ images: imgs }), ['--agent', 'build', 'extra'])).toEqual(['run', '--format', 'json', '--thinking', '--auto', '--agent', 'build', 'extra', '--file', '/up/a.png', '--file', '/up/b.png'])
  })

  it('counts cache writes as input, like Claude', () => {
    const p = new OpenCodeParser()
    p.feed({ type: 'step_finish', sessionID: 'ses_1', part: { cost: 0.01, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 40 } } } })
    expect(p.finish(0, '')).toMatchObject({ type: 'done', usage: { inputTokens: 150, outputTokens: 6, cachedTokens: 100, costUsd: 0.01 } })
  })

  it('passes MCP through a config overlay that references the token by env var', () => {
    const cfg = JSON.parse(opencodeConfig(turn(), undefined))
    expect(cfg.mcp['page-harness']).toEqual({ type: 'remote', url: 'http://127.0.0.1:1/__ph/mcp', headers: { Authorization: 'Bearer {env:PH_MCP_TOKEN}' }, oauth: false, timeout: 1800000 })
    expect(JSON.stringify(cfg)).not.toContain(TOKEN)
    const merged = JSON.parse(opencodeConfig(turn(), JSON.stringify({ model: 'x/y', mcp: { mine: { type: 'local', command: ['a'] } } })))
    expect(merged.model).toBe('x/y')
    expect(Object.keys(merged.mcp)).toEqual(['mine', 'page-harness'])
    expect(JSON.parse(opencodeConfig(turn(), 'not json')).mcp['page-harness']).toBeTruthy()
  })

  it('puts the instructions ahead of the prompt', () => {
    expect(opencodePrompt(turn())).toBe('<instructions>\nYou are inside page-harness.\n</instructions>\n\nmake it bigger')
    expect(opencodePrompt(turn({ system: '' }))).toBe('make it bigger')
  })

  it('parses a real run with reasoning, bash, write and read tools', () => {
    const p = new OpenCodeParser()
    const ev = jsonl('opencode-tools.jsonl').flatMap((o) => p.feed(o))
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'ses_edc01e67affeq26X7JPcr3HBTb' })
    const tools = ev.filter((e) => e.type === 'tool') as Array<Extract<AgentEvent, { type: 'tool' }>>
    expect(tools.map((t) => `${t.name}:${t.status}`)).toEqual(['bash:start', 'bash:done', 'write:start', 'write:done', 'read:start', 'read:done'])
    expect(tools[0]).toMatchObject({ id: 'call_a2e164bfa02f44c2b36783c7', input: { command: 'echo hi' } })
    expect(tools[1].output).toBe('hi\n')
    expect(tools[2].files).toEqual(['/tmp/cbtest/a.txt'])
    expect(tools[4].files).toBeUndefined()
    expect(ev.filter((e) => e.type === 'thinking')).toHaveLength(3)
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Running the requested steps.', '\n\ndone'])
    expect(p.finish(0, '')).toEqual({
      type: 'done',
      sessionId: 'ses_edc01e67affeq26X7JPcr3HBTb',
      usage: { inputTokens: 66 + 7616 + 98 + 7680 + 5484 + 2368, outputTokens: 54 + 24 + 23 + 6 + 3 + 3, cachedTokens: 7616 + 7680 + 2368, costUsd: 0 },
    })
  })

  it('shows page-harness MCP tools by their plain name (real MCP run)', () => {
    const p = new OpenCodeParser()
    const ev = jsonl('opencode-mcp.jsonl').flatMap((o) => p.feed(o))
    expect(ev.find((e) => e.type === 'tool')).toMatchObject({ name: 'page_title', status: 'start', input: { reason: expect.any(String) } })
    expect(ev.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ name: 'page_title', status: 'done', output: 'Cafe Mocha' })
  })

  it('keeps the session id on resume (real)', () => {
    const p = new OpenCodeParser()
    const ev = jsonl('opencode-resume.jsonl').flatMap((o) => p.feed(o))
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'ses_edbfeba65ffeJVajiiDSEGUWG4' })
    expect(ev[1]).toEqual({ type: 'text', delta: 'Cafe Mocha' })
  })

  it('turns error events, failed tools and crashes into errors', () => {
    const p = new OpenCodeParser()
    jsonl('opencode-error.jsonl').forEach((o) => p.feed(o))
    expect(p.finish(1, '')).toMatchObject({ type: 'error', message: 'Unexpected server error. Check server logs for details.' })

    const failed = new OpenCodeParser().feed({ type: 'tool_use', sessionID: 's', part: { tool: 'edit', callID: 'c', state: { status: 'error', input: { filePath: '/p/a' }, error: 'no match' } } })
    expect(failed.slice(1)).toEqual([
      { type: 'tool', id: 'c', name: 'edit', input: { filePath: '/p/a' }, status: 'start', files: undefined },
      { type: 'tool', id: 'c', name: 'edit', status: 'error', output: 'no match' },
    ])

    // `--session <unknown>` prints a coloured error to stderr and exits 1 without any event.
    expect(new OpenCodeParser().finish(1, '\u001b[91m\u001b[1mError: \u001b[0mSession not found\n')).toEqual({ type: 'error', message: 'Session not found', sessionId: undefined })
    expect(new OpenCodeParser().finish(7, '')).toMatchObject({ message: 'opencode exited with code 7' })
  })

  it('collects files from apply_patch metadata', () => {
    const ev = new OpenCodeParser().feed({
      type: 'tool_use',
      part: { tool: 'apply_patch', callID: 'p', state: { status: 'completed', input: {}, output: 'ok', metadata: { files: [{ filePath: '/p/a.ts' }, { filePath: '/p/b.ts', movePath: '/p/c.ts' }] } } },
    })
    expect(ev[0]).toMatchObject({ files: ['/p/a.ts', '/p/c.ts'] })
  })

  it('reads model names and variants from the real `models --verbose` output', () => {
    const models = parseOpenCodeModels(fixture('opencode-models-verbose.txt'))
    expect(models).toHaveLength(11)
    expect(models[0]).toEqual({ id: 'opencode/big-pickle', label: 'Big Pickle' })
    expect(models.find((m) => m.efforts?.length)?.efforts).toEqual(expect.arrayContaining(['high']))
    expect(parseOpenCodeModels(fixture('opencode-models.txt')).map((m) => m.id)).toContain('opencode/big-pickle')
  })

  it('runs a turn end to end: prompt on stdin, MCP via env, done on a clean exit', async () => {
    const { bin, record } = replayBin('opencode', 'opencode-mcp.jsonl')
    const ev = await collect(createOpenCodeRunner({ bin }).run(turn({ resumeId: 'ses_prev' }), new AbortController().signal))
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'ses_edbfeba65ffeJVajiiDSEGUWG4' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', sessionId: 'ses_edbfeba65ffeJVajiiDSEGUWG4' })
    const rec = record()
    expect(rec.argv).toEqual(['run', '--format', 'json', '--thinking', '--auto', '--session', 'ses_prev'])
    expect(rec.stdin).toContain('make it bigger')
    expect(rec.env.PH_MCP_TOKEN).toBe(TOKEN)
    expect(rec.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(JSON.parse(rec.env.OPENCODE_CONFIG_CONTENT).mcp['page-harness'].headers.Authorization).toBe('Bearer {env:PH_MCP_TOKEN}')
    expect(rec.env.OPENCODE_CONFIG_CONTENT).not.toContain(TOKEN)
  })

  it('reports an error exit after an error event', async () => {
    const { bin } = replayBin('opencode', 'opencode-error.jsonl', { exit: 1 })
    const ev = await collect(createOpenCodeRunner({ bin }).run(turn(), new AbortController().signal))
    expect(ev.at(-1)).toMatchObject({ type: 'error', message: 'Unexpected server error. Check server logs for details.' })
  })

  it('stops on abort and reports cancelled', async () => {
    const bin = fakeBin('opencode', "process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_x', part: {} }) + '\\n'); setInterval(() => {}, 1000)")
    const ac = new AbortController()
    const run = collect(createOpenCodeRunner({ bin }).run(turn(), ac.signal))
    setTimeout(() => ac.abort(), 300)
    const ev = await run
    expect(ev).toEqual([{ type: 'session', sessionId: 'ses_x' }, { type: 'error', message: 'cancelled', sessionId: 'ses_x' }])
  })

  it('lists models through `models --verbose`', async () => {
    const out = path.join(FIX, 'opencode-models-verbose.txt')
    const bin = fakeBin('opencode', `if (process.argv.slice(2).join(' ') !== 'models --verbose') process.exit(9); process.stdout.write(require('fs').readFileSync(${JSON.stringify(out)}, 'utf8'))`)
    expect((await createOpenCodeRunner({ bin }).listModels!()).length).toBe(11)
  })
})
