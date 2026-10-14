// A self-contained HTML copy of an element, with computed styles inlined, so a review card can
// show the before/after after the element is gone. No images: the overlay adds those separately.

const PROPS = [
  'display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-decoration-line', 'padding', 'margin',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow',
  'width', 'height', 'max-width', 'transform', 'list-style', 'list-style-type', 'opacity', 'white-space', 'gap',
]

const SKIP = new Set(['normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static'])
// `none` is the whole point of list-style and text-decoration (bullets removed, underline gone).
const KEEP_NONE = new Set(['list-style', 'list-style-type', 'text-decoration', 'text-decoration-line'])
const MAX_NODES = 48

/** The list element, when the change is on a list item, so the shot shows the whole ramp. */
export function shotElement(el: HTMLElement): HTMLElement {
  if (el.tagName === 'LI' || el.closest('li')) {
    const list = el.closest('ul, ol')
    if (list instanceof HTMLElement) return list
  }
  return el
}

export function snapshotHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  const src = [el, ...el.querySelectorAll('*')].slice(0, MAX_NODES)
  const dst = [clone, ...clone.querySelectorAll('*')]
  for (let i = 0; i < src.length; i++) {
    const s = src[i]
    const d = dst[i]
    if (!(s instanceof HTMLElement) || !(d instanceof HTMLElement)) continue
    const cs = getComputedStyle(s)
    const bits: string[] = []
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p)
      if (!v || SKIP.has(v)) continue
      if (v === 'none' && !KEEP_NONE.has(p)) continue
      bits.push(`${p}: ${v}`)
    }
    if (s instanceof HTMLImageElement && (s.currentSrc || s.src)) (d as HTMLImageElement).src = s.currentSrc || s.src
    if (bits.length) d.setAttribute('style', bits.join('; '))
  }
  clone.querySelectorAll('script, iframe, object').forEach((n) => n.remove())
  const html = clone.outerHTML
  return html.length > 40_000 ? html.slice(0, 40_000) : html
}
