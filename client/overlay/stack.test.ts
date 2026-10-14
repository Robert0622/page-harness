/**
 * @vitest-environment happy-dom
 * Plan coverage: g1.1 g1.2 g2.1 — computed chat drawer stacking.
 */
import { describe, expect, it } from 'vitest'
import { LIVE_CSS } from '../live-overlay/style'
import { OVERLAY_CSS } from './style'

describe('chat drawer stacking (g1, g2)', () => {

  it('computes the drawer above live cards, the dock, the banner and the pick hint (g1.1, g2.1)', () => {
    const style = document.createElement('style')
    style.textContent = `${OVERLAY_CSS}\n${LIVE_CSS}`
    const ph = document.createElement('div')
    ph.className = 'ph'
    ph.innerHTML = `
      <div class="banner" style="left:0;top:0;width:140px;height:36px">banner</div>
      <div class="layer">
        <div class="pick-hint" style="left:0;top:0;width:140px;height:28px">hint</div>
        <div class="lv-card" style="left:16px;top:70px;width:120px;height:36px">生成中</div>
      </div>
      <div class="art-mask">
        <div class="art win" style="left:0;top:0;width:240px;height:200px">art</div>
      </div>
      <div class="dock" style="left:280px;top:16px;width:80px;height:36px"><button type="button">dock</button></div>
      <div class="drawer win" style="left:0;top:0;width:200px;height:160px">chat</div>`
    document.body.append(style, ph)

    const z = (sel: string) => Number(getComputedStyle(ph.querySelector(sel)!).zIndex)
    // .drawer overrides .win; the used value is the max, not 2147483643.
    expect(z('.drawer.win')).toBe(2147483647)
    expect(z('.drawer')).toBeGreaterThanOrEqual(z('.lv-card'))
    expect(z('.drawer')).toBeGreaterThanOrEqual(z('.dock'))
    expect(z('.drawer')).toBeGreaterThanOrEqual(z('.banner'))
    expect(z('.drawer')).toBeGreaterThanOrEqual(z('.pick-hint'))
    expect(z('.lv-card')).toBe(2147483646)
    expect(z('.dock')).toBe(2147483646)
    expect(z('.art-mask')).toBe(2147483645)
    expect(z('.banner')).toBe(2147483647)
    expect(z('.pick-hint')).toBe(2147483647)
  })
})
