// Reroutes the page's requests to the target's own origin and its sibling subdomains (api.example.com)
// through the proxy, so APIs whose CORS policy only trusts the real site keep working on localhost.

const PREFIX = '/__ph/relay/'

export function installRelay(target: string | undefined, site: string | null | undefined) {
  if (!target || window.__phRelay) return
  window.__phRelay = true

  const rewrite = (input: string | URL): string | URL => {
    let u: URL
    try {
      u = new URL(String(input), location.href)
    } catch {
      return input
    }
    if (u.origin === location.origin || !/^(https?|wss?):$/.test(u.protocol)) return input
    const http = u.protocol === 'wss:' ? 'https' : u.protocol === 'ws:' ? 'http' : u.protocol.slice(0, -1)
    const ws = u.protocol.startsWith('ws')
    const base = (ws ? location.origin.replace(/^http/, 'ws') : location.origin)
    if (u.host === target) return base + u.pathname + u.search + u.hash
    if (!site || (u.hostname !== site && !u.hostname.endsWith('.' + site))) return input
    return `${base}${PREFIX}${http}/${u.host}${u.pathname}${u.search}${u.hash}`
  }

  const origFetch = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (input instanceof Request) {
      const next = rewrite(input.url)
      return origFetch.call(this, next === input.url ? input : new Request(String(next), input), init)
    }
    return origFetch.call(this, rewrite(input), init)
  }

  const open = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...a: unknown[]) => void
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    return open.call(this, method, rewrite(url), ...rest)
  } as typeof XMLHttpRequest.prototype.open

  const wrapCtor = <T extends abstract new (...a: never[]) => unknown>(C: T): T =>
    new Proxy(C, {
      construct(Target, args: unknown[], newTarget) {
        if (args.length) args[0] = rewrite(args[0] as string | URL)
        return Reflect.construct(Target, args, newTarget) as object
      },
    })
  if (window.EventSource) window.EventSource = wrapCtor(window.EventSource)
  if (window.WebSocket) window.WebSocket = wrapCtor(window.WebSocket)

  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url, data) => beacon(rewrite(url), data)
  }
}
