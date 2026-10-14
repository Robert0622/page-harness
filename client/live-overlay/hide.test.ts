/**
 * @vitest-environment happy-dom
 * Plan coverage: g3.1 g3.2 — hiding a review-mode candidate keeps the target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSession } from '@shared/protocol'
import type { PageHost } from '../shared/page-host'

vi.useFakeTimers()

const eye = { visible: false }
let root: ShadowRoot

function session(selector = '#hero', status: LiveSession['status'] = 'ready'): LiveSession {
  return {
    sid: 's1',
    chatId: 'c1',
    source: 'patch',
    kind: 'generate',
    status,
    display: 'inplace',
    count: 1,
    variants: [{ index: 1, label: '动效', changes: [{ selector, patch: { text: 'Pop' } }] }],
    createdAt: 1,
    updatedAt: 1,
  }
}

async function boot() {
  window.__phLive?.dispose()
  delete window.__phLive
  vi.resetModules()
  document.body.innerHTML = '<h1 id="hero">Hello</h1>'
  document.querySelector('page-harness-root')?.remove()
  const hostEl = document.createElement('page-harness-root')
  root = hostEl.attachShadow({ mode: 'open' })
  const layer = document.createElement('div')
  layer.className = 'layer'
  root.append(layer)
  document.documentElement.append(hostEl)
  eye.visible = false
  const host: PageHost = {
    root,
    layer,
    hostEl,
    send: () => {},
    toast: () => {},
    lang: () => 'zh-CN',
    theme: () => 'light',
    setUiHidden: () => {},
    setEye: (visible) => {
      eye.visible = visible
    },
    setPicking: () => {},
    isOwn: (el) => !!el && (el === hostEl || hostEl.contains(el)),
    patchMode: () => true,
  }
  window.__phHost = host
  await import('./index')
}

const hero = () => document.getElementById('hero')!
const ctrlText = () => root.querySelector('.lv-ctrl')?.textContent ?? ''

beforeEach(async () => {
  await boot()
})

afterEach(() => {
  window.__phLive?.dispose()
  delete window.__phLive
})

describe('hide candidate without losing the element (g3)', () => {
  it('reverts the page while hidden or peeked, keeps 候选, and restores the same change (g3.1, g3.2)', async () => {
    window.__phLive!.setSessions([session()])
    expect(hero().textContent).toBe('Pop')
    expect(eye.visible).toBe(true)
    expect(ctrlText()).not.toContain('页面上找不到这个元素')

    window.__phLive!.eye('down')
    expect(hero().textContent).toBe('Hello')
    expect(eye.visible).toBe(true)
    expect(ctrlText()).not.toContain('页面上找不到这个元素')
    await vi.advanceTimersByTimeAsync(5000)
    expect(hero().textContent).toBe('Hello')
    expect(ctrlText()).not.toContain('页面上找不到这个元素')

    window.__phLive!.eye('up')
    expect(hero().textContent).toBe('Pop')
    expect(eye.visible).toBe(true)

    window.__phLive!.eye('click')
    expect(hero().textContent).toBe('Hello')
    expect(eye.visible).toBe(true)
    expect(ctrlText()).not.toContain('页面上找不到这个元素')
    await vi.advanceTimersByTimeAsync(5000)
    expect(eye.visible).toBe(true)
    expect(ctrlText()).not.toContain('页面上找不到这个元素')

    window.__phLive!.eye('click')
    expect(hero().textContent).toBe('Pop')
    expect(eye.visible).toBe(true)
  })

  it('still reports a selector that matches nothing, and still allows discard (g3.2)', async () => {
    window.__phLive!.setSessions([session('#missing')])
    expect(eye.visible).toBe(false)
    expect(ctrlText()).not.toContain('页面上找不到这个元素')
    await vi.advanceTimersByTimeAsync(4100)
    expect(ctrlText()).toContain('页面上找不到这个元素')
    expect(ctrlText()).toContain('放弃')
    expect(eye.visible).toBe(false)
  })
})
