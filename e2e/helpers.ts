import { expect, type FrameLocator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', 'project')
export const FIXTURE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'index.html')
export const CONTROL = 'http://localhost:17981'

export function resetFixture() {
  writeFileSync(path.join(PROJECT, 'index.html'), readFileSync(FIXTURE_SRC))
}

export function projectFile(): string {
  return readFileSync(path.join(PROJECT, 'index.html'), 'utf8')
}

export const dock = (page: Page) => page.locator('page-harness-root .bar')
export const dockButton = (page: Page, act: 'pick' | 'eye' | 'artifacts' | 'chat') => page.locator(`page-harness-root .bar button[data-act="${act}"]`)
export const chat = (page: Page): FrameLocator => page.frameLocator('iframe[title="Page Harness chat"]')
export const artifacts = (page: Page): FrameLocator => page.frameLocator('iframe[title="Page Harness artifacts"]')

/** Opens the app, waits for the panel to be ready and opens the chat drawer in a fresh chat. */
export async function openChat(page: Page, opts: { fresh?: boolean } = {}) {
  await page.goto('/')
  await expect(dockButton(page, 'chat')).toBeEnabled()
  if (!(await page.locator('page-harness-root .drawer').isVisible())) await dockButton(page, 'chat').click()
  const c = chat(page)
  await expect(c.locator('textarea')).toBeVisible()
  if (opts.fresh !== false) {
    await c.locator('[data-testid="chat-switcher"]').click()
    await c.locator('[data-testid="new-chat"]').click()
    await expect(c.locator('.empty')).toBeVisible()
  }
  return c
}

/**
 * Move the open chat to the bottom-left so Live cards, review notes and param
 * confirm buttons on the right stay clickable (plan g2.2).
 * The rect is written to ph:drawer. The fixture reloads when a candidate lands,
 * and the overlay restores the drawer from that key — inline styles alone snap
 * back to the default rectangle and cover those controls again.
 */
export async function parkChat(page: Page) {
  const drawer = page.locator('page-harness-root .drawer')
  if (!(await drawer.isVisible())) return
  await drawer.evaluate((el) => {
    const r = { x: 16, y: 500, w: 380, h: 320 }
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, right: 'auto', bottom: 'auto' })
    const key = 'ph:drawer'
    let prev: { r?: typeof r; open?: boolean }
    try {
      prev = JSON.parse(localStorage.getItem(key) || '{}')
    } catch {
      prev = {}
    }
    localStorage.setItem(key, JSON.stringify({ ...prev, r, open: true }))
  })
}

export async function send(c: FrameLocator, text: string) {
  await c.locator('textarea').fill(text)
  await c.locator('textarea').press('Enter')
}
