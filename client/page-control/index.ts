// page-control.js — executes the agent's page_* commands in the controlled tab.
import { PageController } from '@page-agent/page-controller'
import { PAGE_CONTROL_VERSION, type PageCmd, type PageResult, type PageState } from '@shared/protocol'
import type { PageHost } from '../shared/page-host'

const MAX_ELEMENTS = 300
const MAX_CHARS = 20_000
const QUIET_MS = 500
const SETTLE_MAX_MS = 3000

const CSS = `
.ph-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none !important; z-index: 3; transition: transform .35s cubic-bezier(.2,.8,.2,1); filter: drop-shadow(0 2px 4px rgba(0,0,0,.35)); }
.ph-cursor svg { width: 22px; height: 22px; }
.ph-ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 2px solid var(--accent); pointer-events: none !important; animation: ph-ripple .5s ease-out forwards; }
@keyframes ph-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
.ph-mask { position: fixed; inset: 0; box-shadow: inset 0 0 0 4px color-mix(in srgb, var(--accent) 85%, transparent), inset 0 0 40px color-mix(in srgb, var(--accent) 25%, transparent); cursor: progress; }
@media (prefers-reduced-motion: reduce) { .ph-cursor { transition: none; } .ph-ripple { animation-duration: .01s; } }
`

function init(host: PageHost) {
  const style = document.createElement('style')
  style.textContent = CSS
  host.root.appendChild(style)
  const pc = new PageController({
    viewportExpansion: -1,
    highlightOpacity: 0,
    highlightLabelOpacity: 0,
    interactiveBlacklist: [() => host.hostEl],
  })
  let stateId: string | null = null
  let cursor: HTMLElement | null = null
  let mask: HTMLElement | null = null

  const showMask = (on: boolean) => {
    if (on && !mask) {
      mask = document.createElement('div')
      mask.className = 'ph-mask'
      for (const ev of ['pointerdown', 'mousedown', 'click', 'keydown', 'wheel', 'touchstart'] as const) mask.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
      host.layer.appendChild(mask)
    } else if (!on && mask) {
      mask.remove()
      mask = null
    }
  }

  const moveCursor = (el: Element | null, click: boolean) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = r.left + Math.min(r.width / 2, 40)
    const y = r.top + Math.min(r.height / 2, 20)
    if (!cursor) {
      cursor = document.createElement('div')
      cursor.className = 'ph-cursor'
      cursor.innerHTML =
        '<svg viewBox="0 0 24 24"><defs><linearGradient id="phg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#818cf8"/><stop offset="1" stop-color="#c026d3"/></linearGradient></defs><path d="M3 2l7 19 2.6-7.4L20 11z" fill="url(#phg)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
      host.layer.appendChild(cursor)
    }
    cursor.style.transform = `translate(${x}px, ${y}px)`
    if (click) {
      const rp = document.createElement('div')
      rp.className = 'ph-ripple'
      rp.style.left = `${x}px`
      rp.style.top = `${y}px`
      host.layer.appendChild(rp)
      setTimeout(() => rp.remove(), 600)
    }
  }

  const elementByIndex = (index: number): HTMLElement | null => {
    const map = (pc as unknown as { selectorMap?: Map<number, { ref?: HTMLElement }> }).selectorMap
    return map?.get(index)?.ref ?? null
  }

  const settle = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      let quiet: number
      const done = () => {
        clearTimeout(quiet)
        clearTimeout(max)
        mo.disconnect()
        resolve()
      }
      const mo = new MutationObserver(() => {
        clearTimeout(quiet)
        quiet = window.setTimeout(done, QUIET_MS)
      })
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      quiet = window.setTimeout(done, QUIET_MS)
      const max = window.setTimeout(done, SETTLE_MAX_MS)
      signal.addEventListener('abort', done, { once: true })
    })

  const readState = async (): Promise<PageState> => {
    host.setUiHidden(true)
    let bs
    try {
      bs = await pc.getBrowserState()
    } finally {
      host.setUiHidden(false)
      void pc.cleanUpHighlights()
    }
    let truncated = false
    const lines = bs.content.split('\n').map((l) =>
      /<input[^>]*type=password/i.test(l) ? l.replace(/\bvalue=("[^"]*"|\S+)/gi, 'value=[hidden]') : l,
    )
    let count = 0
    let cut = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[\d+\]</.test(lines[i]) && ++count > MAX_ELEMENTS) {
        cut = i
        truncated = true
        break
      }
    }
    let content = [bs.header, ...lines.slice(0, cut), truncated ? '' : bs.footer].filter(Boolean).join('\n')
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS)
      truncated = true
    }
    stateId = Math.random().toString(36).slice(2, 10)
    return { stateId, url: bs.url, title: bs.title, content, truncated }
  }

  const withNewTabWatch = async <T>(fn: () => Promise<T>): Promise<{ value: T; newTab: boolean }> => {
    let newTab = false
    const origOpen = window.open
    window.open = function (...args: Parameters<typeof window.open>) {
      newTab = true
      return origOpen.apply(window, args)
    }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[target]') as HTMLAnchorElement | null
      if (a && a.target && a.target !== '_self' && a.target !== '_parent' && a.target !== '_top') newTab = true
    }
    document.addEventListener('click', onClick, true)
    try {
      return { value: await fn(), newTab }
    } finally {
      window.open = origOpen
      document.removeEventListener('click', onClick, true)
    }
  }

  const run = async (cmd: PageCmd, signal: AbortSignal): Promise<PageResult> => {
    if (signal.aborted) return { ok: false, error: 'cancelled' }
    if (cmd.action === 'state') return { ok: true, state: await readState() }
    if (cmd.action !== 'scroll' && cmd.stateId !== stateId) {
      return { ok: false, error: 'This stateId is stale: the page changed since it was read. Call page_state again and use the new indexes.' }
    }
    showMask(true)
    try {
      let message = ''
      let note: string | undefined
      if (cmd.action === 'click') {
        moveCursor(elementByIndex(cmd.index), true)
        const { value, newTab } = await withNewTabWatch(() => pc.clickElement(cmd.index))
        if (!value.success) return { ok: false, error: value.message }
        message = value.message
        if (newTab) note = 'The click opened a new tab. That tab is not controlled; continue on this page or ask the user to open it here.'
      } else if (cmd.action === 'input') {
        const el = elementByIndex(cmd.index)
        moveCursor(el, true)
        const r = await pc.inputText(cmd.index, cmd.text)
        if (!r.success) return { ok: false, error: r.message }
        const secret = el instanceof HTMLInputElement && el.type === 'password'
        message = secret ? `Typed into element [${cmd.index}] (password, value hidden).` : r.message
      } else if (cmd.action === 'select') {
        moveCursor(elementByIndex(cmd.index), true)
        const r = await pc.selectOption(cmd.index, cmd.option)
        if (!r.success) return { ok: false, error: r.message }
        message = r.message
      } else if (cmd.action === 'scroll') {
        if (cmd.index !== undefined) moveCursor(elementByIndex(cmd.index), false)
        const r = await pc.scroll({ down: cmd.down, numPages: cmd.pages ?? 1, index: cmd.index })
        if (!r.success) return { ok: false, error: r.message }
        message = r.message
      }
      await settle(signal)
      if (signal.aborted) return { ok: false, error: 'cancelled' }
      return { ok: true, message, note, state: await readState() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      showMask(false)
      clearTimeout(cursorTimer)
      cursorTimer = window.setTimeout(() => {
        cursor?.remove()
        cursor = null
      }, 2500)
    }
  }
  let cursorTimer = 0

  window.__phPageControl = {
    version: PAGE_CONTROL_VERSION,
    run,
    dispose() {
      showMask(false)
      cursor?.remove()
      pc.dispose()
    },
  }
}

if (window.__phHost && !window.__phPageControl) init(window.__phHost)
