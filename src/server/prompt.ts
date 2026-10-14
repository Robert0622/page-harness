// Turns a panel message (text + picks + marks + attachments) into the agent prompt.
import path from 'node:path'
import type { UserMessage } from '../shared/protocol'
import { truncate } from '../shared/util'
import type { Uploads } from './uploads'

const esc = (s: string) => s.replace(/</g, '&lt;')

export interface BuiltPrompt {
  prompt: string
  images: Array<{ path: string; mime: string }>
}

export function buildPrompt(msg: UserMessage, opts: { uploads: Uploads; project: string; nativeImages: boolean; liveText?: string }): BuiltPrompt {
  const parts: string[] = []
  const images: BuiltPrompt['images'] = []
  if (msg.pageUrl) parts.push(`<page url="${esc(msg.pageUrl)}" />`)
  if (msg.picks.length) {
    const lines = msg.picks.map((p, i) => {
      const html = truncate(p.outerHTML.replace(/\s+/g, ' '), 1200)
      return `${i + 1}. <${p.tagName.toLowerCase()}> selector: ${p.selector}${p.text ? `\n   text: ${JSON.stringify(truncate(p.text, 200))}` : ''}${p.url && p.url !== msg.pageUrl ? `\n   page: ${p.url}` : ''}\n   html: ${esc(html)}`
    })
    parts.push(`<picked-elements>\n${lines.join('\n')}\n</picked-elements>`)
  }
  if (msg.marks?.length) {
    const lines = msg.marks.map((m) => `${m.n}. ${m.kind === 'pin' ? 'pin' : 'circled area'} over ${m.targets.join(', ') || 'empty space'}${m.note ? ` — ${JSON.stringify(m.note)}` : ''}`)
    parts.push(`<marks>\n${lines.join('\n')}\n</marks>`)
  }
  if (msg.attachments.length) {
    const lines: string[] = []
    for (const a of msg.attachments) {
      const p = opts.uploads.path(a.id)
      if (!p) continue
      const shown = path.relative(opts.project, p).startsWith('..') ? p : path.relative(opts.project, p)
      if (a.kind === 'image' && opts.nativeImages) {
        images.push({ path: p, mime: a.mime })
        lines.push(`- ${a.name} (image, attached; also at ${shown})`)
      } else {
        lines.push(`- ${a.name} (${a.mime}, ${a.size} bytes): ${shown}`)
      }
    }
    if (lines.length) parts.push(`<attachments note="read these files from disk if needed">\n${lines.join('\n')}\n</attachments>`)
  }
  if (opts.liveText) parts.push(opts.liveText)
  else parts.push(msg.text)
  return { prompt: parts.join('\n\n'), images }
}
