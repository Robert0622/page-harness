// Finds an annotated element again after the page changes. The selector is tried first and
// checked against a fingerprint (tag, id, stable classes, key attributes, text and its context);
// when it no longer fits, elements of the same tag are scored and the best match wins.
// Nothing above the thresholds means the item is shown as detached instead of guessing.
import type { ReviewAnchor } from '../../src/shared/protocol'

const DYNAMIC_CLASS = /^(css|sc|jsx|emotion|svelte|astro|data-v)-|[0-9a-f]{6,}|__[A-Za-z0-9]{5,}$|^_/
const KEY_ATTRS = ['aria-label', 'alt', 'title', 'name', 'href', 'src', 'role', 'data-testid', 'data-test', 'placeholder', 'type']
const TEXT_LEN = 80
const CONTEXT_LEN = 32
/** A selector hit is kept unless the fingerprint clearly says it is another element. */
export const SELECTOR_MIN = 0.35
/** A fuzzy match must be convincing on its own. */
export const FUZZY_MIN = 0.6
const MAX_CANDIDATES = 4000

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const textOf = (el: Element) => norm(el.textContent ?? '')

function stableClasses(el: Element): string[] {
  return [...el.classList].filter((c) => !DYNAMIC_CLASS.test(c) && c.length < 40).slice(0, 6)
}

export function anchorOf(el: Element): ReviewAnchor {
  const a: ReviewAnchor = { tag: el.tagName.toLowerCase(), vw: typeof innerWidth === 'number' ? innerWidth : undefined }
  if (el.id && !/\d{3,}/.test(el.id)) a.id = el.id
  const classes = stableClasses(el)
  if (classes.length) a.classes = classes
  const attrs: Record<string, string> = {}
  for (const k of KEY_ATTRS) {
    const v = el.getAttribute(k)
    if (v && v.length < 300) attrs[k] = v
  }
  if (Object.keys(attrs).length) a.attrs = attrs
  const text = textOf(el)
  if (text) {
    a.text = text.slice(0, TEXT_LEN)
    const parent = el.parentElement
    if (parent) {
      const all = textOf(parent)
      const at = all.indexOf(text.slice(0, 20))
      if (at > 0) a.prefix = all.slice(Math.max(0, at - CONTEXT_LEN), at)
      const after = at >= 0 ? all.slice(at + text.length, at + text.length + CONTEXT_LEN) : ''
      if (after) a.suffix = after
    }
  }
  return a
}

/** Sørensen–Dice similarity over character bigrams; robust to small copy edits. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const n = grams.get(g) ?? 0
    if (n > 0) {
      grams.set(g, n - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length + b.length - 2)
}

/**
 * How well an element fits an anchor, 0..1. `altTexts` are texts the element may legitimately
 * show instead (e.g. the replacement text of a patch that is currently applied).
 */
export function score(el: Element, a: ReviewAnchor, altTexts: string[] = []): number {
  if (el.tagName.toLowerCase() !== a.tag) return 0
  let got = 0
  let max = 0
  const add = (weight: number, value: number) => {
    max += weight
    got += weight * value
  }
  if (a.id) add(3, el.id === a.id ? 1 : 0)
  if (a.attrs)
    for (const [k, v] of Object.entries(a.attrs)) {
      const cur = el.getAttribute(k)
      add(k === 'href' || k === 'src' ? 1 : 2, cur === v ? 1 : cur ? similarity(cur, v) * 0.5 : 0)
    }
  if (a.text !== undefined) {
    const t = textOf(el).slice(0, TEXT_LEN)
    add(4, Math.max(similarity(t, a.text), ...altTexts.map((x) => similarity(t, norm(x).slice(0, TEXT_LEN)))))
    if (a.prefix || a.suffix) {
      const parent = el.parentElement ? textOf(el.parentElement) : ''
      const ctx = [a.prefix && parent.includes(a.prefix.slice(-12)) ? 1 : 0, a.suffix && parent.includes(a.suffix.slice(0, 12)) ? 1 : 0]
      add(1, (ctx[0] + ctx[1]) / ((a.prefix ? 1 : 0) + (a.suffix ? 1 : 0)))
    }
  }
  if (a.classes?.length) {
    const cur = new Set(stableClasses(el))
    add(1, a.classes.filter((c) => cur.has(c)).length / a.classes.length)
  }
  return max ? got / max : 1
}

export interface Located {
  el: Element
  how: 'selector' | 'fuzzy'
  score: number
}

export function locate(selector: string, a: ReviewAnchor | undefined, opts: { root?: Document; isOwn?: (el: Element) => boolean; altTexts?: string[] } = {}): Located | null {
  const doc = opts.root ?? document
  const own = opts.isOwn ?? (() => false)
  let hits: Element[] = []
  try {
    hits = [...doc.querySelectorAll(selector)].filter((el) => !own(el))
  } catch {}
  if (!a) return hits[0] ? { el: hits[0], how: 'selector', score: 1 } : null
  let best: Located | null = null
  for (const el of hits.slice(0, 50)) {
    const s = score(el, a, opts.altTexts)
    if (s >= SELECTOR_MIN && (!best || s > best.score)) best = { el, how: 'selector', score: s }
  }
  if (best && best.score >= FUZZY_MIN) return best
  const candidates = doc.getElementsByTagName(a.tag)
  let fuzzy: Located | null = null
  for (let i = 0; i < candidates.length && i < MAX_CANDIDATES; i++) {
    const el = candidates[i]
    if (own(el)) continue
    const s = score(el, a, opts.altTexts)
    if (s >= FUZZY_MIN && (!fuzzy || s > fuzzy.score)) fuzzy = { el, how: 'fuzzy', score: s }
  }
  if (fuzzy && (!best || fuzzy.score > best.score + 0.15)) return fuzzy
  return best
}
