// CodeBuddy Code (Tencent): `codebuddy -p --input-format stream-json --output-format stream-json`.
// The headless protocol follows Claude Code's stream-json (system/init, stream_event deltas, assistant,
// user tool_result, result), so the Claude parser does most of the work; the differences are handled here.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelInfo } from '../shared/protocol'
import { ClaudeParser, claudeUserMessage } from './claude'
import type { AgentEvent, AgentRunner, DetectResult, RunnerOptions, TurnInput } from './types'
import { EventQueue, findExecutable, parseJson, runCapture, spawnAgent, type SpawnedAgent } from './util'

/** Tools that would wait for an answer on a terminal nobody is watching. */
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'AskUserForStructuredInput']

export class CodeBuddyParser extends ClaudeParser {
  private sawSession = false

  override feed(o: any): AgentEvent[] {
    if (!o || typeof o !== 'object') return []
    // `system/init` is printed again once the first request starts.
    if (o.type === 'system' && o.subtype === 'init') {
      if (this.sawSession) return []
      this.sawSession = !!o.session_id
    }
    // Without a login the CLI answers with this text as if the model said it; the result error explains it instead.
    if (o.type === 'assistant' && isAuthNotice(o.message?.content)) return []
    // A failed `--resume` prints a bare error line instead of a result.
    if (o.type === 'error') return [{ type: 'error', message: friendlyError(String(o.error ?? o.message ?? 'CodeBuddy reported an error')), sessionId: this.sessionId }]
    // Failed results carry the reason in `errors` rather than `result`.
    if (o.type === 'result' && (o.is_error || (o.subtype && o.subtype !== 'success')) && !o.result) {
      const errors = Array.isArray(o.errors) ? o.errors.filter(Boolean).map(String) : []
      if (errors.length) o = { ...o, result: errors.join('\n') }
    }
    return super.feed(o).map((ev) => (ev.type === 'error' ? { ...ev, message: friendlyError(ev.message) } : ev))
  }
}

function isAuthNotice(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'text' && /^authentication required\b/i.test(String(b.text ?? '')))
}

export function friendlyError(msg: string): string {
  if (/authentication required/i.test(msg)) return 'CodeBuddy Code is not signed in. Run `codebuddy` in a terminal once and sign in with /login, then retry.'
  return msg
}

export function codebuddyArgs(input: TurnInput, mcpConfigPath: string, extra: string[] = []): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--disallowedTools', INTERACTIVE_TOOLS.join(','),
  ]
  if (input.system && process.platform !== 'win32') args.push('--append-system-prompt', input.system)
  if (input.model) args.push('--model', input.model)
  if (input.resumeId) args.push('--resume', input.resumeId)
  return [...args, ...extra]
}

/**
 * `codebuddy --help` lists the model ids the installed build accepts, e.g.
 * `--model <model>  ... Currently supported: (default-model, gpt-5.5, glm-5.3)`.
 * It also prints one global `--effort` level list, but nothing says which models honour it, so no model is given
 * effort levels and the flag is never sent.
 */
export function parseCodeBuddyHelp(help: string): ModelInfo[] {
  const flat = help.replace(/\s+/g, ' ')
  const models = /--model <model>.*?Currently supported: \(([^)]*)\)/.exec(flat)?.[1]
  if (!models) return []
  const ids = [...new Set(models.split(',').map((m) => m.trim()).filter((m) => /^[\w.:\-/]+$/.test(m)))]
  return ids.map((id): ModelInfo => ({
    id,
    label: aliasLabel(id),
    // A session started without --model reports `default-model`.
    ...(id === 'default-model' ? { isDefault: true } : {}),
  }))
}

/** `fast-model` → `Fast model`: the tier aliases CodeBuddy resolves server-side. Real ids stay as they are. */
function aliasLabel(id: string): string {
  const m = /^(default|fast|balanced|primary|deep)-model$/.exec(id)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} model` : id
}

export function createCodeBuddyRunner(opts: RunnerOptions = {}): AgentRunner {
  const bin = () => opts.bin ?? findExecutable(['codebuddy', 'cbc'])
  let models: ModelInfo[] | undefined
  return {
    id: 'codebuddy',
    label: 'CodeBuddy',
    images: true,
    async detect(): Promise<DetectResult> {
      const p = bin()
      if (!p) return { ok: false, error: 'codebuddy not found in PATH' }
      const r = await runCapture(p, ['--version'], 15000)
      if (r.code !== 0) return { ok: false, path: p, error: r.stderr.trim() || 'codebuddy --version failed' }
      return { ok: true, path: p, version: r.stdout.trim().split('\n')[0] }
    },
    async listModels() {
      if (models) return models
      const p = bin()
      if (!p) return []
      const r = await runCapture(p, ['--help'], 15000)
      const found = r.code === 0 ? parseCodeBuddyHelp(r.stdout) : []
      if (found.length) models = found
      return found
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      void (async () => {
        const p = bin()
        if (!p) {
          q.push({ type: 'error', message: 'codebuddy not found in PATH' })
          return q.end()
        }
        // The MCP config carries the bearer token, so from here on every exit path removes it.
        const dir = await mkdtemp(path.join(os.tmpdir(), 'ph-codebuddy-'))
        let proc: SpawnedAgent | undefined
        const onAbort = () => proc?.stop()
        signal.addEventListener('abort', onAbort, { once: true })
        const parser = new CodeBuddyParser()
        try {
          const cfg = path.join(dir, 'mcp.json')
          await writeFile(
            cfg,
            JSON.stringify({ mcpServers: { [input.mcp.name]: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } } }),
            { mode: 0o600 },
          )
          if (signal.aborted) {
            q.push({ type: 'error', message: 'cancelled' })
            return
          }
          proc = spawnAgent(p, codebuddyArgs(input, cfg, opts.extraArgs), {
            cwd: input.cwd,
            stdin: true,
            env: { MCP_TOOL_TIMEOUT: '1800000', MCP_TIMEOUT: '30000' },
          })
          const child = proc.child
          child.stdin?.on('error', () => {})
          child.stdin?.write(claudeUserMessage(input))
          let finished = false
          for await (const line of proc.lines) {
            for (const ev of parser.feed(parseJson(line))) {
              q.push(ev)
              if (ev.type === 'done' || ev.type === 'error') {
                finished = true
                child.stdin?.end()
              }
            }
          }
          const code = await proc.exited
          if (!finished) {
            if (signal.aborted) q.push({ type: 'error', message: 'cancelled', sessionId: parser.sessionId })
            else q.push({ type: 'error', message: proc.stderrTail() || `codebuddy exited with code ${code}`, sessionId: parser.sessionId })
          }
        } catch (e: any) {
          proc?.stop()
          q.push({ type: 'error', message: String(e?.message ?? e), sessionId: parser.sessionId })
        } finally {
          signal.removeEventListener('abort', onAbort)
          await rm(dir, { recursive: true, force: true }).catch(() => {})
          q.end()
        }
      })().catch((e) => {
        q.push({ type: 'error', message: String(e?.message ?? e) })
        q.end()
      })
      return q
    },
  }
}
