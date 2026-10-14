// Review layer: notes, temporary page changes, replies and page approvals left on the page by the
// agent and by people (the owner and teammates who joined with an invite link).
import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'
import path from 'node:path'
import { normalizeHost, normalizePath } from '../shared/paths'
import type { HarnessMode, ReviewAnchor, ReviewAuthor, ReviewItem, ReviewLook, ReviewPatch, ReviewSeverity, ReviewState } from '../shared/protocol'
import { REVIEW_PAGE_SIZE, reviewMarkdown } from '../shared/review-read'
import { extOf, newId, truncate } from '../shared/util'
import { readJson, writeJsonAtomic } from './store'

export const MAX_REVIEW_ITEMS = 500
const MAX_NOTE = 2000
const MAX_TEXT = 4000
const MAX_STYLE_PROPS = 30
const MAX_REPLIES = 100

export const AGENT_AUTHOR: ReviewAuthor = { id: 'agent', name: 'Agent', kind: 'agent' }

/** Artifacts the agent may still write in review mode: reports and data, not page mockups. */
const REVIEW_ARTIFACT_EXT = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'gif'])

export function reviewArtifactAllowed(name: string): boolean {
  return REVIEW_ARTIFACT_EXT.has(extOf(name))
}

export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0
  }
  if (isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
  return !h.includes('.')
}

/** A local or LAN dev server is assumed to be served from the project; anything public is reviewed. */
export function detectMode(target: URL): HarnessMode {
  return privateHost(target.hostname) ? 'source' : 'review'
}

export interface ReviewInput {
  kind: 'note' | 'patch'
  /** Page URL or path; normalised on save. */
  path: string
  /** Site host. Falls back to the store's default (the proxied target). */
  host?: string
  selector: string
  anchor?: ReviewAnchor
  label?: string
  note: string
  severity?: ReviewSeverity
  patch?: ReviewPatch
  look?: ReviewLook
  author?: ReviewAuthor
  chatId?: string
  turnId?: string
}

const MAX_LOOK_HTML = 40_000
const MAX_LOOK_IMG = 180_000
const MAX_PAGE_IMG = 260_000
const LOOK_IMG = /^data:image\/(?:png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '').replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '')
}

/** Keeps a captured before/after only when it is a bounded HTML snippet or a small image data URL. */
export function cleanLook(look: ReviewLook | undefined): ReviewLook | undefined {
  if (!look || typeof look !== 'object') return undefined
  const html = (v: unknown) => (typeof v === 'string' && v.trim() ? truncate(stripHtml(v), MAX_LOOK_HTML) : undefined)
  const img = (v: unknown, max = MAX_LOOK_IMG) => (typeof v === 'string' && v.length <= max && LOOK_IMG.test(v) ? v : undefined)
  const out: ReviewLook = { beforeHtml: html(look.beforeHtml), afterHtml: html(look.afterHtml), beforeImage: img(look.beforeImage), afterImage: img(look.afterImage) }
  const beforePage = img(look.beforePage, MAX_PAGE_IMG)
  const afterPage = img(look.afterPage, MAX_PAGE_IMG)
  if (beforePage) out.beforePage = beforePage
  if (afterPage) out.afterPage = afterPage
  if (!out.beforeHtml && !out.afterHtml && !out.beforeImage && !out.afterImage && !beforePage && !afterPage) return undefined
  return out
}

const SAFE_IMG = /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpe?g|gif|webp);base64,)/i

export function cleanPatch(p: ReviewPatch | undefined): ReviewPatch {
  const out: ReviewPatch = {}
  if ((p as { html?: unknown } | undefined)?.html !== undefined) throw new Error('html patches are not supported: change text, style or image attributes instead')
  if (p?.style) {
    const entries = Object.entries(p.style)
    const bad = entries.filter(([k, v]) => !/^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/.test(k) || typeof v !== 'string' || /url\s*\(|expression\s*\(|javascript:/i.test(v)).map(([k]) => k)
    if (bad.length) throw new Error(`unsupported style properties: ${bad.join(', ')} (plain CSS values only, no url())`)
    if (entries.length > MAX_STYLE_PROPS) throw new Error(`at most ${MAX_STYLE_PROPS} style properties per patch`)
    if (entries.length) out.style = Object.fromEntries(entries.map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), truncate(v, 300)]))
  }
  if (typeof p?.text === 'string') out.text = truncate(p.text, MAX_TEXT)
  if (p?.attrs) {
    const attrs: NonNullable<ReviewPatch['attrs']> = {}
    if (typeof p.attrs.src === 'string') {
      if (!SAFE_IMG.test(p.attrs.src) || p.attrs.src.length > 200_000) throw new Error('image src must be an http(s) URL, a site path or a data:image URL')
      attrs.src = p.attrs.src
    }
    if (typeof p.attrs.alt === 'string') attrs.alt = truncate(p.attrs.alt, 300)
    if (Object.keys(attrs).length) out.attrs = attrs
  }
  if (!out.style && out.text === undefined && !out.attrs) throw new Error('a patch needs style, text or image attributes')
  if (out.style && p?.from && typeof p.from === 'object') {
    const from = Object.fromEntries(Object.entries(p.from).filter(([k, v]) => k in out.style! && typeof v === 'string' && !/url\s*\(|expression\s*\(|javascript:/i.test(v)).map(([k, v]) => [k, truncate(v, 300)]))
    if (Object.keys(from).length) out.from = from
  }
  return out
}

function cleanAnchor(a: ReviewAnchor | undefined): ReviewAnchor | undefined {
  if (!a || typeof a.tag !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(a.tag)) return undefined
  const str = (v: unknown, n: number) => (typeof v === 'string' && v ? truncate(v, n) : undefined)
  const attrs = a.attrs && typeof a.attrs === 'object' ? Object.fromEntries(Object.entries(a.attrs).filter(([k, v]) => /^[a-z-]{1,40}$/.test(k) && typeof v === 'string').slice(0, 12).map(([k, v]) => [k, truncate(v as string, 300)])) : undefined
  return {
    tag: a.tag.toLowerCase(),
    id: str(a.id, 200),
    classes: Array.isArray(a.classes) ? a.classes.filter((c) => typeof c === 'string').slice(0, 6).map((c) => truncate(c, 60)) : undefined,
    attrs: attrs && Object.keys(attrs).length ? attrs : undefined,
    text: str(a.text, 120),
    prefix: str(a.prefix, 48),
    suffix: str(a.suffix, 48),
    vw: typeof a.vw === 'number' && a.vw > 0 && a.vw < 20000 ? Math.round(a.vw) : undefined,
  }
}

/** Old files: a bare item array, no authors, no host, html patches. */
function migrate(raw: unknown, defaultHost: string): { state: ReviewState; backfill: boolean } {
  const src = Array.isArray(raw) ? { items: raw, approvals: [] } : ((raw ?? {}) as Partial<ReviewState> & { items?: Array<ReviewItem & { host?: string }> })
  let backfill = false
  const items = (src.items ?? []).map((i): ReviewItem => {
    if (!i.host) backfill = true
    const item = {
      ...i,
      host: normalizeHost(i.host || defaultHost),
      author: i.author ?? AGENT_AUTHOR,
      status: i.status ?? 'open',
      replies: i.replies ?? [],
      path: normalizePath(i.path ?? '/'),
    } as ReviewItem
    const html = (item.patch as { html?: string } | undefined)?.html
    if (html !== undefined && item.patch) {
      const { html: _drop, ...rest } = item.patch as ReviewPatch & { html?: string }
      void _drop
      item.patch = Object.keys(rest).length ? rest : undefined
      if (!item.patch) item.kind = 'note'
    }
    return item
  })
  const approvals = (src.approvals ?? []).map((a) => {
    if (!a.host) backfill = true
    return { ...a, host: normalizeHost(a.host || defaultHost) }
  })
  return { state: { items, approvals }, backfill: backfill && !!defaultHost }
}

export class ReviewStore extends EventEmitter {
  private state: ReviewState
  private file: string
  private nextN: number
  /** Host used when a note is saved without one (the proxied site). Empty in bookmarklet mode. */
  readonly defaultHost: string

  constructor(dataDir: string, defaultHost = '') {
    super()
    this.defaultHost = normalizeHost(defaultHost)
    this.file = path.join(dataDir, 'review.json')
    const loaded = migrate(readJson<unknown>(this.file, []), this.defaultHost)
    this.state = loaded.state
    this.nextN = this.state.items.reduce((m, i) => Math.max(m, i.n), 0) + 1
    if (loaded.backfill) this.save()
  }

  snapshot(): ReviewState {
    return { items: [...this.state.items], approvals: [...this.state.approvals] }
  }

  list(): ReviewItem[] {
    return [...this.state.items]
  }

  get(id: string): ReviewItem | undefined {
    return this.state.items.find((i) => i.id === id || String(i.n) === id.replace(/^#/, ''))
  }

  hasRoom(n: number): boolean {
    return this.state.items.length + n <= MAX_REVIEW_ITEMS
  }

  add(input: ReviewInput): ReviewItem {
    const author = input.author ?? AGENT_AUTHOR
    if (!input.selector?.trim()) throw new Error('a selector is required')
    const note = (input.note ?? '').trim()
    if (!note && (author.kind === 'agent' || input.kind === 'note')) throw new Error('a note is required: say what is wrong or why the change helps')
    if (this.state.items.length >= MAX_REVIEW_ITEMS) throw new Error(`there are already ${MAX_REVIEW_ITEMS} review items; remove some first`)
    const patch = input.kind === 'patch' ? cleanPatch(input.patch) : undefined
    const look = input.kind === 'patch' ? cleanLook(input.look) : undefined
    const item: ReviewItem = {
      id: newId('rv_'),
      n: this.nextN++,
      kind: input.kind,
      host: normalizeHost(input.host || this.defaultHost),
      path: normalizePath(input.path || '/'),
      selector: truncate(input.selector.trim(), 500),
      anchor: cleanAnchor(input.anchor),
      label: input.label ? truncate(input.label, 120) : undefined,
      note: truncate(note, MAX_NOTE),
      severity: input.kind === 'note' ? (['issue', 'suggestion', 'info'].includes(input.severity ?? '') ? input.severity : 'suggestion') : undefined,
      patch,
      look,
      author,
      status: 'open',
      replies: [],
      chatId: input.chatId,
      turnId: input.turnId,
      createdAt: Date.now(),
    }
    this.state.items.push(item)
    this.save()
    return item
  }

  reply(id: string, author: ReviewAuthor, text: string): ReviewItem {
    const item = this.must(id)
    const t = text.trim()
    if (!t) throw new Error('a reply needs text')
    if (item.replies.length >= MAX_REPLIES) throw new Error('this thread is full')
    item.replies.push({ id: newId('rp_'), author, text: truncate(t, MAX_NOTE), at: Date.now() })
    this.save()
    return item
  }

  editNote(id: string, note: string): ReviewItem {
    const item = this.must(id)
    if (item.kind !== 'note') throw new Error('only notes can be edited; change the page again instead')
    const t = note.trim()
    if (!t) throw new Error('a note needs text')
    item.note = truncate(t, MAX_NOTE)
    this.save()
    return item
  }

  setStatus(id: string, status: 'open' | 'resolved', author?: ReviewAuthor, summary?: string): ReviewItem {
    const item = this.must(id)
    item.status = status
    if (summary?.trim() && author) item.replies.push({ id: newId('rp_'), author, text: truncate(summary.trim(), MAX_NOTE), at: Date.now() })
    this.save()
    return item
  }

  approve(url: string, author: ReviewAuthor, status: 'approved' | 'changes' | null, host?: string): void {
    const p = normalizePath(url)
    const h = normalizeHost(host || this.defaultHost)
    this.state.approvals = this.state.approvals.filter((a) => !(a.path === p && a.host === h && a.author.id === author.id))
    if (status) this.state.approvals.push({ host: h, path: p, author, status, at: Date.now() })
    this.save()
  }

  remove(id: string): ReviewItem | undefined {
    const item = this.get(id)
    if (!item) return undefined
    this.state.items = this.state.items.filter((i) => i !== item)
    this.save()
    return item
  }

  /** Clears one site when `host` is set, otherwise every site. */
  clear(host?: string): number {
    if (!host) {
      const n = this.state.items.length
      this.state = { items: [], approvals: [] }
      this.nextN = 1
      this.save()
      return n
    }
    const h = normalizeHost(host)
    const before = this.state.items.length
    this.state.items = this.state.items.filter((i) => i.host !== h)
    this.state.approvals = this.state.approvals.filter((a) => a.host !== h)
    if (!this.state.items.length) this.nextN = 1
    this.save()
    return before - this.state.items.length
  }

  /** One row per site that has notes. */
  sites(): { host: string; total: number; open: number }[] {
    const map = new Map<string, { host: string; total: number; open: number }>()
    for (const i of this.state.items) {
      const row = map.get(i.host) ?? { host: i.host, total: 0, open: 0 }
      row.total++
      if (i.status === 'open') row.open++
      map.set(i.host, row)
    }
    return [...map.values()].sort((a, b) => a.host.localeCompare(b.host))
  }

  forHost(host: string): ReviewState {
    const h = normalizeHost(host)
    return {
      items: this.state.items.filter((i) => i.host === h),
      approvals: this.state.approvals.filter((a) => a.host === h),
    }
  }

  /** People may edit or delete what they wrote; the owner may delete anything. */
  canRemove(item: ReviewItem, who: ReviewAuthor, owner: boolean): boolean {
    return owner || item.author.id === who.id
  }

  /**
   * Fills in a look captured after the item was saved.
   * A new image replaces a stored one, so a blank strip from an older capture does not stick.
   * HTML is kept once written. An empty or rejected image does not wipe a picture already stored.
   */
  attachLook(id: string, look: ReviewLook | undefined): ReviewItem {
    const item = this.must(id)
    const next = cleanLook(look)
    if (!next || item.kind !== 'patch') return item
    const prev = item.look ?? {}
    const merged: ReviewLook = {
      beforeHtml: prev.beforeHtml || next.beforeHtml,
      afterHtml: prev.afterHtml || next.afterHtml,
      beforeImage: next.beforeImage || prev.beforeImage,
      afterImage: next.afterImage || prev.afterImage,
    }
    const beforePage = next.beforePage || prev.beforePage
    const afterPage = next.afterPage || prev.afterPage
    if (beforePage) merged.beforePage = beforePage
    if (afterPage) merged.afterPage = afterPage
    const same =
      prev.beforeHtml === merged.beforeHtml &&
      prev.afterHtml === merged.afterHtml &&
      prev.beforeImage === merged.beforeImage &&
      prev.afterImage === merged.afterImage &&
      prev.beforePage === merged.beforePage &&
      prev.afterPage === merged.afterPage
    if (same) return item
    item.look = merged
    this.save()
    return item
  }

  /** A Markdown review list a reader can follow without opening the page. */
  markdown(target: string): string {
    return reviewMarkdown(target, this.state.items, this.state.approvals)
  }

  /** One page of open notes for the local-agent API. Does not change status. */
  page(q: { scope: 'here' | 'all'; path: string; page: number; pageSize: number; host?: string }): ReviewPage {
    return pageReviewItems(this.state.items, q)
  }

  private must(id: string): ReviewItem {
    const item = this.get(id)
    if (!item) throw new Error(`no review item "${id}"`)
    return item
  }

  private save() {
    writeJsonAtomic(this.file, this.state)
    this.emit('change')
  }
}

export interface ReviewApiReply {
  author: string
  text: string
}

export interface ReviewApiItem {
  n: number
  kind: string
  path: string
  where: string
  say: string
  selector: string
  replies: ReviewApiReply[]
  before?: string
  after?: string
}

export interface ReviewPage {
  page: number
  pageSize: number
  total: number
  items: ReviewApiItem[]
}

const REVIEW_PAGE_MAX = 100

function whereOf(item: ReviewItem): string {
  const a = item.anchor
  const bits = [item.selector]
  if (item.label) bits.push(item.label)
  if (a?.tag) bits.push(`<${a.tag}>`)
  if (a?.id) bits.push(`#${a.id}`)
  if (a?.text) bits.push(a.text)
  return bits.join(' · ')
}

function beforeAfter(item: ReviewItem): { before?: string; after?: string } {
  const p = item.patch
  if (!p) return {}
  const before: string[] = []
  const after: string[] = []
  if (p.text !== undefined) {
    if (item.anchor?.text) before.push(item.anchor.text)
    after.push(p.text)
  }
  if (p.style && Object.keys(p.style).length) {
    const from = p.from ?? {}
    const keys = Object.keys(p.style)
    if (keys.some((k) => from[k] !== undefined)) before.push(keys.map((k) => `${k}: ${from[k] ?? ''}`).join('; '))
    after.push(keys.map((k) => `${k}: ${p.style![k]}`).join('; '))
  }
  if (p.attrs?.alt) after.push(`alt: ${p.attrs.alt}`)
  if (p.attrs?.src) after.push(p.attrs.src.startsWith('data:') ? '(uploaded image)' : p.attrs.src)
  return { before: before.length ? before.join('\n') : undefined, after: after.length ? after.join('\n') : undefined }
}

export function reviewApiItem(item: ReviewItem): ReviewApiItem {
  const out: ReviewApiItem = {
    n: item.n,
    kind: item.kind === 'patch' ? 'patch' : (item.severity ?? 'suggestion'),
    path: item.path,
    where: whereOf(item),
    say: item.note,
    selector: item.selector,
    replies: item.replies.map((r) => ({ author: r.author.name, text: r.text })),
  }
  const ba = beforeAfter(item)
  if (ba.before) out.before = ba.before
  if (ba.after) out.after = ba.after
  return out
}

/** Open notes in number order. scope=all puts `path` first. `host` limits the list to one site. Fetching is a pure read. */
export function pageReviewItems(items: ReviewItem[], q: { scope: 'here' | 'all'; path: string; page: number; pageSize: number; host?: string }): ReviewPage {
  const path = normalizePath(q.path || '/')
  const pageSize = Math.min(REVIEW_PAGE_MAX, Math.max(1, Math.floor(q.pageSize) || REVIEW_PAGE_SIZE))
  const page = Math.max(1, Math.floor(q.page) || 1)
  const filtering = q.host !== undefined
  const host = filtering ? normalizeHost(q.host ?? '') : ''
  const pool = filtering ? items.filter((i) => i.host === host) : items
  const open = pool.filter((i) => i.status === 'open' && (q.scope === 'all' || i.path === path))
  open.sort((a, b) => {
    if (q.scope === 'all') {
      const d = Number(a.path !== path) - Number(b.path !== path)
      if (d) return d
    }
    return a.n - b.n
  })
  const start = (page - 1) * pageSize
  return { page, pageSize, total: open.length, items: open.slice(start, start + pageSize).map(reviewApiItem) }
}
