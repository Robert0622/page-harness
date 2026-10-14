import { describe, expect, it } from 'vitest'
import { PAGE_MESSAGES, PageBridge } from '../src/server/pageBridge'
import type { PageCmd } from '../src/shared/protocol'

interface Fake {
  id: string
  chatId: string | null
  sent: Record<string, unknown>[]
  send(msg: unknown): void
}

function conn(id: string, chatId = 'c1'): Fake {
  const f: Fake = { id, chatId, sent: [], send: (m) => f.sent.push(m as Record<string, unknown>) }
  return f
}

function page(bridge: PageBridge, id: string, tab: string, visible = true): Fake {
  const c = conn(id)
  bridge.attach(c)
  bridge.update(id, { on: true, attached: true, visible, tab, version: 1 })
  return c
}

const STATE: PageCmd = { action: 'state' } as PageCmd

function lastOf(c: Fake, type: string) {
  return [...c.sent].reverse().find((m) => m.type === type)
}

async function answer(bridge: PageBridge, c: Fake, run: Promise<unknown>) {
  await Promise.resolve()
  const cmd = lastOf(c, 'page_cmd')
  expect(cmd).toBeTruthy()
  bridge.result(c.id, cmd!.id as string, { ok: true } as never)
  return run
}

describe('PageBridge pinning', () => {
  it('without a pin, the most recently activated visible tab wins', async () => {
    const bridge = new PageBridge()
    const a = page(bridge, 'a', 'tabA')
    await new Promise((r) => setTimeout(r, 2))
    const b = page(bridge, 'b', 'tabB')
    const run = bridge.run('c1', STATE)
    await answer(bridge, b, run)
    expect(lastOf(a, 'page_cmd')).toBeUndefined()
  })

  it('keeps sending to the pinned tab after another tab comes to the front', async () => {
    const bridge = new PageBridge()
    const a = page(bridge, 'a', 'tabA')
    bridge.pin('c1', 'tabA')
    await new Promise((r) => setTimeout(r, 2))
    const b = page(bridge, 'b', 'tabB')
    const run = bridge.run('c1', STATE)
    await answer(bridge, a, run)
    expect(lastOf(b, 'page_cmd')).toBeUndefined()
    expect(lastOf(b, 'page_status')?.status).toBe('transferred')
    expect(lastOf(a, 'page_status')?.status).toBe('online')
  })

  it('probes only the pinned tab', async () => {
    const bridge = new PageBridge()
    const a = page(bridge, 'a', 'tabA')
    await new Promise((r) => setTimeout(r, 2))
    const b = page(bridge, 'b', 'tabB')
    bridge.pin('c1', 'tabA')
    const probe = bridge.probe('c1', '#x')
    const msg = lastOf(a, 'page_probe')
    expect(msg).toBeTruthy()
    expect(lastOf(b, 'page_probe')).toBeUndefined()
    bridge.probeResult('a', msg!.id as string, { count: 1, url: 'http://x/tutorials' })
    expect((await probe)?.url).toBe('http://x/tutorials')
  })

  it('does not fall back to another tab when the pinned one is gone', async () => {
    const bridge = new PageBridge()
    page(bridge, 'a', 'tabA')
    const b = page(bridge, 'b', 'tabB')
    bridge.pin('c1', 'tabA')
    bridge.detach('a')
    const r = await bridge.run('c1', STATE)
    expect(r).toEqual({ ok: false, error: PAGE_MESSAGES.pinnedGone })
    expect(lastOf(b, 'page_cmd')).toBeUndefined()
    expect(await bridge.probe('c1', '#x')).toBeNull()
  })

  it('a reload of the pinned tab keeps receiving commands', async () => {
    const bridge = new PageBridge()
    page(bridge, 'a', 'tabA')
    page(bridge, 'b', 'tabB')
    bridge.pin('c1', 'tabA')
    bridge.detach('a')
    const a2 = page(bridge, 'a2', 'tabA')
    await answer(bridge, a2, bridge.run('c1', STATE))
  })

  it('unpin restores last-foreground routing', async () => {
    const bridge = new PageBridge()
    page(bridge, 'a', 'tabA')
    await new Promise((r) => setTimeout(r, 2))
    const b = page(bridge, 'b', 'tabB')
    bridge.pin('c1', 'tabA')
    bridge.unpin('c1')
    await answer(bridge, b, bridge.run('c1', STATE))
  })

  it('tabOf reports the tab a connection sent', () => {
    const bridge = new PageBridge()
    page(bridge, 'a', 'tabA')
    expect(bridge.tabOf('a')).toBe('tabA')
    expect(bridge.tabOf('missing')).toBe('')
  })
})
