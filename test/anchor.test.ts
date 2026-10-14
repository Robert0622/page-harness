// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { anchorOf, locate, score, similarity } from '../client/shared/anchor'

const page = (html: string) => {
  document.body.innerHTML = html
  return document
}

describe('anchoring', () => {
  it('scores text similarity', () => {
    expect(similarity('Hello world', 'Hello world')).toBe(1)
    expect(similarity('Hello world', 'Hello worlds')).toBeGreaterThan(0.8)
    expect(similarity('Hello world', 'Pricing')).toBeLessThan(0.2)
  })

  it('keeps a selector hit that still fits', () => {
    const doc = page('<section><h1 class="title">Hello fixture</h1></section>')
    const a = anchorOf(doc.querySelector('h1')!)
    expect(a).toMatchObject({ tag: 'h1', classes: ['title'], text: 'Hello fixture' })
    expect(locate('h1.title', a)).toMatchObject({ how: 'selector' })
  })

  it('finds the element again by text after classes and structure change', () => {
    const doc = page('<main><div><h2 class="a">Plans</h2><p class="lead">Pick the plan that fits your team</p></div></main>')
    const a = anchorOf(doc.querySelector('p.lead')!)
    page('<main><section><div><h2 class="b">Plans</h2></div><p class="intro-x">Pick the plan that fits your team.</p></section></main>')
    const r = locate('div > p.lead', a)
    expect(r?.how).toBe('fuzzy')
    expect(r?.el.textContent).toContain('Pick the plan')
  })

  it('rejects a selector that now points at a different element and gives up when nothing fits', () => {
    page('<ul><li>Alpha feature</li><li>Beta feature</li></ul>')
    const a = anchorOf(document.querySelectorAll('li')[1])
    page('<ul><li>Gamma thing</li><li>Delta thing</li></ul>')
    expect(score(document.querySelectorAll('li')[1], a)).toBeLessThan(0.35)
    expect(locate('li:nth-of-type(2)', a)).toBeNull()
  })

  it('accepts the replacement text of an applied patch', () => {
    page('<h1 class="t">Old title</h1>')
    const a = anchorOf(document.querySelector('h1')!)
    document.querySelector('h1')!.textContent = 'Completely different words'
    expect(locate('h1.t', a, { altTexts: ['Completely different words'] })?.how).toBe('selector')
  })
})
