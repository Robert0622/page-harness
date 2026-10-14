// Claude Code: `claude -p --input-format stream-json --output-format stream-json`.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, AgentRunner, DetectResult, RunnerOptions, TurnInput } from './types'
import { clip, displayToolName, EventQueue, findExecutable, parseJson, runCapture, spawnAgent, stringifyOutput } from './util'

const FILE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** Turns Claude stream-json objects into agent events. Stateful across one turn. */
export class ClaudeParser {
  private streamed = new Set<string>()
  private currentMessage = ''
  private toolNames = new Map<string, string>()
  sessionId?: string

  feed(o: any): AgentEvent[] {
    if (!o || typeof o !== 'object') return []
    const out: AgentEvent[] = []
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && o.session_id) {
          this.sessionId = o.session_id
          out.push({ type: 'session', sessionId: o.session_id })
        }
        break
      case 'stream_event': {
        const e = o.event ?? {}
        if (e.type === 'message_start') this.currentMessage = e.message?.id ?? ''
        if (e.type === 'content_block_delta') {
          const d = e.delta ?? {}
          if (d.type === 'text_delta' && d.text) {
            this.streamed.add(this.currentMessage)
            out.push({ type: 'text', delta: d.text })
          } else if (d.type === 'thinking_delta' && d.thinking) {
            this.streamed.add(this.currentMessage)
            out.push({ type: 'thinking', delta: d.thinking })
          }
        }
        break
      }
      case 'assistant': {
        const msg = o.message ?? {}
        const streamed = msg.id && this.streamed.has(msg.id)
        for (const b of msg.content ?? []) {
          if (b.type === 'text' && !streamed && b.text) out.push({ type: 'text', delta: b.text })
          else if (b.type === 'thinking' && !streamed && b.thinking) out.push({ type: 'thinking', delta: b.thinking })
          else if (b.type === 'tool_use') {
            const name = displayToolName(String(b.name ?? 'tool'))
            this.toolNames.set(b.id, name)
            const key = FILE_TOOLS[b.name]
            const file = key && b.input?.[key]
            out.push({ type: 'tool', id: b.id, name, input: b.input, status: 'start', files: file ? [String(file)] : undefined })
          }
        }
        break
      }
      case 'user': {
        for (const b of o.message?.content ?? []) {
          if (b.type !== 'tool_result') continue
          out.push({
            type: 'tool',
            id: b.tool_use_id,
            name: this.toolNames.get(b.tool_use_id) ?? 'tool',
            status: b.is_error ? 'error' : 'done',
            output: clip(stringifyOutput(b.content)),
          })
        }
        break
      }
      case 'result': {
        const sessionId = o.session_id ?? this.sessionId
        const u = o.usage ?? {}
        const usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || undefined,
          outputTokens: u.output_tokens,
          cachedTokens: u.cache_read_input_tokens,
          costUsd: o.total_cost_usd,
        }
        if (o.is_error || (o.subtype && o.subtype !== 'success')) {
          out.push({ type: 'error', message: String(o.result || o.error || o.subtype || 'Claude reported an error'), sessionId })
        } else {
          out.push({ type: 'done', sessionId, usage })
        }
        break
      }
    }
    return out
  }
}

export function claudeArgs(input: TurnInput, mcpConfigPath: string, extra: string[] = []): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--disallowedTools', 'AskUserQuestion',
  ]
  if (input.system && process.platform !== 'win32') args.push('--append-system-prompt', input.system)
  if (input.model) args.push('--model', input.model)
  if (input.resumeId) args.push('--resume', input.resumeId)
  return [...args, ...extra]
}

export function claudeUserMessage(input: TurnInput): string {
  const text = input.system && process.platform === 'win32' ? `<instructions>\n${input.system}\n</instructions>\n\n${input.prompt}` : input.prompt
  const content: any[] = [{ type: 'text', text }]
  for (const img of input.images) {
    try {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: readFileSync(img.path).toString('base64') } })
    } catch {}
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

export function createClaudeRunner(opts: RunnerOptions = {}): AgentRunner {
  const bin = () => opts.bin ?? findExecutable(['claude'])
  return {
    id: 'claude',
    label: 'Claude Code',
    images: true,
    async detect(): Promise<DetectResult> {
      const p = bin()
      if (!p) return { ok: false, error: 'claude not found in PATH' }
      const r = await runCapture(p, ['--version'])
      if (r.code !== 0) return { ok: false, path: p, error: r.stderr.trim() || 'claude --version failed' }
      return { ok: true, path: p, version: r.stdout.trim().split('\n')[0] }
    },
    async listModels() {
      return [
        { id: 'sonnet', label: 'Claude Sonnet' },
        { id: 'opus', label: 'Claude Opus' },
        { id: 'haiku', label: 'Claude Haiku' },
      ]
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      void (async () => {
        const p = bin()
        if (!p) {
          q.push({ type: 'error', message: 'claude not found in PATH' })
          return q.end()
        }
        const dir = await mkdtemp(path.join(os.tmpdir(), 'ph-claude-'))
        const cfg = path.join(dir, 'mcp.json')
        await writeFile(
          cfg,
          JSON.stringify({ mcpServers: { [input.mcp.name]: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } } }),
          { mode: 0o600 },
        )
        const proc = spawnAgent(p, claudeArgs(input, cfg, opts.extraArgs), {
          cwd: input.cwd,
          stdin: true,
          env: { MCP_TOOL_TIMEOUT: '1800000', MCP_TIMEOUT: '30000' },
        })
        const onAbort = () => proc.stop()
        signal.addEventListener('abort', onAbort, { once: true })
        proc.child.stdin?.on('error', () => {})
        proc.child.stdin?.write(claudeUserMessage(input))
        const parser = new ClaudeParser()
        let finished = false
        try {
          for await (const line of proc.lines) {
            for (const ev of parser.feed(parseJson(line))) {
              q.push(ev)
              if (ev.type === 'done' || ev.type === 'error') {
                finished = true
                proc.child.stdin?.end()
              }
            }
          }
          const code = await proc.exited
          if (!finished) {
            if (signal.aborted) q.push({ type: 'error', message: 'cancelled', sessionId: parser.sessionId })
            else q.push({ type: 'error', message: proc.stderrTail() || `claude exited with code ${code}`, sessionId: parser.sessionId })
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          await rm(dir, { recursive: true, force: true })
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
