/**
 * @vitest-environment happy-dom
 * Plan coverage: g4.1 g4.2 — thinking blocks collapse after the turn ends.
 */
import { createApp, h, nextTick, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { TurnItem, TurnView } from '@shared/protocol'
import TurnBlock from './TurnBlock.vue'
import { setLang } from '../lib/i18n'

function turn(status: TurnView['status'], items: TurnItem[], id = 't1'): TurnView {
  return {
    id,
    ts: 1,
    user: { text: 'hi', attachments: [], picks: [] },
    agent: 'cursor',
    items,
    status,
    files: [],
    artifacts: [],
    lastSeq: items.length,
  }
}

function mount(initial: TurnView) {
  const state = reactive({ turn: initial, now: 1 })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({
    setup() {
      return () => h(TurnBlock, { turn: state.turn, interactive: true, now: state.now })
    },
  })
  app.mount(el)
  return {
    state,
    el,
    async flush() {
      await nextTick()
    },
    unmount() {
      app.unmount()
      el.remove()
    },
  }
}

const thinking = (text: string): TurnItem => ({ kind: 'thinking', text })
const reply = (text: string): TurnItem => ({ kind: 'text', text })
const blocks = (el: HTMLElement) => [...el.querySelectorAll<HTMLDetailsElement>('details.thinking')]

describe('thinking collapse (g4)', () => {
  it('stays open while generating as the last block, then collapses when the turn ends (g4.1)', async () => {
    const view = mount(turn('running', [thinking('planning the change')]))
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(true)

    view.state.turn = turn('done', [thinking('planning the change'), reply('done')])
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(false)
    expect(blocks(view.el)[0].textContent).toContain('planning the change')

    for (const status of ['interrupted', 'error', 'cancelled'] as const) {
      view.state.turn = turn('running', [thinking('still going')])
      await view.flush()
      expect(blocks(view.el)[0].open).toBe(true)
      view.state.turn = turn(status, [thinking('still going')])
      await view.flush()
      expect(blocks(view.el)[0].open).toBe(false)
    }
    view.unmount()
  })

  it('keeps a manual expand after the default collapse, including across re-renders (g4.2)', async () => {
    const view = mount(turn('done', [thinking('first'), reply('answer'), thinking('second')]))
    await view.flush()
    const [first, second] = blocks(view.el)
    expect(first.open).toBe(false)
    expect(second.open).toBe(false)

    first.querySelector('summary')!.click()
    await view.flush()
    expect(first.open).toBe(true)
    expect(second.open).toBe(false)

    view.state.now = 2
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(true)
    expect(blocks(view.el)[1].open).toBe(false)

    blocks(view.el)[0].querySelector('summary')!.click()
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(false)
    view.unmount()
  })

  it('opens a finished turn from history collapsed (g4.2)', async () => {
    setLang('zh-CN')
    const view = mount(turn('done', [thinking('already finished'), reply('visible answer')], 'history'))
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(false)
    expect(view.el.textContent).toContain('思考过程')
    view.unmount()
  })

  it('collapses a thinking block once it is no longer the last block while still generating (g4.1)', async () => {
    const view = mount(turn('running', [thinking('early'), reply('partial')]))
    await view.flush()
    expect(blocks(view.el)[0].open).toBe(false)
    view.unmount()
  })
})
