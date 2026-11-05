import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/lib/markdown.ts'

const CORPUS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '[a](javascript:alert(1))',
  '[a](JaVaScRiPt:alert(1))',
  '[a](data:text/html;base64,PHNjcmlwdD4=)',
  '![a](javascript:alert(1))',
  '<a href="javascript:alert(1)">x</a>',
  '<svg onload=alert(1)>',
  '<iframe src=//evil></iframe>',
  '<style>*{display:none}</style>',
  '<form action=//evil><input></form>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<details open ontoggle=alert(1)>',
  '[a](vbscript:x)',
  '`<script>`',
]

describe('renderMarkdown', () => {
  for (const src of CORPUS) {
    it(`is inert: ${src}`, () => {
      const html = renderMarkdown(src)
      const doc = new DOMParser().parseFromString(html, 'text/html')
      expect(doc.querySelectorAll('script, iframe, svg, style, form, input, math, img, details').length).toBe(
        src === '`<script>`' ? 0 : 0,
      )
      for (const el of doc.querySelectorAll('*')) {
        for (const a of el.getAttributeNames()) expect(a.startsWith('on'), `${a} on ${el.tagName}`).toBe(false)
      }
      for (const a of doc.querySelectorAll('a')) {
        const href = a.getAttribute('href')
        expect(href === null || /^(https?:|mailto:)/i.test(href)).toBe(true)
      }
    })
  }
  it('opens links outside with noopener', () => {
    const html = renderMarkdown('[x](https://example.com) and https://example.org and <a@example.com>')
    const links = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a')]
    expect(links).toHaveLength(3)
    for (const l of links) {
      expect(l.getAttribute('target')).toBe('_blank')
      expect(l.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })
  it('renders ordinary markdown', () => {
    expect(renderMarkdown('**bold** and `code`')).toContain('<strong>bold</strong>')
  })
})
