// Artifacts live in <project>/.page-harness/artifacts/<name>/v<n>, every write is a new version.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ArtifactInfo } from '../shared/protocol'
import { artifactKind, artifactMime, isTextKind } from '../shared/util'
import { readJson, writeJsonAtomic } from './store'

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024

/** Artifact names are flat file names; folders, dot-files and traversal are rejected. */
export function validArtifactName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 120 &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._()\-+@]*$/u.test(name) &&
    !name.includes('..') &&
    !name.endsWith('.') &&
    !name.endsWith(' ')
  )
}

interface Index {
  artifacts: ArtifactInfo[]
  pinned?: string
}

export class ArtifactStore extends EventEmitter {
  private root: string
  private indexFile: string
  private index: Index

  constructor(dataDir: string) {
    super()
    this.root = path.join(dataDir, 'artifacts')
    this.indexFile = path.join(this.root, 'index.json')
    mkdirSync(this.root, { recursive: true })
    this.index = readJson<Index>(this.indexFile, { artifacts: [] })
  }

  list(): ArtifactInfo[] {
    return [...this.index.artifacts].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get pinned(): string | undefined {
    return this.index.pinned
  }

  get(name: string): ArtifactInfo | undefined {
    return this.index.artifacts.find((a) => a.name === name)
  }

  write(name: string, content: Buffer, meta: { chatId?: string; turnId?: string } = {}): ArtifactInfo {
    if (!validArtifactName(name)) throw new Error(`invalid artifact name "${name}": use a plain file name like report.md`)
    if (content.length > MAX_ARTIFACT_BYTES) throw new Error('artifact too large (max 20 MB)')
    let info = this.get(name)
    const now = Date.now()
    if (!info) {
      info = { name, kind: artifactKind(name), mime: artifactMime(name), latest: 0, updatedAt: now, size: 0, versions: [] }
      this.index.artifacts.push(info)
    }
    const v = info.latest + 1
    const dir = path.join(this.root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `v${v}`), content)
    info.latest = v
    info.updatedAt = now
    info.size = content.length
    info.versions.push({ v, ts: now, size: content.length, chatId: meta.chatId, turnId: meta.turnId })
    this.save()
    this.emit('change', name)
    return info
  }

  read(name: string, version?: number): { info: ArtifactInfo; data: Buffer; version: number } | undefined {
    const info = this.get(name)
    if (!info) return undefined
    const v = version && info.versions.some((x) => x.v === version) ? version : info.latest
    const file = path.join(this.root, name, `v${v}`)
    if (!existsSync(file)) return undefined
    return { info, data: readFileSync(file), version: v }
  }

  readText(name: string, version?: number): string | undefined {
    const r = this.read(name, version)
    if (!r) return undefined
    return isTextKind(r.info.kind) ? r.data.toString('utf8') : `[binary ${r.info.mime}, ${r.data.length} bytes]`
  }

  pin(name: string | undefined): void {
    if (name && !this.get(name)) throw new Error(`no artifact named "${name}"`)
    this.index.pinned = name
    this.save()
    this.emit('change', name)
  }

  private save() {
    writeJsonAtomic(this.indexFile, this.index)
  }
}
