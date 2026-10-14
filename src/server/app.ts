// Two listeners:
//   app port      the proxied frontend plus the injected page scripts (/__ph/overlay.js …)
//   control port  panel UI, history page, JSON API, WebSocket and the agent MCP endpoint
// The panel runs on its own origin so scripts of the target page cannot read or drive it.
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AgentRegistry } from '../agents'
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import { REVIEW_PAGE_SIZE } from '../shared/review-read'
import { newId } from '../shared/util'
import type { ArtifactStore } from './artifacts'
import type { Auth, Who } from './auth'
import type { Gateway } from './gateway'
import { OVERLAY_PATH } from './inject'
import type { LiveManager } from './live'
import { LiveError } from './live'
import { log } from './log'
import { handleMcp } from './mcp'
import { createProxy, RELAY_PREFIX } from './proxy'
import type { Uploads } from './uploads'
import { MAX_UPLOAD_BYTES } from './uploads'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

export function clientDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'client'), path.join(here, '..', 'client'), path.join(here, '..', '..', 'dist', 'client')]
  return candidates.find((d) => existsSync(path.join(d, 'page', 'overlay.js'))) ?? candidates[0]
}

export interface AppOptions {
  target: URL
  host: string
  appPort: number
  controlPort: number
  project: string
  auth: Auth
  gateway: Gateway
  registry: AgentRegistry
  artifacts: ArtifactStore
  uploads: Uploads
  live: LiveManager
  keepHost?: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function hostname(req: IncomingMessage): string {
  const h = req.headers.host ?? 'localhost'
  const m = /^(\[[^\]]+\]|[^:]+)/.exec(h)
  return m ? m[1] : 'localhost'
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
  res.end(body)
}

function json(res: ServerResponse, data: unknown, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8')
}

/** Positive integer query param. Missing uses the default; anything else is invalid. */
function positiveInt(raw: string | null, dflt: number): number | null {
  if (raw === null || raw === '') return dflt
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 ? n : null
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody<T>(req: IncomingMessage, limit = 1 << 20): Promise<T> {
  const buf = await readBody(req, limit)
  if (!buf.length) return {} as T
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

function serveFile(res: ServerResponse, file: string, extra: Record<string, string> = {}, cache = 'no-cache') {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found')
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  })
  createReadStream(file).pipe(res)
}

export interface Servers {
  app: Server
  control: Server
  close(): Promise<void>
}

export async function startServers(o: AppOptions): Promise<Servers> {
  const dir = clientDir()
  const pageDir = path.join(dir, 'page')
  const appDir = path.join(dir, 'app')
  const controlOrigin = (req: IncomingMessage) => o.auth.origin(hostname(req), o.controlPort)
  const appOrigin = (req: IncomingMessage) => o.auth.origin(hostname(req), o.appPort)
  const proxy = createProxy({ target: o.target, cookieName: o.auth.cookieName, controlOrigin, keepHost: o.keepHost, scheme: o.auth.scheme })

  // ---------- app port ----------
  const pageScripts: Record<string, string> = {
    [OVERLAY_PATH]: 'overlay.js',
    '/__ph/page-control.js': 'page-control.js',
    '/__ph/live-overlay.js': 'live-overlay.js',
  }
  const app = http.createServer((req, res) => {
    try {
      serveApp(req, res)
    } catch (e) {
      log.error('app request failed', e)
      if (!res.headersSent) send(res, 500, 'page-harness: internal error')
      else res.end()
    }
  })
  const serveApp = (req: IncomingMessage, res: ServerResponse) => {
    if (!o.auth.checkHost(req, o.appPort)) return send(res, 421, 'page-harness: unexpected Host header')
    if (!o.auth.allowApp(req)) return noAccess(res, 'Open this page with the invite link from the person running Page Harness.<br>请使用 Page Harness 发起人分享的邀请链接打开。')
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/__ph/')) {
      if (url.pathname.startsWith(RELAY_PREFIX)) {
        if (!proxy.relay(req, res)) send(res, 403, 'page-harness: relay only reaches subdomains of the target site')
        return
      }
      const file = pageScripts[url.pathname]
      if (!file || req.method !== 'GET') return send(res, 404, 'not found')
      const p = path.join(pageDir, file)
      if (!existsSync(p)) return send(res, 503, `/* page-harness: ${file} missing, run npm run build */`, 'text/javascript')
      let body = readFileSync(p, 'utf8')
      if (file === 'overlay.js') body = `window.__PH_CONFIG=${JSON.stringify({ controlOrigin: controlOrigin(req), appPort: o.appPort, target: o.target.host, relay: proxy.site })};\n` + body
      return send(res, 200, body, 'text/javascript; charset=utf-8', { 'Cross-Origin-Resource-Policy': 'same-origin' })
    }
    proxy.handle(req, res)
  }
  app.on('upgrade', (req, socket, head) => {
    try {
      const u = req.url ?? ''
      if (!o.auth.checkHost(req, o.appPort) || !o.auth.allowApp(req) || (u.startsWith('/__ph/') && !u.startsWith(RELAY_PREFIX))) return socket.destroy()
      proxy.upgrade(req, socket, head)
    } catch (e) {
      log.error('app upgrade failed', e)
      socket.destroy()
    }
  })

  // ---------- control port ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 })
  const panelCsp = (req: IncomingMessage, ancestors: string) =>
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${o.auth.scheme === 'https' ? 'wss' : 'ws'}://${req.headers.host}`,
      "frame-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${ancestors}`,
    ].join('; ')

  const noAccess = (res: ServerResponse, text: string) =>
    send(res, 403, `<!doctype html><meta charset="utf-8"><title>Page Harness</title><body style="font:14px/1.6 system-ui,sans-serif;padding:24px;color:#444">${text}</body>`, 'text/html; charset=utf-8', {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    })

  const servePage = (req: IncomingMessage, res: ServerResponse, page: 'panel' | 'history') => {
    const file = path.join(appDir, `${page}.html`)
    const who = o.auth.issuePageSession(req, res)
    if (!who) return noAccess(res, 'Open this page with the invite link from the person running Page Harness.<br>请使用 Page Harness 发起人分享的邀请链接打开。')
    if (page === 'history' && who.access !== 'owner') return noAccess(res, 'Chat history is only available to the person running Page Harness.<br>对话记录仅发起人可见。')
    if (!existsSync(file)) return send(res, 503, 'page-harness: client build missing, run npm run build')
    const html = readFileSync(file, 'utf8').replace('<html', `<html data-app-origin="${appOrigin(req)}"`)
    send(res, 200, html, 'text/html; charset=utf-8', {
      'Content-Security-Policy': panelCsp(req, page === 'panel' ? appOrigin(req) : "'none'"),
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': page === 'history' ? 'same-origin' : 'unsafe-none',
    })
  }

  const api = createApi(o)

  const control = http.createServer(async (req, res) => {
    try {
      if (!o.auth.checkHost(req, o.controlPort)) return send(res, 421, 'page-harness: unexpected Host header')
      const url = new URL(req.url ?? '/', 'http://x')
      const p = url.pathname
      if (p === '/__ph/mcp') {
        const r = o.auth.checkMcp(req)
        if ('error' in r) return json(res, { jsonrpc: '2.0', error: { code: -32001, message: r.error }, id: null }, 401)
        const body = req.method === 'POST' ? await readJsonBody(req, 32 << 20) : undefined
        return await handleMcp(o.gateway.toolHost(), r.scope, req, res, body)
      }
      if (p === '/' || p === '/__ph' || p === '/__ph/') {
        res.writeHead(302, { Location: '/__ph/history' })
        return res.end()
      }
      if (p === '/__ph/join' && req.method === 'GET') {
        const who = o.auth.joinWithInvite(req, res, url.searchParams.get('t') ?? '')
        if (!who) return noAccess(res, 'This invite link is not valid (sharing may be off).<br>邀请链接无效，可能对方已关闭分享。')
        res.writeHead(302, { Location: `${appOrigin(req)}/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
        return res.end()
      }
      if (p === '/__ph/ui' && req.method === 'GET') return servePage(req, res, 'panel')
      if (p === '/__ph/history' && req.method === 'GET') return servePage(req, res, 'history')
      if (p.startsWith('/__ph/app/') && req.method === 'GET') {
        const rel = decodeURIComponent(p.slice('/__ph/app/'.length))
        const file = path.resolve(appDir, rel)
        if (!file.startsWith(appDir + path.sep) || rel.endsWith('.html')) return send(res, 404, 'not found')
        return serveFile(res, file, {}, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      }
      if (req.method === 'GET' && p === '/__ph/api/review') return serveReviewPage(o.gateway, res, url)
      if (req.method === 'POST' && p === '/__ph/api/review/resolve') return await serveReviewResolve(o.gateway, req, res)
      if (p.startsWith('/__ph/api/')) {
        const err = o.auth.checkUi(req)
        if (err) return json(res, { error: err }, 403)
        const who = o.auth.identify(req)!
        if (who.access !== 'owner' && !(req.method === 'GET' && url.pathname.startsWith('/__ph/api/artifacts'))) return json(res, { error: 'reviewers cannot use this' }, 403)
        return await api(req, res, url)
      }
      send(res, 404, 'not found')
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof LiveError ? 400 : 500
      if (status === 500) log.error('control request failed', e)
      if (!res.headersSent) json(res, { error: e instanceof Error ? e.message : String(e) }, status)
      else res.end()
    }
  })
  // ask_* tool calls may block for up to 30 minutes.
  control.requestTimeout = 0
  control.headersTimeout = 60_000
  control.keepAliveTimeout = 5_000

  control.on('upgrade', (req, socket, head) => {
    const deny = () => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!o.auth.checkHost(req, o.controlPort) || url.pathname !== '/__ph/ws' || o.auth.checkWs(req)) return deny()
      const who = o.auth.identify(req)
      if (!who) return deny()
      wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, who))
    } catch (e) {
      log.error('control upgrade failed', e)
      socket.destroy()
    }
  })

  const attachClient = (ws: WebSocket, who: Who) => {
    const id = newId('ws_')
    const client = {
      id,
      chatId: null as string | null,
      role: 'chat' as 'chat' | 'artifacts' | 'history',
      who,
      send(msg: ServerMsg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
      },
    }
    o.gateway.connect(client)
    let alive = true
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 20_000)
    ws.on('pong', () => (alive = true))
    ws.on('message', (data) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return client.send({ type: 'error', message: 'bad message' })
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return
      o.gateway.handle(client, msg)
    })
    ws.on('close', () => {
      clearInterval(ping)
      o.gateway.disconnect(id)
    })
  }

  await listen(app, o.appPort, o.host)
  await listen(control, o.controlPort, o.host)

  return {
    app,
    control,
    async close() {
      for (const c of wss.clients) c.terminate()
      await Promise.all([app, control].map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))))
    },
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use; pick another with --port / --control-port`) : e)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

// ---------- local review API (no session; paging and resolve only) ----------

function serveReviewPage(gateway: Gateway, res: ServerResponse, url: URL): void {
  const scope = url.searchParams.get('scope')
  if (scope !== 'here' && scope !== 'all') return json(res, { ok: false, error: 'scope' }, 400)
  const page = positiveInt(url.searchParams.get('page'), 1)
  const pageSize = positiveInt(url.searchParams.get('pageSize'), REVIEW_PAGE_SIZE)
  if (page === null || pageSize === null) return json(res, { ok: false, error: 'page' }, 400)
  json(res, gateway.listReviewPage({ scope, path: url.searchParams.get('path') ?? '/', page, pageSize }))
}

async function serveReviewResolve(gateway: Gateway, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ n?: unknown; result?: unknown }>(req)
  const n = typeof body.n === 'number' ? body.n : typeof body.n === 'string' && /^\d+$/.test(body.n) ? Number(body.n) : NaN
  if (!Number.isInteger(n) || n < 1) return json(res, { ok: false, error: 'unknown' }, 404)
  const result = typeof body.result === 'string' ? body.result : ''
  const out = gateway.resolveReviewN(n, result)
  if (!out) return json(res, { ok: false, error: 'unknown' }, 404)
  json(res, out)
}

// ---------- JSON API ----------

function createApi(o: AppOptions) {
  const { gateway, artifacts, uploads, registry, live } = o
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const parts = url.pathname.slice('/__ph/api/'.length).split('/').map(decodeURIComponent)
    const m = req.method ?? 'GET'
    const [a, b, c] = parts

    if (a === 'config' && m === 'GET') {
      return json(res, { project: o.project, target: o.target.href, agents: registry.list(), defaultAgent: gateway.o.defaultAgent })
    }
    if (a === 'agents') {
      if (!b && m === 'GET') return json(res, registry.list())
      if (b && c === 'models' && m === 'GET') return json(res, await registry.models(b))
    }
    if (a === 'chats') {
      if (!b && m === 'GET') return json(res, gateway.listChats())
      if (!b && m === 'POST') {
        const body = await readJsonBody<{ agent?: string; model?: string }>(req)
        return json(res, gateway.createChat(body.agent, body.model))
      }
      if (b && !c && m === 'GET') {
        const s = gateway.snapshot(b)
        return s ? json(res, s) : json(res, { error: 'not found' }, 404)
      }
      if (b && !c && m === 'PATCH') {
        const body = await readJsonBody<{ title?: string; agent?: string; model?: string | null; effort?: string | null; fast?: boolean }>(req)
        return json(res, gateway.updateChat(b, body))
      }
      if (b && !c && m === 'DELETE') {
        gateway.deleteChat(b)
        return json(res, { ok: true })
      }
      if (b && c === 'turns' && m === 'GET') {
        const r = gateway.page(b, url.searchParams.get('before') ?? undefined, Number(url.searchParams.get('limit') ?? 20))
        return r ? json(res, r) : json(res, { error: 'not found' }, 404)
      }
      if (b && c === 'export.md' && m === 'GET') {
        const md = gateway.exportMarkdown(b)
        if (md === undefined) return json(res, { error: 'not found' }, 404)
        return send(res, 200, md, 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="chat-${b}.md"` })
      }
    }
    if (a === 'search' && m === 'GET') {
      return json(res, gateway.search(url.searchParams.get('q') ?? '', url.searchParams.get('chat') ?? undefined))
    }
    if (a === 'artifacts') {
      if (!b && m === 'GET') return json(res, { artifacts: artifacts.list(), pinned: artifacts.pinned })
      if (b && c === 'raw' && m === 'GET') {
        const v = Number(url.searchParams.get('v')) || undefined
        const r = artifacts.read(b, v)
        if (!r) return json(res, { error: 'not found' }, 404)
        const download = url.searchParams.has('download')
        const active = r.info.kind === 'html' || r.info.mime === 'image/svg+xml'
        const headers: Record<string, string> = {}
        // Rendered artifacts run in an opaque origin: no access to the panel, its cookie or the API.
        if (active) headers['Content-Security-Policy'] = "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'"
        if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(b)}`
        const type = r.info.kind === 'image' || active ? r.info.mime : r.info.kind === 'file' ? 'application/octet-stream' : 'text/plain; charset=utf-8'
        return send(res, 200, r.data, type.startsWith('text/html') || type === 'text/html' ? 'text/html; charset=utf-8' : type, headers)
      }
      if (b === '_pin' && m === 'POST') {
        const body = await readJsonBody<{ name?: string | null }>(req)
        artifacts.pin(body.name ?? undefined)
        return json(res, { ok: true })
      }
    }
    if (a === 'uploads') {
      if (!b && m === 'POST') {
        const name = url.searchParams.get('name') ?? 'file'
        const mime = url.searchParams.get('mime') ?? req.headers['content-type'] ?? 'application/octet-stream'
        const data = await readBody(req, MAX_UPLOAD_BYTES + 1)
        return json(res, uploads.save(name, String(mime), data))
      }
      if (b && m === 'GET') {
        const p = uploads.path(b)
        if (!p) return json(res, { error: 'not found' }, 404)
        return serveFile(res, p, { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'", 'Content-Disposition': 'inline' })
      }
    }
    if (a === 'live' && m === 'GET') return json(res, live.list())
    json(res, { error: 'not found' }, 404)
  }
}
