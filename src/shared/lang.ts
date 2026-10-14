import type { Lang } from './protocol'

/** `--lang zh|en`. Also accepts zh-CN and en-US. */
export function parseLang(raw: string | undefined): Lang | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const s = raw.trim().toLowerCase()
  if (s === 'en' || s.startsWith('en-')) return 'en'
  if (s === 'zh' || s.startsWith('zh-')) return 'zh-CN'
  throw new Error('--lang must be zh or en')
}
