// Serves the e2e fixture app from a scratch project directory (re-read on every request, like a dev server),
// then starts page-harness in front of it with the scripted test agent.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.join(here, '.tmp', 'project')
rmSync(path.join(here, '.tmp'), { recursive: true, force: true })
mkdirSync(project, { recursive: true })
copyFileSync(path.join(here, 'fixture', 'index.html'), path.join(project, 'index.html'))

const port = Number(process.env.FIXTURE_PORT ?? 5179)
const appPort = Number(process.env.APP_PORT ?? 17980)
http
  .createServer((req, res) => {
    const file = path.join(project, 'index.html')
    if (req.url === '/__version') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end(String(statSync(file).mtimeMs))
      return
    }
    if (req.url?.startsWith('/favicon')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    const version = String(statSync(file).mtimeMs)
    res.end(readFileSync(file, 'utf8').replace('let v = null', `let v = ${JSON.stringify(version)}`))
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`fixture on http://127.0.0.1:${port}`)
    // A second harness in front of the same app, forced into review mode (no source to edit).
    const reviewProject = path.join(here, '.tmp', 'review-project')
    mkdirSync(reviewProject, { recursive: true })
    const reviewPort = Number(process.env.REVIEW_PORT ?? appPort + 4)
    const harness = (dir, p, extra = []) =>
      spawn(
        process.execPath,
        [path.join(here, '..', 'dist', 'cli.js'), `http://127.0.0.1:${port}`, '--project', dir, '--agent', 'fake', '--port', String(p), '--control-port', String(p + 1), ...extra],
        { stdio: 'inherit', env: { ...process.env, PH_FAKE_AGENT: '1' } },
      )
    const clis = [harness(project, appPort), harness(reviewProject, reviewPort, ['--review', '--share', '--host', '127.0.0.1'])]
    const stop = () => clis.forEach((c) => c.kill('SIGTERM'))
    process.on('SIGTERM', () => (stop(), process.exit(0)))
    process.on('SIGINT', () => (stop(), process.exit(0)))
    for (const c of clis) c.on('exit', (code) => (stop(), process.exit(code ?? 0)))
  })
