const useColor = process.stderr.isTTY && !process.env.NO_COLOR
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

let quiet = false
let verbose = !!process.env.PH_DEBUG

const fmt = (msg: string, rest: unknown[]) =>
  [msg, ...rest.map((r) => (r instanceof Error ? (verbose ? r.stack : r.message) : typeof r === 'string' ? r : JSON.stringify(r)))].join(' ')

export const log = {
  setQuiet(v: boolean) {
    quiet = v
  },
  setVerbose(v: boolean) {
    verbose = v
  },
  info(msg: string, ...rest: unknown[]) {
    if (!quiet) process.stderr.write(`${c('36', 'page-harness')} ${fmt(msg, rest)}\n`)
  },
  warn(msg: string, ...rest: unknown[]) {
    if (!quiet) process.stderr.write(`${c('33', 'page-harness')} ${fmt(msg, rest)}\n`)
  },
  error(msg: string, ...rest: unknown[]) {
    process.stderr.write(`${c('31', 'page-harness')} ${fmt(msg, rest)}\n`)
  },
  debug(msg: string, ...rest: unknown[]) {
    if (verbose && !quiet) process.stderr.write(`${c('90', 'page-harness')} ${c('90', fmt(msg, rest))}\n`)
  },
  dim: (s: string) => c('90', s),
  bold: (s: string) => c('1', s),
}
