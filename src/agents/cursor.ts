// Cursor CLI: `cursor-agent -p --output-format stream-json --stream-partial-output`.
// cursor-agent only reads MCP servers from .cursor/mcp.json, so the project file is merged for the
// duration of a turn and restored afterwards. The token is referenced as ${env:PH_MCP_TOKEN} and
// never written to disk.
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { AgentEvent, AgentRunner, DetectResult, RunnerOptions, TurnInput } from './types'
import type { ModelInfo } from '../shared/protocol'
import { clip, displayToolName, EventQueue, findExecutable, parseJson, runCapture, spawnAgent } from './util'

const BACKUP = '.page-harness/cursor-mcp-backup.json'

interface Backup {
  existed: boolean
  content?: string
  createdDir: boolean
}

const active = new Map<string, { count: number; backup: Backup }>()

function mcpFile(cwd: string) {
  return path.join(cwd, '.cursor', 'mcp.json')
}

export function installCursorMcp(cwd: string, name: string, url: string): void {
  const slot = active.get(cwd)
  if (slot) {
    slot.count++
    return
  }
  const file = mcpFile(cwd)
  const dir = path.dirname(file)
  const backup: Backup = { existed: existsSync(file), createdDir: !existsSync(dir) }
  let config: any = { mcpServers: {} }
  if (backup.existed) {
    backup.content = readFileSync(file, 'utf8')
    try {
      config = JSON.parse(backup.content)
    } catch {
      config = { mcpServers: {} }
    }
  }
  mkdirSync(path.join(cwd, '.page-harness'), { recursive: true })
  writeFileSync(path.join(cwd, BACKUP), JSON.stringify(backup))
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { url, headers: { Authorization: 'Bearer ${env:PH_MCP_TOKEN}' } } }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  active.set(cwd, { count: 1, backup })
}

function restore(cwd: string, backup: Backup) {
  const file = mcpFile(cwd)
  try {
    if (backup.existed) writeFileSync(file, backup.content ?? '')
    else if (existsSync(file)) unlinkSync(file)
    if (backup.createdDir && existsSync(path.dirname(file)) && readdirSync(path.dirname(file)).length === 0) rmdirSync(path.dirname(file))
  } catch {}
  try {
    unlinkSync(path.join(cwd, BACKUP))
  } catch {}
}

export function releaseCursorMcp(cwd: string): void {
  const slot = active.get(cwd)
  if (!slot) return
  if (--slot.count > 0) return
  active.delete(cwd)
  restore(cwd, slot.backup)
}

/** Restores a backup left by a crashed run, and everything still installed on exit. */
export function recoverCursorMcp(cwd: string): boolean {
  const p = path.join(cwd, BACKUP)
  if (!existsSync(p)) return false
  try {
    restore(cwd, JSON.parse(readFileSync(p, 'utf8')))
    return true
  } catch {
    return false
  }
}

export function releaseAllCursorMcp(): void {
  for (const [cwd, slot] of active) restore(cwd, slot.backup)
  active.clear()
}

const FILE_TOOL_KEYS = ['write', 'edit', 'delete', 'searchReplace', 'multiEdit', 'applyPatch']

export class CursorParser {
  private text = ''
  private names = new Map<string, string>()
  sessionId?: string

  feed(o: any): AgentEvent[] {
    if (!o || typeof o !== 'object') return []
    const out: AgentEvent[] = []
    if (o.session_id && !this.sessionId) {
      this.sessionId = o.session_id
      out.push({ type: 'session', sessionId: o.session_id })
    }
    switch (o.type) {
      case 'assistant': {
        const t = (o.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
        if (!t) break
        // With --stream-partial-output each event is a delta; a closing event may repeat the whole segment.
        if (this.text && t === this.text) {
          this.text = ''
          break
        }
        this.text += t
        out.push({ type: 'text', delta: t })
        break
      }
      case 'thinking':
        if (o.subtype === 'delta' && o.text) out.push({ type: 'thinking', delta: o.text })
        break
      case 'tool_call': {
        this.text = ''
        const id = String(o.call_id ?? o.id ?? Math.random())
        const call = o.tool_call ?? {}
        const key = Object.keys(call)[0] ?? 'tool'
        const body = call[key] ?? {}
        let name = key.replace(/ToolCall$/, '')
        if (key === 'mcpToolCall') name = displayToolName(String(body.args?.toolName ?? body.args?.name ?? 'mcp'))
        if (key === 'function') name = String(body.name ?? 'function')
        const input = key === 'mcpToolCall' ? body.args?.args ?? {} : body.args ?? (key === 'function' ? safeJson(body.arguments) : undefined)
        if (o.subtype === 'started') {
          this.names.set(id, name)
          const files = FILE_TOOL_KEYS.some((k) => key.startsWith(k)) && input?.path ? [String(input.path)] : undefined
          out.push({ type: 'tool', id, name, input, status: 'start', files })
        } else if (o.subtype === 'completed') {
          const r = body.result ?? {}
          const failed = !!(r.error || r.failure || r.rejected) || r === 'rejected'
          const payload = r.success ?? r.error ?? r.failure ?? r
          out.push({ type: 'tool', id, name: this.names.get(id) ?? name, status: failed ? 'error' : 'done', output: clip(summarize(payload)) })
        }
        break
      }
      case 'result':
        if (o.is_error || (o.subtype && o.subtype !== 'success')) {
          out.push({ type: 'error', message: String(o.result || o.error || 'cursor-agent reported an error'), sessionId: this.sessionId })
        } else {
          const u = o.usage ?? {}
          out.push({ type: 'done', sessionId: this.sessionId, usage: { inputTokens: u.inputTokens ?? u.input_tokens, outputTokens: u.outputTokens ?? u.output_tokens } })
        }
        break
    }
    return out
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function summarize(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  for (const k of ['content', 'output', 'stdout', 'text', 'message']) {
    if (typeof v[k] === 'string' && v[k]) return v[k] + (typeof v.stderr === 'string' && v.stderr ? `\n${v.stderr}` : '')
  }
  if (Array.isArray(v.content)) return v.content.map((c: any) => (typeof c.text === 'string' ? c.text : typeof c.text?.text === 'string' ? c.text.text : JSON.stringify(c))).join('\n')
  return JSON.stringify(v, null, 2)
}

export function cursorArgs(input: TurnInput, extra: string[] = []): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', input.cwd, '--force', '--approve-mcps', '--trust']
  if (input.model) args.push('--model', input.model)
  if (input.resumeId) args.push('--resume', input.resumeId)
  return [...args, ...extra]
}

function promptWithContext(input: TurnInput): string {
  const parts = [input.system ? `<instructions>\n${input.system}\n</instructions>` : '', input.prompt]
  if (input.images.length) parts.push('Attached images (read them from disk):\n' + input.images.map((i) => `- ${i.path}`).join('\n'))
  return parts.filter(Boolean).join('\n\n')
}

/** Parses `cursor-agent --list-models` lines such as `auto - Auto (current, default)`. */
export function parseCursorModels(out: string): ModelInfo[] {
  const list: ModelInfo[] = []
  // eslint-disable-next-line no-control-regex
  for (const raw of out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const m = /^\s*[-*]?\s*([a-z0-9][\w.\-[\]=,]*)(?:\s+-\s+(.+))?\s*$/i.exec(raw)
    if (!m || /^(available|models?|usage|error|tip)$/i.test(m[1])) continue
    let label = (m[2] ?? '').trim()
    const flags = /\s*\(([^)]*)\)\s*$/.exec(label)
    const isDefault = !!flags && /\b(default|current)\b/i.test(flags[1])
    if (isDefault) label = label.slice(0, flags!.index).trim()
    list.push({ id: m[1], label: label || m[1], ...(isDefault ? { isDefault } : {}) })
  }
  return list
}

export function createCursorRunner(opts: RunnerOptions = {}): AgentRunner {
  const bin = () => opts.bin ?? findExecutable(['cursor-agent', 'agent'])
  let models: ModelInfo[] | undefined
  return {
    id: 'cursor',
    label: 'Cursor CLI',
    images: false,
    async detect(): Promise<DetectResult> {
      const p = bin()
      if (!p) return { ok: false, error: 'cursor-agent not found in PATH' }
      const r = await runCapture(p, ['--version'])
      if (r.code !== 0) return { ok: false, path: p, error: r.stderr.trim() || 'cursor-agent --version failed' }
      return { ok: true, path: p, version: r.stdout.trim().split('\n')[0] }
    },
    async listModels() {
      if (models) return models
      const p = bin()
      if (!p) return []
      const r = await runCapture(p, ['--list-models'], 15000)
      const found = parseCursorModels(r.stdout)
      models = r.code === 0 && found.length ? found : []
      return models
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      void (async () => {
        const p = bin()
        if (!p) {
          q.push({ type: 'error', message: 'cursor-agent not found in PATH' })
          return q.end()
        }
        installCursorMcp(input.cwd, input.mcp.name, input.mcp.url)
        const proc = spawnAgent(p, cursorArgs(input, opts.extraArgs), {
          cwd: input.cwd,
          stdin: true,
          env: { PH_MCP_TOKEN: input.mcp.token },
        })
        proc.child.stdin?.on('error', () => {})
        proc.child.stdin?.end(promptWithContext(input))
        const onAbort = () => proc.stop()
        signal.addEventListener('abort', onAbort, { once: true })
        const parser = new CursorParser()
        let finished = false
        try {
          for await (const line of proc.lines) {
            for (const ev of parser.feed(parseJson(line))) {
              q.push(ev)
              if (ev.type === 'done' || ev.type === 'error') finished = true
            }
          }
          const code = await proc.exited
          if (!finished) {
            const msg = signal.aborted ? 'cancelled' : proc.stderrTail() || `cursor-agent exited with code ${code}`
            q.push({ type: 'error', message: msg, sessionId: parser.sessionId })
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          releaseCursorMcp(input.cwd)
          q.end()
        }
      })().catch((e) => {
        releaseCursorMcp(input.cwd)
        q.push({ type: 'error', message: String(e?.message ?? e) })
        q.end()
      })
      return q
    },
  }
}
