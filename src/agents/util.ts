import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/** Push-based async iterable; producers call push/end/fail, consumers `for await`. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private done = false
  private err: unknown

  push(item: T): void {
    if (this.done) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.done) return
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  fail(err: unknown): void {
    this.err = err
    this.end()
  }

  get closed(): boolean {
    return this.done
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.done) {
          if (this.err) {
            const e = this.err
            this.err = undefined
            return Promise.reject(e)
          }
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

const isWin = process.platform === 'win32'

export function findExecutable(names: string[]): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const name of names) {
    if (path.isAbsolute(name)) {
      if (isExecutable(name)) return name
      continue
    }
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext)
        if (isExecutable(p)) return p
      }
    }
  }
  return undefined
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function runCapture(bin: string, args: string[], timeoutMs = 8000, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(isWin ? cmdArg(bin) : bin, isWin ? args.map(cmdArg) : args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface SpawnedAgent {
  child: ChildProcess
  lines: AsyncIterable<string>
  stderrTail(): string
  /** Ask nicely, then kill the whole process group. */
  stop(graceMs?: number): void
  exited: Promise<number | null>
}

/**
 * Windows runs agents through cmd.exe (npm installs .cmd shims), which does not escape arguments.
 * Prompts and page data go over stdin; the remaining flags are quoted, and characters cmd.exe
 * expands even inside quotes are refused.
 */
export function cmdArg(a: string): string {
  if (/["%\r\n]/.test(a)) throw new Error(`argument not safe for cmd.exe: ${a.slice(0, 40)}`)
  return /^[\w\-.:\\/=@,+]+$/.test(a) ? a : `"${a.replace(/\\+$/, (m) => m + m)}"`
}

const running = new Set<(sig: NodeJS.Signals) => void>()

/** Last resort on exit: agent process groups that ignored SIGINT must not outlive us. */
export function killAllAgents(): void {
  for (const kill of running) kill('SIGKILL')
  running.clear()
}

export function spawnAgent(bin: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: boolean }): SpawnedAgent {
  let cmd = bin
  let argv = args
  let shell = isWin
  try {
    if (isWin) [cmd, ...argv] = [bin, ...args].map(cmdArg)
  } catch (e) {
    // Fail like a crashed agent so the turn reports the reason.
    ;[cmd, argv, shell] = [process.execPath, ['-e', `process.stderr.write(${JSON.stringify(String((e as Error).message))});process.exit(1)`], false]
  }
  const child = spawn(cmd, argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: !isWin,
    shell,
  })
  let tail = ''
  child.stderr?.on('data', (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4000)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      tail += `\n${e.message}`
      resolve(-1)
    })
    child.on('close', (code) => resolve(code))
  })
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (!isWin && child.pid) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch {}
  }
  running.add(kill)
  child.once('close', () => running.delete(kill))
  let stopping = false
  return {
    child,
    lines: rl,
    stderrTail: () => tail.trim(),
    exited,
    stop(graceMs = 3000) {
      if (stopping || child.exitCode !== null) return
      stopping = true
      kill('SIGINT')
      const t = setTimeout(() => kill('SIGKILL'), graceMs)
      t.unref()
      child.once('close', () => clearTimeout(t))
    },
  }
}

export function parseJson(line: string): any {
  const s = line.trim()
  if (!s.startsWith('{')) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s
}

export function stringifyOutput(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : typeof x === 'string' ? x : JSON.stringify(x)))
      .join('\n')
  }
  return JSON.stringify(v, null, 2)
}

/** Strips agent-specific MCP prefixes so tools display by their plain name. */
export function displayToolName(name: string): string {
  return name.replace(/^mcp__page[-_]harness__/, '').replace(/^page[-_]harness[.:/_]/, '')
}

/** Removes terminal colour codes, e.g. from CLI errors printed for a TTY. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}
