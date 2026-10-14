import type { AgentInfo, ModelInfo } from '../shared/protocol'
import { createClaudeRunner } from './claude'
import { createCodeBuddyRunner } from './codebuddy'
import { createCodexRunner } from './codex'
import { createCursorRunner } from './cursor'
import { createFakeRunner } from './fake'
import { createOpenCodeRunner } from './opencode'
import type { AgentId, AgentRunner } from './types'

export type { AgentRunner, AgentId } from './types'

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'cursor', 'codebuddy', 'opencode']

export interface RegistryOptions {
  paths?: Partial<Record<AgentId, string>>
  extraArgs?: Partial<Record<AgentId, string[]>>
}

export class AgentRegistry {
  readonly runners = new Map<string, AgentRunner>()
  private info = new Map<string, AgentInfo>()

  constructor(opts: RegistryOptions = {}) {
    const o = (id: AgentId) => ({ bin: opts.paths?.[id], extraArgs: opts.extraArgs?.[id] })
    this.runners.set('claude', createClaudeRunner(o('claude')))
    this.runners.set('codex', createCodexRunner(o('codex')))
    this.runners.set('cursor', createCursorRunner(o('cursor')))
    this.runners.set('codebuddy', createCodeBuddyRunner(o('codebuddy')))
    this.runners.set('opencode', createOpenCodeRunner(o('opencode')))
    if (process.env.PH_FAKE_AGENT === '1') this.runners.set('fake', createFakeRunner())
  }

  async detect(): Promise<AgentInfo[]> {
    const list = await Promise.all(
      [...this.runners.values()].map(async (r): Promise<AgentInfo> => {
        const d = await r.detect()
        return { id: r.id, label: r.label, available: d.ok, version: d.version, path: d.path }
      }),
    )
    for (const i of list) this.info.set(i.id, i)
    return list
  }

  list(): AgentInfo[] {
    return [...this.info.values()]
  }

  get(id: string): AgentRunner | undefined {
    return this.runners.get(id)
  }

  available(id: string): boolean {
    return !!this.info.get(id)?.available
  }

  firstAvailable(): string | undefined {
    if (this.available('fake')) return 'fake'
    return AGENT_ORDER.find((id) => this.available(id))
  }

  async models(id: string): Promise<ModelInfo[]> {
    const info = this.info.get(id)
    if (info?.models) return info.models
    const r = this.runners.get(id)
    const models = (await r?.listModels?.().catch(() => [])) ?? []
    // An empty or stand-in list means listing failed; leave it uncached so the next request tries again.
    if (info && models.length && !models.some((m) => m.fallback)) info.models = models
    return models
  }

  /** The model list if it has already been fetched, without starting a fetch. */
  cachedModels(id: string): ModelInfo[] | undefined {
    return this.info.get(id)?.models
  }
}
