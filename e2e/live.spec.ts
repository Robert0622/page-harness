import { expect, test, type Page } from '@playwright/test'
import { dockButton, openChat, parkChat, projectFile, resetFixture } from './helpers'

const lv = (page: Page, sel: string) => page.locator(`page-harness-root .lv-root ${sel}`)

async function pickTitle(page: Page) {
  await dockButton(page, 'pick').click()
  await expect(lv(page, '.lv-pickbar')).toBeVisible()
  const h = (await page.locator('.hero-title').boundingBox())!
  await page.mouse.move(h.x + 20, h.y + h.height / 2)
  await page.mouse.click(h.x + 20, h.y + h.height / 2)
  await expect(page.locator('page-harness-root [data-testid="pick-actions"]')).toBeVisible()
}

async function generate(page: Page) {
  await pickTitle(page)
  await page.locator('page-harness-root [data-testid="pick-live"]').click()
  const design = lv(page, '.lv-design')
  await expect(design).toBeVisible()
  await parkChat(page)
  await design.locator('textarea').fill('make it pop')
  await design.locator('.lv-foot button', { hasText: 'Generate' }).click()
  await expect(design).toBeHidden()
  // The fake agent edits the source; the fixture's mini-HMR reloads the page.
  await expect.poll(() => projectFile()).toContain('data-ph-live=')
  await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
  await expect(lv(page, '.lv-ctrl .idx')).toHaveText('1/2')
  // g2.2: the parked drawer survives the candidate reload instead of jumping back over the controls.
  const parked = (await page.locator('page-harness-root .drawer').boundingBox())!
  expect(parked.x).toBeLessThan(80)
  expect(parked.y).toBeGreaterThan(400)
}

test.describe('Live candidates', () => {
  test.beforeEach(() => resetFixture())
  test.afterAll(() => resetFixture())

  test('pick → modify → generate → cycle → accept writes the chosen variant to source', async ({ page }) => {
    const c = await openChat(page)
    await generate(page)
    await expect(dockButton(page, 'eye')).toBeVisible()
    await expect(c.locator('.livebar')).toBeVisible()
    await expect(c.locator('.live.card.compact').last()).toContainText('make it pop')
    // The full card with candidates comes after the agent's reply.
    await expect(c.locator('.row.agent .live.card.agent').last()).toBeVisible()

    await lv(page, '.lv-ctrl button').filter({ hasText: '›' }).click()
    await expect(lv(page, '.lv-ctrl .idx')).toHaveText('2/2')
    await expect(page.locator('[data-ph-variant="2"]')).toBeVisible()
    await expect(page.locator('[data-ph-variant="1"]')).toBeHidden()
    await page.keyboard.press('ArrowLeft')
    await expect(lv(page, '.lv-ctrl .idx')).toHaveText('1/2')

    await lv(page, '.lv-ctrl button').filter({ hasText: 'Accept' }).click()
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
    expect(projectFile()).toContain('<h1 style="font-weight:800" class="hero-title">Hello fixture</h1>')
    await expect(lv(page, '.lv-ctrl')).toHaveCount(0, { timeout: 15_000 })
    await expect(dockButton(page, 'eye')).toBeHidden()
  })

  test('params panel tunes a variant via CSS variables; discard restores the original', async ({ page }) => {
    await openChat(page)
    await generate(page)
    await lv(page, '.lv-ctrl button').filter({ hasText: '›' }).click()
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Tune' }).click()
    const slider = lv(page, '.lv-params input[type="range"]')
    await slider.fill('24')
    await expect(page.locator('[data-ph-live]')).toHaveAttribute('style', /--ph-gap:\s*24px/)
    await expect(page.locator('[data-ph-live]')).toHaveAttribute('data-ph-param-gap', '24')
    await lv(page, '.lv-params .lv-foot button').click()
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Discard' }).click()
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
    expect(projectFile()).toContain('<h1 class="hero-title">Hello fixture</h1>')
  })

  test('compare mode shows all candidates side by side with badges', async ({ page }) => {
    await openChat(page)
    await generate(page)
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Side by side' }).click()
    await expect(page.locator('[data-ph-variant="0"]')).toBeVisible()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible()
    await expect(page.locator('[data-ph-variant="2"]')).toBeVisible()
    await expect(page.locator('page-harness-root .lv-badge')).toHaveCount(3)
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Discard' }).click()
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
  })

  test('Quote in the pick bar adds the element to the chat instead of starting Live', async ({ page }) => {
    const c = await openChat(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-quote"]').click()
    await expect(c.locator('.chip.draft')).toContainText('Hello fixture')
    await page.keyboard.press('Escape')
  })
})
