import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseAllCursorMcp } from '../agents/cursor'
import { killAllAgents } from '../agents/util'
import { startHarness } from '../server/harness'
import { log } from '../server/log'

const HELP = `page-harness — Pick, Chat and Artifacts on top of any running frontend, driven by your local coding agent.

Usage
  page-harness <frontend-url> [options]

Examples
  npx page-harness http://localhost:5173
  npx page-harness 3000 --project ../web --agent codex

Options
  --project <dir>        Project the agent works in (default: current directory)
  --agent <id>           claude | codex | cursor | codebuddy | opencode (default: first one installed)
  --model <name>         Default model for new chats
  --port <n>             App port: the proxied frontend (default 17990)
  --control-port <n>     Panel / API port (default: app port + 1)
  --host <addr>          Listen address (default 127.0.0.1)
  --allow-host <name>    Extra Host header to accept (repeatable), e.g. a LAN name
  --keep-host            Forward the browser's Host header to the target
  --public-scheme <s>    http | https: scheme browsers use to reach both ports (default http).
                         Use https behind a load balancer that terminates TLS on the same ports
  --open                 Open the browser
  --claude-path <bin>    Path to the claude CLI   (also --codex-path, --cursor-path, --codebuddy-path, --opencode-path)
  --live-guard-hook      Install a git pre-commit hook that rejects Live candidate markers
  --review               No source for this page: the agent leaves notes and page changes instead of editing files
                         (default for public sites; --source forces source mode)
  --share                Listen on the network and print an invite link: teammates join as reviewers
                         (comment, reply, resolve, approve, edit text/style in review mode; never the agent)
  --verbose / --quiet
  -v, --version
  -h, --help
`

function version(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const p of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      if (pkg.name === 'page-harness') return pkg.version
    } catch {}
  }
  return '0.0.0'
}

export function normalizeTarget(raw: string): URL {
  let s = raw.trim()
  if (/^\d+$/.test(s)) s = `http://localhost:${s}`
  else if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  const u = new URL(s)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the frontend URL must be http(s)')
  return u
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, host, () => s.close(() => resolve(true)))
  })
}

async function pickPorts(host: string, app?: number, control?: number): Promise<[number, number]> {
  if (app !== undefined) return [app, control ?? app + 1]
  for (let p = 17990; p < 18090; p += 2) {
    const c = control ?? p + 1
    if ((await portFree(p, host)) && (await portFree(c, host))) return [p, c]
    if (control !== undefined) break
  }
  return [17990, control ?? 17991]
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

function intOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--${name} must be a port number`)
  return n
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      port: { type: 'string' },
      'control-port': { type: 'string' },
      host: { type: 'string' },
      'allow-host': { type: 'string', multiple: true },
      'keep-host': { type: 'boolean' },
      'public-scheme': { type: 'string' },
      open: { type: 'boolean' },
      'claude-path': { type: 'string' },
      'codex-path': { type: 'string' },
      'cursor-path': { type: 'string' },
      'codebuddy-path': { type: 'string' },
      'opencode-path': { type: 'string' },
      'live-guard-hook': { type: 'boolean' },
      review: { type: 'boolean' },
      source: { type: 'boolean' },
      share: { type: 'boolean' },
      verbose: { type: 'boolean' },
      quiet: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.version) {
    console.log(version())
    return
  }
  if (values.help || !positionals[0]) {
    process.stdout.write(HELP)
    if (!values.help) process.exitCode = 1
    return
  }
  if (values.verbose) log.setVerbose(true)
  if (values.quiet) log.setQuiet(true)

  const target = normalizeTarget(positionals[0])
  const project = path.resolve(values.project ?? process.cwd())
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error(`project directory not found: ${project}`)
  const host = values.host ?? (values.share ? '0.0.0.0' : '127.0.0.1')
  const [appPort, controlPort] = await pickPorts(host, intOpt(values.port, 'port'), intOpt(values['control-port'], 'control-port'))
  if (appPort === controlPort) throw new Error('--port and --control-port must differ')
  if (values.review && values.source) throw new Error('use either --review or --source')
  const publicScheme = values['public-scheme'] ?? 'http'
  if (publicScheme !== 'http' && publicScheme !== 'https') throw new Error('--public-scheme must be http or https')

  const h = await startHarness({
    target,
    project,
    host,
    appPort,
    controlPort,
    agent: values.agent,
    model: values.model,
    allowHosts: values['allow-host'],
    keepHost: values['keep-host'],
    publicScheme,
    agentPaths: {
      claude: values['claude-path'],
      codex: values['codex-path'],
      cursor: values['cursor-path'],
      codebuddy: values['codebuddy-path'],
      opencode: values['opencode-path'],
    },
    liveGuardHook: values['live-guard-hook'],
    mode: values.review ? 'review' : values.source ? 'source' : undefined,
    share: values.share,
  })

  const agentLine = h.agents
    .map((a) => (a.available ? `${a.id === h.defaultAgent ? log.bold(a.id) : a.id}${a.version ? ` ${log.dim(a.version)}` : ''}` : log.dim(`${a.id} (not found)`)))
    .join('  ')
  log.info(`v${version()}`)
  process.stderr.write(
    [
      `  Open     ${log.bold(h.appUrl)}  ${log.dim(`→ ${target.href}`)}`,
      `  History  ${h.controlUrl}/__ph/history`,
      `  Project  ${project}`,
      `  Mode     ${h.mode === 'review' ? `review ${log.dim('(no source: notes, page changes, Live candidates as page changes)')}` : 'source'}`,
      `  Agents   ${agentLine}`,
      ...(h.shareUrl ? [`  Share    ${log.bold(h.shareUrl)}  ${log.dim('(teammates on your network join as reviewers: comment, reply, approve; they cannot run the agent)')}`] : []),
      ...(!h.shareUrl && !LOCAL_HOSTS.has(host)
        ? [`  ${log.bold('Warning')}  listening on ${host} without --share: anyone who can reach these ports gets full control, including running the agent. Use --share to give others reviewer access only.`]
        : []),
      '',
    ].join('\n'),
  )
  if (values.open) openBrowser(h.appUrl)

  let closing = false
  const shutdown = async () => {
    if (closing) return process.exit(0)
    closing = true
    log.info('shutting down…')
    await h.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.on('exit', () => {
    killAllAgents()
    releaseAllCursorMcp()
  })
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const isEntry = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()

if (isEntry || process.env.PH_CLI === '1') {
  main().catch((e) => {
    log.error(e instanceof Error ? e.message : String(e))
    releaseAllCursorMcp()
    process.exit(1)
  })
}
