import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientDir } from '../src/server/app'
import { Auth } from '../src/server/auth'
import { startHarness, type Harness } from '../src/server/harness'
import { freePort, staticServer, tempProject } from './helpers'

process.env.PH_FAKE_AGENT = '1'

const built = existsSync(path.join(clientDir(), 'app', 'panel.html'))

let h: Harness
let target: Awaited<ReturnType<typeof staticServer>>
let appPort: number
let controlPort: number

beforeAll(async () => {
  const project = tempProject()
  target = await staticServer(project)
  appPort = await freePort()
  controlPort = await freePort()
  h = await startHarness({ target: new URL(target.url), project, host: '127.0.0.1', appPort, controlPort, agent: 'fake', publicScheme: 'https' })
})

afterAll(async () => {
  await h?.close()
  await target?.close()
})

describe('--public-scheme https', () => {
  it('advertises https origins', () => {
    expect(h.appUrl).toBe(`https://localhost:${appPort}`)
    expect(h.controlUrl).toBe(`https://localhost:${controlPort}`)
  })

  it('treats a Host header without a port as 443', () => {
    const auth = new Auth({ host: '127.0.0.1', appPort: 443, controlPort: 17991, extraHosts: ['ph.example'], publicScheme: 'https' })
    const req = (host: string) => ({ headers: { host } }) as Parameters<Auth['checkHost']>[0]
    expect(auth.checkHost(req('ph.example'), 443)).toBe(true)
    expect(auth.checkHost(req('ph.example:17991'), 17991)).toBe(true)
    expect(auth.checkHost(req('ph.example'), 80)).toBe(false)
  })

  it('issues a Secure session cookie and accepts writes only from the https origin', async () => {
    const r = await fetch(`http://localhost:${controlPort}/__ph/ui`)
    const setCookie = r.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/; Secure/)
    const cookie = setCookie.split(';')[0]
    const post = (origin: string) =>
      fetch(`http://localhost:${controlPort}/__ph/api/chats`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-PH': '1', 'Content-Type': 'application/json' }, body: '{}' })
    expect((await post(`http://localhost:${controlPort}`)).status).toBe(403)
    expect((await post(`https://localhost:${controlPort}`)).status).not.toBe(403)
  })

  it.skipIf(!built)('points the overlay and the panel CSP at https / wss', async () => {
    const js = await (await fetch(`http://localhost:${appPort}/__ph/overlay.js`)).text()
    expect(js).toContain(`"controlOrigin":"https://localhost:${controlPort}"`)
    const csp = (await fetch(`http://localhost:${controlPort}/__ph/ui`)).headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`frame-ancestors https://localhost:${appPort}`)
    expect(csp).toContain(`wss://localhost:${controlPort}`)
  })
})
