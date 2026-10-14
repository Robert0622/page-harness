// Bookmarklet transport: the overlay on a foreign page talks to the local control server
// with fetch, instead of an iframe. The page origin and 127.0.0.1 are different origins.
import type { Me, ReviewState, ToPanel } from '@shared/protocol'

export interface DirectReview {
  send(m: ToPanel): void
  stop(): void
}

export function startDirectReview(o: {
  controlOrigin: string
  token: string
  host: string
  onState(review: ReviewState, me: Me): void
  onError(message: string): void
}): DirectReview {
  let stopped = false
  let pulling = false
  const headers = (json = false): Record<string, string> => ({
    Accept: 'application/json',
    'X-PH-Token': o.token,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  })

  const apply = (data: { review?: ReviewState; me?: Me }) => {
    if (data.review && data.me) o.onState(data.review, data.me)
  }

  const pull = async () => {
    if (stopped || pulling) return
    pulling = true
    try {
      const r = await fetch(`${o.controlOrigin}/__ph/api/review/state?host=${encodeURIComponent(o.host)}`, { headers: headers() })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      apply(await r.json())
    } catch (e) {
      o.onError(e instanceof Error ? e.message : String(e))
    } finally {
      pulling = false
    }
  }

  const post = async (body: unknown) => {
    const r = await fetch(`${o.controlOrigin}/__ph/api/review/op`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${r.status}`)
    apply(data)
  }

  const timer = setInterval(() => void pull(), 2000)
  void pull()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    send(m) {
      const host = o.host
      const run = () => {
        switch (m.type) {
          case 'ph:review-add':
            return post({ op: 'add', host, draft: { ...m.draft, host: m.draft.host || host } })
          case 'ph:review-reply':
            return post({ op: 'reply', host, id: m.id, text: m.text })
          case 'ph:review-edit':
            return post({ op: 'edit', host, id: m.id, note: m.note })
          case 'ph:review-status':
            return post({ op: 'status', host, id: m.id, status: m.status })
          case 'ph:review-approve':
            return post({ op: 'approve', host, url: m.url, status: m.status })
          case 'ph:review-remove':
            return post({ op: 'remove', host, id: m.id })
          case 'ph:review-look':
            return post({ op: 'look', host, id: m.id, look: m.look })
          case 'ph:review-clear':
            return post({ op: 'clear', host })
          default:
            return Promise.resolve()
        }
      }
      void run().catch((e) => o.onError(e instanceof Error ? e.message : String(e)))
    },
  }
}
