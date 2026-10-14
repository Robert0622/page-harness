// Teammates who joined with the invite link (--share). They can review the page but never drive
// the agent. The invite and signing key persist so links and sessions survive restarts.
import { createHmac } from 'node:crypto'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import type { ReviewAuthor } from '../shared/protocol'
import { newId, truncate } from '../shared/util'
import { randomToken, safeEqual } from './auth'
import { readJson, writeJsonAtomic } from './store'

interface TeamFile {
  invite: string
  key: string
  ownerName?: string
  reviewers: Record<string, { name: string; joinedAt: number }>
}

export class Team {
  private file: string
  private data: TeamFile

  constructor(
    dataDir: string,
    readonly enabled: boolean,
  ) {
    this.file = path.join(dataDir, 'team.json')
    const d = readJson<Partial<TeamFile>>(this.file, {})
    this.data = { invite: d.invite || randomToken(18), key: d.key || randomToken(), ownerName: d.ownerName, reviewers: d.reviewers ?? {} }
    if (!d.invite || !d.key) this.save()
  }

  get invite(): string {
    return this.data.invite
  }

  /** Cookie value for a reviewer: id plus an HMAC so it cannot be forged or guessed. */
  sign(id: string): string {
    return `r.${id}.${createHmac('sha256', this.data.key).update(id).digest('base64url')}`
  }

  verify(value: string): string | null {
    const m = /^r\.([A-Za-z0-9_]+)\.([A-Za-z0-9_-]+)$/.exec(value)
    if (!m || !safeEqual(this.sign(m[1]), value)) return null
    return this.data.reviewers[m[1]] ? m[1] : null
  }

  join(): string {
    const id = newId('u_')
    this.data.reviewers[id] = { name: '', joinedAt: Date.now() }
    this.save()
    return id
  }

  author(access: 'owner' | 'reviewer', id?: string): ReviewAuthor {
    if (access === 'owner') return { id: 'owner', name: this.data.ownerName || '匿名', kind: 'human' }
    const name = (id && this.data.reviewers[id]?.name) || ''
    return { id: id ?? 'reviewer', name: name || 'Reviewer', kind: 'human' }
  }

  hasName(id: string): boolean {
    return !!this.data.reviewers[id]?.name
  }

  setName(access: 'owner' | 'reviewer', id: string | undefined, name: string): void {
    const n = truncate(name.replace(/\s+/g, ' ').trim(), 40)
    if (!n) throw new Error('a name is required')
    if (access === 'owner') this.data.ownerName = n
    else if (id && this.data.reviewers[id]) this.data.reviewers[id].name = n
    this.save()
  }

  private save() {
    writeJsonAtomic(this.file, this.data)
    try {
      chmodSync(this.file, 0o600)
    } catch {}
  }
}
