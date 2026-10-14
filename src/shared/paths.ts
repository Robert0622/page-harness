// Page identity for review items: the same page must match whether the user arrived with a
// trailing slash, a hash or tracking parameters.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|spm|from|ref|_ga|mc_[a-z]+)$/i

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
