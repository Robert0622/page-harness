// live-overlay.js — Live candidates on the page: choose a target, design request, switch / compare /
// tune / accept / discard rendered variants. Loaded on demand by overlay.js.
import { LIVE_ACTIONS, LIVE_VERSION, type Lang, type LiveAction, type LiveChange, type LiveDisplay, type LiveRequest, type LiveSession, type Mark } from '@shared/protocol'
import { appearanceSelectors } from '@shared/review-read'
import { locate } from '../shared/anchor'
import { clip, describe, followLayout, placeBeside, prefersReducedMotion, selectorFor } from '../shared/dom'
import { createPatcher } from '../shared/patcher'
import { shotElement, snapshotHtml } from '../shared/snapshot'
import { pageStrings } from '../shared/i18n-page'
import type { PageHost } from '../shared/page-host'
import { LIVE_CSS } from './style'

interface View {
  current: number
  display: LiveDisplay
  params: Record<string, Record<string, string>>
}

interface ParamSpec {
  name: string
  type: 'range' | 'steps' | 'toggle'
  label?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: string[]
  default?: string | number | boolean
}

const VIEW_KEY = 'ph:live-view'
const BUSY = ['generating', 'refining', 'accepting', 'discarding']

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else el.setAttribute(k, v)
  }
  for (const k of kids) el.append(k)
  return el
}

function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', cls ? { class: cls } : {}, text)
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

function init(host: PageHost) {
  const style = document.createElement('style')
  style.textContent = LIVE_CSS
  host.root.appendChild(style)
  let t = pageStrings(host.lang())
  let sessions: LiveSession[] = []
  let picking = false
  let mode: 'select' | 'insert' = 'select'
  let views: Record<string, View> = {}
  try {
    views = JSON.parse(sessionStorage.getItem(VIEW_KEY) || '{}')
  } catch {}
  let peek = false
  let hideAll = false
  let focusSid: string | null = null
  const mountMissingSince = new Map<string, number>()
  const sameOrigin = (url?: string) => {
    try {
      return !!url && new URL(url, location.href).origin === location.origin
    } catch {
      return false
    }
  }

  const saveViews = () => {
    const keys = Object.keys(views)
    if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete views[k]
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify(views))
    } catch {}
  }
  const viewOf = (s: LiveSession): View => {
    let v = views[s.sid]
    if (!v) {
      v = views[s.sid] = {
        current: s.variants[0]?.index ?? 1,
        display: s.display,
        params: {},
      }
      saveViews()
    }
    if (s.variants.length && !s.variants.some((x) => x.index === v.current) && v.current !== 0) v.current = s.variants[0].index
    return v
  }
  const send = (request: LiveRequest) => host.send({ type: 'ph:live', request })
  const sendView = (s: LiveSession) => {
    const v = viewOf(s)
    host.send({
      type: 'ph:live-view',
      sid: s.sid,
      current: v.current,
      display: v.display,
    })
  }

  const ui = h('div', { class: 'lv-root' })
  host.layer.appendChild(ui)
  const ctrlLayer = h('div')
  const fxLayer = h('div')
  ui.append(fxLayer, ctrlLayer)

  // ---------- pick bar (select / insert / steer) ----------
  let pickbar: HTMLElement | null = null
  const renderPickbar = () => {
    pickbar?.remove()
    pickbar = null
    if (!picking) return
    if (host.patchMode()) mode = 'select'
    const seg = h('div', { class: 'lv-seg' })
    seg.append(button(t.modeSelect, () => ((mode = 'select'), renderPickbar()), mode === 'select' ? 'on' : ''))
    if (!host.patchMode()) seg.append(button(t.modeInsert, () => ((mode = 'insert'), renderPickbar()), mode === 'insert' ? 'on' : ''))
    const input = h('input', { placeholder: t.steerPlaceholder })
    const go = button(
      t.steerGo,
      () => {
        const prompt = input.value.trim()
        if (!prompt) return input.focus()
        send({
          op: 'steer',
          prompt,
          count: 3,
          display: 'inplace',
          url: location.href,
          scope: 'page',
        })
        input.value = ''
        host.setPicking(false)
      },
      'primary',
    )
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.isComposing) go.click()
    })
    pickbar = h('div', { class: 'lv-card lv-pickbar' }, seg, input, go)
    ui.appendChild(pickbar)
  }

  // ---------- popover after a pick ----------
  let pop: HTMLElement | null = null
  let unfollowPop: (() => void) | null = null
  const closePop = () => {
    pop?.remove()
    pop = null
    unfollowPop?.()
    unfollowPop = null
  }
  const placeNear = (card: HTMLElement, r: DOMRect, below = true) => {
    const cw = card.offsetWidth || 300
    const ch = card.offsetHeight || 40
    let x = Math.min(Math.max(8, r.left), innerWidth - cw - 8)
    let y = below ? r.bottom + 8 : r.top - ch - 8
    if (y + ch > innerHeight - 8) y = r.top - ch - 8
    if (y < 8) y = Math.min(innerHeight - ch - 8, r.bottom + 8)
    if (y < 8) y = 8
    x = Math.max(8, x)
    card.style.left = `${x}px`
    card.style.top = `${y}px`
  }

  const insideOpenWrapper = (el: Element) => {
    const w = el.closest('[data-ph-live]')
    if (!w) return false
    const sid = w.getAttribute('data-ph-live')
    return sessions.some((s) => s.sid === sid && s.status !== 'accepted' && s.status !== 'discarded')
  }

  const onPick = (el: Element): boolean => {
    closePop()
    if (insideOpenWrapper(el)) {
      host.toast('warn', t.blockedNested)
      return true
    }
    if (mode !== 'insert' || host.patchMode()) return false
    const r = el.getBoundingClientRect()
    pop = h(
      'div',
      { class: 'lv-card lv-pop' },
      button(t.before, () => (closePop(), openDesign(el, 'before'))),
      button(t.after, () => (closePop(), openDesign(el, 'after'))),
      button('✕', closePop),
    )
    ui.appendChild(pop)
    placeNear(pop, r)
    const card = pop
    unfollowPop = followLayout(() => placeNear(card, el.getBoundingClientRect()), [el])
    return true
  }

  // ---------- marks ----------
  let marks: Mark[] = []
  let marksLayer: HTMLElement | null = null
  const renderMarks = () => {
    marksLayer?.remove()
    marksLayer = null
    if (!marks.length || !design) return
    marksLayer = h('div', { class: 'lv-marks' })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const m of marks) {
      if (m.kind === 'stroke' && m.points) {
        const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
        pl.setAttribute('points', m.points.map((p) => p.join(',')).join(' '))
        pl.setAttribute('fill', 'none')
        pl.style.stroke = 'var(--err)'
        pl.setAttribute('stroke-width', '3')
        pl.setAttribute('stroke-linecap', 'round')
        pl.setAttribute('stroke-linejoin', 'round')
        svg.appendChild(pl)
      }
    }
    marksLayer.appendChild(svg)
    for (const m of marks) {
      const at = m.at ?? m.points?.[0]
      if (!at) continue
      const pin = h('div', { class: 'lv-pin' }, String(m.n))
      pin.style.left = `${at[0]}px`
      pin.style.top = `${at[1]}px`
      marksLayer.appendChild(pin)
    }
    fxLayer.appendChild(marksLayer)
  }
  const targetsAt = (pts: Array<[number, number]>): string[] => {
    const out = new Set<string>()
    host.setUiHidden(true)
    try {
      const step = Math.max(1, Math.floor(pts.length / 6))
      for (let i = 0; i < pts.length; i += step) {
        const el = document.elementsFromPoint(pts[i][0], pts[i][1]).find((e) => !host.isOwn(e) && e !== document.documentElement && e !== document.body)
        if (el) out.add(selectorFor(el))
        if (out.size >= 3) break
      }
    } finally {
      host.setUiHidden(false)
    }
    return [...out]
  }
  const askNote = (at: [number, number], m: Mark, done: () => void) => {
    const input = h('input', { placeholder: t.notePlaceholder })
    const card = h(
      'div',
      { class: 'lv-card lv-note' },
      input,
      button('✓', () => finish(), 'primary'),
    )
    const finish = () => {
      m.note = input.value.trim() || undefined
      card.remove()
      done()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.isComposing) finish()
      if (e.key === 'Escape') finish()
    })
    ui.appendChild(card)
    card.style.left = `${Math.min(at[0] + 14, innerWidth - 236)}px`
    card.style.top = `${Math.min(at[1] + 14, innerHeight - 50)}px`
    input.focus()
  }
  const startMarking = (kind: 'stroke' | 'pin', after: () => void) => {
    if (marks.length >= 8) return host.toast('warn', t.maxMarks)
    const layer = h('div', { class: 'lv-draw' })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    pl.setAttribute('fill', 'none')
    pl.style.stroke = 'var(--err)'
    pl.setAttribute('stroke-width', '3')
    svg.appendChild(pl)
    layer.appendChild(svg)
    layer.tabIndex = -1
    ui.appendChild(layer)
    layer.focus({ preventScroll: true })
    const pts: Array<[number, number]> = []
    const finish = (m: Mark | null) => {
      layer.remove()
      if (!m) return after()
      marks.push(m)
      renderMarks()
      askNote(m.at ?? m.points![0], m, () => {
        renderMarks()
        after()
      })
    }
    layer.addEventListener('keydown', (e) => e.key === 'Escape' && finish(null))
    if (kind === 'pin') {
      layer.addEventListener('click', (e) => {
        const at: [number, number] = [e.clientX, e.clientY]
        finish({
          n: marks.length + 1,
          kind: 'pin',
          at,
          targets: targetsAt([at]),
        })
      })
      return
    }
    layer.addEventListener('pointerdown', (e) => {
      layer.setPointerCapture(e.pointerId)
      pts.push([e.clientX, e.clientY])
      const move = (ev: PointerEvent) => {
        pts.push([ev.clientX, ev.clientY])
        pl.setAttribute('points', pts.map((p) => p.join(',')).join(' '))
      }
      const up = () => {
        layer.removeEventListener('pointermove', move)
        if (pts.length < 3) return finish(null)
        const simplified = pts.filter((_, i) => i % 2 === 0).slice(0, 200)
        finish({
          n: marks.length + 1,
          kind: 'stroke',
          points: simplified,
          targets: targetsAt(simplified),
        })
      }
      layer.addEventListener('pointermove', move)
      layer.addEventListener('pointerup', up, { once: true })
    })
  }

  /** Page Harness windows a card should keep clear of: the chat window and the dock. */
  const obstacles = () =>
    [...host.root.querySelectorAll<HTMLElement>('.drawer, .dock')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)

  // ---------- design panel ----------
  let design: HTMLElement | null = null
  let unfollowDesign: (() => void) | null = null
  const closeDesign = () => {
    design?.remove()
    design = null
    unfollowDesign?.()
    unfollowDesign = null
    marks = []
    renderMarks()
  }
  const openDesign = (el: Element, position?: 'before' | 'after') => {
    closeDesign()
    host.setPicking(false)
    const target = describe(el)
    let action: LiveAction = position ? 'freeform' : 'polish'
    let count = 3
    let display: LiveDisplay = 'inplace'
    const card = h('div', { class: 'lv-card lv-design' })
    const head = h('h4', {}, t.designTitle, h('span', { class: 'sp' }), button('✕', closeDesign, 'ghost icon'))
    // The element in words: tag as a small chip, then its text (or selector) in the UI font.
    const summary = h(
      'div',
      { class: 'lv-target', title: target.selector },
      ...(position ? [h('span', { class: 'pos' }, position === 'before' ? t.before : t.after)] : []),
      h('span', { class: 'tag' }, target.tagName.toLowerCase()),
      h('span', { class: 'txt' }, clip(target.text || target.selector, 80)),
    )
    const actions = h('div', { class: 'lv-actions' })
    const renderActions = () => {
      actions.replaceChildren(...LIVE_ACTIONS.map((a) => button(t.actions[a] ?? a, () => ((action = a), renderActions()), a === action ? 'on' : '')))
    }
    if (!position) renderActions()
    const prompt = h('textarea', {
      placeholder: position ? t.insertPlaceholder : t.promptPlaceholder,
      rows: '3',
    })
    prompt.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) submit()
    })
    const markCount = h('span', { class: 'sp' })
    const updateMarkCount = () => (markCount.textContent = marks.length ? `${marks.length}/8` : '')
    const marksRow = h(
      'div',
      { class: 'lv-row' },
      h('label', {}, t.marks),
      button(t.draw, () => startMarking('stroke', updateMarkCount)),
      button(t.pin, () => startMarking('pin', updateMarkCount)),
      markCount,
      button(t.undo, () => (marks.pop(), renderMarks(), updateMarkCount()), 'ghost'),
      button(t.clear, () => ((marks = []), renderMarks(), updateMarkCount()), 'ghost'),
    )
    const countRow = h('div', { class: 'lv-row' })
    const renderCount = () => {
      const counts = h('div', { class: 'lv-seg' }, ...[2, 3, 4].map((n) => button(String(n), () => ((count = n), renderCount()), n === count ? 'on' : '')))
      if (host.patchMode()) return countRow.replaceChildren(h('label', {}, t.count), counts)
      const displays = h(
        'div',
        { class: 'lv-seg' },
        button(t.inplace, () => ((display = 'inplace'), renderCount()), display === 'inplace' ? 'on' : ''),
        button(t.compare, () => ((display = 'compare'), renderCount()), display === 'compare' ? 'on' : ''),
      )
      countRow.replaceChildren(h('label', {}, t.count), counts, h('span', { class: 'sp' }), h('label', {}, t.display), displays)
    }
    renderCount()
    const submit = () => {
      const text = prompt.value.trim()
      if (position && !text) return prompt.focus()
      const req: LiveRequest = position
        ? {
            op: 'insert',
            target,
            position,
            prompt: text,
            count,
            display,
            marks: marks.length ? marks : undefined,
            url: location.href,
            scope: 'element',
          }
        : {
            op: 'generate',
            target,
            action,
            prompt: text || undefined,
            count,
            display,
            marks: marks.length ? marks : undefined,
            url: location.href,
            scope: 'element',
          }
      send(req)
      closeDesign()
    }
    const foot = h('div', { class: 'lv-foot' }, button(t.cancel, closeDesign), button(t.generate, submit, 'primary'))
    card.append(head, summary)
    if (!position) card.append(actions)
    card.append(prompt, marksRow, countRow, foot)
    design = card
    ui.appendChild(card)
    // Beside the element (right, left, below, above), and it keeps following the element as the page scrolls.
    const place = () => placeBeside(card, el.getBoundingClientRect(), { avoid: obstacles() })
    place()
    const unfollow = followLayout(place, [el, card])
    // Moving, opening or closing the chat window re-places the card so it is not left underneath.
    const drawerMo = new MutationObserver(place)
    const drawer = host.root.querySelector('.drawer')
    if (drawer) drawerMo.observe(drawer, { attributes: true, attributeFilter: ['style', 'hidden'] })
    unfollowDesign = () => (unfollow(), drawerMo.disconnect())
    prompt.focus()
  }

  // ---------- candidates on the page ----------
  const pathOf = (u?: string) => {
    if (!u) return ''
    try {
      const x = new URL(u, location.href)
      return x.pathname + x.search
    } catch {
      return u
    }
  }
  const onThisPage = (s: LiveSession) => !s.url || pathOf(s.url) === location.pathname + location.search
  const wrapperOf = (sid: string) => document.querySelector<HTMLElement>(`[data-ph-live="${CSS.escape(sid)}"]`)
  const variantsOf = (w: HTMLElement) => [...w.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-ph-variant'))
  const variantIndex = (el: Element) => Number(el.getAttribute('data-ph-variant'))
  const unionRect = (els: Element[]): DOMRect | null => {
    let l = Infinity,
      tp = Infinity,
      r = -Infinity,
      b = -Infinity
    for (const e of els) {
      const rc = e.getBoundingClientRect()
      if (!rc.width && !rc.height) continue
      l = Math.min(l, rc.left)
      tp = Math.min(tp, rc.top)
      r = Math.max(r, rc.right)
      b = Math.max(b, rc.bottom)
    }
    return l === Infinity ? null : new DOMRect(l, tp, r - l, b - tp)
  }

  const paramsOf = (el: HTMLElement | undefined): ParamSpec[] => {
    if (!el) return []
    try {
      const v = JSON.parse(el.getAttribute('data-ph-params') || '[]') as ParamSpec[]
      return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string' && /^[\w-]+$/.test(p.name)).slice(0, 6) : []
    } catch {
      return []
    }
  }
  const paramValue = (p: ParamSpec, set: Record<string, string>): string => {
    if (set[p.name] !== undefined) return set[p.name]
    if (p.type === 'toggle') return p.default === false || p.default === 'false' || p.default === 0 ? '0' : '1'
    if (p.type === 'steps') return String(p.default ?? p.options?.[0] ?? '')
    return String(p.default ?? p.min ?? 0)
  }

  // No-source candidates: the overlay applies the current candidate's page changes itself.
  const patcher = createPatcher()
  const isPatch = (s: LiveSession) => s.source === 'patch'
  const patchEls = new Map<string, HTMLElement[]>()
  const keyOf = (sid: string, index: number, c: LiveChange) => `${sid}:${index}:${c.selector}:${JSON.stringify(c.patch)}`
  const findChange = (c: LiveChange) => {
    const own = (el: Element) => host.isOwn(el)
    let el: Element | null =
      locate(c.selector, c.anchor, {
        isOwn: own,
        altTexts: c.patch.text !== undefined ? [c.patch.text] : [],
      })?.el ?? null
    // Candidates are short-lived: a selector that still matches beats a fingerprint taken from a changed page.
    if (!el)
      try {
        el = [...document.querySelectorAll(c.selector)].find((x) => !own(x)) ?? null
      } catch {}
    return el instanceof HTMLElement ? el : null
  }
  const reconcilePatch = (s: LiveSession) => {
    const v = viewOf(s)
    const active = onThisPage(s) && (s.status === 'ready' || s.status === 'refining')
    const show = active && !peek && !hideAll
    const current = active ? s.variants.find((x) => x.index === v.current) : undefined
    const wanted = new Set(show && current ? current.changes?.map((c) => keyOf(s.sid, current.index, c)) ?? [] : [])
    // Revert first (other candidates, a refine, or a hidden/peeked view) so the page can show the original.
    patcher.prune((k) => !k.startsWith(`${s.sid}:`) || wanted.has(k))
    const els: HTMLElement[] = []
    for (const c of current?.changes ?? []) {
      // Hide and peek drop the visible change. The target is still on the page: remember it
      // so an empty applied list is not reported as "element not found".
      const el = show ? patcher.ensure(keyOf(s.sid, current!.index, c), c.patch, () => findChange(c)) : findChange(c)
      if (el) els.push(el)
    }
    patchEls.set(s.sid, els)
    return els.length > 0
  }
  const dropPatches = (sid: string) => patcher.prune((k) => !k.startsWith(`${sid}:`))
  const mounted = (s: LiveSession) => (isPatch(s) ? !!patchEls.get(s.sid)?.length : !!wrapperOf(s.sid))

  /** Makes the DOM match the view state; cheap and idempotent (re-run after HMR re-renders). */
  const reconcile = (s: LiveSession) => {
    if (isPatch(s)) return reconcilePatch(s)
    const w = wrapperOf(s.sid)
    if (!w) return false
    const v = viewOf(s)
    const variants = variantsOf(w)
    const showOriginal = peek || hideAll
    for (const el of variants) {
      const i = variantIndex(el)
      let visible: boolean
      if (s.status === 'accepted' || s.status === 'discarded') visible = i === 0
      else if (showOriginal) visible = i === 0
      else if (v.display === 'compare') visible = true
      else visible = i === v.current
      if (el.hidden === visible) el.hidden = !visible
    }
    const cur = variants.find((el) => variantIndex(el) === v.current)
    const set = v.params[v.current] ?? {}
    for (const p of paramsOf(cur)) {
      const val = paramValue(p, set)
      const css = p.type === 'range' ? `${val}${p.unit ?? ''}` : val
      if (w.style.getPropertyValue(`--ph-${p.name}`) !== css) w.style.setProperty(`--ph-${p.name}`, css)
      if (w.getAttribute(`data-ph-param-${p.name}`) !== val) w.setAttribute(`data-ph-param-${p.name}`, val)
    }
    return true
  }

  const animateIn = (s: LiveSession) => {
    if (prefersReducedMotion()) return
    const w = isPatch(s) ? null : wrapperOf(s.sid)
    const cur = isPatch(s) ? patchEls.get(s.sid)?.[0] : w && variantsOf(w).find((el) => variantIndex(el) === viewOf(s).current)
    cur?.animate?.(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 180, easing: 'ease-out' },
    )
  }

  const go = (s: LiveSession, delta: number) => {
    const v = viewOf(s)
    const list = s.variants.map((x) => x.index)
    if (!list.length) return
    const i = list.indexOf(v.current)
    v.current = list[(i + delta + list.length) % list.length]
    v.display = 'inplace'
    saveViews()
    reconcile(s)
    animateIn(s)
    sendView(s)
    render()
  }
  const accept = (s: LiveSession) => {
    const v = viewOf(s)
    // The accepted changes come back as review items; they must start from the original page.
    // Capture the reader-facing before/after first (one shot for a whole list, not one per li).
    let looks: LiveRequest['looks']
    if (isPatch(s)) {
      const changes = s.variants.find((x) => x.index === v.current)?.changes ?? []
      const selectors = appearanceSelectors(changes)
      const after = new Map<string, string>()
      const elOf = (sel: string) => {
        const ch = changes.find((c) => c.selector === sel)
        const el = ch ? findChange(ch) : null
        return el ? shotElement(el) : null
      }
      for (const sel of selectors) {
        const el = elOf(sel)
        if (el) after.set(sel, snapshotHtml(el))
      }
      dropPatches(s.sid)
      patchEls.delete(s.sid)
      looks = []
      for (const sel of selectors) {
        const el = elOf(sel)
        const beforeHtml = el ? snapshotHtml(el) : undefined
        const afterHtml = after.get(sel)
        if (beforeHtml || afterHtml) looks.push({ selector: sel, look: { beforeHtml, afterHtml } })
      }
    }
    send({
      op: 'accept',
      sid: s.sid,
      variant: v.current,
      params: v.params[v.current],
      looks,
    })
  }

  let paramsCard: HTMLElement | null = null
  const openParams = (s: LiveSession, anchor: DOMRect) => {
    paramsCard?.remove()
    const w = wrapperOf(s.sid)
    const v = viewOf(s)
    const cur = w ? variantsOf(w).find((el) => variantIndex(el) === v.current) : undefined
    const specs = paramsOf(cur)
    if (!specs.length) return
    const set = (v.params[v.current] ??= {})
    const card = h('div', { class: 'lv-card lv-params' }, h('h4', {}, t.params))
    for (const p of specs) {
      const val = paramValue(p, set)
      const row = h('div', { class: 'p' })
      const out = h('span', {}, p.type === 'range' ? `${val}${p.unit ?? ''}` : val)
      row.append(h('div', { class: 'h' }, h('span', {}, p.label || p.name), out))
      const update = (nv: string) => {
        set[p.name] = nv
        out.textContent = p.type === 'range' ? `${nv}${p.unit ?? ''}` : nv
        saveViews()
        reconcile(s)
      }
      if (p.type === 'range') {
        const input = h('input', {
          type: 'range',
          min: String(p.min ?? 0),
          max: String(p.max ?? 100),
          step: String(p.step ?? 1),
          value: val,
        })
        input.addEventListener('input', () => update(input.value))
        row.append(input)
      } else if (p.type === 'steps') {
        const seg = h('div', { class: 'lv-seg' })
        const draw = () => seg.replaceChildren(...(p.options ?? []).map((o) => button(o, () => (update(o), draw()), (set[p.name] ?? val) === o ? 'on' : '')))
        draw()
        row.append(seg)
      } else {
        const b = button(
          '',
          () => {
            const nv = (set[p.name] ?? val) === '1' ? '0' : '1'
            update(nv)
            b.textContent = nv === '1' ? 'ON' : 'OFF'
            b.classList.toggle('on', nv === '1')
          },
          val === '1' ? 'on' : '',
        )
        b.textContent = val === '1' ? 'ON' : 'OFF'
        row.append(b)
      }
      card.append(row)
    }
    card.append(
      h(
        'div',
        { class: 'lv-foot' },
        button('✓', () => (card.remove(), (paramsCard = null))),
      ),
    )
    paramsCard = card
    ui.appendChild(card)
    placeNear(card, anchor)
  }

  const refineInputs = new Map<string, string>()

  /** Re-renders controls, shimmer and compare badges. Called on state changes and on scroll/resize. */
  let mountTimer = 0
  /**
   * Content of a control bar, without its position. Pages that animate inline styles re-render
   * many times a second; an unchanged bar keeps its node, so a press or hover in progress survives.
   */
  const ctrlSig = new WeakMap<Element, string>()
  const render = () => {
    const prev = new Map([...ctrlLayer.children].map((el) => [(el as HTMLElement).dataset.sid ?? '', el as HTMLElement]))
    const shown: HTMLElement[] = []
    fxLayer.querySelectorAll('.lv-shimmer, .lv-outline, .lv-badge').forEach((e) => e.remove())
    let anyMounted = false
    for (const s of sessions) {
      if (s.status === 'accepted' || s.status === 'discarded') continue
      const here = onThisPage(s)
      const patch = isPatch(s)
      const w = here && !patch ? wrapperOf(s.sid) : null
      const pEls = here && patch ? (patchEls.get(s.sid) ?? []) : []
      const isMounted = patch ? pEls.length > 0 : !!w
      const v = viewOf(s)
      const variants = w ? variantsOf(w) : []
      const visible = variants.filter((el) => !el.hidden)
      let rect = w ? unionRect(visible.length ? visible : variants) : pEls.length ? unionRect(pEls) : null
      if (!rect && here && s.target) {
        try {
          const el = document.querySelector(s.target.selector)
          if (el) rect = el.getBoundingClientRect()
        } catch {}
      }
      const busy = BUSY.includes(s.status)
      if (busy && rect) {
        const sh = h('div', { class: 'lv-shimmer' })
        Object.assign(sh.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        })
        fxLayer.appendChild(sh)
      }
      if (isMounted && s.status === 'ready') anyMounted = true
      if (w && s.status === 'ready' && v.display === 'compare' && !peek && !hideAll) {
        for (const el of variants) {
          const i = variantIndex(el)
          const r = el.getBoundingClientRect()
          if (!r.width && !r.height) continue
          const ol = h('div', { class: 'lv-outline' })
          Object.assign(ol.style, {
            left: `${r.left - 2}px`,
            top: `${r.top - 2}px`,
            width: `${r.width + 4}px`,
            height: `${r.height + 4}px`,
          })
          const label = i === 0 ? t.original : (s.variants.find((x) => x.index === i)?.label ?? `#${i}`)
          const badge = h('div', { class: 'lv-badge' }, `${i === 0 ? '' : `${i} · `}${label}`)
          Object.assign(badge.style, {
            right: `${innerWidth - r.right + 4}px`,
            top: `${Math.max(0, r.top + 4)}px`,
          })
          badge.addEventListener('click', () => {
            if (i === 0) return
            v.current = i
            v.display = 'inplace'
            saveViews()
            reconcile(s)
            sendView(s)
            render()
          })
          fxLayer.append(ol, badge)
        }
      }

      const ctrl = h('div', { class: 'lv-card lv-ctrl', 'data-sid': s.sid })
      const status = h('span', { class: `st ${busy ? 'busy' : s.status === 'failed' ? 'err' : ''}` }, (t as unknown as Record<string, string>)[`status_${s.status}`] ?? s.status)
      if (!here) {
        ctrl.append(
          status,
          h('span', { class: 'msg' }, t.otherRoute),
          button(t.goThere, () => sameOrigin(s.url) && (location.href = s.url!)),
          button(t.discard, () => send({ op: 'discard', sid: s.sid })),
        )
      } else if (s.status === 'failed') {
        ctrl.append(
          status,
          h('span', { class: 'msg', title: s.error ?? '' }, clip(s.error ?? '', 80)),
          button(t.retry, () => send({ op: 'retry', sid: s.sid })),
        )
        if (s.accepted !== undefined) ctrl.append(button(t.retryAccept, () => send({ op: 'retry', sid: s.sid, andAccept: true })))
        ctrl.append(button(t.discard, () => send({ op: 'discard', sid: s.sid })))
      } else if (busy) {
        ctrl.append(status, h('span', { class: 'lbl' }, clip(s.prompt || (s.action ? t.actions[s.action] : '') || '', 40)))
        if (s.status === 'generating' || s.status === 'refining') ctrl.append(button(t.discard, () => send({ op: 'discard', sid: s.sid })))
      } else if (s.status === 'ready' && !isMounted) {
        const since = mountMissingSince.get(s.sid) ?? Date.now()
        mountMissingSince.set(s.sid, since)
        if (Date.now() - since < 4000) {
          ctrl.append(status)
          clearTimeout(mountTimer)
          mountTimer = window.setTimeout(render, 4050 - (Date.now() - since))
        } else if (patch)
          ctrl.append(
            h('span', { class: 'st err' }, t.notFound),
            button(t.discard, () => send({ op: 'discard', sid: s.sid })),
          )
        else
          ctrl.append(
            h('span', { class: 'st err' }, t.notMounted),
            button(t.reload, () => location.reload()),
            button(t.tellAgent, () =>
              send({
                op: 'mount_failed',
                sid: s.sid,
                url: location.href,
                reason: 'wrapper [data-ph-live] not found in the DOM',
              }),
            ),
            button(t.discard, () => send({ op: 'discard', sid: s.sid })),
          )
      } else if (s.status === 'ready' && isMounted) {
        mountMissingSince.delete(s.sid)
        const n = s.variants.length
        const pos = s.variants.findIndex((x) => x.index === v.current)
        const label = s.variants[pos]?.label ?? ''
        const peekBtn = button(t.original, () => {})
        peekBtn.addEventListener('pointerdown', () => ((peek = true), reconcile(s)))
        const unpeek = () => {
          if (!peek) return
          peek = false
          reconcile(s)
          render()
        }
        peekBtn.addEventListener('pointerup', unpeek)
        peekBtn.addEventListener('pointerleave', unpeek)
        ctrl.append(
          button('‹', () => go(s, -1), 'icon'),
          h('span', { class: 'idx' }, `${pos + 1}/${n}`),
          button('›', () => go(s, 1), 'icon'),
          h('span', { class: 'lbl', title: label }, label),
          peekBtn,
        )
        if (!patch)
          ctrl.append(
            v.display === 'compare'
              ? button(t.inplace, () => ((v.display = 'inplace'), saveViews(), reconcile(s), sendView(s), render()))
              : button(t.compare, () => ((v.display = 'compare'), saveViews(), reconcile(s), sendView(s), render())),
          )
        const cur = variants.find((el) => variantIndex(el) === v.current)
        if (paramsOf(cur).length) ctrl.append(button(t.params, () => openParams(s, ctrl.getBoundingClientRect())))
        const refine = h('input', { placeholder: t.refinePlaceholder })
        refine.value = refineInputs.get(s.sid) ?? ''
        refine.addEventListener('input', () => refineInputs.set(s.sid, refine.value))
        refine.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.isComposing && refine.value.trim()) {
            send({
              op: 'refine',
              sid: s.sid,
              variant: v.current,
              prompt: refine.value.trim(),
            })
            refineInputs.delete(s.sid)
          }
        })
        refine.addEventListener('focus', () => (focusSid = s.sid))
        ctrl.append(
          refine,
          button(t.discard, () => send({ op: 'discard', sid: s.sid })),
          button(t.accept, () => accept(s), 'primary'),
        )
        ctrl.addEventListener('pointerenter', () => (focusSid = s.sid))
      } else continue
      ctrl.dataset.v = `${s.updatedAt}:${peek}:${hideAll}`
      const sig = `${ctrl.className}|${ctrl.dataset.v}|${ctrl.innerHTML}`
      const old = prev.get(s.sid)
      const node = old && ctrlSig.get(old) === sig ? old : ctrl
      ctrlSig.set(node, sig)
      const at = ctrlLayer.children[shown.length]
      if (at !== node) ctrlLayer.insertBefore(node, at ?? null)
      if (old && old !== node) old.remove()
      shown.push(node)
      if (rect) {
        const cw = node.offsetWidth
        const x = Math.min(Math.max(8, rect.right - cw), innerWidth - cw - 8)
        let y = rect.top - node.offsetHeight - 8
        if (y < 8) y = Math.min(rect.bottom + 8, innerHeight - node.offsetHeight - 80)
        node.style.left = `${x}px`
        node.style.top = `${Math.max(8, y)}px`
      } else {
        node.style.right = '16px'
        node.style.bottom = `${72 + shown.length * 44}px`
      }
    }
    for (const el of [...ctrlLayer.children]) if (!shown.includes(el as HTMLElement)) el.remove()
    host.setEye(anyMounted)
    // Keep focused inputs focused across re-renders.
    if (focusedRefine) {
      const el = ctrlLayer.querySelector<HTMLInputElement>(`.lv-ctrl[data-sid="${focusedRefine.sid}"] input`)
      if (el) {
        el.focus()
        el.setSelectionRange(focusedRefine.pos, focusedRefine.pos)
      }
    }
  }
  let focusedRefine: { sid: string; pos: number } | null = null
  const safeRender = () => {
    const active = host.root.activeElement as HTMLInputElement | null
    const card = active?.closest?.('.lv-ctrl') as HTMLElement | null
    focusedRefine = active && card && active.tagName === 'INPUT' ? { sid: card.dataset.sid!, pos: active.selectionStart ?? 0 } : null
    render()
    focusedRefine = null
  }

  const reconcileAll = () => {
    for (const s of sessions) if (onThisPage(s)) reconcile(s)
  }

  // DOM changes (HMR) reset `hidden`; re-apply and re-position.
  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      reconcileAll()
      safeRender()
    })
  }
  const mo = new MutationObserver((records) => {
    if (records.every((r) => host.isOwn(r.target as Element))) return
    if (sessions.some((s) => s.status !== 'accepted' && s.status !== 'discarded')) schedule()
  })
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'data-ph-live', 'data-ph-variant', 'style', 'src'],
  })
  addEventListener('scroll', schedule, true)
  addEventListener('resize', schedule)
  const tick = setInterval(() => sessions.some((s) => s.status === 'ready' || BUSY.includes(s.status)) && schedule(), 1000)

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const target = e.composedPath()[0] as HTMLElement | undefined
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    // Keys on focused page controls (links, buttons, carousels) belong to the page.
    const idle = !target || target === document.body || target === document.documentElement
    if (!idle && !(target.closest?.('.lv-ctrl') || (e.composedPath() as Element[]).some((n) => n instanceof Element && n.classList?.contains('lv-ctrl')))) return
    const ready = sessions.filter((s) => s.status === 'ready' && onThisPage(s) && mounted(s))
    const s = ready.find((x) => x.sid === focusSid) ?? ready[ready.length - 1]
    if (!s) return
    if (e.key === 'ArrowLeft') go(s, -1)
    else if (e.key === 'ArrowRight') go(s, 1)
    else if (e.key === 'Enter') accept(s)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  addEventListener('keydown', onKey, true)

  window.__phLive = {
    version: LIVE_VERSION,
    setSessions(list) {
      const prev = new Map(sessions.map((s) => [s.sid, s.status]))
      sessions = [...list].sort((a, b) => a.createdAt - b.createdAt)
      const open = new Set(sessions.filter((s) => isPatch(s) && s.status !== 'accepted' && s.status !== 'discarded').map((s) => s.sid))
      patcher.prune((k) => open.has(k.slice(0, k.indexOf(':'))))
      const live = new Set(sessions.filter((s) => s.status !== 'accepted' && s.status !== 'discarded').map((s) => s.sid))
      for (const m of [patchEls, mountMissingSince, refineInputs]) for (const sid of [...m.keys()]) if (!live.has(sid)) m.delete(sid)
      for (const s of sessions) {
        if (s.status === 'ready' && prev.get(s.sid) !== 'ready') {
          const v = viewOf(s)
          if (!s.variants.some((x) => x.index === v.current)) v.current = s.variants[0]?.index ?? 1
          saveViews()
          focusSid = s.sid
        }
      }
      reconcileAll()
      safeRender()
    },
    nav(sid, current, display) {
      const s = sessions.find((x) => x.sid === sid)
      if (!s) return
      const v = viewOf(s)
      if (current !== undefined) v.current = current
      if (display) v.display = display
      saveViews()
      reconcile(s)
      animateIn(s)
      safeRender()
      ;(isPatch(s) ? patchEls.get(sid)?.[0] : wrapperOf(sid))?.scrollIntoView?.({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
    },
    onPick,
    design: (el) => openDesign(el),
    setPicking(on) {
      picking = on
      if (!on) closePop()
      renderPickbar()
    },
    setLang(lang: Lang) {
      t = pageStrings(lang)
      renderPickbar()
      safeRender()
    },
    eye(kind) {
      if (kind === 'down') peek = true
      else if (kind === 'up') peek = false
      else hideAll = !hideAll
      reconcileAll()
      safeRender()
    },
    dispose() {
      mo.disconnect()
      clearInterval(tick)
      removeEventListener('scroll', schedule, true)
      removeEventListener('resize', schedule)
      removeEventListener('keydown', onKey, true)
      patcher.prune(() => false)
      ui.remove()
      style.remove()
    },
  }
}

if (window.__phHost && !window.__phLive) init(window.__phHost)
