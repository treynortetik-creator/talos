import { describe, expect, test } from 'bun:test'
import { markdownToPlain } from '../src/markdown-plain.ts'

describe('markdownToPlain', () => {
  test('strips emphasis markers', () => {
    expect(markdownToPlain('a **bold** and *it* and __b2__ and _i2_ and ~~gone~~ and ***both***')).toBe(
      'a bold and it and b2 and i2 and gone and both',
    )
  })
  test('keeps snake_case and math-like asterisks', () => {
    expect(markdownToPlain('use my_var_name and 2 * 3 * 4')).toBe('use my_var_name and 2 * 3 * 4')
  })
  test('keeps bullets as "- " and normalizes * and +', () => {
    expect(markdownToPlain('- a\n* b\n+ c\n  - nested **x**\n1. one')).toBe('- a\n- b\n- c\n  - nested x\n1. one')
  })
  test('inline code loses backticks, contents untouched', () => {
    expect(markdownToPlain('run `git **status**` now')).toBe('run git **status** now')
  })
  test('fenced code keeps content without fences', () => {
    expect(markdownToPlain('before\n```ts\nconst a = *b*\n- x\n```\nafter')).toBe('before\nconst a = *b*\n- x\nafter')
  })
  test('links become "text (url)", bare-url links collapse', () => {
    expect(markdownToPlain('see [the **docs**](https://x.test/a_b_c) ok')).toBe(
      'see the docs (https://x.test/a_b_c) ok',
    )
    expect(markdownToPlain('[https://x.test](https://x.test)')).toBe('https://x.test')
  })
  test('images become [image: alt]', () => {
    expect(markdownToPlain('![a cat](https://x.test/c.png)')).toBe('[image: a cat]')
  })
  test('headings lose the #', () => {
    expect(markdownToPlain('# One\n### Two ###\ntext')).toBe('One\nTwo\ntext')
  })
  test('tables become one row per line joined by " · "', () => {
    const md = '| Name | Qty |\n| --- | :-: |\n| **a** | 1 |\n| `b` | 2 |\n\nafter'
    expect(markdownToPlain(md)).toBe('Name · Qty\na · 1\nb · 2\n\nafter')
  })
  test('blockquotes and rules', () => {
    expect(markdownToPlain('> quoted\n---\nend')).toBe('quoted\nend')
  })
})
