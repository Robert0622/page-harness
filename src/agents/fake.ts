// Scripted agent used by tests and the e2e suite (enabled with PH_FAKE_AGENT=1).
// It talks to the real MCP endpoint, so the whole tool path is exercised.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parseRequestText } from '../server/live'
import type { AgentEvent, AgentRunner, TurnInput } from './types'
import { EventQueue } from './util'

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

type CallResult = { text: string; isError: boolean }

async function connect(input: TurnInput) {
  const client = new Client({ name: 'page-harness-fake', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${input.mcp.token}` } },
  })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60 * 1000 })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
  }
  return { call, close: () => client.close().catch(() => {}) }
}

function findFiles(dir: string, depth = 3): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory() && depth > 0) out.push(...findFiles(p, depth - 1))
    else if (/\.(html|vue|jsx|tsx|svelte)$/.test(name)) out.push(p)
  }
  return out
}

/** Applies a Live op to the project files the way a real agent would. */
function liveEdit(cwd: string, req: Record<string, string>): { ok: boolean; variants?: Array<{ index: number; label: string }>; message?: string } {
  const sid = req.sid
  const stash = path.join(cwd, '.page-harness', `fake-live-${sid}.json`)
  if (req.op === 'generate' || req.op === 'mount_failed') {
    if (req.op === 'mount_failed' && existsSync(stash)) {
      const { file, original, wrapper } = JSON.parse(readFileSync(stash, 'utf8')) as { file: string; original: string; wrapper: string }
      const src = readFileSync(file, 'utf8')
      if (!src.includes(wrapper)) writeFileSync(file, src.replace(original, wrapper))
      return { ok: true, variants: [{ index: 1, label: 'Bold' }, { index: 2, label: 'Soft' }] }
    }
    const original = req.outerHTML
    if (!original) return { ok: false, message: 'no target html' }
    const file = findFiles(cwd).find((f) => readFileSync(f, 'utf8').includes(original))
    if (!file) return { ok: false, message: 'target not found in source' }
    const hide = (html: string, attrs: string) => html.replace(/^<([a-zA-Z0-9-]+)/, `<$1 ${attrs}`)
    const wrapper =
      `<div data-ph-live="${sid}" style="display:contents">` +
      hide(original, 'data-ph-variant="0" hidden') +
      hide(original, 'data-ph-variant="1" data-ph-variant-label="Bold" style="font-weight:800"') +
      hide(original, `data-ph-variant="2" data-ph-variant-label="Soft" style="opacity:.7" hidden data-ph-params='[{"name":"gap","type":"range","min":0,"max":40,"step":4,"default":8,"unit":"px","label":"Gap"}]'`) +
      `</div>`
    writeFileSync(file, readFileSync(file, 'utf8').replace(original, wrapper))
    mkdirSync(path.dirname(stash), { recursive: true })
    writeFileSync(stash, JSON.stringify({ file, original, wrapper }))
    return { ok: true, variants: [{ index: 1, label: 'Bold' }, { index: 2, label: 'Soft' }] }
  }
  if (!['refine', 'accept', 'discard'].includes(req.op)) return { ok: false, message: `unsupported op ${req.op}` }
  if (!existsSync(stash)) return { ok: false, message: 'unknown session' }
  const { file, original, wrapper } = JSON.parse(readFileSync(stash, 'utf8')) as { file: string; original: string; wrapper: string }
  const src = readFileSync(file, 'utf8')
  if (req.op === 'refine') return { ok: true, variants: [{ index: 1, label: 'Bold' }, { index: 2, label: 'Soft+' }] }
  if (req.op === 'accept') {
    const chosen = req.variant === '1' ? original.replace(/^<([a-zA-Z0-9-]+)/, '<$1 style="font-weight:800"') : original
    writeFileSync(file, src.replace(wrapper, chosen))
    return { ok: true }
  }
  if (req.op === 'discard') {
    writeFileSync(file, src.replace(wrapper, original))
    return { ok: true }
  }
  return { ok: false, message: `unsupported op ${req.op}` }
}

export function createFakeRunner(): AgentRunner {
  return {
    id: 'fake',
    label: 'Test agent',
    images: true,
    async detect() {
      return { ok: true, version: 'test', path: 'builtin' }
    },
    async listModels() {
      return [
        { id: 'fake-auto', label: 'Auto', isDefault: true },
        { id: 'fake-small', label: 'Fake Small' },
        { id: 'fake-large', label: 'Fake Large', efforts: ['low', 'high'], defaultEffort: 'low', fastTier: { id: 'priority', description: '1.5x speed, increased usage' } },
        { id: 'claude-fake-4', label: 'Claude Fake 4' },
        { id: 'gpt-fake-5', label: 'GPT Fake 5' },
      ]
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      const p = input.prompt
      const toolCall = async (mcp: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) => {
        const id = `t${Math.random().toString(36).slice(2, 8)}`
        q.push({ type: 'tool', id, name, input: args, status: 'start' })
        const r = await mcp.call(name, args)
        q.push({ type: 'tool', id, name, input: args, status: r.isError ? 'error' : 'done', output: r.text })
        return r
      }
      ;(async () => {
        const sessionId = input.resumeId ?? `fake-${input.chatId}`
        q.push({ type: 'session', sessionId })
        if (p.includes('[fake:fail]')) {
          q.push({ type: 'error', message: 'Scripted failure', sessionId })
          return
        }
        const mcp = await connect(input)
        try {
          const live = parseRequestText(p)
          if (live?.render) {
            const target = /^\s+selector: (.+)$/m.exec(p)?.[1] ?? 'h1'
            const variants =
              live.op === 'refine'
                ? [{ label: 'Bigger', changes: [{ selector: target, style: { 'font-size': '40px' } }] }]
                : live.op === 'revise'
                  ? [
                      { label: 'Airy', changes: [{ selector: target, style: { padding: '48px 0' } }] },
                      { label: 'Roomy', changes: [{ selector: target, style: { padding: '72px 0' } }] },
                    ]
                  : [
                    { label: 'Bold', changes: [{ selector: target, style: { 'font-weight': '800' } }, { selector: '.hero-sub', text: 'Bold subtitle' }] },
                    { label: 'Soft', changes: [{ selector: target, style: { opacity: '0.6' }, text: 'Soft title' }] },
                  ]
            const r = await toolCall(mcp, 'live_patch_variants', { sid: live.sid, variants })
            q.push({ type: 'text', delta: r.text })
            q.push({ type: 'done', sessionId })
            return
          }
          if (live) {
            const r = liveEdit(input.cwd, live)
            if (r.ok && r.variants) await toolCall(mcp, 'live_update', { sid: live.sid, status: 'ready', variants: r.variants })
            else if (r.ok) await toolCall(mcp, 'live_update', { sid: live.sid, status: 'done' })
            else await toolCall(mcp, 'live_update', { sid: live.sid, status: 'failed', message: r.message, partial: false })
            q.push({ type: 'text', delta: r.ok ? 'Candidates are on the page.' : `Could not apply: ${r.message}` })
            q.push({ type: 'done', sessionId })
            return
          }
          if (p.includes('[fake:slow]')) {
            for (let i = 0; i < 30 && !signal.aborted; i++) {
              q.push({ type: 'text', delta: `${i} ` })
              await sleep(100, signal)
            }
          }
          if (p.includes('[fake:think]')) q.push({ type: 'thinking', delta: 'Considering the request…' })
          const click = /\[fake:click=([^\]]+)\]/.exec(p)
          if (click) {
            const st = await toolCall(mcp, 'page_state', {})
            const m = /stateId: (\S+)/.exec(st.text)
            const line = st.text.split('\n').find((l) => l.includes(click[1]) && /\[\d+\]/.test(l))
            const idx = line ? Number(/\[(\d+)\]/.exec(line)![1]) : -1
            if (m && idx >= 0) await toolCall(mcp, 'page_click', { stateId: m[1], index: idx })
            else q.push({ type: 'text', delta: `Could not find "${click[1]}" on the page. ` })
          }
          if (p.includes('[fake:artifact]')) {
            await toolCall(mcp, 'write_artifact', { name: 'report.md', content: '# Report\n\n```ts\nconst answer = 42\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' })
          }
          if (p.includes('[fake:html]')) {
            await toolCall(mcp, 'write_artifact', { name: 'mock.html', content: '<!doctype html><h1 id="m">Mockup</h1><script>document.getElementById("m").textContent += " ok"</script>' })
          }
          const note = /\[fake:note=([^\]]+)\]/.exec(p)
          if (note) {
            const r = await toolCall(mcp, 'page_note', { selector: note[1], note: 'The headline does not say what the product does.', severity: 'issue' })
            q.push({ type: 'text', delta: `${r.text} ` })
          }
          const patch = /\[fake:patch=([^\]]+)\]/.exec(p)
          if (patch) {
            const r = await toolCall(mcp, 'page_patch', {
              selector: patch[1],
              note: 'Shorter, clearer headline.',
              style: { color: 'rgb(220, 38, 38)' },
              text: 'Reviewed headline',
            })
            q.push({ type: 'text', delta: `${r.text} ` })
          }
          const resolve = /\[fake:resolve=([^\]]+)\]/.exec(p)
          if (resolve) {
            const list = await toolCall(mcp, 'list_review', { open_only: true })
            q.push({ type: 'text', delta: `${list.text.split('\n')[0]} ` })
            const r = await toolCall(mcp, 'resolve_review', { id: resolve[1], summary: 'Fixed in the copy.' })
            q.push({ type: 'text', delta: `${r.text} ` })
          }
          if (p.includes('[fake:json]')) {
            await toolCall(mcp, 'write_artifact', { name: 'data.json', content: JSON.stringify({ name: 'fixture', version: 2, tags: ['a', 'b'], nested: { ok: true, score: 9.5, none: null } }, null, 2) })
          }
          if (p.includes('[fake:ask]')) {
            const r = await toolCall(mcp, 'ask_question', {
              questions: [{ id: 'color', prompt: 'Which color?', options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue', recommended: true }] }],
            })
            q.push({ type: 'text', delta: `You answered: ${r.text}. ` })
          }
          if (p.includes('[fake:form]')) {
            const r = await toolCall(mcp, 'ask_form', { title: 'Details', fields: [{ name: 'repo', label: 'Repository URL', type: 'url', required: true }] })
            q.push({ type: 'text', delta: `Form: ${r.text}. ` })
          }
          if (p.includes('[fake:edit]')) {
            q.push({ type: 'tool', id: 'e1', name: 'Edit', input: { file_path: 'src/App.vue' }, status: 'start' })
            q.push({ type: 'tool', id: 'e1', name: 'Edit', input: { file_path: 'src/App.vue' }, status: 'done', output: 'ok', files: ['src/App.vue'] })
          }
          if (p.includes('[fake:burst]')) {
            const para = (n: number) => `Paragraph ${n} ` + 'lorem ipsum dolor sit amet '.repeat(8) + '\n\n'
            const chunks = [
              '# Burst title\n\n' + para(1) + para(2),
              '- item one\n- item two\n- item three\n\n```ts\nconst answer = 42\nconsole.log(answer)\n```\n\n',
              para(3) + 'Last line.',
            ]
            for (const c of chunks) {
              q.push({ type: 'text', delta: c })
              await sleep(300, signal)
            }
            q.push({ type: 'done', sessionId, usage: { inputTokens: p.length, outputTokens: 10 } })
            return
          }
          const userText = p.split('\n').filter((l) => !l.startsWith('<') && l.trim()).pop() ?? ''
          for (const word of `Echo: ${userText.replace(/\[fake:[^\]]*\]/g, '').trim()}`.split(/(?<= )/)) {
            if (signal.aborted) break
            q.push({ type: 'text', delta: word })
            await sleep(5, signal)
          }
          q.push({ type: 'done', sessionId, usage: { inputTokens: p.length, outputTokens: 10 } })
        } finally {
          await mcp.close()
        }
      })()
        .catch((e) => q.push({ type: 'error', message: String(e?.message ?? e) }))
        .finally(() => q.end())
      return q
    },
  }
}
