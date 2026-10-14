// Chat attachments: <dataDir>/uploads/<id>/<name>
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Attachment } from '../shared/protocol'
import { newId } from '../shared/util'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

function safeName(name: string): string {
  const base = path.basename(name || 'file').replace(/[^\p{L}\p{N}._\-() ]+/gu, '_').replace(/^\.+/, '')
  return base.slice(-100) || 'file'
}

export class Uploads {
  readonly root: string

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'uploads')
    mkdirSync(this.root, { recursive: true })
  }

  save(name: string, mime: string, data: Buffer): Attachment {
    if (data.length > MAX_UPLOAD_BYTES) throw new Error('file too large (max 25 MB)')
    const id = newId('u_')
    const file = safeName(name)
    mkdirSync(path.join(this.root, id), { recursive: true })
    writeFileSync(path.join(this.root, id, file), data)
    const cleanMime = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream'
    return { id, name: file, mime: cleanMime, size: data.length, kind: cleanMime.startsWith('image/') ? 'image' : 'file' }
  }

  path(id: string): string | undefined {
    if (!/^u_[a-z0-9]+$/i.test(id)) return undefined
    const dir = path.join(this.root, id)
    if (!existsSync(dir)) return undefined
    const name = readdirSync(dir).find((n) => statSync(path.join(dir, n)).isFile())
    return name ? path.join(dir, name) : undefined
  }
}
