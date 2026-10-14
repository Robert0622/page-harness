// Routes the agent's page_* commands to the one browser tab that currently holds page control.
// Each chat panel connection reports {on, visible}; the most recently enabled visible tab wins,
// unless the running turn is pinned to the tab that sent it.
import type { PageCmd, PageControlStatus, PageResult, ProbeResult } from '../shared/protocol'
import { newId } from '../shared/util'

export interface BridgeConn {
  id: string
  chatId: string | null
  send(msg: unknown): void
}

interface ConnState {
  conn: BridgeConn
  on: boolean
  /** A page is attached to this panel (independent of page control). */
  attached: boolean
  attachedAt: number
  visible: boolean
  tab: string
  version: number | null
  activatedAt: number
}

interface Pending {
  connId: string
  chatId: string
  resolve(r: PageResult): void
  timer: NodeJS.Timeout
}

export const PAGE_MESSAGES = {
  offline:
    'Page control is offline: no browser tab has "Allow agent to operate this page" turned on. Ask the user to enable it in the chat settings, or continue without operating the page.',
  paused: 'Page control is paused: the controlled tab is in the background. Ask the user to bring it to the front, then try again.',
  unsupported: 'The page script is outdated or failed to load; page control is unavailable on this page.',
  timeout: 'The page did not answer in time. Call page_state to see the current page.',
  stopped: 'The user stopped page control.',
  disconnected: 'The controlled tab was closed or reloaded. Call page_state again.',
  pinnedGone:
    'The tab that sent this message was closed or turned off page control. Other tabs are not used for this turn; ask the user to go back to that page and turn "Allow agent to operate this page" on again.',
}

export class PageBridge {
  private conns = new Map<string, ConnState>()
  private pending = new Map<string, Pending>()
  private probes = new Map<string, { connId: string; resolve(r: ProbeResult | null): void; timer: NodeJS.Timeout }>()
  private busy = new Map<string, number>()
  private visibilityWaiters = new Set<() => void>()
  /** chatId -> tab the running turn is bound to. */
  private pins = new Map<string, string>()

  attach(conn: BridgeConn): void {
    this.conns.set(conn.id, { conn, on: false, attached: false, attachedAt: 0, visible: true, tab: '', version: null, activatedAt: 0 })
  }

  detach(connId: string): void {
    const s = this.conns.get(connId)
    this.conns.delete(connId)
    for (const [id, p] of this.pending) if (p.connId === connId) this.finish(id, { ok: false, error: PAGE_MESSAGES.disconnected })
    for (const [id, p] of this.probes) if (p.connId === connId) this.finishProbe(id, null)
    if (s?.conn.chatId) this.broadcast(s.conn.chatId)
  }

  /** Called when a connection switches chats. */
  rebind(connId: string, oldChat: string | null): void {
    if (oldChat) this.broadcast(oldChat)
    const s = this.conns.get(connId)
    if (s?.conn.chatId) this.broadcast(s.conn.chatId)
  }

  update(connId: string, patch: { on?: boolean; attached?: boolean; visible?: boolean; tab?: string; version?: number | null }): void {
    const s = this.conns.get(connId)
    if (!s) return
    const wasOn = s.on
    const wasVisible = s.visible
    if (patch.on !== undefined) s.on = patch.on
    if (patch.attached !== undefined) {
      if (patch.attached && !s.attached) s.attachedAt = Date.now()
      s.attached = patch.attached
    }
    if (patch.visible !== undefined) s.visible = patch.visible
    if (patch.tab !== undefined) s.tab = patch.tab
    if (patch.version !== undefined) s.version = patch.version
    if ((s.on && !wasOn) || (s.on && s.visible && !wasVisible)) s.activatedAt = Date.now()
    if (!s.on) for (const [id, p] of this.pending) if (p.connId === connId) this.finish(id, { ok: false, error: PAGE_MESSAGES.stopped })
    if (s.visible) for (const w of this.visibilityWaiters) w()
    if (s.conn.chatId) this.broadcast(s.conn.chatId)
  }

  /** The tab id a connection last reported, or '' when its page has not attached. */
  tabOf(connId: string): string {
    return this.conns.get(connId)?.tab ?? ''
  }

  /** Binds this chat's page commands and probes to one tab until unpin. */
  pin(chatId: string, tab: string): void {
    this.pins.set(chatId, tab)
    this.broadcast(chatId)
  }

  unpin(chatId: string): void {
    if (!this.pins.delete(chatId)) return
    this.broadcast(chatId)
  }

  /** Connections of this chat that may receive its commands: all of them, or only the pinned tab's. */
  private eligible(chatId: string): ConnState[] {
    const pin = this.pins.get(chatId)
    return [...this.conns.values()].filter((s) => s.conn.chatId === chatId && (pin === undefined || s.tab === pin))
  }

  private candidates(chatId: string): ConnState[] {
    return this.eligible(chatId).filter((s) => s.on && s.version !== null)
  }

  /** The connection that commands for this chat go to. */
  active(chatId: string): ConnState | undefined {
    const c = this.candidates(chatId).sort((a, b) => b.activatedAt - a.activatedAt)
    return c.find((s) => s.visible) ?? c[0]
  }

  status(connId: string): PageControlStatus {
    const s = this.conns.get(connId)
    if (!s || !s.on || !s.conn.chatId) return 'disabled'
    if (s.version === null) return 'unsupported'
    const a = this.active(s.conn.chatId)
    if (a !== s) return 'transferred'
    return s.visible ? 'online' : 'paused'
  }

  isBusy(chatId: string): boolean {
    return (this.busy.get(chatId) ?? 0) > 0
  }

  private broadcast(chatId: string): void {
    const busy = this.isBusy(chatId)
    for (const s of this.conns.values()) {
      if (s.conn.chatId === chatId) s.conn.send({ type: 'page_status', status: this.status(s.conn.id), busy })
    }
  }

  private waitVisible(chatId: string, ms: number): Promise<ConnState | undefined> {
    return new Promise((resolve) => {
      const check = () => {
        const a = this.active(chatId)
        if (a?.visible) done(a)
      }
      const done = (v: ConnState | undefined) => {
        clearTimeout(t)
        this.visibilityWaiters.delete(check)
        resolve(v)
      }
      const t = setTimeout(() => done(undefined), ms)
      this.visibilityWaiters.add(check)
      check()
    })
  }

  async run(chatId: string, cmd: PageCmd, timeoutMs = cmd.action === 'state' ? 20000 : 30000): Promise<PageResult> {
    let target = this.active(chatId)
    if (!target) {
      const anyOn = this.eligible(chatId).some((s) => s.on)
      return { ok: false, error: anyOn ? PAGE_MESSAGES.unsupported : this.pins.has(chatId) ? PAGE_MESSAGES.pinnedGone : PAGE_MESSAGES.offline }
    }
    if (!target.visible) {
      target = await this.waitVisible(chatId, 8000)
      if (!target) return { ok: false, error: PAGE_MESSAGES.paused }
    }
    const id = newId('cmd_')
    this.busy.set(chatId, (this.busy.get(chatId) ?? 0) + 1)
    this.broadcast(chatId)
    const result = await new Promise<PageResult>((resolve) => {
      const timer = setTimeout(() => {
        target!.conn.send({ type: 'page_cancel', id })
        this.finish(id, { ok: false, error: PAGE_MESSAGES.timeout })
      }, timeoutMs)
      this.pending.set(id, { connId: target!.conn.id, chatId, resolve, timer })
      target!.conn.send({ type: 'page_cmd', id, cmd })
    })
    this.busy.set(chatId, Math.max(0, (this.busy.get(chatId) ?? 1) - 1))
    this.broadcast(chatId)
    return result
  }

  result(connId: string, id: string, result: PageResult): void {
    const p = this.pending.get(id)
    if (p && p.connId === connId) this.finish(id, result)
  }

  /** The user pressed Stop on the page banner. */
  stop(chatId: string): void {
    for (const [id, p] of this.pending) {
      if (p.chatId !== chatId) continue
      const s = this.conns.get(p.connId)
      s?.conn.send({ type: 'page_cancel', id })
      this.finish(id, { ok: false, error: PAGE_MESSAGES.stopped })
    }
  }

  private finish(id: string, r: PageResult): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(r)
  }

  /**
   * Asks a page showing this chat whether a selector matches anything. Read-only, so it does not
   * need page control. Resolves null when no page answers.
   */
  probe(chatId: string, selector: string, timeoutMs = 3000): Promise<ProbeResult | null> {
    const pages = this.eligible(chatId).filter((s) => s.attached).sort((a, b) => Number(b.visible) - Number(a.visible) || b.attachedAt - a.attachedAt)
    const target = pages[0]
    if (!target) return Promise.resolve(null)
    const id = newId('prb_')
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishProbe(id, null), timeoutMs)
      this.probes.set(id, { connId: target.conn.id, resolve, timer })
      target.conn.send({ type: 'page_probe', id, selector })
    })
  }

  probeResult(connId: string, id: string, result: ProbeResult): void {
    const p = this.probes.get(id)
    if (!p || p.connId !== connId) return
    const count = Number.isInteger(result?.count) ? Math.max(-1, result.count) : -1
    const url = typeof result?.url === 'string' ? result.url.slice(0, 2000) : ''
    const label = typeof result?.label === 'string' ? result.label.slice(0, 120) : undefined
    const anchor = result?.anchor && typeof result.anchor === 'object' ? result.anchor : undefined
    this.finishProbe(id, { count, url, label, anchor })
  }

  private finishProbe(id: string, r: ProbeResult | null): void {
    const p = this.probes.get(id)
    if (!p) return
    this.probes.delete(id)
    clearTimeout(p.timer)
    p.resolve(r)
  }
}
