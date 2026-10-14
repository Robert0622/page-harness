// Codex: `codex app-server --listen stdio://` (JSON-RPC 2.0, one JSON object per line).
import os from 'node:os'
import type { AgentEvent, AgentRunner, DetectResult, RunnerOptions, TurnInput } from './types'
import { clip, displayToolName, EventQueue, findExecutable, parseJson, runCapture, spawnAgent, stringifyOutput } from './util'
import type { ModelInfo, Usage } from '../shared/protocol'

/** Maps app-server notifications to agent events. Stateful across one turn. */
export class CodexParser {
  private deltaItems = new Set<string>()
  usage?: Usage

  feed(method: string, p: any): AgentEvent[] {
    const out: AgentEvent[] = []
    switch (method) {
      case 'item/agentMessage/delta':
        if (p.delta) {
          this.deltaItems.add(p.itemId)
          out.push({ type: 'text', delta: p.delta })
        }
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (p.delta) {
          this.deltaItems.add(p.itemId)
          out.push({ type: 'thinking', delta: p.delta })
        }
        break
      case 'item/reasoning/summaryPartAdded':
        out.push({ type: 'thinking', delta: '\n\n' })
        break
      case 'item/started':
        out.push(...this.item(p.item, false))
        break
      case 'item/completed':
        out.push(...this.item(p.item, true))
        break
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage?.last ?? p.tokenUsage?.total
        if (t) this.usage = { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cachedTokens: t.cachedInputTokens }
        break
      }
    }
    return out
  }

  private item(item: any, done: boolean): AgentEvent[] {
    if (!item) return []
    const id = String(item.id)
    switch (item.type) {
      case 'agentMessage':
        if (done && !this.deltaItems.has(id) && item.text) return [{ type: 'text', delta: item.text }]
        return []
      case 'reasoning':
        if (done && !this.deltaItems.has(id)) {
          const t = [...(item.summary ?? []), ...(item.content ?? [])].join('\n')
          return t ? [{ type: 'thinking', delta: t }] : []
        }
        return []
      case 'commandExecution':
        return [{
          type: 'tool', id, name: 'shell', input: { command: item.command, cwd: item.cwd },
          status: !done ? 'start' : item.status === 'failed' || (item.exitCode ?? 0) !== 0 ? 'error' : 'done',
          output: done ? clip(String(item.aggregatedOutput ?? '')) : undefined,
        }]
      case 'fileChange': {
        const files = (item.changes ?? []).map((c: any) => String(c.path))
        return [{
          type: 'tool', id, name: 'edit', input: { files }, files,
          status: !done ? 'start' : item.status === 'failed' || item.status === 'declined' ? 'error' : 'done',
          output: done ? clip((item.changes ?? []).map((c: any) => c.diff ?? '').join('\n')) : undefined,
        }]
      }
      case 'mcpToolCall':
        return [{
          type: 'tool', id, name: displayToolName(String(item.tool)), input: item.arguments,
          status: !done ? 'start' : item.error || item.status === 'failed' ? 'error' : 'done',
          output: done ? clip(item.error?.message ?? stringifyOutput(item.result?.content)) : undefined,
        }]
      case 'webSearch':
        return [{ type: 'tool', id, name: 'web_search', input: { query: item.query }, status: done ? 'done' : 'start' }]
      case 'dynamicToolCall':
        return [{ type: 'tool', id, name: String(item.tool), input: item.arguments, status: !done ? 'start' : item.success === false ? 'error' : 'done', output: done ? clip(stringifyOutput(item.contentItems)) : undefined }]
      default:
        return []
    }
  }
}

function tomlString(s: string): string {
  return JSON.stringify(s)
}

export function codexArgs(input: TurnInput, extra: string[] = []): string[] {
  const key = `mcp_servers.${input.mcp.name.replace(/[^a-zA-Z0-9_]/g, '_')}`
  return [
    'app-server', '--listen', 'stdio://',
    '-c', `${key}.url=${tomlString(input.mcp.url)}`,
    '-c', `${key}.bearer_token_env_var="PH_MCP_TOKEN"`,
    '-c', `${key}.tool_timeout_sec=1800`,
    '-c', `${key}.startup_timeout_sec=30`,
    ...extra,
  ]
}

class RpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  constructor(private write: (s: string) => void) {}

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  notify(method: string, params?: unknown) {
    this.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  respond(id: number | string, result: unknown) {
    this.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  respondError(id: number | string, message: string) {
    this.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n')
  }

  /** Returns true when the message was a response to one of our requests. */
  handleResponse(m: any): boolean {
    if (m.id === undefined || m.method !== undefined) return false
    const p = this.pending.get(m.id)
    if (!p) return true
    this.pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message ?? 'rpc error'))
    else p.resolve(m.result)
    return true
  }

  failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

/** Answers for server-initiated requests; we run with approvals off, so these are fallbacks. */
export function answerServerRequest(method: string): { result?: unknown; error?: string } {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'accept' } }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'approved' } }
    case 'item/permissions/requestApproval':
      return { result: { decision: 'accept' } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline' } }
    default:
      return { error: `unsupported request ${method}` }
  }
}

/** Maps a `model/list` result to picker entries. */
export function parseCodexModels(result: any): ModelInfo[] {
  return (result?.data ?? [])
    .filter((m: any) => m?.id && !m.hidden)
    .map((m: any): ModelInfo => {
      const efforts = (m.supportedReasoningEfforts ?? []).map((e: any) => (typeof e === 'string' ? e : e?.reasoningEffort)).filter((e: unknown) => typeof e === 'string' && e)
      const tier = (m.serviceTiers ?? []).find((s: any) => s?.id && /fast/i.test(String(s.name ?? s.id)))
      return {
        id: String(m.id),
        label: String(m.displayName || m.id),
        ...(m.isDefault ? { isDefault: true } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(m.defaultReasoningEffort ? { defaultEffort: String(m.defaultReasoningEffort) } : {}),
        ...(tier ? { fastTier: { id: String(tier.id), ...(tier.description ? { description: String(tier.description) } : {}) } } : {}),
      }
    })
}

/** Codex reports API failures as a JSON-encoded body inside the message string. */
export function codexErrorMessage(msg: string): string {
  try {
    const j = JSON.parse(msg)
    const inner = j?.error?.message ?? j?.message
    return typeof inner === 'string' && inner ? inner : msg
  } catch {
    return msg
  }
}

const INIT_PARAMS = { clientInfo: { name: 'page-harness', title: 'Page Harness', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }

async function fetchCodexModels(bin: string, timeoutMs = 15000): Promise<ModelInfo[]> {
  const proc = spawnAgent(bin, ['app-server', '--listen', 'stdio://'], { cwd: os.tmpdir(), stdin: true })
  proc.child.stdin?.on('error', () => {})
  const rpc = new RpcClient((s) => proc.child.stdin?.write(s))
  void (async () => {
    for await (const line of proc.lines) {
      const m = parseJson(line)
      if (!m || rpc.handleResponse(m)) continue
      if (m.id !== undefined && m.method) rpc.respondError(m.id, `unsupported request ${m.method}`)
    }
  })()
  void proc.exited.then(() => rpc.failAll(new Error('codex exited')))
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('codex model/list timed out')), timeoutMs)
  })
  try {
    return await Promise.race([timeout, (async () => {
      await rpc.request('initialize', INIT_PARAMS)
      rpc.notify('initialized')
      const models: ModelInfo[] = []
      let cursor: string | null = null
      do {
        const res: any = await rpc.request('model/list', cursor ? { cursor } : {})
        models.push(...parseCodexModels(res))
        cursor = res?.nextCursor ?? null
      } while (cursor)
      return models
    })()])
  } finally {
    clearTimeout(timer)
    proc.child.stdin?.end()
    proc.stop(1000)
  }
}

export function createCodexRunner(opts: RunnerOptions = {}): AgentRunner {
  const bin = () => opts.bin ?? findExecutable(['codex'])
  let models: ModelInfo[] | undefined
  return {
    id: 'codex',
    label: 'Codex',
    images: true,
    async detect(): Promise<DetectResult> {
      const p = bin()
      if (!p) return { ok: false, error: 'codex not found in PATH' }
      const r = await runCapture(p, ['--version'])
      if (r.code !== 0) return { ok: false, path: p, error: r.stderr.trim() || 'codex --version failed' }
      return { ok: true, path: p, version: r.stdout.trim().split('\n')[0] }
    },
    async listModels() {
      if (models) return models
      const p = bin()
      const found = p ? await fetchCodexModels(p).catch(() => []) : []
      if (!found.length) return [{ id: 'gpt-5.5', label: 'GPT-5.5', fallback: true }]
      models = found
      return models
    },
    run(input, signal) {
      const q = new EventQueue<AgentEvent>()
      void (async () => {
        const p = bin()
        if (!p) {
          q.push({ type: 'error', message: 'codex not found in PATH' })
          return q.end()
        }
        const proc = spawnAgent(p, codexArgs(input, opts.extraArgs), { cwd: input.cwd, stdin: true, env: { PH_MCP_TOKEN: input.mcp.token } })
        proc.child.stdin?.on('error', () => {})
        const rpc = new RpcClient((s) => proc.child.stdin?.write(s))
        const parser = new CodexParser()
        let threadId: string | undefined
        let turnId: string | undefined
        let finished = false
        const finish = (ev: AgentEvent) => {
          if (finished) return
          finished = true
          q.push(ev)
          proc.child.stdin?.end()
          proc.stop(1500)
        }
        const onAbort = () => {
          if (threadId && turnId) rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
          setTimeout(() => finish({ type: 'error', message: 'cancelled', sessionId: threadId }), 2500).unref()
        }
        signal.addEventListener('abort', onAbort, { once: true })

        const reader = (async () => {
          for await (const line of proc.lines) {
            const m = parseJson(line)
            if (!m) continue
            if (rpc.handleResponse(m)) continue
            if (m.id !== undefined && m.method) {
              const a = answerServerRequest(m.method)
              if (a.error) rpc.respondError(m.id, a.error)
              else rpc.respond(m.id, a.result)
              continue
            }
            if (!m.method) continue
            const params = m.params ?? {}
            if (params.threadId && threadId && params.threadId !== threadId) continue
            for (const ev of parser.feed(m.method, params)) q.push(ev)
            if (m.method === 'turn/started' && params.turn?.id) turnId = params.turn.id
            if (m.method === 'error' && params.willRetry === false) {
              finish({ type: 'error', message: codexErrorMessage(params.error?.message ?? 'codex error'), sessionId: threadId })
            }
            if (m.method === 'turn/completed') {
              const t = params.turn ?? {}
              if (t.status === 'completed') finish({ type: 'done', sessionId: threadId, usage: parser.usage })
              else if (t.status === 'interrupted') finish({ type: 'error', message: 'cancelled', sessionId: threadId })
              else finish({ type: 'error', message: codexErrorMessage(t.error?.message ?? `turn ${t.status}`), sessionId: threadId })
            }
          }
        })()

        try {
          await rpc.request('initialize', INIT_PARAMS)
          rpc.notify('initialized')
          const threadParams = {
            cwd: input.cwd,
            model: input.model ?? null,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            developerInstructions: input.system || null,
          }
          let res: any
          if (input.resumeId) {
            try {
              res = await rpc.request('thread/resume', { threadId: input.resumeId, ...threadParams, excludeTurns: true })
            } catch {
              res = await rpc.request('thread/start', threadParams)
            }
          } else {
            res = await rpc.request('thread/start', threadParams)
          }
          threadId = res?.thread?.id
          if (threadId) q.push({ type: 'session', sessionId: threadId })
          const items: any[] = [{ type: 'text', text: input.prompt, text_elements: [] }]
          for (const img of input.images) items.push({ type: 'localImage', path: img.path })
          // A resumed thread keeps the last turn's effort and tier, so defaults have to be sent explicitly.
          const model = models?.find((m) => (input.model ? m.id === input.model : m.isDefault))
          const effort = input.effort ?? model?.defaultEffort ?? null
          const serviceTier = input.fast && model?.fastTier ? model.fastTier.id : 'default'
          const started = await rpc.request('turn/start', { threadId, input: items, effort, serviceTier })
          turnId = started?.turn?.id ?? turnId
        } catch (e: any) {
          finish({ type: 'error', message: proc.stderrTail() || String(e?.message ?? e), sessionId: threadId })
        }
        await Promise.race([reader, proc.exited])
        const code = await proc.exited
        rpc.failAll(new Error('codex exited'))
        if (!finished) finish({ type: 'error', message: signal.aborted ? 'cancelled' : proc.stderrTail() || `codex exited with code ${code}`, sessionId: threadId })
        signal.removeEventListener('abort', onAbort)
        q.end()
      })().catch((e) => {
        q.push({ type: 'error', message: String(e?.message ?? e) })
        q.end()
      })
      return q
    },
  }
}
