import type { ArtifactKind } from './protocol'

export function newId(prefix = ''): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  const raw = g.crypto?.randomUUID ? g.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix + raw.slice(0, 16)
}

const EXT_KIND: Record<string, ArtifactKind> = {
  html: 'html', htm: 'html',
  json: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  txt: 'text', log: 'text', csv: 'text', ts: 'text', js: 'text', css: 'text', vue: 'text', tsx: 'text', jsx: 'text', py: 'text', go: 'text', sh: 'text', xml: 'text', toml: 'text',
}

const KIND_MIME: Record<string, string> = {
  html: 'text/html', json: 'application/json', markdown: 'text/markdown', yaml: 'text/yaml', text: 'text/plain',
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function artifactKind(name: string): ArtifactKind {
  return EXT_KIND[extOf(name)] ?? 'file'
}

export function artifactMime(name: string): string {
  const ext = extOf(name)
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext]
  return KIND_MIME[artifactKind(name)] ?? 'application/octet-stream'
}

export function isTextKind(kind: ArtifactKind): boolean {
  return kind !== 'image' && kind !== 'file'
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
