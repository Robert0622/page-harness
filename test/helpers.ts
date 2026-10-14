import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import type { ClientMsg, ServerMsg } from '../src/shared/protocol'

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

export const FIXTURE_HTML = `<!doctype html>
<html><head><title>Fixture</title></head>
<body>
  <h1 class="title">Hello fixture</h1>
  <button id="save" onclick="document.getElementById('out').textContent='saved'">Save</button>
  <p id="out"></p>
</body></html>
`

export function tempProject(html = FIXTURE_HTML): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ph-test-'))
  writeFileSync(path.join(dir, 'index.html'), html)
  return dir
}

/** Serves <dir>/index.html (re-read on every request, like a dev server). */
export async function staticServer(dir: string, extraHeaders: Record<string, string> = {}): Promise<{ url: string; close(): Promise<void>; server: http.Server }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders })
      res.end(readFileSync(path.join(dir, 'index.html')))
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/` })
      res.end()
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port
  return { url: `http://127.0.0.1:${port}/`, server, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) }
}

export class WsClient {
  msgs: ServerMsg[] = []
  private waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = []
  onMessage?: (m: ServerMsg) => void

  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg
      this.msgs.push(m)
      this.onMessage?.(m)
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    })
  }

  static async open(url: string, headers: Record<string, string>): Promise<WsClient> {
    const ws = new WebSocket(url, { headers })
    const c = new WsClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)))
    })
    return c
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m))
  }

  wait<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, timeout = 10000, fromStart = false): Promise<T> {
    if (fromStart) {
      const hit = this.msgs.find(pred)
      if (hit) return Promise.resolve(hit as T)
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout)
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m as T)) })
    })
  }

  close() {
    this.ws.close()
  }
}
