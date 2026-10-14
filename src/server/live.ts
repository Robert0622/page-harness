// Live variants: session state machine, agent request text, and the marker guard.
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { LIVE_MAX_CHANGES, LIVE_OPEN, type LiveChange, type LiveRequest, type LiveSession, type LiveStatus, type LiveVariant } from '../shared/protocol'
import { newId, truncate } from '../shared/util'
import { readJson, writeJsonAtomic } from './store'

const exec = promisify(execFile)

export interface LiveTurnPlan {
  sid: string
  chatId: string
  /** Shown as the user's message in the chat. */
  summary: string
  /** Sent to the agent. */
  agentText: string
}

const TRANSIENT: LiveStatus[] = ['generating', 'refining', 'accepting', 'discarding']

export class LiveError extends Error {}

export class LiveManager extends EventEmitter {
  private sessions = new Map<string, LiveSession>()
  private file: string
  /** sid -> turn that is handling it */
  private turns = new Map<string, string>()

  /** `patch`: no source (review mode); candidates are page changes, accept/discard need no agent. */
  constructor(dataDir: string, private patch = false) {
    super()
    this.file = path.join(dataDir, 'live.json')
    for (const s of readJson<LiveSession[]>(this.file, [])) {
      if (TRANSIENT.includes(s.status)) {
        s.status = 'failed'
        s.error = 'Interrupted by a restart'
      }
      this.sessions.set(s.sid, s)
    }
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  open(): LiveSession[] {
    return this.list().filter((s) => LIVE_OPEN.includes(s.status))
  }

  get(sid: string): LiveSession | undefined {
    return this.sessions.get(sid)
  }

  private save() {
    writeJsonAtomic(this.file, this.list().slice(0, 200))
    this.emit('change')
  }

  private set(s: LiveSession, patch: Partial<LiveSession>) {
    Object.assign(s, patch, { updatedAt: Date.now() })
    this.save()
  }

  /** Validates a user op, updates the session and returns what to run. */
  request(chatId: string, req: LiveRequest): LiveTurnPlan | null {
    const now = Date.now()
    if (req.op === 'generate' || req.op === 'insert' || req.op === 'steer') {
      const count = Math.min(4, Math.max(2, Math.round(req.count ?? 3)))
      if (req.op !== 'steer' && !req.target) throw new LiveError('a target element is required')
      if (req.op === 'insert' && !req.prompt?.trim()) throw new LiveError('describe the block to insert')
      if (req.op === 'steer' && !req.prompt?.trim()) throw new LiveError('describe the page change')
      if (req.op === 'insert' && this.patch) throw new LiveError('inserting new elements needs the page source; without it candidates can only change text, styles and images')
      const s: LiveSession = {
        sid: 'L' + newId().slice(0, 8),
        chatId,
        source: this.patch ? 'patch' : undefined,
        kind: req.op,
        status: 'generating',
        display: req.display ?? 'inplace',
        count,
        variants: [],
        target: req.target,
        position: req.op === 'insert' ? req.position ?? 'after' : undefined,
        action: req.op === 'generate' ? req.action ?? 'freeform' : undefined,
        prompt: req.prompt,
        url: req.url,
        path: pathOf(req.url),
        pending: { ...req, count, scope: req.op === 'steer' ? 'page' : 'element' },
        createdAt: now,
        updatedAt: now,
      }
      this.sessions.set(s.sid, s)
      this.save()
      return this.plan(s, s.pending!)
    }
    const s = req.sid ? this.sessions.get(req.sid) : undefined
    if (!s) throw new LiveError('unknown candidate session')
    switch (req.op) {
      case 'refine':
        if (s.status !== 'ready') throw new LiveError('candidates are not ready')
        if (!req.prompt?.trim()) throw new LiveError('describe the refinement')
        if (s.source === 'patch' && !s.variants.some((v) => v.index === req.variant)) throw new LiveError('choose a candidate to refine')
        this.set(s, { status: 'refining', pending: req, error: undefined })
        break
      case 'accept':
        if (s.status !== 'ready') throw new LiveError('candidates are not ready')
        if (req.variant === undefined || !s.variants.some((v) => v.index === req.variant)) throw new LiveError('choose a candidate to accept')
        if (s.source === 'patch') {
          this.set(s, { status: 'accepted', accepted: req.variant, pending: undefined, error: undefined })
          return null
        }
        this.set(s, { status: 'accepting', pending: req, accepted: req.variant, error: undefined })
        break
      case 'discard':
        if (!LIVE_OPEN.includes(s.status) || s.status === 'discarding' || s.status === 'accepting') throw new LiveError('nothing to discard')
        if (s.source === 'patch') {
          this.set(s, { status: 'discarded', pending: undefined, error: undefined })
          return null
        }
        // The agent reported failure without touching the source: nothing to clean up.
        if (s.status === 'failed' && !s.variants.length && s.partial === false) {
          this.set(s, { status: 'discarded', pending: undefined, error: undefined })
          return null
        }
        this.set(s, { status: 'discarding', pending: req, error: undefined })
        break
      case 'mount_failed':
        if (s.source === 'patch') throw new LiveError('nothing to rebuild for page-change candidates')
        if (s.status !== 'ready') throw new LiveError('candidates are not ready')
        this.set(s, { status: 'generating', pending: req })
        break
      case 'retry': {
        if (s.status !== 'failed' || !s.pending) throw new LiveError('nothing to retry')
        let op = s.pending
        if (req.andAccept && s.accepted !== undefined) op = { op: 'accept', sid: s.sid, variant: s.accepted, params: op.params }
        const status: LiveStatus = op.op === 'accept' ? 'accepting' : op.op === 'discard' ? 'discarding' : op.op === 'refine' ? 'refining' : 'generating'
        this.set(s, { status, pending: op, error: undefined, partial: undefined })
        return this.plan(s, op, true)
      }
      default:
        throw new LiveError(`unsupported op ${req.op}`)
    }
    return this.plan(s, req)
  }

  bindTurn(sid: string, turnId: string) {
    this.turns.set(sid, turnId)
  }

  /** The agent's live_update call. Returns the text the agent gets back. */
  update(chatId: string, u: { sid: string; status: 'ready' | 'failed' | 'done'; variants?: LiveVariant[]; message?: string; partial?: boolean }): string {
    const s = this.sessions.get(u.sid)
    if (!s) throw new LiveError(`unknown sid ${u.sid}`)
    if (s.chatId !== chatId) throw new LiveError(`sid ${u.sid} belongs to another chat`)
    if (u.status === 'failed') {
      this.set(s, { status: 'failed', error: u.message || 'The agent could not finish', partial: u.partial })
      return 'Recorded as failed. The user can retry or discard from the page.'
    }
    if (u.status === 'ready') {
      if (s.source === 'patch') throw new LiveError('there is no source here: render candidates with live_patch_variants')
      if (s.status !== 'generating' && s.status !== 'refining') throw new LiveError(`session is ${s.status}; "ready" only follows generate/steer/insert/refine/mount_failed`)
      const variants = (u.variants ?? []).filter((v) => Number.isInteger(v.index) && v.index > 0).map((v) => ({ index: v.index, label: truncate(String(v.label || `#${v.index}`), 24) }))
      if (variants.length < 1) throw new LiveError('report the candidates you rendered: variants:[{index:1,label:"…"},…]')
      this.set(s, { status: 'ready', variants, error: undefined, partial: undefined })
      return `Recorded ${variants.length} candidates. Wait for the user's choice; do not accept on their behalf.`
    }
    if (s.status === 'accepting') {
      this.set(s, { status: 'accepted', pending: undefined })
      return 'Accepted and cleaned up.'
    }
    if (s.status === 'discarding') {
      this.set(s, { status: 'discarded', pending: undefined })
      return 'Discarded and cleaned up.'
    }
    throw new LiveError(`session is ${s.status}; "done" only follows accept or discard`)
  }

  /**
   * The agent's live_patch_variants call (no source). generate/steer: the full set of candidates;
   * refine: the candidate being refined (index defaults to it). Changes arrive validated.
   */
  setPatchVariants(chatId: string, sid: string, input: Array<{ index?: number; label: string; changes: LiveChange[] }>): string {
    const s = this.sessions.get(sid)
    if (!s) throw new LiveError(`unknown sid ${sid}`)
    if (s.chatId !== chatId) throw new LiveError(`sid ${sid} belongs to another chat`)
    if (s.source !== 'patch') throw new LiveError('this session renders candidates in the source; use live_update')
    if (s.status !== 'generating' && s.status !== 'refining') throw new LiveError(`session is ${s.status}; candidates can only be set while generating or refining`)
    for (const v of input) {
      if (!v.changes.length) throw new LiveError(`candidate "${v.label}" changes nothing`)
      if (v.changes.length > LIVE_MAX_CHANGES) throw new LiveError(`a candidate may change at most ${LIVE_MAX_CHANGES} elements`)
    }
    const label = (v: { label: string }, i: number) => truncate(String(v.label || `#${i}`), 24)
    let variants: LiveVariant[]
    if (s.status === 'refining') {
      const target = s.pending?.variant
      variants = s.variants.map((v) => ({ ...v }))
      for (const v of input) {
        const index = v.index ?? (input.length === 1 ? target : undefined)
        const at = variants.findIndex((x) => x.index === index)
        if (at < 0) throw new LiveError(`refine replaces existing candidates; give index (current: ${s.variants.map((x) => x.index).join(', ')})`)
        // The page showed this candidate while it was probed; keep the fingerprints of the original.
        const before = new Map((variants[at].changes ?? []).map((c) => [c.selector, c.anchor]))
        const changes = v.changes.map((c) => (before.get(c.selector) ? { ...c, anchor: before.get(c.selector) } : c))
        variants[at] = { index: index!, label: label(v, index!), changes }
      }
    } else {
      if (input.length < 1 || input.length > 4) throw new LiveError('render 2–4 candidates')
      variants = input.map((v, i) => ({ index: i + 1, label: label(v, i + 1), changes: v.changes }))
    }
    this.set(s, { status: 'ready', variants, error: undefined, partial: undefined })
    return `Showing ${variants.length} candidates on the page. Wait for the user's choice; accepting or discarding happens on the page.`
  }

  /** A turn finished; sessions it left mid-flight become failed. */
  turnEnded(turnId: string, status: string) {
    for (const [sid, t] of this.turns) {
      if (t !== turnId) continue
      this.turns.delete(sid)
      const s = this.sessions.get(sid)
      if (s && TRANSIENT.includes(s.status)) {
        this.set(s, { status: 'failed', error: status === 'cancelled' ? 'Stopped' : 'The agent finished without reporting the result' })
      }
    }
  }

  private plan(s: LiveSession, req: LiveRequest, retry = false): LiveTurnPlan {
    return { sid: s.sid, chatId: s.chatId, summary: summarize(s, req, retry), agentText: requestText(s, req) }
  }
}

function pathOf(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

function summarize(s: LiveSession, req: LiveRequest, retry: boolean): string {
  const target = s.target ? `<${s.target.tagName.toLowerCase()}> ${truncate(s.target.text || s.target.selector, 40)}` : 'page'
  const pre = retry ? '↻ ' : ''
  switch (req.op) {
    case 'generate':
      return `${pre}Live · ${req.action ?? 'freeform'} · ${target}${req.prompt ? ` — ${req.prompt}` : ''}`
    case 'insert':
      return `${pre}Live · insert ${req.position ?? 'after'} ${target} — ${req.prompt ?? ''}`
    case 'steer':
      return `${pre}Live · page — ${req.prompt ?? ''}`
    case 'refine':
      return `${pre}Live · refine #${req.variant} — ${req.prompt ?? ''}`
    case 'accept':
      return `${pre}Live · accept #${req.variant}`
    case 'discard':
      return `${pre}Live · discard`
    case 'mount_failed':
      return `Live · candidates did not appear on the page`
    default:
      return `Live · ${req.op}`
  }
}

/** The "## Live request" block the agent receives. */
export function requestText(s: LiveSession, req: LiveRequest): string {
  const lines = ['## Live request', `sid: ${s.sid}`, `op: ${req.op}`]
  if (s.source === 'patch') lines.push('render: page changes (no source) with live_patch_variants')
  if (req.op === 'generate' || req.op === 'insert' || req.op === 'steer') {
    lines.push(`count: ${s.count}`, `scope: ${req.op === 'steer' ? 'page' : 'element'}`)
    if (req.action) lines.push(`action: ${req.action}`)
    if (req.position) lines.push(`position: ${req.position}`)
  }
  if (req.variant !== undefined) lines.push(`variant: ${req.variant}`)
  if (req.params && Object.keys(req.params).length) lines.push(`params: ${JSON.stringify(req.params)}`)
  if (req.url || s.url) lines.push(`url: ${req.url ?? s.url}`)
  const t = req.target ?? s.target
  if (t && (req.op === 'generate' || req.op === 'insert' || req.op === 'mount_failed' || req.op === 'refine')) {
    lines.push('target:', `  selector: ${t.selector}`, `  tag: ${t.tagName.toLowerCase()}`)
    if (t.id) lines.push(`  id: ${t.id}`)
    if (t.classes.length) lines.push(`  classes: ${t.classes.join(' ')}`)
    if (t.text) lines.push(`  text: ${JSON.stringify(t.text)}`)
    const styles = Object.entries(t.styles ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ')
    if (styles) lines.push(`  styles: ${styles}`)
    lines.push('  outerHTML:', '```html', t.outerHTML, '```')
  }
  if (req.op === 'refine' || req.op === 'accept') {
    const v = s.variants.find((x) => x.index === req.variant)
    if (v) lines.push(`variant label: ${v.label}`)
    if (v?.changes) lines.push('variant changes:', '```json', JSON.stringify(v.changes.map(({ selector, patch }) => ({ selector, ...patch }))), '```')
  }
  if (req.prompt) lines.push(`request: ${req.prompt}`)
  if (req.notes) lines.push(`notes: ${req.notes}`)
  if (req.marks?.length) {
    lines.push('marks:')
    for (const m of req.marks) lines.push(`  ${m.n}. ${m.kind === 'pin' ? 'pin' : 'circled'} on ${m.targets.join(', ') || '(nothing)'}${m.note ? ` — ${JSON.stringify(m.note)}` : ''}`)
  }
  if (req.reason) lines.push(`reason: ${req.reason}`)
  if (s.variants.length && req.op !== 'generate') lines.push(`current variants: ${s.variants.map((v) => `${v.index}=${v.label}`).join(', ')}`)
  return lines.join('\n')
}

/** Parses a request block (used by the scripted test agent). */
export function parseRequestText(text: string): Record<string, string> | null {
  if (!text.includes('## Live request')) return null
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([a-z ]+):\s*(.*)$/.exec(line)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  const html = /```html\n([\s\S]*?)\n```/.exec(text)
  if (html) out.outerHTML = html[1]
  return out
}

// ---------- marker guard ----------

const MARKER_RE = 'data-ph-live="[^"]+"'

export class MarkerGuard {
  private baseline: Map<string, number> | null = null
  private git: boolean | null = null
  private hookInstalled = false

  constructor(private cwd: string) {}

  private async isGit(): Promise<boolean> {
    if (this.git !== null) return this.git
    try {
      const r = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.cwd })
      this.git = r.stdout.trim() === 'true'
    } catch {
      this.git = false
    }
    return this.git
  }

  /** Counts markers in HEAD before the first Live edit; existing occurrences are ignored later. */
  async ensureBaseline(): Promise<void> {
    if (this.baseline || !(await this.isGit())) return
    this.baseline = new Map()
    try {
      const r = await exec('git', ['grep', '-c', '-E', MARKER_RE, 'HEAD', '--', '.'], { cwd: this.cwd, maxBuffer: 8 << 20 })
      for (const line of r.stdout.split('\n')) {
        const m = /^HEAD:(.+):(\d+)$/.exec(line)
        if (m) this.baseline.set(m[1], Number(m[2]))
      }
    } catch {
      // exit code 1: no matches
    }
  }

  /** Returns {file, sid} for markers in the working tree that are new since the baseline. */
  async scan(): Promise<Array<{ file: string; sid: string }>> {
    if (!(await this.isGit())) return []
    await this.ensureBaseline()
    let out: string
    try {
      const r = await exec('git', ['grep', '-n', '-I', '--untracked', '-o', '-E', MARKER_RE, '--', '.', ':!.page-harness'], { cwd: this.cwd, maxBuffer: 8 << 20 })
      out = r.stdout
    } catch {
      return []
    }
    const counts = new Map<string, number>()
    const found: Array<{ file: string; sid: string }> = []
    for (const line of out.split('\n')) {
      const m = /^(.+?):\d+:data-ph-live="([^"]+)"$/.exec(line)
      if (!m) continue
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
      found.push({ file: m[1], sid: m[2] })
    }
    return found.filter((f) => (counts.get(f.file) ?? 0) > (this.baseline?.get(f.file) ?? 0))
  }

  private hookPath(): string {
    return path.join(this.cwd, '.git', 'hooks', 'pre-commit')
  }

  /** Optional pre-commit hook that rejects staged Live markers. */
  async installHook(): Promise<boolean> {
    if (!(await this.isGit()) || !existsSync(path.join(this.cwd, '.git', 'hooks'))) return false
    const hook = this.hookPath()
    const orig = hook + '.page-harness-orig'
    if (existsSync(hook) && !readFileSync(hook, 'utf8').includes('page-harness live guard')) renameSync(hook, orig)
    writeFileSync(
      hook,
      `#!/bin/sh
# page-harness live guard (removed when page-harness exits)
if git diff --cached -U0 | grep -E '^\\+.*data-ph-(live|variant)=' >/dev/null; then
  echo "page-harness: staged changes still contain Live candidate markers (data-ph-live). Accept or discard them first." >&2
  exit 1
fi
if [ -x "$0.page-harness-orig" ]; then exec "$0.page-harness-orig" "$@"; fi
exit 0
`,
    )
    chmodSync(hook, 0o755)
    this.hookInstalled = true
    return true
  }

  uninstallHook(): void {
    if (!this.hookInstalled) return
    const hook = this.hookPath()
    try {
      if (existsSync(hook) && readFileSync(hook, 'utf8').includes('page-harness live guard')) unlinkSync(hook)
      if (existsSync(hook + '.page-harness-orig')) renameSync(hook + '.page-harness-orig', hook)
    } catch {}
    this.hookInstalled = false
  }
}
