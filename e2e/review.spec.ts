/// <reference lib="dom" />
import { expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifacts, chat, parkChat, send } from './helpers'

const REVIEW = 'http://localhost:17984'
const REVIEW_CONTROL = 'http://localhost:17985'
const REVIEW_PROJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', 'review-project')
const btn = (page: Page, act: string) => page.locator(`page-harness-root .bar button[data-act="${act}"]`)
const pins = (page: Page) => page.locator('page-harness-root .rv-pin')
const list = (page: Page) => page.locator('page-harness-root .rv-list')
const ui = (page: Page, id: string) => page.locator(`page-harness-root [data-testid="${id}"]`)
const SUB = 'A tiny app to drive the e2e suite.'

async function pickAt(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function ready() {
  await expect.poll(async () => (await fetch(`${REVIEW}/__ph/overlay.js`).catch(() => null))?.status ?? 0, { timeout: 20_000 }).toBe(200)
}

async function open(page: Page, fresh = true) {
  await ready()
  await page.goto(`${REVIEW}/`)
  await expect(btn(page, 'chat')).toBeEnabled()
  if (!(await page.locator('page-harness-root .drawer').isVisible())) await btn(page, 'chat').click()
  const c = chat(page)
  await expect(c.locator('textarea')).toBeVisible()
  if (fresh) {
    await c.locator('[data-testid="chat-switcher"]').click()
    await c.locator('[data-testid="new-chat"]').click()
    await expect(c.locator('.empty')).toBeVisible()
  }
  // Chat paints above review pins and the notes list. Park it so those controls stay usable (g2.2).
  await parkChat(page)
  return c
}

async function clearAll(page: Page) {
  await parkChat(page)
  if (!(await list(page).isVisible())) await btn(page, 'review').click()
  const clear = list(page).locator('.clear')
  if (await clear.isEnabled()) {
    await clear.click()
    await clear.click()
  }
  await expect(pins(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
}

async function reviewer(browser: Browser) {
  const team = JSON.parse(readFileSync(path.join(REVIEW_PROJECT, '.page-harness', 'team.json'), 'utf8')) as { invite: string }
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${REVIEW_CONTROL}/__ph/join?t=${team.invite}`)
  await expect(page).toHaveURL(`${REVIEW}/`)
  return { ctx, page }
}

test.describe('review mode (no source)', () => {
  test('explains the mode; Live stays available as page changes', async ({ page }) => {
    const c = await open(page)
    await expect(c.locator('.empty')).toContainText('What would you like reviewed')
    await expect(btn(page, 'review')).toBeVisible()
    await c.locator('[data-testid="settings"]').click()
    await expect(c.locator('[data-testid="toggle-live"]')).toBeEnabled()
    await expect(c.locator('.menu')).toContainText('candidates are page changes')
    await expect(c.locator('[data-testid="share-link"]')).toHaveValue(/\/__ph\/join\?t=/)
  })

  test('the agent pins notes and patches the page in place; mockups are refused', async ({ page }) => {
    const c = await open(page)
    await clearAll(page)
    await send(c, 'review the hero [fake:note=.hero-title] [fake:patch=.hero-sub] [fake:html]')
    await expect(c.locator('.turn').last()).toContainText('Change #', { timeout: 15_000 })

    await expect(pins(page)).toHaveCount(2)
    await expect(btn(page, 'review').locator('.count')).toHaveText('2')
    const sub = page.locator('.hero-sub')
    await expect(sub).toHaveText('Reviewed headline')
    await expect(sub).toHaveCSS('color', 'rgb(220, 38, 38)')
    await expect(c.locator('.turn').last()).toContainText('write_artifact')
    expect(existsSync(path.join(REVIEW_PROJECT, '.page-harness', 'artifacts', 'mock.html'))).toBe(false)

    // Pin popover: thread, compare with the original, reply, resolve, quote into the chat.
    await pins(page).nth(1).click()
    const pop = page.locator('page-harness-root .rv-pop')
    await expect(pop).toContainText('Shorter, clearer headline.')
    await pop.locator('.toggle').click()
    await expect(sub).toHaveText(SUB)
    await pop.locator('.toggle').click()
    await expect(sub).toHaveText('Reviewed headline')
    await ui(page, 'review-reply').fill('Looks better')
    await ui(page, 'review-reply').press('Enter')
    await expect(pop).toContainText('Looks better')
    await pop.locator('.status').click()
    await expect(pop).toContainText('Resolved')
    await pop.locator('.quote').click()
    await expect(c.locator('.chip.draft')).toHaveCount(1)

    // Survives a reload and the framework re-creating the element.
    await page.reload()
    await expect(pins(page)).toHaveCount(2)
    await expect(sub).toHaveText('Reviewed headline')
    await page.evaluate((text) => {
      const n = document.createElement('p')
      n.className = 'hero-sub'
      n.textContent = text
      document.querySelector('.hero-sub')!.replaceWith(n)
    }, SUB)
    await expect(sub).toHaveText('Reviewed headline')

    // Notes list: hide all changes, export.
    await btn(page, 'review').click()
    await expect(list(page).locator('.rv-row')).toHaveCount(2)
    await ui(page, 'review-show').uncheck()
    await expect(sub).toHaveText(SUB)
    await ui(page, 'review-show').check()
    await expect(sub).toHaveText('Reviewed headline')
    await list(page).locator('.export').click()
    await expect(artifacts(page).locator('body')).toContainText('page-review.md')
    await page.keyboard.press('Escape')
  })

  test('notes stay on their page; the All tab jumps back and opens the pin', async ({ page }) => {
    const c = await open(page)
    await clearAll(page)
    await send(c, 'review [fake:note=.hero-title]')
    await expect(pins(page)).toHaveCount(1, { timeout: 15_000 })
    await page.locator('#about-link').click()
    await expect(page).toHaveURL(/\/about$/)
    await expect(pins(page)).toHaveCount(0)
    await expect(btn(page, 'review').locator('.count')).toBeHidden()
    await expect(btn(page, 'review')).toHaveClass(/elsewhere/)
    await btn(page, 'review').click()
    await expect(list(page).locator('.rv-empty')).toContainText('other pages are under All')
    await ui(page, 'review-tab-all').click()
    await expect(list(page).locator('.rv-group')).toHaveText(['/'])
    await list(page).locator('.rv-row').first().click()
    await expect(page).toHaveURL(`${REVIEW}/`)
    await expect(page.locator('page-harness-root .rv-pop')).toBeVisible()
    await expect(page.locator('page-harness-root .rv-pop')).toContainText('#')

    // An element that disappears is reported, not silently dropped.
    await page.keyboard.press('Escape')
    await page.evaluate(() => document.querySelector('.hero-title')!.remove())
    await btn(page, 'review').click()
    await ui(page, 'review-tab-here').click()
    await expect(list(page).locator('.rv-row').first()).toContainText('not found on the page')
    await clearAll(page)
  })

  test('a teammate joins with the invite link, comments, edits and approves; the owner sees it live', async ({ page, browser }) => {
    await open(page, false)
    await clearAll(page)
    const { ctx, page: rp } = await reviewer(browser)
    await expect(btn(rp, 'chat')).toBeEnabled()
    await expect(btn(rp, 'pick')).toBeVisible()
    await expect(btn(rp, 'chat')).toHaveText(/Review/)
    await btn(rp, 'chat').click()
    await parkChat(rp)
    const panel = chat(rp)
    await expect(panel.locator('[data-testid="reviewer-panel"]')).toBeVisible()
    await expect(panel.locator('textarea')).toHaveCount(0)

    // Must pick a name before commenting. Reviewers get Comment / Edit only.
    await btn(rp, 'pick').click()
    await pickAt(rp, '.hero-title')
    await expect(ui(rp, 'pick-actions').locator('button')).toHaveText(['Comment', 'Edit', '×'])
    await ui(rp, 'pick-comment').click()
    await expect(rp.locator('page-harness-root .toast')).toContainText('name')
    await panel.locator('[data-testid="reviewer-name"]').fill('Alice')
    await panel.locator('[data-testid="reviewer-save"]').click()
    await expect(panel.locator('[data-testid="reviewer-me"]')).toHaveText('Alice')

    // Comment on the title.
    await btn(rp, 'pick').click()
    await pickAt(rp, '.hero-title')
    await ui(rp, 'pick-comment').click()
    await ui(rp, 'review-comment').fill('Say what the product does')
    await rp.locator('page-harness-root .rv-form .save').click()
    await expect(pins(rp)).toHaveCount(1)
    await expect(pins(page)).toHaveCount(1)
    await expect(page.locator('page-harness-root .toast')).toContainText('Alice added #')

    // Edit the nav link text and color in place.
    await btn(rp, 'pick').click()
    await pickAt(rp, '#home-link')
    await ui(rp, 'pick-edit').click()
    await ui(rp, 'review-edit-text').fill('Start')
    await rp.locator('page-harness-root .rv-form input[data-prop="font-size"]').fill('22')
    await rp.locator('page-harness-root .rv-form .save').click()
    await expect(rp.locator('#home-link')).toHaveText('Start')
    await expect(page.locator('#home-link')).toHaveText('Start')
    await expect(page.locator('#home-link')).toHaveCSS('font-size', '22px')

    // Approve; the owner sees who approved. Reviewers cannot clear or export.
    await btn(rp, 'review').click()
    await ui(rp, 'review-changes').click()
    await expect(list(rp).locator('.rv-chip')).toContainText('Alice requested changes')
    await expect(list(rp).locator('.clear')).toHaveCount(0)
    await btn(page, 'review').click()
    await expect(list(page).locator('.rv-chip')).toContainText('Alice requested changes')
    await expect(list(page).locator('.rv-row').first()).toContainText('Alice')

    await ctx.close()
    await clearAll(page)
  })

  test('Copy prompt puts every open note of the tab on the clipboard as agent instructions', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: REVIEW })
    await open(page, false)
    await clearAll(page)
    await btn(page, 'review').click()
    await expect(ui(page, 'review-copy-prompt')).toBeDisabled()
    await page.keyboard.press('Escape')

    await btn(page, 'pick').click()
    await pickAt(page, '#home-link')
    await ui(page, 'pick-edit').click()
    await ui(page, 'review-edit-text').fill('Start')
    await page.locator('page-harness-root .rv-form input[data-prop="font-size"]').fill('22')
    await page.locator('page-harness-root .rv-form .save').click()
    await expect(page.locator('#home-link')).toHaveText('Start')

    await btn(page, 'pick').click()
    await pickAt(page, '.hero-title')
    await ui(page, 'pick-comment').click()
    await ui(page, 'review-comment').fill('Say what the product does')
    await page.locator('page-harness-root .rv-form .save').click()
    await expect(pins(page)).toHaveCount(2)

    await btn(page, 'review').click()
    const copy = ui(page, 'review-copy-prompt')
    await expect(copy).toHaveText('Copy prompt')
    await expect(copy).toHaveAttribute('title', /page through open notes and mark each one/)
    await copy.click()
    await expect(copy).toHaveText('✓ Copied')
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text).toContain('# Handle local page notes')
    expect(text).toContain('Scope: this page')
    expect(text).toContain('Open items: 2')
    expect(text).toContain('one of the two is enough')
    expect(text).toContain('curl ')
    expect(text).toContain('browser use')
    expect(text).toContain(`GET ${REVIEW_CONTROL}/__ph/api/review?`)
    expect(text).toContain('scope=here')
    expect(text).toContain(`POST ${REVIEW_CONTROL}/__ph/api/review/resolve`)
    expect(text).toContain(`browser use: open ${REVIEW}/`)
    expect(text).not.toContain('/review/next')
    expect(text).not.toContain('Say what the product does')
    expect(text).not.toContain('> Start')
    await expect(copy).toHaveText('Copy prompt', { timeout: 4000 })

    await ui(page, 'review-tab-all').click()
    await copy.click()
    const all = await page.evaluate(() => navigator.clipboard.readText())
    expect(all).toContain('Scope: all pages (current page first)')
    expect(all).toContain('scope=all')
    expect(all).toContain(`GET ${REVIEW_CONTROL}/__ph/api/review?`)
    expect(all).not.toContain('Say what the product does')
    await page.keyboard.press('Escape')
    await clearAll(page)
  })

  test('Live without source: candidates are page changes; accepting keeps them as changes', async ({ page }) => {
    const c = await open(page)
    await clearAll(page)
    await c.locator('[data-testid="settings"]').click()
    const live = c.locator('[data-testid="toggle-live"]')
    if (!(await live.isChecked())) await live.check()
    await c.locator('[data-testid="settings"]').click()

    await btn(page, 'pick').click()
    await expect(page.locator('page-harness-root .lv-pickbar')).toBeVisible()
    await expect(page.locator('page-harness-root .lv-pickbar')).not.toContainText('Insert block')
    await pickAt(page, '.hero-title')
    await expect(ui(page, 'pick-actions').locator('button')).toHaveText(['Quote in chat', 'Comment', 'Edit', 'Live candidates', '×'])
    await ui(page, 'pick-live').click()
    const design = page.locator('page-harness-root .lv-design')
    await expect(design).toBeVisible()
    await expect(design).not.toContainText('Side by side')
    await parkChat(page)
    await design.locator('.lv-foot button.primary').click()

    const ctrl = page.locator('page-harness-root .lv-ctrl')
    const title = page.locator('.hero-title')
    const sub = page.locator('.hero-sub')
    await expect(ctrl.locator('.idx')).toHaveText('1/2', { timeout: 15_000 })
    await expect(ctrl).not.toContainText('Side by side')
    await expect(title).toHaveCSS('font-weight', '800')
    await expect(sub).toHaveText('Bold subtitle')
    await ctrl.locator('button', { hasText: '›' }).click()
    await expect(title).toHaveText('Soft title')
    await expect(title).toHaveCSS('opacity', '0.6')
    await expect(sub).toHaveText(SUB)
    await expect(title).not.toHaveCSS('font-weight', '800')

    await ctrl.locator('input').fill('bigger')
    await ctrl.locator('input').press('Enter')
    await expect(ctrl.locator('.lbl')).toHaveText('Bigger', { timeout: 15_000 })
    await expect(title).toHaveCSS('font-size', '40px')
    await expect(title).toHaveText('Hello fixture')

    await ctrl.locator('button', { hasText: '‹' }).click()
    await expect(sub).toHaveText('Bold subtitle')
    await ctrl.locator('button', { hasText: 'Accept' }).click()
    await expect(ctrl).toHaveCount(0)
    await expect(pins(page)).toHaveCount(2)
    await expect(sub).toHaveText('Bold subtitle')
    await expect(title).toHaveCSS('font-weight', '800')
    await btn(page, 'review').click()
    await expect(list(page).locator('.rv-row')).toHaveCount(2)
    await expect(list(page).locator('.rv-row').first()).toContainText('Live: Bold')
    await page.keyboard.press('Escape')
    await clearAll(page)
    await expect(sub).toHaveText(SUB)
  })
})
