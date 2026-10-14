// OpenCode (sst/opencode): `opencode run --format json`, prompt on stdin, one JSON event per line.
// The MCP server is passed through OPENCODE_CONFIG_CONTENT (merged over the user's own config); the
// bearer token is referenced as {env:PH_MCP_TOKEN} and never written to disk or argv.
import type { ModelInfo, Usage } from '../shared/protocol'
import type { AgentEvent, AgentRunner, DetectResult, RunnerOptions, TurnInput } from './types'
import { clip, displayToolName, EventQueue, findExecutable, parseJson, runCapture, spawnAgent, stripAnsi } from './util'

/** Maps `opencode run --format json` events to agent events. Stateful across one turn. */
export class OpenCodeParser {
  sessionId?: string
  error?: string
  private wrote = false
  private usage: Usage = {}

  feed(o: any): AgentEvent[] {
    if (!o || typeof o !== 'object') return []
    const out: AgentEvent[] = []
    if (o.sessionID && !this.sessionId) {
      this.sessionId = String(o.sessionID)
      out.push({ type: 'session', sessionId: this.sessionId })
    }
    const part = o.part ?? {}
    switch (o.type) {
      // Text and reasoning parts arrive whole, once they end.
      case 'text':
        if (part.text) {
          out.push({ type: 'text', delta: (this.wrote ? '\n\n' : '') + part.text })
          this.wrote = true
        }
        break
      case 'reasoning':
        if (part.text) out.push({ type: 'thinking', delta: part.text })
        break
      // Tools are reported only when they finish, so a card opens and closes in one go.
      case 'tool_use': {
        const st = part.state ?? {}
        const id = String(part.callID ?? part.id ?? Math.random())
        const name = displayToolName(String(part.tool ?? 'tool'))
        const files = changedFiles(String(part.tool ?? ''), st)
        out.push({ type: 'tool', id, name, input: st.input, status: 'start', files })
        out.push({ type: 'tool', id, name, status: st.status === 'error' ? 'error' : 'done', output: clip(String(st.status === 'error' ? st.error ?? 'failed' : st.output ?? '')) })
        break
      }
      case 'step_finish': {
        const t = part.tokens ?? {}
        const add = (a: number | undefined, b: unknown) => (typeof b === 'number' ? (a ?? 0) + b : a)
        this.usage = {
          // Counted like Claude's input: fresh + cache reads + cache writes.
          inputTokens: add(add(add(this.usage.inputTokens, t.input), t.cache?.read), t.cache?.write),
          outputTokens: add(add(this.usage.outputTokens, t.output), t.reasoning),
          cachedTokens: add(this.usage.cachedTokens, t.cache?.read),
          costUsd: add(this.usage.costUsd, part.cost),
        }
        break
      }
      case 'error': {
        const e = o.error ?? {}
        const msg = String(e.data?.message ?? e.message ?? e.name ?? 'opencode reported an error')
        this.error = this.error ? `${this.error}\n${msg}` : msg
        break
      }
    }
    return out
  }

  /** The CLI exits once the session is idle; there is no closing event. */
  finish(code: number | null, stderr: string): AgentEvent {
    if (this.error) return { type: 'error', message: this.error, sessionId: this.sessionId }
    if (code === 0) return { type: 'done', sessionId: this.sessionId, usage: this.usage }
    const tail = stripAnsi(stderr).trim().split('\n').filter((l) => !/^\s*(timestamp=|INFO|DEBUG)/.test(l)).slice(-6).join('\n')
    return { type: 'error', message: tail.replace(/^Error:\s*/, '') || `opencode exited with code ${code}`, sessionId: this.sessionId }
  }
}

function changedFiles(tool: string, st: any): string[] | undefined {
  if (st.status === 'error') return undefined
  if ((tool === 'edit' || tool === 'write') && st.input?.filePath) return [String(st.input.filePath)]
  if (tool === 'apply_patch' && Array.isArray(st.metadata?.files)) {
    const files = st.metadata.files.map((f: any) => String(f.movePath ?? f.filePath ?? '')).filter(Boolean)
    return files.length ? files : undefined
  }
  return undefined
}

export function opencodeArgs(input: TurnInput, extra: string[] = []): string[] {
  const args = ['run', '--format', 'json', '--thinking', '--auto']
  if (input.model) args.push('--model', input.model)
  if (input.effort) args.push('--variant', input.effort)
  if (input.resumeId) args.push('--session', input.resumeId)
  // `--file` is an array option and would take any positional args that follow it, so extras go first.
  const files = input.images.flatMap((img) => ['--file', img.path])
  return [...args, ...extra, ...files]
}

/** Config overlay with the page-harness MCP server, merged over OPENCODE_CONFIG_CONTENT if the user set one. */
export function opencodeConfig(input: TurnInput, existing = process.env.OPENCODE_CONFIG_CONTENT): string {
  let base: any = {}
  try {
    base = existing ? JSON.parse(existing) : {}
  } catch {}
  if (!base || typeof base !== 'object') base = {}
  return JSON.stringify({
    ...base,
    mcp: {
      ...(base.mcp ?? {}),
      [input.mcp.name]: {
        type: 'remote',
        url: input.mcp.url,
        headers: { Authorization: 'Bearer {env:PH_MCP_TOKEN}' },
        oauth: false,
        // Applies to tool calls too; page tools can wait on the user for a long time.
        timeout: 1800000,
      },
    },
  })
}

export function opencodePrompt(input: TurnInput): string {
  return [input.system ? `<instructions>\n${input.system}\n</instructions>` : '', input.prompt].filter(Boolean).join('\n\n')
}

/**
 * Parses `opencode models --verbose`: a `provider/model` line followed by that model's JSON.
 * Falls back to the plain one-id-per-line listing.
 */
export function parseOpenCodeModels(out: string): ModelInfo[] {
  const list: ModelInfo[] = []
  const lines = stripAnsi(out).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim()
    if (!/^[\w.@-]+\/\S+$/.test(id)) continue
    let label = id
    let efforts: string[] = []
    if (lines[i + 1]?.trim() === '{') {
      let j = i + 1
      while (j < lines.length && lines[j] !== '}') j++
      try {
        const m = JSON.parse(lines.slice(i + 1, j + 1).join('\n'))
        if (m.name) label = String(m.name)
        efforts = Object.keys(m.variants ?? {})
      } catch {}
      i = j
    }
    list.push({ id, label, ...(efforts.length ? { efforts } : {}) })
  }
  return list
}

export function createOpenCodeRunner(opts: RunnerOptions = {}): AgentRunner {
  const bin = () => opts.bin ?? findExecutable(['opencode'])
  let models: ModelInfo[] | undefined
  return {
    id: 'opencode',
    label: 'OpenCode',
    images: true,
    async detect(): Promise<DetectResult> {
      const p = bin()
      if (!p) return { ok: false, error: 'opencode not found in PATH' }
      const r = await runCapture(p, ['--version'], 15000)
      if (r.code !== 0) return { ok: false, path: p, error: r.stderr.trim() || 'opencode --version failed' }
      return { ok: true, path: p, version: r.stdout.trim().split('\n')[0] }
    },
    async listModels() {
      if (models) return models
      const p = bin()
      if (!p) return []
      const r = await runCapture(p, ['models', '--verbose'], 20000)
      const found = r.code === 0 ? parseOpenCodeModels(r.stdout) : []
      if (found.length) models = found
      return found
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      void (async () => {
        const p = bin()
        if (!p) {
          q.push({ type: 'error', message: 'opencode not found in PATH' })
          return q.end()
        }
        const proc = spawnAgent(p, opencodeArgs(input, opts.extraArgs), {
          cwd: input.cwd,
          stdin: true,
          env: { PH_MCP_TOKEN: input.mcp.token, OPENCODE_CONFIG_CONTENT: opencodeConfig(input), OPENCODE_DISABLE_AUTOUPDATE: '1' },
        })
        proc.child.stdin?.on('error', () => {})
        // `opencode run` reads the whole of stdin before it starts.
        proc.child.stdin?.end(opencodePrompt(input))
        const onAbort = () => proc.stop()
        signal.addEventListener('abort', onAbort, { once: true })
        const parser = new OpenCodeParser()
        try {
          for await (const line of proc.lines) for (const ev of parser.feed(parseJson(line))) q.push(ev)
          const code = await proc.exited
          q.push(signal.aborted ? { type: 'error', message: 'cancelled', sessionId: parser.sessionId } : parser.finish(code, proc.stderrTail()))
        } finally {
          signal.removeEventListener('abort', onAbort)
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
