import type { ModelInfo, Usage, ToolStatus } from '../shared/protocol'

export type AgentId = 'claude' | 'codex' | 'cursor' | 'codebuddy' | 'opencode' | 'fake'

export interface McpEndpoint {
  /** Server name as the agent sees it. */
  name: string
  url: string
  token: string
}

export interface TurnInput {
  chatId: string
  turnId: string
  prompt: string
  /** Extra instructions; appended to the agent's system prompt where the CLI supports it. */
  system: string
  images: Array<{ path: string; mime: string }>
  cwd: string
  model?: string
  effort?: string
  fast?: boolean
  resumeId?: string
  mcp: McpEndpoint
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; id: string; name: string; input?: unknown; status: ToolStatus; output?: string; files?: string[] }
  | { type: 'done'; sessionId?: string; usage?: Usage }
  | { type: 'error'; message: string; sessionId?: string }

export interface DetectResult {
  ok: boolean
  version?: string
  path?: string
  error?: string
}

export interface AgentRunner {
  id: AgentId
  label: string
  /** Whether image attachments can be passed natively. */
  images: boolean
  detect(): Promise<DetectResult>
  listModels?(): Promise<ModelInfo[]>
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<AgentEvent>
}

export interface RunnerOptions {
  /** Override the executable path. */
  bin?: string
  extraArgs?: string[]
}
