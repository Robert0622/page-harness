// Rebuilds client bundles and the CLI on change. Run `node dist/cli.js <url>` in another terminal.
import { spawn } from 'node:child_process'

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
const procs = [
  run('node', ['scripts/build-client.mjs', '--watch', '--no-minify']),
  run('npx', ['tsup', '--watch']),
]
const stop = () => procs.forEach((p) => p.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
