// Page identity for review items: the same page must match whether the user arrived with a
// trailing slash, a hash or tracking parameters.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|spm|from|ref|_ga|mc_[a-z]+)$/i

/**
 * Site key for review notes: hostname plus a non-default port (`shop.example.com`, `localhost:5173`).
 * Accepts a host or an absolute URL. Empty when the value is not a host.
 */
export function normalizeHost(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s || s.length > 300) return ''
  try {
    const u = s.includes('://') ? new URL(s) : new URL(`http://${s}`)
    if (u.username || u.password || !u.hostname) return ''
    const host = u.host
    if (!host || host.length > 253 || !/^[a-z0-9.\-:[\]]+$/.test(host)) return ''
    return host
  } catch {
    return ''
  }
}

export function normalizePath(url: string): string {
  let u: URL
  try {
    u = new URL(url, 'http://x')
  } catch {
    return '/'
  }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k) && !k.startsWith('ph-')).sort(([a], [b]) => a.localeCompare(b))
  const search = new URLSearchParams(params).toString()
  return (path || '/') + (search ? `?${search}` : '')
}
