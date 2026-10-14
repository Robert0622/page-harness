// Wires every server component together. Used by the CLI and by the integration tests.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_ORDER, AgentRegistry, type AgentId } from '../agents'
import { recoverCursorMcp, releaseAllCursorMcp } from '../agents/cursor'
import type { AgentInfo, HarnessMode } from '../shared/protocol'
import { startServers } from './app'
import { ArtifactStore } from './artifacts'
import { Auth, type PublicScheme } from './auth'
import { Gateway } from './gateway'
import { LiveManager, MarkerGuard } from './live'
import { log } from './log'
import { PageBridge } from './pageBridge'
import { ReviewStore, detectMode } from './review'
import { Team } from './team'
import { Uploads } from './uploads'

export interface HarnessOptions {
  target: URL
  project: string
  host: string
  appPort: number
  controlPort: number
  agent?: string
  model?: string
  allowHosts?: string[]
  keepHost?: boolean
  agentPaths?: Partial<Record<AgentId, string>>
  liveGuardHook?: boolean
  /** Defaults to "review" for public targets and "source" for local/LAN dev servers. */
  mode?: HarnessMode
  /** Let teammates join as reviewers with an invite link. */
  share?: boolean
  /** Scheme browsers use to reach both ports, "https" behind a TLS-terminating load balancer. */
  publicScheme?: PublicScheme
}

export interface Harness {
  appUrl: string
  controlUrl: string
  agents: AgentInfo[]
  defaultAgent: string
  mode: HarnessMode
  /** Invite link for teammates (with share). */
  shareUrl?: string
  gateway: Gateway
  auth: Auth
  close(): Promise<void>
}

export async function startHarness(o: HarnessOptions): Promise<Harness> {
  const dataDir = path.join(o.project, '.page-harness')
  mkdirSync(dataDir, { recursive: true })
  // Keeps chats, artifacts and uploads out of git without touching the project's own .gitignore.
  if (!existsSync(path.join(dataDir, '.gitignore'))) writeFileSync(path.join(dataDir, '.gitignore'), '*\n')
  if (recoverCursorMcp(o.project)) log.warn('restored .cursor/mcp.json left behind by a previous run')

  const registry = new AgentRegistry({ paths: o.agentPaths })
  const agents = await registry.detect()
  let defaultAgent = o.agent
  if (defaultAgent) {
    if (!registry.get(defaultAgent)) throw new Error(`unknown agent "${defaultAgent}"; use ${AGENT_ORDER.join(', ')}`)
    if (!registry.available(defaultAgent)) log.warn(`${defaultAgent} CLI not found; chats will fail until it is installed (or pass --${defaultAgent}-path)`)
  } else {
    defaultAgent = registry.firstAvailable()
    if (!defaultAgent) {
      log.warn('no agent CLI found (claude, codex, cursor-agent, codebuddy or opencode). The panel will open, but chats cannot run until one is installed.')
      defaultAgent = 'claude'
    }
  }

  const team = new Team(dataDir, !!o.share)
  const auth = new Auth({ host: o.host, appPort: o.appPort, controlPort: o.controlPort, extraHosts: o.allowHosts, team, publicScheme: o.publicScheme })
  const artifacts = new ArtifactStore(dataDir)
  const uploads = new Uploads(dataDir)
  const mode = o.mode ?? detectMode(o.target)
  const live = new LiveManager(dataDir, mode === 'review')
  const guard = new MarkerGuard(o.project)
  const bridge = new PageBridge()
  const review = new ReviewStore(dataDir)
  const shownHost = o.host === '0.0.0.0' || o.host === '::' || o.host === '127.0.0.1' ? 'localhost' : o.host
  const appUrl = auth.origin(shownHost, o.appPort)
  const shareHost = o.host === '0.0.0.0' || o.host === '::' ? (lanAddress() ?? shownHost) : shownHost
  const shareUrl = o.share ? `${auth.origin(shareHost, o.controlPort)}/__ph/join?t=${team.invite}` : undefined
  const gateway = new Gateway({
    project: o.project,
    dataDir,
    target: o.target.href,
    appUrl,
    mcpUrl: `http://${mcpHost(o.host)}:${o.controlPort}/__ph/mcp`,
    registry,
    defaultAgent,
    defaultModel: o.model,
    artifacts,
    uploads,
    live,
    guard,
    bridge,
    auth,
    mode,
    review,
    team,
    shareUrl,
  })
  if (o.liveGuardHook && !(await guard.installHook())) log.warn('--live-guard-hook needs a git repository')

  const servers = await startServers({
    target: o.target,
    host: o.host,
    appPort: o.appPort,
    controlPort: o.controlPort,
    project: o.project,
    auth,
    gateway,
    registry,
    artifacts,
    uploads,
    live,
    keepHost: o.keepHost,
  })

  let closed = false
  return {
    appUrl,
    controlUrl: auth.origin(shownHost, o.controlPort),
    agents,
    defaultAgent,
    mode,
    shareUrl,
    gateway,
    auth,
    async close() {
      if (closed) return
      closed = true
      await gateway.shutdown().catch(() => {})
      releaseAllCursorMcp()
      guard.uninstallHook()
      await servers.close().catch(() => {})
    },
  }
}

/** Agents reach MCP on this machine; a specific listen address is the only one that answers. */
function mcpHost(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '127.0.0.1') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return undefined
}
