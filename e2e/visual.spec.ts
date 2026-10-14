import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { CONTROL, dockButton, openChat, parkChat, PROJECT, projectFile, resetFixture, send } from './helpers'

// Captures every surface in both themes for manual review: e2e/.tmp/screens/*.png
const OUT = path.join(PROJECT, '..', 'screens')
mkdirSync(OUT, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' })

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    test.describe(`screens ${theme} ${locale}`, () => {
      test.use({ locale })
      test.beforeEach(async ({ page }) => {
        resetFixture()
        await page.addInitScript((t) => localStorage.setItem('ph:theme', location.port === '17980' ? JSON.stringify(t) : t), theme)
      })
      const tag = `${theme}-${locale.slice(0, 2)}`

      test('chat', async ({ page }) => {
        const c = await openChat(page)
        await shot(page, `${tag}-01-chat-empty`)
        await send(c, '[fake:think] [fake:edit] [fake:artifact] Make the **hero** title bigger and add a `subtitle`')
        await c.locator('.turn .foot .st').last().waitFor()
        await send(c, '[fake:ask] which color')
        await c.locator('.ask.card').waitFor()
        await shot(page, `${tag}-02-chat-turns`)
        await c.locator('.ask.card .opt').first().click()
        await c.locator('.ask.card .foot .primary').click()
        await send(c, '[fake:slow] long one')
        await send(c, 'queued message one')
        await send(c, 'queued message two')
        await c.locator('.queue').waitFor()
        await expect(c.locator('.indicator')).toBeInViewport()
        await shot(page, `${tag}-03-chat-queue`)
        await c.locator('.composer .btn.danger').click()
        await c.locator('[data-testid="settings"]').click()
        await shot(page, `${tag}-04-settings`)
        await c.locator('[data-testid="toggle-control"]').check()
        await page.locator('page-harness-root .banner').waitFor()
        await shot(page, `${tag}-05-control-on`)
        await c.locator('[data-testid="settings"]').click()
        await c.locator('[data-testid="chat-switcher"]').click()
        await shot(page, `${tag}-06-switcher`)
        await c.locator('[data-testid="chat-switcher"]').click()
        await c.locator('[data-testid="model-pill"]').click()
        await c.locator('[data-testid="model-picker"]').waitFor()
        await shot(page, `${tag}-07-model-picker`)
        await c.locator('[data-testid="agent-trigger"]').click()
        await shot(page, `${tag}-07b-agent-list`)
        const missing = c.locator('[data-testid="agent-option"].off').first()
        if (await missing.count()) {
          await missing.click()
          await c.locator('[data-testid="agent-hint"]').waitFor()
          await shot(page, `${tag}-08-agent-hint`)
        }
        await page.keyboard.press('Escape')
      })

      test('artifacts', async ({ page }) => {
        const c = await openChat(page)
        await send(c, '[fake:artifact] [fake:html] [fake:json] write things')
        await c.locator('.turn .foot .st').last().waitFor()
        await dockButton(page, 'artifacts').click()
        const a = page.frameLocator('iframe[title="Page Harness artifacts"]')
        await a.locator('.tile').first().waitFor()
        await page.waitForTimeout(300)
        await shot(page, `${tag}-10-artifacts-grid`)
        await a.locator('.tile[data-artifact="report.md"]').click()
        await a.locator('.doc h1').waitFor()
        await shot(page, `${tag}-11-artifact-md`)
        await a.locator('[data-testid="tab-all"]').click()
        await a.locator('.tile[data-artifact="mock.html"]').click()
        await a.frameLocator('.frame-box iframe').locator('#m').waitFor()
        await shot(page, `${tag}-12-artifact-html`)
        await a.locator('[data-testid="tab-all"]').click()
        await a.locator('.tile[data-artifact="data.json"]').click()
        await page.waitForTimeout(300)
        await shot(page, `${tag}-13-artifact-json`)
      })

      test('live', async ({ page }) => {
        await openChat(page)
        await dockButton(page, 'pick').click()
        await page.locator('page-harness-root .lv-pickbar').waitFor()
        const h = (await page.locator('.hero-title').boundingBox())!
        await page.mouse.move(h.x + 20, h.y + h.height / 2)
        await shot(page, `${tag}-20-pick-hover`)
        await page.mouse.click(h.x + 20, h.y + h.height / 2)
        await page.locator('page-harness-root [data-testid="pick-actions"]').waitFor()
        await shot(page, `${tag}-21-pick-pop`)
        await page.locator('page-harness-root [data-testid="pick-live"]').click()
        await page.locator('page-harness-root .lv-design').waitFor()
        await shot(page, `${tag}-22-design`)
        await parkChat(page)
        await page.locator('page-harness-root .lv-design .lv-foot button.primary').click()
        await page.locator('[data-ph-variant="1"]').waitFor({ timeout: 15_000 })
        await page.locator('page-harness-root .lv-ctrl .idx').waitFor()
        await page.waitForTimeout(300)
        await shot(page, `${tag}-23-live-ready`)
        await page.locator('page-harness-root .lv-ctrl button', { hasText: /›/ }).click()
        await page.locator('page-harness-root .lv-ctrl button', { hasText: /Tune|参数/ }).click()
        await shot(page, `${tag}-24-live-params`)
        await page.locator('page-harness-root .lv-params .lv-foot button').click()
        await page.locator('page-harness-root .lv-ctrl button', { hasText: /Side by side|并排/ }).click()
        await page.waitForTimeout(200)
        await shot(page, `${tag}-25-live-compare`)
        await page.locator('page-harness-root .lv-ctrl button', { hasText: /Discard|放弃/ }).click()
        await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
      })

      test('history', async ({ page }) => {
        const c = await openChat(page)
        await send(c, '[fake:artifact] history sample with a searchable word zebra')
        await c.locator('.turn .foot .st').last().waitFor()
        await page.goto(`${CONTROL}/__ph/history`)
        await page.locator('.item').first().click()
        await page.locator('.turn').first().waitFor()
        await shot(page, `${tag}-30-history`)
        await page.locator('[data-testid="history-search"]').fill('zebra')
        await page.locator('.item.hit').first().waitFor()
        await shot(page, `${tag}-31-history-search`)
      })
    })
  }
}
