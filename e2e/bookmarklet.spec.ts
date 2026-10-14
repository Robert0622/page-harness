/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const FIXTURE = 'http://127.0.0.1:5179'
const BOOKMARKLET = 'http://127.0.0.1:17988'
const NOAGENT = 'http://127.0.0.1:17986'
const btn = (page: Page, act: string) => page.locator(`page-harness-root .bar button[data-act="${act}"]`)
const ui = (page: Page, id: string) => page.locator(`page-harness-root [data-testid="${id}"]`)

async function up(url: string) {
  await expect.poll(async () => (await fetch(url).catch(() => null))?.status ?? 0, { timeout: 25_000 }).toBe(200)
}

async function shot(page: Page, name: string) {
  const dir = process.env.PH_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, name), fullPage: true })
}

async function pickAt(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('bookmarklet and review-only', () => {
  test('home page bookmarklet injects Pick and Notes on any page, grouped by site', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BOOKMARKLET })
    await up(`${BOOKMARKLET}/`)
    await page.goto(`${BOOKMARKLET}/`)
    await expect(page.locator('#bm')).toHaveText('✦ Page-Harness')
    await expect(page.locator('#hero-title')).toHaveText('Drag to your bookmarks bar')
    await expect(page.locator('#hero-sub')).toHaveText('Click it on any page to start marking.')
    await expect(page.locator('#tonotes')).toHaveText('My notes (0)')
    await expect(page.locator('#home')).toBeVisible()
    await expect(page.locator('#notes')).toBeHidden()
    await expect(page.locator('[data-testid="note"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="bookmarklet-source"]')).toHaveCount(0)
    await page.locator('#bm').dispatchEvent('dragstart')
    await expect(page.locator('#bar')).toHaveClass(/hot/)
    await page.locator('#bm').dispatchEvent('dragend')
    await expect(page.locator('#bar')).not.toHaveClass(/hot/)
    await page.locator('#help').click()
    await expect(page.locator('#modal')).toBeVisible()
    await expect(page.locator('#modal')).toContainText('127.0.0.1')
    await expect(page.locator('#modal')).toContainText('page-harness <url> --no-agent')
    await expect(page.locator('#modal')).toContainText('CSP')
    await page.locator('#modal').click({ position: { x: 8, y: 8 } })
    await expect(page.locator('#modal')).toBeHidden()
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/Inter Variable/)
    expect(await page.locator('.bm').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(123, 97, 255)')
    const boot = JSON.parse((await page.locator('#ph-boot').textContent()) ?? '{}') as { token: string; version: string }
    const localHref = await page.locator('#bm').getAttribute('href')
    expect(localHref).toMatch(/^javascript:/)
    expect(localHref).toContain(`${BOOKMARKLET}/__ph/overlay.js`)
    expect(localHref).toContain(boot.token)
    expect(localHref).not.toContain('jsdelivr')
    await shot(page, 'home-bookmarklet.png')

    await page.goto(`${FIXTURE}/`)
    await page.evaluate(
      ({ origin, token }) => {
        const w = window as Window & { __PH_CONFIG?: unknown; __phOverlay?: boolean }
        w.__PH_CONFIG = { controlOrigin: origin, bookmarklet: true, noAgent: true, token }
        const s = document.createElement('script')
        s.src = `${origin}/__ph/overlay.js`
        document.documentElement.appendChild(s)
      },
      { origin: BOOKMARKLET, token: boot.token },
    )
    await expect(btn(page, 'pick')).toBeEnabled()
    await expect(btn(page, 'chat')).toBeHidden()
    await expect(btn(page, 'artifacts')).toBeHidden()
    await expect(btn(page, 'eye')).toBeHidden()
    await expect(page.locator('page-harness-root [data-testid="review-host"]')).toContainText('127.0.0.1:5179')
    const inShadow = await page.evaluate(() => !!document.querySelector('page-harness-root')?.shadowRoot?.querySelector('.bar'))
    expect(inShadow).toBe(true)
    await page.addStyleTag({ content: 'button { background: rgb(255, 0, 0) !important; }' })
    await expect(btn(page, 'pick')).not.toHaveCSS('background-color', 'rgb(255, 0, 0)')

    await btn(page, 'pick').click()
    await pickAt(page, '.hero-title')
    await expect(ui(page, 'pick-actions').locator('button')).toHaveText(['Comment', 'Edit', '×'])
    await ui(page, 'pick-comment').click()
    await page.locator('page-harness-root .rv-form .save').click()
    await expect(page.locator('page-harness-root .toast.warn')).toContainText('A note needs text')
    await ui(page, 'review-comment').fill('Price is easy to miss')
    await page.locator('page-harness-root .rv-form .save').click()
    await expect(page.locator('page-harness-root .rv-pin')).toHaveCount(1)
    await shot(page, 'bookmarklet-on-site.png')
    await page.locator('page-harness-root .rv-pin').click()
    await page.locator('page-harness-root .rv-pop button.remove').click()
    await expect(page.locator('page-harness-root .rv-pop button.remove')).toHaveText('Click again to remove')
    await expect(page.locator('page-harness-root .rv-pin')).toHaveCount(1)
    await page.locator('page-harness-root .rv-pop button.x').click()

    await page.goto(`${BOOKMARKLET}/`)
    await expect(page.locator('#tonotes')).toHaveText('My notes (1)')
    await expect(page.locator('#home')).toBeVisible()
    await expect(page.locator('[data-testid="note"]')).toHaveCount(0)
    await page.locator('#tonotes').click()
    await expect(page.locator('#notes')).toBeVisible()
    await expect(page.locator('#home')).toBeHidden()
    await expect(page.locator('#tonotes')).toHaveText('← Home')
    await expect(page.locator('[data-testid="domain"]')).toContainText('127.0.0.1:5179')
    await expect(page.locator('[data-testid="note"]')).toContainText('Price is easy to miss')
    await page.locator('[data-testid="copy-prompt"]').click()
    await expect(page.locator('[data-testid="prompt"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="copy-prompt"]')).toHaveText('Copied')
    const prompt = await page.evaluate(() => navigator.clipboard.readText())
    expect(prompt).toContain('host=127.0.0.1')
    expect(prompt).toContain(`${BOOKMARKLET}/__ph/api/review?`)
    expect(prompt).not.toContain('Price is easy to miss')
    await expect(page.locator('[data-testid="copy-prompt"]')).toHaveText('Copy prompt', { timeout: 4000 })
    const downloadPromise = page.waitForEvent('download')
    await page.locator('[data-testid="export-md"]').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('review-')
    await shot(page, 'home-notes-by-site.png')
  })

  test('proxy --no-agent shows only Pick and Notes and stores the target host', async ({ page }) => {
    await up(`${NOAGENT}/__ph/overlay.js`)
    await page.goto(`${NOAGENT}/`)
    await expect(btn(page, 'pick')).toBeEnabled()
    await expect(btn(page, 'chat')).toBeHidden()
    await expect(btn(page, 'artifacts')).toBeHidden()
    await expect(btn(page, 'eye')).toBeHidden()
    await expect(page.locator('page-harness-root .drawer')).toBeHidden()
    await expect(page.locator('page-harness-root [data-testid="review-host"]')).toContainText('127.0.0.1:5179')
    await expect(page.locator('page-harness-root [data-testid="review-host"]')).not.toContainText('17986')

    await btn(page, 'pick').click()
    await pickAt(page, '.hero-title')
    await expect(ui(page, 'pick-quote')).toHaveCount(0)
    await expect(ui(page, 'pick-live')).toHaveCount(0)
    await ui(page, 'pick-comment').click()
    await ui(page, 'review-comment').fill('Proxy review note')
    await page.locator('page-harness-root .rv-form .save').click()
    await expect(page.locator('page-harness-root .rv-pin')).toHaveCount(1)
    await btn(page, 'review').click()
    await expect(page.locator('page-harness-root .rv-list')).toContainText('Proxy review note')
  })
})
