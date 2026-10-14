// DOM helpers shared by the page scripts.
import type { ElementDescribe, Pick } from '@shared/protocol'

const DYNAMIC_CLASS = /^(css|sc|jsx|emotion|svelte|astro|data-v)-|[0-9a-f]{6,}|__[A-Za-z0-9]{5,}$|^_/

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`)
}

function stableClasses(el: Element): string[] {
  return [...el.classList].filter((c) => !DYNAMIC_CLASS.test(c) && c.length < 40).slice(0, 3)
}

/** A short, reasonably stable CSS selector for an element. */
export function selectorFor(el: Element): string {
  const doc = el.ownerDocument
  if (el.id && !/\d{3,}/.test(el.id)) {
    const sel = `#${cssEscape(el.id)}`
    try {
      if (doc.querySelectorAll(sel).length === 1) return sel
    } catch {}
  }
  const parts: string[] = []
  let cur: Element | null = el
  for (let depth = 0; cur && cur !== doc.documentElement && depth < 6; depth++) {
    let part = cur.tagName.toLowerCase()
    if (cur.id && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`)
      break
    }
    const cls = stableClasses(cur)
    if (cls.length) part += cls.map((c) => `.${cssEscape(c)}`).join('')
    const parent: Element | null = cur.parentElement
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    const sel = parts.join(' > ')
    try {
      if (doc.querySelectorAll(sel).length === 1) return sel
    } catch {}
    cur = parent
  }
  return parts.join(' > ')
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const BLANK = /^[ \t\n\r\f]*$/

/**
 * Text as a reader sees it, by the rendered text from innerText. Headings split into one element per character
 * (animated hero text) come back from innerText one character per line, which reads as "S k i l l"; those are
 * rebuilt from their text nodes instead, dropping the whitespace between flex/grid items that never renders.
 */
export function textOf(el: Element): string {
  const inner = squash((el as HTMLElement).innerText ?? el.textContent ?? '')
  const words = inner.split(' ')
  if (words.length < 4 || words.filter((w) => [...w].length === 1).length / words.length < 0.6) return inner
  const joined = squash(joinedText(el))
  return joined.replace(/\s/g, '') === inner.replace(/\s/g, '') ? joined : inner
}

function joinedText(root: Element): string {
  let out = ''
  const walk = (node: Element) => {
    const display = getComputedStyle(node).display
    const itemsBox = /flex|grid/.test(display)
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        const v = c.nodeValue ?? ''
        out += BLANK.test(v) ? (itemsBox ? '' : ' ') : v
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const d = getComputedStyle(c as Element).display
        if (d === 'none') continue
        const block = !d.startsWith('inline') && d !== 'contents' && !itemsBox
        if (block) out += ' '
        walk(c as Element)
        if (block) out += ' '
      }
    }
  }
  walk(root)
  return out
}

/** True when any part of the rect is inside the viewport. */
export function inViewport(r: DOMRect): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && (r.width > 0 || r.height > 0)
}

/**
 * Places a fixed card beside an element's rect: to the right, else left, else below, else above, preferring spots
 * that keep clear of `avoid` (e.g. the chat window). Below/above slide sideways to get past those. When nothing
 * fits it takes the side with more room and stays inside the viewport; the card never jumps to a corner.
 */
export function placeBeside(card: HTMLElement, r: DOMRect, opts: { gap?: number; margin?: number; avoid?: DOMRect[] } = {}): void {
  const gap = opts.gap ?? 12
  const m = opts.margin ?? 12
  const vw = innerWidth
  const vh = innerHeight
  const cw = Math.min(card.offsetWidth || 320, vw - m * 2)
  const ch = Math.min(card.offsetHeight || 200, vh - m * 2)
  const avoid = (opts.avoid ?? []).filter((a) => a.width > 0 && a.height > 0)
  const clampX = (x: number) => Math.min(Math.max(m, x), vw - cw - m)
  const clampY = (y: number) => Math.min(Math.max(m, y), vh - ch - m)
  const fits = (x: number, y: number) => x >= m - 0.5 && y >= m - 0.5 && x + cw <= vw - m + 0.5 && y + ch <= vh - m + 0.5
  const hits = (x: number, y: number) => avoid.some((a) => x < a.right && x + cw > a.left && y < a.bottom && y + ch > a.top)
  // Sideways positions for a card above/below: aligned with the element, then just past each obstacle.
  const slides = (y: number) => [clampX(r.left), ...avoid.flatMap((a) => (y < a.bottom && y + ch > a.top ? [clampX(a.right + gap), clampX(a.left - gap - cw)] : []))]
  const below = r.bottom + gap
  const above = r.top - gap - ch
  const spots: Array<[number, number]> = [
    [r.right + gap, clampY(r.top)],
    [r.left - gap - cw, clampY(r.top)],
    ...slides(below).map((x): [number, number] => [x, below]),
    ...slides(above).map((x): [number, number] => [x, above]),
  ]
  const spot =
    spots.find(([x, y]) => fits(x, y) && !hits(x, y)) ??
    spots.find(([x, y]) => fits(x, y)) ?? [clampX(r.left), clampY(vh - r.bottom > r.top ? below : above)]
  card.style.left = `${Math.round(spot[0])}px`
  card.style.top = `${Math.round(spot[1])}px`
}

/**
 * Calls `update` at most once per frame while the page or any nested scroller scrolls, the window resizes, or a
 * watched element changes size. Returns a function that stops following.
 */
export function followLayout(update: () => void, watch: Element[] = []): () => void {
  let raf = 0
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), update()))
  }
  addEventListener('scroll', schedule, { capture: true, passive: true })
  addEventListener('resize', schedule)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
  for (const el of watch) ro?.observe(el)
  return () => {
    removeEventListener('scroll', schedule, { capture: true })
    removeEventListener('resize', schedule)
    ro?.disconnect()
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }
}

/** outerHTML with password values removed. */
export function safeOuterHTML(el: Element): string {
  const clone = el.cloneNode(true) as Element
  const inputs = clone.matches?.('input[type=password]') ? [clone] : [...clone.querySelectorAll('input[type=password]')]
  for (const i of inputs) i.removeAttribute('value')
  return clone.outerHTML
}

export function pickOf(el: Element): Pick {
  return {
    id: Math.random().toString(36).slice(2, 10),
    selector: selectorFor(el),
    tagName: el.tagName,
    text: clip(textOf(el), 120),
    outerHTML: clip(safeOuterHTML(el), 1024),
    url: location.href,
    ts: Date.now(),
  }
}

const STYLE_KEYS = [
  'display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'text-align', 'padding', 'margin', 'gap', 'border', 'border-radius', 'box-shadow', 'width', 'height',
  'flex-direction', 'justify-content', 'align-items', 'grid-template-columns',
]

export function describe(el: Element): ElementDescribe {
  const cs = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const k of STYLE_KEYS) {
    const v = cs.getPropertyValue(k)
    if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[k] = v
  }
  return {
    selector: selectorFor(el),
    tagName: el.tagName,
    id: el.id || undefined,
    classes: [...el.classList],
    text: clip(textOf(el), 300),
    outerHTML: clip(safeOuterHTML(el), 6000),
    styles,
    url: location.href,
  }
}

export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Makes a fixed-position window draggable by `handle` and resizable from 8 directions. */
export function makeWindow(
  win: HTMLElement,
  handle: HTMLElement,
  opts: { minW: number; minH: number; onChange(r: { x: number; y: number; w: number; h: number }): void },
): void {
  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  for (const d of dirs) {
    const h = document.createElement('div')
    h.className = `rs rs-${d}`
    h.dataset.dir = d
    win.appendChild(h)
  }
  const rect = () => {
    const r = win.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  const apply = (r: { x: number; y: number; w: number; h: number }, resizing = '') => {
    const vw = document.documentElement.clientWidth || innerWidth
    const vh = document.documentElement.clientHeight || innerHeight
    if (resizing) {
      // Edges being dragged stop at the viewport instead of pushing the window along.
      if (resizing.includes('w') && r.x < 0) {
        r.w += r.x
        r.x = 0
      }
      if (resizing.includes('n') && r.y < 0) {
        r.h += r.y
        r.y = 0
      }
      if (resizing.includes('e')) r.w = Math.min(r.w, vw - r.x)
      if (resizing.includes('s')) r.h = Math.min(r.h, vh - r.y)
    }
    r.w = Math.min(Math.max(opts.minW, r.w), vw)
    r.h = Math.min(Math.max(opts.minH, r.h), vh)
    r.x = Math.max(0, Math.min(r.x, vw - r.w))
    r.y = Math.max(0, Math.min(r.y, vh - r.h))
    Object.assign(win.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, right: 'auto', bottom: 'auto' })
    return r
  }
  const start = (e: PointerEvent, dir: string | null) => {
    if (e.button !== 0) return
    e.preventDefault()
    const s = rect()
    const sx = e.clientX
    const sy = e.clientY
    win.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const r = { ...s }
      if (!dir) {
        r.x += dx
        r.y += dy
      } else {
        if (dir.includes('e')) r.w = s.w + dx
        if (dir.includes('s')) r.h = s.h + dy
        if (dir.includes('w')) {
          r.w = Math.max(opts.minW, s.w - dx)
          r.x = s.x + s.w - r.w
        }
        if (dir.includes('n')) {
          r.h = Math.max(opts.minH, s.h - dy)
          r.y = s.y + s.h - r.h
        }
      }
      apply(r, dir ?? '')
    }
    const up = () => {
      win.classList.remove('dragging')
      removeEventListener('pointermove', move, true)
      removeEventListener('pointerup', up, true)
      opts.onChange(rect())
    }
    addEventListener('pointermove', move, true)
    addEventListener('pointerup', up, true)
  }
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    start(e, null)
  })
  win.addEventListener('pointerdown', (e) => {
    const d = (e.target as HTMLElement).dataset?.dir
    if (d) start(e, d)
  })
  ;(win as HTMLElement & { __apply?: typeof apply }).__apply = apply
  let pending = 0
  addEventListener('resize', () => {
    if (win.hidden || pending) return
    pending = requestAnimationFrame(() => {
      pending = 0
      const before = rect()
      if (!before.w || !before.h) return
      const after = apply({ ...before })
      if (after.x !== before.x || after.y !== before.y || after.w !== before.w || after.h !== before.h) opts.onChange(after)
    })
  })
}

export function placeWindow(win: HTMLElement, r: { x: number; y: number; w: number; h: number }) {
  ;(win as HTMLElement & { __apply?: (r: { x: number; y: number; w: number; h: number }) => unknown }).__apply?.({ ...r })
}
