/** Plan coverage: g1.1 g1.2 — drawer z-index source and document order. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_CSS } from '../client/live-overlay/style'
import { OVERLAY_CSS } from '../client/overlay/style'

function zOf(css: string, selector: string): number {
  const re = new RegExp(`${selector}[^{]*\\{[^}]*?z-index:\\s*(\\d+)`)
  const m = css.match(re)
  if (!m) throw new Error(`no z-index for ${selector}`)
  return Number(m[1])
}

describe('chat drawer source order (g1.1, g1.2)', () => {
  it('keeps the drawer at the max z-index and last among harness siblings', () => {
    expect(zOf(OVERLAY_CSS, '\\.drawer')).toBe(2147483647)
    expect(zOf(OVERLAY_CSS, '\\.banner')).toBe(2147483647)
    expect(zOf(OVERLAY_CSS, '\\.pick-hint')).toBe(2147483647)
    expect(zOf(OVERLAY_CSS, '\\.dock')).toBe(2147483646)
    expect(zOf(OVERLAY_CSS, '\\.art-mask')).toBe(2147483645)
    expect(zOf(OVERLAY_CSS, '\\.rv-pop')).toBe(2147483646)
    expect(zOf(OVERLAY_CSS, '\\.pick-actions')).toBe(2147483646)
    expect(zOf(LIVE_CSS, '\\.lv-card')).toBe(2147483646)

    const src = readFileSync(path.resolve('client/overlay/index.ts'), 'utf8')
    const html = src.slice(src.indexOf('ph.innerHTML'), src.indexOf('root.appendChild(ph)'))
    const at = (marker: string) => html.indexOf(marker)
    const drawer = at('class="drawer win"')
    expect(drawer).toBeGreaterThan(at('class="banner"'))
    expect(drawer).toBeGreaterThan(at('class="layer"'))
    expect(drawer).toBeGreaterThan(at('class="art-mask"'))
    expect(drawer).toBeGreaterThan(at('class="dock"'))
  })
})
