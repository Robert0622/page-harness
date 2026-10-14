// JSON API on the control origin. The session cookie rides along; writes add the X-PH header.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob | ArrayBuffer): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-PH'] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(`/__ph/api/${path}`, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  })
  const type = r.headers.get('content-type') ?? ''
  const data = type.includes('json') ? await r.json() : await r.text()
  if (!r.ok) throw new ApiError(r.status, (data && typeof data === 'object' && 'error' in data ? String(data.error) : String(data)) || r.statusText)
  return data as T
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body ?? {}),
  patch: <T>(p: string, body: unknown) => request<T>('PATCH', p, body),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(file: File | Blob, name: string) =>
    request<T>('POST', `uploads?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(file.type || 'application/octet-stream')}`, undefined, file),
}

export const rawUrl = (name: string, v?: number, download = false) =>
  `/__ph/api/artifacts/${encodeURIComponent(name)}/raw${v ? `?v=${v}` : ''}${download ? `${v ? '&' : '?'}download` : ''}`

export const uploadUrl = (id: string) => `/__ph/api/uploads/${encodeURIComponent(id)}`
