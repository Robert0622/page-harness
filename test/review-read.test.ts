import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReviewItem, ReviewLook, ReviewPatch } from '../src/shared/protocol'
import { appearanceSelectors, authorNotes, isAncestorSelector, listRootSelector, readerEntries, reviewMarkdown } from '../src/shared/review-read'
import { ReviewStore } from '../src/server/review'

const author = { id: 'owner', name: 'root', kind: 'human' as const }
const JPEG = `data:image/jpeg;base64,${'a'.repeat(80)}`

function item(partial: Partial<ReviewItem> & Pick<ReviewItem, 'id' | 'n' | 'selector'> & { patch?: ReviewPatch }): ReviewItem {
  return {
    kind: 'patch',
    path: '/',
    note: partial.note ?? 'Live: sample',
    author,
    status: 'open',
    replies: [],
    createdAt: partial.n,
    ...partial,
  }
}

const look = (n: number): ReviewLook => ({ beforeImage: JPEG, afterImage: JPEG.replace('aaa', 'bbb'), beforeHtml: `<div>before-${n}</div>`, afterHtml: `<div>after-${n}</div>` })

function stroustrup(): ReviewItem[] {
  const li = (n: number, px: string, extra: Record<string, string> = {}) =>
    item({
      id: `li${n}`,
      n,
      selector: `ul > li:nth-child(${n})`,
      note: 'Live: Type ramp',
      anchor: { tag: 'li', text: n === 1 ? 'A Tour of C++' : 'The C++ Programming Language' },
      patch: { style: { 'font-size': px, 'font-weight': n > 4 ? '700' : '700', ...extra } },
    })
  return [
    item({
      id: 'title',
      n: 13,
      selector: 'center:nth-of-type(2) h1',
      note: 'Live: Desk photo',
      anchor: { tag: 'h1', text: "Welcome to Bjarne Stroustrup's homepage!" },
      patch: { text: "Welcome to Bjarne Stroustrup's homepage.", style: { 'font-style': 'italic', 'font-family': 'Georgia, serif' } },
      look: look(13),
    }),
    item({
      id: 'photo',
      n: 14,
      selector: 'center:nth-of-type(2) img',
      note: 'Live: Desk photo',
      anchor: { tag: 'img', text: '' },
      patch: { style: { border: '12px solid #fff', 'box-shadow': '0 14px 28px rgba(0,0,0,.22)', transform: 'rotate(-2.5deg)' } },
      look: look(14),
    }),
    item({
      id: 'pad',
      n: 12,
      selector: 'center:nth-of-type(2)',
      note: 'Live: Desk photo',
      patch: { style: { padding: '12px 8px' } },
    }),
    item({
      id: 'ul',
      n: 1,
      selector: 'ul',
      note: 'Live: Type ramp',
      anchor: { tag: 'ul', text: 'A Tour of C++' },
      patch: { style: { 'list-style': 'none', padding: '0' } },
      look: look(1),
    }),
    ...[32, 24, 20, 18, 16, 16, 16, 16, 16, 16].map((px, i) => li(i + 1, `${px}px`, i === 3 ? { 'border-bottom': '3px solid #111' } : {})),
    item({
      id: 'note',
      n: 15,
      kind: 'note',
      selector: 'p',
      note: '第一段太长，希望先看到他现在在哪工作。',
      label: 'p "I am a Technical Fellow at Morgan Stanley"',
      anchor: { tag: 'p', text: 'I am a Technical Fellow at Morgan Stanley' },
      patch: undefined,
    }),
  ]
}

describe('list grouping', () => {
  it('reads a ul and its li children as one list', () => {
    expect(listRootSelector('ul')).toBe('ul')
    expect(listRootSelector('ul > li:nth-child(3)')).toBe('ul')
    expect(listRootSelector('center:nth-of-type(2) > ul:nth-of-type(1) > li:nth-of-type(2)')).toBe('center:nth-of-type(2) > ul:nth-of-type(1)')
    expect(listRootSelector('center:nth-of-type(2) img')).toBeNull()
    expect(isAncestorSelector('center:nth-of-type(2)', 'center:nth-of-type(2) img')).toBe(true)
    expect(isAncestorSelector('ul', 'ul.books > li')).toBe(false)
  })

  it('collapses the type ramp, keeps the title and photo apart, and hides wrapper padding (g1.3)', () => {
    const entries = readerEntries(stroustrup())
    expect(entries.map((e) => e.n).sort((a, b) => a - b)).toEqual([1, 13, 14, 15])
    const ramp = entries.find((e) => e.n === 1)!
    expect(ramp.members).toHaveLength(11)
    expect(ramp.lines.map((l) => l.selector)).toHaveLength(11)
    expect(ramp.title).toContain('字号阶梯')
    expect(ramp.say).toContain('书目')
    expect(ramp.say).toContain('由大到小')
    expect(ramp.say).not.toMatch(/nth-child|border:|font-size/)
    const photo = entries.find((e) => e.n === 14)!
    const title = entries.find((e) => e.n === 13)!
    expect(photo.title).toContain('照片')
    expect(photo.say).toContain('白边')
    expect(photo.say).toContain('倾斜')
    expect(photo.say).not.toContain('center:nth-of-type')
    expect(title.say).toContain('斜体')
    expect(title.say).toContain('感叹号')
    expect(title.say).toContain('Welcome to Bjarne Stroustrup')
    expect(photo.lines.some((l) => l.selector === 'center:nth-of-type(2)' && l.css?.includes('padding'))).toBe(true)
    expect(title.lines.some((l) => l.selector === 'center:nth-of-type(2)')).toBe(true)
    expect(entries.some((e) => e.primary.id === 'pad')).toBe(false)
    const note = entries.find((e) => e.n === 15)!
    expect(note.say).toBe('第一段太长，希望先看到他现在在哪工作。')
    expect(note.where).toContain('Technical Fellow')
    expect(authorNotes(note)).toEqual([])
    expect(note.title).not.toBe('p')
    expect(authorNotes(entries.find((e) => e.n === 14)!)).toEqual([])
  })

  it('keeps a free-form patch note beside the sentence (g1.2)', () => {
    const patch = item({
      id: 'sub',
      n: 2,
      selector: '.hero-sub',
      note: 'Shorter, clearer headline.',
      anchor: { tag: 'p', text: 'A tiny app to drive the e2e suite.' },
      patch: { text: 'Reviewed headline', style: { color: 'rgb(220, 38, 38)' } },
    })
    const [entry] = readerEntries([patch])
    expect(entry.say).toContain('Reviewed headline')
    expect(entry.say).not.toContain('.hero-sub')
    expect(entry.say).not.toContain('color')
    expect(authorNotes(entry)).toEqual(['Shorter, clearer headline.'])
    const md = reviewMarkdown('http://localhost/', [patch], [])
    expect(md).toContain('Shorter, clearer headline.')
    expect(md).toContain('Reviewed headline')
    expect(md.indexOf('Shorter, clearer headline.')).toBeLessThan(md.indexOf('<summary>选择器和样式</summary>'))
  })

  it('does not merge a text change and a frame change that share a Live name', () => {
    const entries = readerEntries(stroustrup().filter((i) => i.note === 'Live: Desk photo'))
    expect(entries.map((e) => e.primary.id).sort()).toEqual(['photo', 'title'])
  })

  it('asks for one appearance shot per reader entry, not one per li (g1.1)', () => {
    const changes = stroustrup()
      .filter((i) => i.patch)
      .map((i) => ({ selector: i.selector, patch: i.patch! }))
    expect(appearanceSelectors(changes).sort()).toEqual(['center:nth-of-type(2) h1', 'center:nth-of-type(2) img', 'ul'])
  })
})

describe('page-review.md', () => {
  it('exports one readable entry per change, with before/after images and the ramp kept whole (g2.1, g2.2)', () => {
    const items = stroustrup()
    const md = reviewMarkdown('http://www.stroustrup.com/', items, [])
    const headings = md.match(/^### /gm) ?? []
    expect(headings).toHaveLength(4)
    expect(md).toContain('照片')
    expect(md).toContain('这张照片加上一圈白边')
    expect(md).toContain('标题改成斜体，并去掉感叹号')
    expect(md).toContain('书目改成由大到小的字号阶梯')
    expect(md).toContain('整段书目不再是同一号字的圆点列表')
    expect(md).toContain('![改前](data:image/jpeg;base64,')
    expect(md).toContain('![改后](data:image/jpeg;base64,')
    expect(md.match(/ul > li:nth-child/g)?.length).toBe(10)
    expect(md).toContain('<summary>选择器和样式</summary>')
    expect(md).not.toMatch(/^### #\d+ \[[^\]]+\] ul >/m)
    expect(md).not.toMatch(/^### #\d+ \[[^\]]+\] center:nth-of-type\(2\)$/m)
    const rampAt = md.indexOf('字号阶梯')
    const techAt = md.indexOf('ul > li:nth-child(1)', rampAt)
    expect(techAt).toBeGreaterThan(rampAt)
    expect(md.slice(rampAt, techAt)).not.toContain('nth-child')
  })
})

describe('saved looks', () => {
  it('keeps a before/after look on the patch and still shows it in the export when nothing else is on the page (g1.1)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ph-review-'))
    const s = new ReviewStore(dir)
    const added = s.add({
      kind: 'patch',
      path: '/',
      selector: 'img.hero',
      note: '',
      patch: { style: { border: '12px solid #fff', transform: 'rotate(-2.5deg)', 'box-shadow': '0 8px 16px #000' } },
      look: { beforeImage: JPEG, afterImage: JPEG, beforeHtml: '<img class="before">', afterHtml: '<img class="after">' },
      author,
      anchor: { tag: 'img' },
    })
    expect(added.look?.beforeHtml).toContain('before')
    s.attachLook(added.id, { beforeImage: 'javascript:alert(1)', afterImage: JPEG, afterHtml: '<img class="later">' })
    const again = new ReviewStore(dir).get(added.id)!
    expect(again.look?.beforeImage).toBe(JPEG)
    expect(again.look?.afterHtml).toContain('after')
    const md = s.markdown('https://www.stroustrup.com/')
    expect(md).toContain('这张照片')
    expect(md).toContain('![改前](')
    expect(md).toContain('![改后](')
  })

  it('replaces a blank saved picture when a later capture has a real image (g1.1)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ph-review-'))
    const s = new ReviewStore(dir)
    const added = s.add({
      kind: 'patch',
      path: '/',
      selector: 'h1',
      note: '',
      patch: { style: { 'font-style': 'italic' } },
      look: { beforeImage: JPEG, afterImage: JPEG, beforeHtml: '<h1>before</h1>', afterHtml: '<h1>after</h1>' },
      author,
      anchor: { tag: 'h1' },
    })
    const shot = `data:image/jpeg;base64,${'c'.repeat(120)}`
    s.attachLook(added.id, { beforeImage: shot, afterImage: shot, afterHtml: '<h1>later</h1>' })
    const again = new ReviewStore(dir).get(added.id)!
    expect(again.look?.beforeImage).toBe(shot)
    expect(again.look?.afterImage).toBe(shot)
    expect(again.look?.beforeHtml).toContain('before')
    expect(again.look?.afterHtml).toContain('after')
    s.attachLook(added.id, { beforeImage: 'javascript:alert(1)' })
    expect(new ReviewStore(dir).get(added.id)!.look?.beforeImage).toBe(shot)
    const md = s.markdown('https://www.stroustrup.com/')
    expect(md).toContain('斜体')
    expect(md).toContain(shot)
  })
})
