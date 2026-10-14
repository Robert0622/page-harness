// Temporary page changes (text, inline CSS, image src/alt) keyed by an id. Each change remembers
// what it replaced so it can be reverted exactly, and is re-applied when the page re-renders the
// element or overwrites the change, up to a limit so a page that fights back cannot loop forever.
import type { ReviewPatch } from '../../src/shared/protocol'

interface Applied {
  el: HTMLElement
  style: Record<string, [string, string]>
  /** Style values as the browser serialises them (e.g. colours become rgb()). */
  shown: Record<string, string>
  children?: Node[]
  applied?: string
  attrs?: Record<string, string | null>
}

const MAX_REAPPLY = 50

export type Patcher = ReturnType<typeof createPatcher>

export function createPatcher() {
  const applied = new Map<string, Applied>()
  const tries = new Map<string, number>()

  const bump = (key: string) => {
    const n = (tries.get(key) ?? 0) + 1
    tries.set(key, n)
    return n <= MAX_REAPPLY
  }
  const apply = (key: string, el: HTMLElement, p: ReviewPatch) => {
    const a: Applied = { el, style: {}, shown: {} }
    for (const [k, v] of Object.entries(p.style ?? {})) {
      a.style[k] = [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]
      el.style.setProperty(k, v, 'important')
      a.shown[k] = el.style.getPropertyValue(k)
    }
    if (p.text !== undefined) {
      a.children = [...el.childNodes]
      el.textContent = p.text
      a.applied = el.innerHTML
    }
    if (p.attrs) {
      a.attrs = {}
      const set = (k: string, v: string | undefined) => {
        if (v === undefined) return
        a.attrs![k] = el.getAttribute(k)
        el.setAttribute(k, v)
      }
      if (p.attrs.src !== undefined) {
        a.attrs.srcset = el.getAttribute('srcset')
        el.removeAttribute('srcset')
      }
      set('src', p.attrs.src)
      set('alt', p.attrs.alt)
    }
    applied.set(key, a)
  }
  const revert = (key: string) => {
    const a = applied.get(key)
    if (!a) return
    applied.delete(key)
    if (!a.el.isConnected) return
    for (const [k, [v, prio]] of Object.entries(a.style)) {
      if (v) a.el.style.setProperty(k, v, prio)
      else a.el.style.removeProperty(k)
    }
    if (a.children) a.el.replaceChildren(...a.children)
    for (const [k, v] of Object.entries(a.attrs ?? {})) {
      if (v === null) a.el.removeAttribute(k)
      else a.el.setAttribute(k, v)
    }
  }

  return {
    /** The element a change is applied to, while it is still on the page. */
    elOf(key: string): HTMLElement | undefined {
      const a = applied.get(key)
      return a?.el.isConnected ? a.el : undefined
    },
    /**
     * Makes sure `p` is shown: applies it on the element `find` returns when it is not applied
     * (or the element was replaced), and puts back parts the page overwrote. Returns the element.
     */
    ensure(key: string, p: ReviewPatch, find: () => HTMLElement | null): HTMLElement | null {
      const a = applied.get(key)
      if (!a || !a.el.isConnected) {
        applied.delete(key)
        const el = find()
        if (el && bump(key)) apply(key, el, p)
        return el
      }
      const st = a.el.style
      for (const [k, v] of Object.entries(p.style ?? {}))
        if ((st.getPropertyValue(k) !== a.shown[k] || st.getPropertyPriority(k) !== 'important') && bump(key)) {
          st.setProperty(k, v, 'important')
          a.shown[k] = st.getPropertyValue(k)
        }
      if (a.applied !== undefined && a.el.innerHTML !== a.applied && bump(key)) {
        a.children = [...a.el.childNodes]
        a.el.textContent = p.text ?? ''
        a.applied = a.el.innerHTML
      }
      const src = p.attrs?.src
      if (src !== undefined && (a.el.getAttribute('src') !== src || a.el.hasAttribute('srcset')) && bump(key)) {
        a.el.removeAttribute('srcset')
        a.el.setAttribute('src', src)
      }
      if (p.attrs?.alt !== undefined && a.el.getAttribute('alt') !== p.attrs.alt && bump(key)) a.el.setAttribute('alt', p.attrs.alt)
      return a.el
    },
    revert,
    /** Reverts every change on `el` (e.g. before editing it by hand), newest first. */
    revertOn(el: Element) {
      for (const [key, a] of [...applied].reverse()) if (a.el === el) revert(key)
    },
    /** Reverts changes whose key fails `keep`, and forgets their retry counts. */
    prune(keep: (key: string) => boolean) {
      for (const key of [...applied.keys()].reverse()) if (!keep(key)) revert(key)
      for (const key of [...tries.keys()]) if (!keep(key)) tries.delete(key)
    },
  }
}
