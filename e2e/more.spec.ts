/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test'
import { artifacts, chat, CONTROL, dock, dockButton, openChat, parkChat, projectFile, resetFixture, send } from './helpers'

const lv = (page: Page, sel: string) => page.locator(`page-harness-root .lv-root ${sel}`)

async function pickTitle(page: Page) {
  await dockButton(page, 'pick').click()
  await expect(lv(page, '.lv-pickbar')).toBeVisible()
  const h = (await page.locator('.hero-title').boundingBox())!
  await page.mouse.move(h.x + 20, h.y + h.height / 2)
  await page.mouse.click(h.x + 20, h.y + h.height / 2)
  await expect(page.locator('page-harness-root [data-testid="pick-actions"]')).toBeVisible()
}

test.describe('windows and settings', () => {
  test('the chat drawer stacks above the artifacts window; mask click and Esc close it', async ({ page }) => {
    const c = await openChat(page)
    await send(c, '[fake:artifact] report')
    await expect(c.locator('.turn .chip.art').last()).toBeVisible()
    await dockButton(page, 'artifacts').click()
    await expect(artifacts(page).locator('.tile').first()).toBeVisible()
    const topAt = await page.evaluate(() => {
      const root = document.querySelector('page-harness-root')!.shadowRoot!
      const a = root.querySelector('.art')!.getBoundingClientRect()
      const d = root.querySelector('.drawer')!.getBoundingClientRect()
      const x = Math.max(a.left, d.left) + 20
      const y = Math.max(a.top, d.top) + 20
      return root.elementFromPoint(x, y)?.closest('.win')?.className
    })
    expect(topAt).toContain('drawer')
    await page.mouse.click(5, 5)
    await expect(page.locator('page-harness-root .art-mask')).toBeHidden()
    await dockButton(page, 'artifacts').click()
    await expect(page.locator('page-harness-root .art-mask')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('page-harness-root .art-mask')).toBeHidden()
    await expect(dockButton(page, 'artifacts')).not.toHaveClass(/on/)
  })

  test('an overlapping live card hits the open chat drawer, and the dock works again once the drawer is collapsed', async ({ page }) => {
    await openChat(page)
    await page.waitForFunction(() => {
      const root = document.querySelector('page-harness-root')?.shadowRoot
      return [...(root?.querySelectorAll('style') ?? [])].some((s) => s.textContent?.includes('.lv-card'))
    })
    const drawer = page.locator('page-harness-root .drawer')
    const top = await page.evaluate(() => {
      const root = document.querySelector('page-harness-root')!.shadowRoot!
      const d = root.querySelector('.drawer')!.getBoundingClientRect()
      const card = document.createElement('div')
      card.className = 'lv-card'
      card.dataset.testid = 'fake-live'
      card.textContent = '生成中'
      Object.assign(card.style, { left: `${d.left + 24}px`, top: `${d.top + 48}px`, width: '160px', height: '40px' })
      root.querySelector('.layer')!.append(card)
      const banner = root.querySelector<HTMLElement>('.banner')!
      banner.hidden = false
      Object.assign(banner.style, { left: `${d.left + 8}px`, top: `${d.top + 8}px`, transform: 'none' })
      const r = card.getBoundingClientRect()
      const b = banner.getBoundingClientRect()
      return {
        card: root.elementFromPoint(r.left + 8, r.top + 8)?.closest('.drawer, .lv-card')?.className ?? '',
        banner: root.elementFromPoint(b.left + 8, b.top + 8)?.closest('.drawer, .banner')?.className ?? '',
      }
    })
    expect(top.card).toContain('drawer')
    expect(top.banner).toContain('drawer')
    await page.locator('page-harness-root .drawer .collapse').click()
    await expect(drawer).toBeHidden()
    const cardHit = await page.evaluate(() => {
      const root = document.querySelector('page-harness-root')!.shadowRoot!
      const card = root.querySelector('[data-testid="fake-live"]')!
      const r = card.getBoundingClientRect()
      return root.elementFromPoint(r.left + 8, r.top + 8)?.closest('.lv-card')?.className ?? ''
    })
    expect(cardHit).toContain('lv-card')
    await expect(dockButton(page, 'pick')).toBeEnabled()
    await dockButton(page, 'chat').click()
    await expect(drawer).toBeVisible()
  })

  test('settings use switches and the gear shows a dot while page control is on', async ({ page }) => {
    const c = await openChat(page)
    const gear = c.locator('[data-testid="settings"]')
    await expect(gear.locator('.dot')).toHaveCount(0)
    await gear.click()
    await expect(c.locator('[data-testid="toggle-control"]')).toHaveClass(/switch/)
    await expect(c.locator('[data-testid="toggle-live"]')).toBeChecked()
    await c.locator('[data-testid="toggle-control"]').check()
    await expect(gear.locator('.dot')).toBeVisible()
    await expect(c.locator('[data-testid="control-status"]')).toHaveClass(/online/)
    await page.locator('page-harness-root .banner .stop').click()
    await expect(page.locator('page-harness-root .banner')).toBeHidden()
    await expect(c.locator('[data-testid="toggle-control"]')).not.toBeChecked()
    await expect(gear.locator('.dot')).toHaveCount(0)
  })

  test('switching the language in the panel updates the page dock too, and persists', async ({ page }) => {
    const c = await openChat(page)
    await c.locator('[data-testid="settings"]').click()
    await c.locator('.menu .seg .btn', { hasText: '中文' }).click()
    await expect(dockButton(page, 'chat')).toHaveText(/对话/)
    await expect(dockButton(page, 'pick')).toHaveText(/取点/)
    await expect(c.locator('.composer textarea')).toHaveAttribute('placeholder', /[\u4e00-\u9fa5]/)
    await page.reload()
    await expect(dockButton(page, 'artifacts')).toHaveText(/产物/)
    await expect(chat(page).locator('[data-testid="send"]')).toHaveAttribute('title', /发送/)
    await expect(chat(page).locator('.composer .hint')).toContainText('Enter 发送')
    await chat(page).locator('[data-testid="settings"]').click()
    await chat(page).locator('.menu .seg .btn', { hasText: 'English' }).click()
    await expect(dockButton(page, 'chat')).toHaveText(/Chat/)
  })

  test('design tokens are identical on the page dock and inside the panel, in both themes', async ({ page }) => {
    const c = await openChat(page)
    const keys = ['--bg', '--bg2', '--base', '--fg', '--fg2', '--line', '--accent', '--accent-2', '--accent-fg', '--agent', '--err', '--font', '--r', '--r-lg', '--h']
    const read = async () => {
      const overlay = await page.evaluate((ks) => {
        const ph = document.querySelector('page-harness-root')!.shadowRoot!.querySelector('.ph')!
        const cs = getComputedStyle(ph)
        return Object.fromEntries(ks.map((k) => [k, cs.getPropertyValue(k).trim()]))
      }, keys)
      const panel = await c.locator('html').evaluate((el, ks) => {
        const cs = getComputedStyle(el)
        return Object.fromEntries(ks.map((k) => [k, cs.getPropertyValue(k).trim()]))
      }, keys)
      return { overlay, panel }
    }
    const light = await read()
    expect(await c.locator('html').evaluate(async () => (await document.fonts.ready, document.fonts.check('13px "Inter Variable"')))).toBe(true)
    expect(await c.locator('body').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"Inter Variable"/)
    expect(light.overlay['--accent']).toBe('#7b61ff')
    expect(light.panel).toEqual(light.overlay)
    await page.locator('page-harness-root .drawer .theme').click()
    await expect(c.locator('html')).toHaveAttribute('data-theme', 'dark')
    const dark = await read()
    expect(dark.overlay['--bg']).not.toBe(light.overlay['--bg'])
    expect(dark.panel).toEqual(dark.overlay)
    await page.locator('page-harness-root .drawer .theme').click()
  })

  test('controls share one height and radius across dock, panel and Live cards', async ({ page }) => {
    const c = await openChat(page)
    const panelBtn = await c.locator('header .btn').first().evaluate((el) => ({ h: el.getBoundingClientRect().height, r: getComputedStyle(el).borderRadius }))
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    await parkChat(page)
    const liveBtn = await lv(page, '.lv-design .lv-foot button.primary').evaluate((el) => ({ h: el.getBoundingClientRect().height, r: getComputedStyle(el).borderRadius }))
    expect(liveBtn).toEqual(panelBtn)
    await lv(page, '.lv-design .lv-foot button').filter({ hasText: 'Cancel' }).click()
    await page.keyboard.press('Escape')
  })

  test('fits a narrow (mobile) viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 760 })
    await openChat(page)
    const vw = 390
    for (const sel of ['page-harness-root .bar', 'page-harness-root .drawer']) {
      const b = (await page.locator(sel).boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 1)
    }
    const overflow = await chat(page).locator('.chat-app').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('composer and queue', () => {
  test('attaches an image file and shows it in the sent message', async ({ page }) => {
    const c = await openChat(page)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    await c.locator('.composer input[type="file"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
    await expect(c.locator('.composer .att img')).toBeVisible()
    await expect(c.locator('.composer .att .spin')).toHaveCount(0)
    await send(c, 'see the image')
    await expect(c.locator('.turn .user .atts img').last()).toBeVisible()
    await expect(c.locator('.turn .md').last()).toContainText('Echo: see the image')
  })

  test('queued messages can be reordered from the keyboard and edited', async ({ page }) => {
    const c = await openChat(page)
    await send(c, '[fake:slow] busy')
    await expect(c.locator('.indicator')).toBeVisible()
    await send(c, 'alpha')
    await send(c, 'beta')
    await expect(c.locator('.queue .qi')).toHaveCount(2)
    await expect(c.locator('.indicator')).toBeInViewport()
    await c.locator('.queue .qi').nth(1).locator('.grip').focus()
    await page.keyboard.press('ArrowUp')
    await expect(c.locator('.queue .qi .txt')).toHaveText(['beta', 'alpha'])
    await c.locator('.queue .qi').nth(1).locator('button[title="Edit"]').click()
    await expect(c.locator('.composer textarea')).toHaveValue('alpha')
    await expect(c.locator('.queue .qi')).toHaveCount(1)
    await c.locator('.composer textarea').fill('alpha edited')
    await c.locator('.composer textarea').press('Control+Enter')
    await expect(c.locator('.queue .qi .txt')).toHaveText(['beta', 'alpha edited'])
    await c.locator('.composer .btn.danger').click()
    await expect(c.locator('.turn .md').last()).toContainText('Echo: alpha edited', { timeout: 15_000 })
  })

  test('the list follows new output at the bottom, and offers "back to bottom" after scrolling up', async ({ page }) => {
    const c = await openChat(page)
    for (let i = 0; i < 4; i++) {
      await send(c, `[fake:think] filler ${i} ${'lorem ipsum '.repeat(30)}`)
      await expect(c.locator('.turn .foot .st').nth(i)).toHaveClass(/done/)
    }
    await expect(c.locator('.turn').last()).toBeInViewport()
    await send(c, '[fake:slow] streaming')
    await expect(c.locator('.indicator')).toBeInViewport()
    await c.locator('.list').evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(c.locator('.unread')).toBeVisible({ timeout: 10_000 })
    await expect(c.locator('.unread')).toHaveText(/1 new message/)
    await expect(c.locator('.indicator')).not.toBeInViewport()
    await c.locator('.unread').click()
    await expect(c.locator('.turn').last().locator('.foot, .indicator').first()).toBeInViewport()
    await c.locator('.composer .btn.danger').click()
  })

  test('a chat can be renamed from the switcher', async ({ page }) => {
    const c = await openChat(page)
    await send(c, 'first message')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    await c.locator('[data-testid="chat-switcher"]').click()
    await c.locator('.menu .acts .btn', { hasText: 'Rename' }).click()
    await c.locator('.switcher input.rn').fill('My renamed chat')
    await c.locator('.switcher input.rn').press('Enter')
    await expect(c.locator('[data-testid="chat-switcher"]')).toContainText('My renamed chat')
    await page.reload()
    await expect(chat(page).locator('[data-testid="chat-switcher"]')).toContainText('My renamed chat')
  })
})

test.describe('chat UI', () => {
  test('messages have avatars; user bubbles sit on the right, agent replies on the left', async ({ page }) => {
    const c = await openChat(page)
    await send(c, 'hello avatars')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    const turn = c.locator('.turn').last()
    await expect(turn.locator('.row.user .av.me')).toHaveText('Me')
    await expect(turn.locator('.row.agent .av.bot svg')).toBeVisible()
    const user = (await turn.locator('.row.user .bubble').boundingBox())!
    const agent = (await turn.locator('.row.agent .msg').boundingBox())!
    const avatar = (await turn.locator('.row.user .av').boundingBox())!
    expect(user.x + user.width).toBeLessThanOrEqual(avatar.x)
    expect(agent.x).toBeLessThan(user.x)
    await expect(turn.locator('.foot')).toHaveAttribute('title', /fake|ms/)
  })

  test('Enter sends, Shift+Enter adds a line, and nothing is sent while an IME is composing', async ({ page }) => {
    const c = await openChat(page)
    const ta = c.locator('.composer textarea')
    await ta.fill('line one')
    await ta.press('Shift+Enter')
    await ta.pressSequentially('line two')
    await expect(ta).toHaveValue('line one\nline two')
    await ta.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    await expect(c.locator('.turn')).toHaveCount(0)
    await ta.press('Enter')
    await expect(c.locator('.turn .user .text').last()).toHaveText('line one\nline two')
    await expect(ta).toHaveValue('')
  })

  test('bursty text is revealed smoothly and settled blocks keep their DOM', async ({ page }) => {
    const c = await openChat(page)
    const frame = page.frames().find((f) => f.url().includes('/__ph/ui'))!
    await frame.evaluate(() => {
      const w = window as unknown as { __samples: number[]; __h1?: Element; __stop?: boolean }
      w.__samples = []
      const loop = () => {
        const md = [...document.querySelectorAll('.row.agent .md')].pop()
        if (md) {
          w.__samples.push(md.textContent?.length ?? 0)
          w.__h1 ??= md.querySelector('h1') ?? undefined
        }
        if (!w.__stop) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
    await send(c, 'go [fake:burst]')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    const md = c.locator('.row.agent .md').last()
    await expect(md).toContainText('Last line.')
    await expect(md).not.toHaveClass(/streaming/)
    await expect(md.locator('.code-block')).toHaveCount(1)
    const r = await frame.evaluate(() => {
      const w = window as unknown as { __samples: number[]; __h1?: Element; __stop?: boolean }
      w.__stop = true
      const md = [...document.querySelectorAll('.row.agent .md')].pop()!
      const s = w.__samples.filter((n, i, a) => i === 0 || n !== a[i - 1])
      let jump = 0
      for (let i = 1; i < s.length; i++) jump = Math.max(jump, s[i] - s[i - 1])
      return { steps: s.length, jump, total: md.textContent!.length, sameH1: !!w.__h1 && md.querySelector('h1') === w.__h1 }
    })
    // Three bursts of several hundred characters each must not appear as three jumps.
    expect(r.steps).toBeGreaterThan(20)
    expect(r.jump).toBeLessThan(r.total / 6)
    expect(r.sameH1).toBe(true)
  })

  test('a streaming reply shows Writing and a caret; thoughts end in the done state', async ({ page }) => {
    const c = await openChat(page)
    await send(c, '[fake:slow] stream')
    await expect(c.locator('.turn .md.streaming')).toBeVisible()
    await expect(c.locator('.indicator.writing .shimmer')).toHaveText('Writing')
    await c.locator('.composer .stop').click()
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/cancelled/)
    await expect(c.locator('.turn .md.streaming')).toHaveCount(0)
    await send(c, '[fake:think] ponder')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    await expect(c.locator('.turn').last().locator('[data-testid="thought-status"]')).toHaveAttribute('data-state', 'done')
  })

  test('consecutive tool calls fold into one line that expands to the full list', async ({ page }) => {
    const c = await openChat(page)
    await send(c, '[fake:edit] [fake:artifact] tools')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    const groups = c.locator('.turn').last().locator('[data-testid="tool-group"]')
    await expect(groups.first().locator('.tool')).toHaveCount(0)
    let total = 0
    for (let i = 0; i < (await groups.count()); i++) {
      const g = groups.nth(i)
      const n = Number(/Used (\d+) tool/.exec((await g.locator('.head').first().textContent()) ?? '')?.[1])
      await g.locator('.head').first().click()
      await expect(g.locator('.tool')).toHaveCount(n)
      total += n
    }
    expect(total).toBeGreaterThanOrEqual(2)
  })
})

test.describe('model picker', () => {
  test('search, pick, persist, custom id and back to default', async ({ page }) => {
    const c = await openChat(page)
    const pill = c.locator('[data-testid="model-pill"]')
    await expect(pill).toContainText('Auto')
    await pill.click()
    const picker = c.locator('[data-testid="model-picker"]')
    await expect(picker).toBeVisible()
    const inside = await picker.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    })
    expect(inside).toBe(true)
    await expect(picker.locator('[data-testid="model-default"] .ck')).toBeVisible()
    await expect(picker.locator('[data-testid="model-option"]')).toHaveCount(4)
    await expect(picker.locator('.gname')).toHaveText(['Claude', 'GPT', 'Other'])
    await picker.locator('[data-testid="model-search"]').fill('large')
    await expect(picker.locator('[data-testid="model-option"]')).toHaveCount(1)
    await expect(picker.locator('mark')).toHaveText('Large')
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect(pill).toContainText('Fake Large')
    await send(c, 'with model')
    await expect(c.locator('.turn .foot').last()).toHaveAttribute('title', /fake-large/)
    await page.reload()
    const c2 = chat(page)
    await expect(c2.locator('[data-testid="model-pill"]')).toContainText('Fake Large')
    await c2.locator('[data-testid="model-pill"]').click()
    await expect(c2.locator('[data-testid="model-option"][data-model="fake-large"] .ck')).toBeVisible()
    const slider = c2.locator('[data-testid="effort-picker"] [role="slider"]')
    await expect(c2.locator('[data-testid="effort-value"]')).toHaveText('Low')
    await expect(c2.locator('[data-testid="effort-reset"]')).toBeDisabled()
    await slider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(c2.locator('[data-testid="model-pill"]')).toContainText('Fake Large · High')
    await expect(c2.locator('[data-testid="effort-value"]')).toHaveText('High')
    await expect(slider).toHaveAttribute('aria-valuenow', '1')
    await c2.locator('[data-testid="effort-reset"]').click()
    await expect(c2.locator('[data-testid="model-pill"]')).toHaveText(/Fake Large$/)
    const box = (await slider.boundingBox())!
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2)
    await expect(c2.locator('[data-testid="model-pill"]')).toContainText('Fake Large · High')
    const fastBtn = c2.locator('[data-testid="fast-toggle"]')
    await fastBtn.hover()
    await expect(fastBtn.locator('.tip')).toBeVisible()
    await expect(fastBtn.locator('.tip')).toContainText('1.5x speed')
    await fastBtn.click()
    await expect(fastBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(c2.locator('[data-testid="pill-fast"]')).toBeVisible()
    await fastBtn.click()
    await expect(fastBtn).toHaveAttribute('aria-pressed', 'false')
    await expect(c2.locator('[data-testid="pill-fast"]')).toHaveCount(0)
    await c2.locator('[data-testid="model-search"]').fill('my-custom-1')
    await c2.locator('[data-testid="model-custom"]').click()
    await expect(c2.locator('[data-testid="model-pill"]')).toHaveText(/my-custom-1$/)
    await c2.locator('[data-testid="model-pill"]').click()
    await expect(c2.locator('[data-testid="effort-picker"]')).toHaveCount(0)
    await c2.locator('[data-testid="model-default"]').click()
    await expect(c2.locator('[data-testid="model-pill"]')).toContainText('Auto')
  })

  test('keyboard navigation, Escape and outside click close it', async ({ page }) => {
    const c = await openChat(page)
    const pill = c.locator('[data-testid="model-pill"]')
    await pill.click()
    await expect(c.locator('[data-testid="agent-trigger"] [data-agent-badge="fake"]')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(c.locator('.opt.active')).toContainText('GPT Fake 5')
    await page.keyboard.press('Enter')
    await expect(pill).toContainText('GPT Fake 5')
    await pill.click()
    await page.keyboard.press('Escape')
    await expect(c.locator('[data-testid="model-picker"]')).toBeHidden()
    await pill.click()
    await c.locator('.list').first().click({ position: { x: 20, y: 20 }, force: true })
    await expect(c.locator('[data-testid="model-picker"]')).toBeHidden()
    await pill.click()
    await c.locator('[data-testid="model-default"]').click()
  })

  test('agent dropdown lists every agent in a fixed order, explains missing ones and fits a narrow window', async ({ page }) => {
    const c = await openChat(page)
    const pill = c.locator('[data-testid="model-pill"]')
    await expect(pill.locator('[data-testid="pill-agent"]')).toHaveAttribute('data-agent-badge', 'fake')
    await pill.click()
    const trigger = c.locator('[data-testid="agent-trigger"]')
    const list = c.locator('[data-testid="agent-list"]')
    const opts = c.locator('[data-testid="agent-option"]')
    // Closed by default: a compact trigger naming the current agent.
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toContainText('Test')
    await expect(list).toHaveCount(0)
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(list).toHaveAttribute('role', 'listbox')
    // A fixed order whether or not each CLI is installed; the test agent goes last.
    await expect(opts).toHaveCount(6)
    const ids = await opts.evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')))
    expect(ids).toEqual(['claude', 'codex', 'cursor', 'codebuddy', 'opencode', 'fake'])
    await expect(opts.last()).toHaveAttribute('aria-selected', 'true')
    // Every listed product shows its logo; only the test agent keeps a generic glyph.
    expect(await opts.evaluateAll((els) => els.map((e) => !!e.querySelector('svg.logo')))).toEqual([true, true, true, true, true, false])
    // A missing CLI shows how to install it instead of switching; the chat keeps its agent.
    const missing = c.locator('[data-testid="agent-option"].off').first()
    if (await missing.count()) {
      const id = (await missing.getAttribute('data-agent'))!
      await expect(missing).toContainText(/未安装|not installed/)
      await missing.click()
      await expect(list).toHaveCount(0)
      await expect(c.locator('[data-testid="agent-hint"]')).toContainText(`--${id}-path`)
      await expect(trigger).toContainText('Test')
      await expect(pill.locator('[data-testid="pill-agent"]')).toHaveAttribute('data-agent-badge', 'fake')
    }
    // Keyboard: Enter opens on the current agent, arrows move without wrapping, Escape closes the list only.
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(list).toBeFocused()
    await expect(list).toHaveAttribute('aria-activedescendant', 'ph-agent-fake')
    await page.keyboard.press('ArrowDown')
    await expect(list).toHaveAttribute('aria-activedescendant', 'ph-agent-fake')
    await page.keyboard.press('Home')
    await expect(list).toHaveAttribute('aria-activedescendant', 'ph-agent-claude')
    await page.keyboard.press('ArrowDown')
    await expect(list).toHaveAttribute('aria-activedescendant', 'ph-agent-codex')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(list).toHaveAttribute('aria-activedescendant', 'ph-agent-claude')
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(c.locator('[data-testid="model-picker"]')).toBeVisible()
    await page.keyboard.press(' ')
    await expect(list).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(list).toHaveCount(0)
    await expect(trigger).toContainText('Test')
    // Choosing an installed agent clears the install hint.
    await expect(c.locator('[data-testid="agent-hint"]')).toHaveCount(0)
    // A click elsewhere in the picker collapses the list and keeps the click: the search box gets focus,
    // and a model row below is still picked.
    await trigger.click()
    await expect(list).toBeVisible()
    await c.locator('[data-testid="model-search"]').click()
    await expect(list).toHaveCount(0)
    await expect(c.locator('[data-testid="model-search"]')).toBeFocused()
    await expect(c.locator('[data-testid="model-picker"]')).toBeVisible()
    await trigger.click()
    await expect(list).toBeVisible()
    await c.locator('[data-testid="model-option"][data-model="gpt-fake-5"]').click()
    await expect(c.locator('[data-testid="model-picker"]')).toBeHidden()
    await expect(pill).toContainText('GPT Fake 5')
    await pill.click()
    await c.locator('[data-testid="model-default"]').click()
    await expect(c.locator('[data-testid="model-picker"]')).toBeHidden()

    // Narrowest chat window: the pill drops the agent name but keeps the badge; the dropdown stays inside.
    const drawer = page.locator('page-harness-root .drawer')
    await drawer.evaluate((el) => Object.assign(el.style, { left: '40px', top: '120px', width: '320px', height: '640px', right: 'auto', bottom: 'auto' }))
    await expect(pill.locator('.ag')).toBeHidden()
    await expect(pill.locator('[data-testid="pill-agent"]')).toBeVisible()
    await pill.click()
    await trigger.click()
    const picker = c.locator('[data-testid="model-picker"]')
    const fits = await picker.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const rows = [...el.querySelectorAll('[data-testid="agent-option"]')]
      return r.left >= 0 && r.right <= innerWidth && rows.every((row) => row.getBoundingClientRect().right <= r.right + 0.5 && row.scrollWidth <= row.clientWidth + 1)
    })
    expect(fits).toBe(true)
    await page.keyboard.press('Escape')
  })
})

test.describe('Live edge cases', () => {
  test.beforeEach(() => resetFixture())
  test.afterEach(async ({ page }) => {
    await parkChat(page)
    const discard = lv(page, '.lv-ctrl button').filter({ hasText: 'Discard' })
    for (let i = 0; i < 5 && (await discard.count()); i++) {
      await discard.first().click()
      await page.waitForTimeout(500)
    }
    resetFixture()
  })

  test('a failed Live request shows the error with Retry and Discard', async ({ page }) => {
    await openChat(page)
    await dockButton(page, 'pick').click()
    await lv(page, '.lv-pickbar input').fill('make everything blue')
    await lv(page, '.lv-pickbar input').press('Enter')
    const ctrl = lv(page, '.lv-ctrl')
    await expect(ctrl.locator('.st.err')).toBeVisible()
    await expect(ctrl).toContainText('unsupported op steer')
    await expect(ctrl.locator('button', { hasText: 'Retry' })).toBeVisible()
    await parkChat(page)
    await ctrl.locator('button', { hasText: 'Discard' }).click()
    await expect(lv(page, '.lv-ctrl')).toHaveCount(0, { timeout: 15_000 })
  })

  test('the live bar clears failed sets without asking', async ({ page }) => {
    const c = await openChat(page)
    await dockButton(page, 'pick').click()
    await lv(page, '.lv-pickbar input').fill('make everything blue')
    await lv(page, '.lv-pickbar input').press('Enter')
    await expect(lv(page, '.lv-ctrl .st.err')).toBeVisible()
    let asked = false
    page.on('dialog', (d) => ((asked = true), d.dismiss()))
    await c.locator('[data-testid="live-clear-failed"]').click()
    await expect(c.locator('.livebar')).toBeHidden({ timeout: 15_000 })
    expect(asked).toBe(false)
  })

  test('discard all asks before dropping ready candidates', async ({ page }) => {
    const c = await openChat(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    await parkChat(page)
    await lv(page, '.lv-design .lv-foot button.primary').click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
    await expect(c.locator('[data-testid="live-clear-failed"]')).toHaveCount(0)
    const all = c.locator('[data-testid="live-discard-all"]')
    await expect(all).toHaveText('Discard all (1)')
    page.once('dialog', (d) => d.dismiss())
    await all.click()
    await expect(c.locator('.livebar')).toBeVisible()
    page.once('dialog', (d) => d.accept())
    await all.click()
    await expect(c.locator('.livebar')).toBeHidden({ timeout: 15_000 })
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
  })

  test('candidates that never mount offer Reload / Tell the agent', async ({ page }) => {
    const c = await openChat(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    await parkChat(page)
    await lv(page, '.lv-design .lv-foot button.primary').click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
    resetFixture()
    await expect(page.locator('[data-ph-live]')).toHaveCount(0, { timeout: 10_000 })
    const ctrl = lv(page, '.lv-ctrl')
    await expect(ctrl.locator('.st.err')).toHaveText('The candidates did not appear on the page', { timeout: 10_000 })
    await expect(ctrl.locator('button', { hasText: 'Reload' })).toBeVisible()
    await ctrl.locator('button', { hasText: 'Tell the agent' }).click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
    await expect(c.locator('.livebar')).toContainText('1 candidate set open')
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Discard' }).click()
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
  })

  test('the eye button hides candidates on click and restores them', async ({ page }) => {
    await openChat(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    await parkChat(page)
    await lv(page, '.lv-design .lv-foot button.primary').click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
    await dockButton(page, 'eye').click()
    await expect(page.locator('[data-ph-variant="0"]')).toBeVisible()
    await expect(page.locator('[data-ph-variant="1"]')).toBeHidden()
    await expect(lv(page, '.lv-ctrl')).toBeVisible()
    await dockButton(page, 'eye').click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible()
    await lv(page, '.lv-ctrl button').filter({ hasText: 'Discard' }).click()
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
  })

  test('Enter accepts the current candidate', async ({ page }) => {
    await openChat(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    await parkChat(page)
    await lv(page, '.lv-design .lv-foot button.primary').click()
    await expect(page.locator('[data-ph-variant="1"]')).toBeVisible({ timeout: 15_000 })
    await expect(lv(page, '.lv-ctrl .idx')).toHaveText('1/2')
    await page.mouse.click(5, 700)
    await page.keyboard.press('Enter')
    await expect.poll(() => projectFile()).not.toContain('data-ph-live=')
    expect(projectFile()).toContain('style="font-weight:800"')
  })
})

test.describe('history page actions', () => {
  test('continue in panel switches the open panel to that chat; delete removes it', async ({ page, context }) => {
    const c = await openChat(page)
    await send(c, 'chat to continue')
    await expect(c.locator('.turn .foot .st').last()).toHaveClass(/done/)
    await c.locator('[data-testid="chat-switcher"]').click()
    await c.locator('[data-testid="new-chat"]').click()
    await expect(c.locator('.turn')).toHaveCount(0)

    const h = await context.newPage()
    await h.goto(`${CONTROL}/__ph/history`)
    await h.locator('.item', { hasText: 'chat to continue' }).first().click()
    await h.locator('[data-testid="continue"]').click()
    await expect(h.locator('.hint')).toBeVisible()
    await expect(c.locator('.turn .user .text').first()).toHaveText('chat to continue')

    h.once('dialog', (d) => d.accept())
    await h.locator('header .btn.danger').click()
    await expect(h.locator('.item', { hasText: 'chat to continue' })).toHaveCount(0)
  })

  test('the dock stays usable while the history page is open in another tab', async ({ page, context }) => {
    await openChat(page)
    const h = await context.newPage()
    await h.goto(`${CONTROL}/__ph/history`)
    await page.bringToFront()
    await expect(dock(page)).toBeVisible()
    await expect(dockButton(page, 'chat')).toBeEnabled()
  })
})

test.describe('selection follows the page', () => {
  const rect = (page: Page, sel: string) =>
    page.evaluate((s) => {
      const root = document.querySelector('page-harness-root')!.shadowRoot!
      const el = root.querySelector<HTMLElement>(s)
      if (!el || el.hidden || getComputedStyle(el).visibility === 'hidden') return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }
    }, sel)
  const elRect = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }
  })
  const scrollPage = async (page: Page, y: number) => {
    await page.evaluate((v) => window.scrollTo(0, v), y)
    // The throttled reposition runs on the next frame; the pick highlight also has a 50ms transition.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.waitForTimeout(120)
  }
  async function setup(page: Page) {
    // No chat drawer: it would sit over the cards these tests click.
    await page.goto('/')
    await expect(dockButton(page, 'pick')).toBeEnabled()
    if (await page.locator('page-harness-root .drawer').isVisible()) await dockButton(page, 'chat').click()
    await page.evaluate(() => {
      document.body.style.paddingTop = '200px'
      document.body.style.paddingBottom = '2000px'
    })
  }

  test('the pick highlight and action bar track the element while the page scrolls', async ({ page }) => {
    await setup(page)
    await pickTitle(page)
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(3)
    for (const y of [0, 120, 160]) {
      await scrollPage(page, y)
      const el = await elRect(page, '.hero-title')
      const hl = (await rect(page, '.hl'))!
      near(hl.x, el.x - 2)
      near(hl.y, el.y - 2)
      near(hl.w, el.w + 4)
      const bar = (await rect(page, '[data-testid="pick-actions"]'))!
      near(bar.y, el.bottom + 8)
    }
    // Scrolled out of view: both hide, and come back when it returns.
    await scrollPage(page, 900)
    expect(await rect(page, '.hl')).toBeNull()
    expect(await rect(page, '[data-testid="pick-actions"]')).toBeNull()
    await scrollPage(page, 40)
    near((await rect(page, '.hl'))!.y, (await elRect(page, '.hero-title')).y - 2)
    await expect(page.locator('page-harness-root [data-testid="pick-actions"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  test('the comment form and its highlight follow the element; the header names it plainly', async ({ page }) => {
    await setup(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-comment"]').click()
    const form = page.locator('page-harness-root .rv-form')
    await expect(form.locator('.rv-tag')).toHaveText('h1')
    await expect(form.locator('.rv-desc')).toHaveText('Hello fixture')
    for (const y of [0, 100, 150]) {
      await scrollPage(page, y)
      const el = await elRect(page, '.hero-title')
      const hl = (await rect(page, '.rv-hl'))!
      expect(Math.abs(hl.y - (el.y - 3))).toBeLessThan(3)
      expect(Math.abs(hl.h - (el.h + 6))).toBeLessThan(3)
      const f = (await rect(page, '.rv-form'))!
      expect(Math.abs(f.y - (el.bottom + 6))).toBeLessThan(3)
    }
    // Out of view the highlight hides but the form stays on screen with what was typed.
    await form.locator('textarea').fill('keep me')
    await scrollPage(page, 900)
    expect(await rect(page, '.rv-hl')).toBeNull()
    const f = (await rect(page, '.rv-form'))!
    expect(f.y).toBeGreaterThanOrEqual(8)
    await expect(form.locator('textarea')).toHaveValue('keep me')
    await page.keyboard.press('Escape')
  })

  test('design candidates open beside the element, follow it, and read split text normally', async ({ page }) => {
    await setup(page)
    // A full-width heading split into one flex item per character, like animated hero text.
    await page.evaluate(() => {
      const h = document.createElement('h2')
      h.id = 'split'
      h.style.cssText = 'display:flex;font-size:26px;margin:16px 0'
      h.innerHTML = [...'Hi SkillHub 你好'].map((c) => `\n  <span style="display:inline-block;pointer-events:none">${c === ' ' ? '&nbsp;' : c}</span>`).join('') + '\n'
      document.querySelector('.hero')!.append(h)
    })
    await dockButton(page, 'pick').click()
    const s = await elRect(page, '#split')
    await page.mouse.move(s.x + 30, s.y + s.h / 2)
    await page.mouse.click(s.x + 30, s.y + s.h / 2)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    const design = lv(page, '.lv-design')
    await expect(design).toBeVisible()
    await expect(design.locator('.lv-target .tag')).toHaveText('h2')
    await expect(design.locator('.lv-target .txt')).toHaveText('Hi SkillHub 你好')
    // Too wide for either side: it opens just below the element instead of jumping to the top-right corner.
    const el = await elRect(page, '#split')
    const card = (await rect(page, '.lv-design'))!
    expect(Math.abs(card.y - (el.bottom + 12))).toBeLessThan(3)
    expect(Math.abs(card.x - el.x)).toBeLessThan(3)
    await scrollPage(page, 80)
    const el2 = await elRect(page, '#split')
    const card2 = (await rect(page, '.lv-design'))!
    expect(Math.abs(card2.y - (el2.bottom + 12))).toBeLessThan(3)
    await design.locator('.lv-foot button').filter({ hasText: 'Cancel' }).click()
    await expect(design).toBeHidden()
  })

  test('design candidates stay inside a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 760 })
    await setup(page)
    await pickTitle(page)
    await page.locator('page-harness-root [data-testid="pick-live"]').click()
    const design = lv(page, '.lv-design')
    await expect(design).toBeVisible()
    const card = (await rect(page, '.lv-design'))!
    expect(card.x).toBeGreaterThanOrEqual(12)
    expect(card.right).toBeLessThanOrEqual(390 - 12 + 0.5)
    expect(card.y).toBeGreaterThanOrEqual(12)
    await design.locator('.lv-foot button').filter({ hasText: 'Cancel' }).click()
  })
})
