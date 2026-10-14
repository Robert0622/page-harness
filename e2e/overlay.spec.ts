/// <reference lib="dom" />
import { expect, test } from '@playwright/test'
import { chat, CONTROL, dock, dockButton, openChat, send } from './helpers'

test.describe('page dock (overlay)', () => {
  test('mounts in shadow DOM with Pick / Artifacts / Chat; eye hidden without Live candidates', async ({ page }) => {
    await page.goto('/')
    await expect(dock(page)).toBeVisible()
    await expect(dockButton(page, 'pick')).toHaveText(/Pick/)
    await expect(dockButton(page, 'artifacts')).toHaveText(/Artifacts/)
    await expect(dockButton(page, 'chat')).toHaveText(/Chat/)
    await expect(dockButton(page, 'eye')).toBeHidden()
    const inShadow = await page.evaluate(() => !!document.querySelector('page-harness-root')?.shadowRoot?.querySelector('.bar'))
    expect(inShadow).toBe(true)
    await expect(dockButton(page, 'chat')).toBeEnabled()
  })

  test('remounts after the body is replaced and after pushState navigation', async ({ page }) => {
    await page.goto('/')
    await expect(dockButton(page, 'chat')).toBeEnabled()
    await page.evaluate(() => document.querySelector('page-harness-root')!.remove())
    await expect(dock(page)).toBeVisible()
    await page.locator('#about-link').click()
    await expect(page).toHaveURL(/\/about$/)
    await expect(dock(page)).toBeVisible()
  })

  test('chat drawer opens, remembers open state, and syncs theme', async ({ page }) => {
    await page.goto('/')
    await expect(dockButton(page, 'chat')).toBeEnabled()
    await dockButton(page, 'chat').click()
    const drawer = page.locator('page-harness-root .drawer')
    await expect(drawer).toBeVisible()
    await page.locator('page-harness-root .drawer .theme').click()
    await expect(page.locator('page-harness-root .ph')).toHaveAttribute('data-theme', 'dark')
    await expect(chat(page).locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.reload()
    await expect(drawer).toBeVisible()
    await page.locator('page-harness-root .drawer .theme').click()
    await expect(page.locator('page-harness-root .ph')).toHaveAttribute('data-theme', 'light')
  })

  test('drawer can be dragged and resized; position persists', async ({ page }) => {
    await page.goto('/')
    await expect(dockButton(page, 'chat')).toBeEnabled()
    const drawer = page.locator('page-harness-root .drawer')
    if (!(await drawer.isVisible())) await dockButton(page, 'chat').click()
    const before = (await drawer.boundingBox())!
    const bar = page.locator('page-harness-root .drawer .titlebar .brand')
    const b = (await bar.boundingBox())!
    await page.mouse.move(b.x + 5, b.y + 5)
    await page.mouse.down()
    await page.mouse.move(b.x - 95, b.y - 45, { steps: 5 })
    await page.mouse.up()
    const moved = (await drawer.boundingBox())!
    expect(Math.round(moved.x)).toBe(Math.round(before.x - 100))
    const se = page.locator('page-harness-root .drawer .rs-w')
    const s = (await se.boundingBox())!
    await page.mouse.move(s.x + 5, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(s.x - 55, s.y + s.height / 2, { steps: 5 })
    await page.mouse.up()
    const resized = (await drawer.boundingBox())!
    expect(Math.round(resized.width)).toBe(Math.round(moved.width + 60))
    await page.reload()
    await expect(drawer).toBeVisible()
    expect(Math.round((await drawer.boundingBox())!.width)).toBe(Math.round(resized.width))
  })

  test('drawer stays inside the viewport when dragged, resized or the window shrinks', async ({ page }) => {
    await page.goto('/')
    await expect(dockButton(page, 'chat')).toBeEnabled()
    const drawer = page.locator('page-harness-root .drawer')
    if (!(await drawer.isVisible())) await dockButton(page, 'chat').click()
    const vp = page.viewportSize()!
    const inside = async () => {
      const r = (await drawer.boundingBox())!
      const v = page.viewportSize()!
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(v.width + 0.5)
      expect(r.y + r.height).toBeLessThanOrEqual(v.height + 0.5)
      return r
    }
    const bar = page.locator('page-harness-root .drawer .titlebar .brand')
    for (const [dx, dy] of [[2000, 0], [-3000, 0], [0, 2000], [0, -3000]]) {
      const b = (await bar.boundingBox())!
      await page.mouse.move(b.x + 5, b.y + 5)
      await page.mouse.down()
      await page.mouse.move(b.x + 5 + dx, b.y + 5 + dy, { steps: 4 })
      await page.mouse.up()
      await inside()
    }
    const before = await inside()
    const e = (await page.locator('page-harness-root .drawer .rs-e').boundingBox())!
    await page.mouse.move(e.x + 3, e.y + e.height / 2)
    await page.mouse.down()
    await page.mouse.move(e.x + 3000, e.y + e.height / 2, { steps: 4 })
    await page.mouse.up()
    const r = await inside()
    expect(Math.round(r.x)).toBe(Math.round(before.x))
    await page.setViewportSize({ width: 700, height: 500 })
    await expect
      .poll(async () => {
        const b = (await drawer.boundingBox())!
        return b.x + b.width <= 700.5 && b.y + b.height <= 500.5
      })
      .toBe(true)
    await inside()
    await page.setViewportSize(vp)
  })

  test('pick mode quotes elements into the composer from the action bar; Esc exits', async ({ page }) => {
    const c = await openChat(page)
    await c.locator('[data-testid="settings"]').click()
    const live = c.locator('[data-testid="toggle-live"]')
    if (await live.isChecked()) await live.uncheck()
    await c.locator('[data-testid="settings"]').click()
    await dockButton(page, 'pick').click()
    await expect(dockButton(page, 'pick')).toHaveClass(/on/)
    const h = (await page.locator('.hero-title').boundingBox())!
    await page.mouse.move(h.x + 20, h.y + h.height / 2)
    await expect(page.locator('page-harness-root .hl')).toBeVisible()
    await page.mouse.click(h.x + 20, h.y + h.height / 2)
    const bar = page.locator('page-harness-root [data-testid="pick-actions"]')
    await expect(bar.locator('button')).toHaveText(['Quote in chat', 'Comment', '×'])
    await bar.locator('[data-testid="pick-quote"]').click()
    await expect(c.locator('.chip.draft')).toContainText('Hello fixture')
    await expect(bar).toBeHidden()
    await expect(dockButton(page, 'pick')).toHaveClass(/on/)
    await page.keyboard.press('Escape')
    await expect(dockButton(page, 'pick')).not.toHaveClass(/on/)
    await send(c, 'make it bigger')
    await expect(c.locator('.turn .bubble .chip')).toContainText('Hello fixture')
    await expect(c.locator('.turn .md').last()).toContainText('Echo: make it bigger')
  })

  test('a long picked element keeps its remove button visible and removable', async ({ page }) => {
    const c = await openChat(page)
    await c.locator('[data-testid="settings"]').click()
    const live = c.locator('[data-testid="toggle-live"]')
    if (await live.isChecked()) await live.uncheck()
    await c.locator('[data-testid="settings"]').click()
    await page.evaluate(() => {
      document.querySelector('.hero-title')!.textContent = 'Very long heading text '.repeat(30)
    })
    await dockButton(page, 'pick').click()
    const h = (await page.locator('.hero-title').boundingBox())!
    await page.mouse.move(h.x + 20, h.y + 10)
    await expect(page.locator('page-harness-root .hl')).toBeVisible()
    await page.keyboard.down('Shift')
    await page.mouse.click(h.x + 20, h.y + 10)
    await page.keyboard.up('Shift')
    await page.keyboard.press('Escape')
    const chip = c.locator('.chip.draft')
    await expect(chip).toHaveCount(1)
    const remove = chip.locator('[data-testid="remove-draft"]')
    await expect(remove).toBeVisible()
    const cb = (await chip.boundingBox())!
    const rb = (await remove.boundingBox())!
    expect(rb.width).toBeGreaterThan(0)
    expect(rb.x).toBeGreaterThanOrEqual(cb.x - 0.5)
    expect(rb.x + rb.width).toBeLessThanOrEqual(cb.x + cb.width + 0.5)
    await remove.click()
    await expect(chip).toHaveCount(0)
  })

  test('the page cannot read the control API (separate origin)', async ({ page }) => {
    await page.goto('/')
    const r = await page.evaluate(async (url) => {
      try {
        const res = await fetch(`${url}/__ph/api/chats`, { credentials: 'include' })
        return res.status
      } catch {
        return 'blocked'
      }
    }, CONTROL)
    expect(r === 'blocked' || r === 403).toBe(true)
    const same = await page.evaluate(async () => (await fetch('/__ph/api/chats')).status)
    expect(same).not.toBe(200)
  })
})
