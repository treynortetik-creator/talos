// 0.18: long Markdown is cut into pieces that are drawn one by one. These tests pin where it may cut (never inside a fence,
// table or list), that growing text keeps its earlier pieces, and that the pieces draw the same page as the whole text.
import { describe, expect, it } from 'vitest'
import { markdownPieces, renderPieces } from '../../src/features/threads/markdownPieces.ts'
import { renderMarkdown } from '../../src/lib/markdown.ts'
import { LARGE_MARKDOWN_CHUNK_MAX_CHARS, splitMarkdown, withMarkdownDefinitions } from '../../src/lib/markdownChunks.ts'

const TARGET = 4 * 1024
const para = (n: number) => `Paragraph ${n}: ${'word '.repeat(60).trim()}.`
const paras = (count: number, from = 0) => Array.from({ length: count }, (_, i) => para(from + i)).join('\n\n')
const fenceCount = (text: string) => text.split('\n').filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l)).length

describe('splitMarkdown: where it cuts', () => {
  it('never cuts inside a backtick, longer backtick or tilde fence', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} of the code\n\n# not a heading ${i}`).join('\n')
    for (const [open, close] of [
      ['```sh', '```'],
      ['````md', '````'],
      ['~~~', '~~~'],
    ] as const) {
      const inner = open.startsWith('````') ? `${body}\n\`\`\`\nstill inside` : body
      const text = `${paras(3)}\n\n${open}\n${inner}\n${close}\n\n${paras(3, 10)}`
      const { chunks } = splitMarkdown(text)
      expect(chunks.length).toBeGreaterThan(1)
      const holding = chunks.filter((c) => c.text.includes(`${open}\n`))
      expect(holding).toHaveLength(1)
      expect(holding[0]?.text).toContain(`\n${close}`)
      expect(holding[0]?.text.split('\n').at(-1)).not.toBe(open)
      expect(holding[0]?.text).toContain('line 199 of the code')
      expect(chunks.map((c) => c.text).join('\n')).toBe(text)
    }
  })

  it('keeps an unclosed fence at the end in the last piece', () => {
    const text = `${paras(40)}\n\n\`\`\`sh\n${'echo hi\n'.repeat(2000)}`
    const { chunks } = splitMarkdown(text)
    expect(chunks.length).toBeGreaterThan(1)
    const last = chunks.at(-1)?.text ?? ''
    expect(last).toContain('```sh')
    expect(chunks.slice(0, -1).every((c) => !c.text.includes('```'))).toBe(true)
  })

  it('keeps a table straddling the target whole', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| row ${i} | ${'cell '.repeat(10).trim()} |`).join('\n')
    const table = `| name | value |\n|------|-------|\n${rows}`
    const text = `${paras(14)}\n\n${table}\n\n${paras(6, 50)}`
    const { chunks } = splitMarkdown(text)
    const holding = chunks.filter((c) => c.text.includes('| row '))
    expect(holding).toHaveLength(1)
    expect(holding[0]?.text).toContain('| row 0 |')
    expect(holding[0]?.text).toContain('| row 119 |')
  })

  it('keeps bullet, ordered and nested lists (with blank lines between items) whole', () => {
    const bullets = Array.from({ length: 150 }, (_, i) => `- item ${i} ${'text '.repeat(8).trim()}`).join('\n\n')
    const ordered = Array.from({ length: 150 }, (_, i) => `${i + 1}. step ${i} ${'text '.repeat(8).trim()}`).join(
      '\n\n',
    )
    const nested = Array.from({ length: 80 }, (_, i) => `- parent ${i}\n\n  - child ${i}\n\n    still child ${i}`).join(
      '\n\n',
    )
    for (const [name, list, first, last] of [
      ['bullets', bullets, '- item 0 ', '- item 149 '],
      ['ordered', ordered, '1. step 0 ', '150. step 149 '],
      ['nested', nested, '- parent 0', '- parent 79'],
    ] as const) {
      const { chunks } = splitMarkdown(`${paras(13)}\n\n${list}\n\n${paras(5, 60)}`)
      const holding = chunks.filter((c) => c.text.includes(first) || c.text.includes(last))
      expect(holding, name).toHaveLength(1)
      expect(holding[0]?.text, name).toContain(first)
      expect(holding[0]?.text, name).toContain(last)
    }
  })

  it('does not cut at an ordered list item that follows a blank line', () => {
    const text = `${paras(20)}\n\n1. one\n\n2. two\n\n3. three`
    const { chunks } = splitMarkdown(text)
    expect(chunks.at(-1)?.text).not.toMatch(/^2\. two/)
  })

  it('splits CRLF text like LF text once the line ends are normalised', () => {
    const lf = `${paras(30)}\n\n\`\`\`\ncode\n\`\`\`\n\n${paras(10, 40)}`
    const crlf = lf.replaceAll('\n', '\r\n')
    expect(markdownPieces(crlf, 1)?.map((p) => p.text)).toEqual(markdownPieces(lf, 1)?.map((p) => p.text))
  })
})

describe('splitMarkdown: growing text', () => {
  it('keeps every earlier piece when more text is appended, and an open fence stays in the last piece', () => {
    const lines =
      `${paras(60)}\n\n\`\`\`sh\n${Array.from({ length: 400 }, (_, i) => `echo ${i}`).join('\n')}\n\`\`\`\n\n${paras(30, 90)}`.split(
        '\n',
      )
    let previous: readonly string[] = []
    for (let end = 1; end <= lines.length; end += 7) {
      const text = lines.slice(0, end).join('\n')
      const texts = splitMarkdown(text).chunks.map((c) => c.text)
      // every piece but the last is fixed once a later piece exists
      for (let i = 0; i < previous.length - 1; i++) expect(texts[i]).toBe(previous[i])
      const open = fenceCount(text) % 2 === 1
      if (open) expect(texts.at(-1)).toContain('```sh')
      previous = texts
    }
  })

  it('draws only the last piece again when text is appended (the earlier ones come from the cache)', () => {
    const lines = paras(80).split('\n')
    let calls = 0
    const draw = (t: string) => {
      calls++
      return `<p>${t.length}</p>`
    }
    const cache = new Map<string, string>()
    const first = markdownPieces(lines.slice(0, 80).join('\n'), TARGET) ?? []
    renderPieces(first, draw, cache)
    const pieces = first.length
    expect(pieces).toBeGreaterThan(1)
    expect(calls).toBe(pieces)
    for (let step = 1; step <= 20; step++) {
      calls = 0
      const next = markdownPieces(`${lines.slice(0, 80 + step).join('\n')}`, TARGET) ?? []
      renderPieces(next, draw, cache)
      expect(calls).toBeLessThanOrEqual(2) // the grown last piece, and at most one new piece
    }
  })

  it('draws every piece again once when a new link definition arrives', () => {
    const base = `${paras(40)}\n\n[a]: https://example.com/a\n\n${paras(10, 50)}`
    let calls = 0
    const draw = (t: string) => {
      calls++
      return t
    }
    const cache = new Map<string, string>()
    const one = markdownPieces(base, TARGET) ?? []
    renderPieces(one, draw, cache)
    calls = 0
    const two = markdownPieces(`${base}\n\n[b]: https://example.com/b`, TARGET) ?? []
    renderPieces(two, draw, cache)
    expect(calls).toBe(two.length)
  })
})

describe('link definitions and an open fence', () => {
  it('are not put inside a last piece that ends in a fence still being written', () => {
    const defs = '[docs]: https://example.com/docs'
    // a reply still streaming: its last piece opens a fence and has not closed it yet
    // the definitions go before the block that is still open, so links above it in the same piece keep theirs
    expect(withMarkdownDefinitions('See [docs].\n\n```ts\nconst a = 1', defs)).toBe(
      `See [docs].\n\n${defs}\n\n\`\`\`ts\nconst a = 1`,
    )
    expect(withMarkdownDefinitions('Some words\n\n~~~\nplain', defs)).toBe(`Some words\n\n${defs}\n\n~~~\nplain`)
  })
  it('are still added after a fence that is closed', () => {
    const defs = '[docs]: https://example.com/docs'
    expect(withMarkdownDefinitions('See [docs].\n\n```\nx\n```', defs)).toBe(
      `See [docs].\n\n\`\`\`\nx\n\`\`\`\n\n${defs}`,
    )
  })
})

describe('splitMarkdown: huge input', () => {
  it('splits 5 MB into about size/target pieces and shows one oversized fence as source, unparsed', () => {
    const big = paras(20000)
    expect(big.length).toBeGreaterThan(5_000_000)
    const { chunks } = splitMarkdown(big)
    expect(chunks.length).toBeGreaterThan(big.length / (TARGET * 2))
    expect(chunks.length).toBeLessThan(big.length / (TARGET / 2))
    expect(chunks.every((c) => c.text.length < LARGE_MARKDOWN_CHUNK_MAX_CHARS)).toBe(true)
    const text = `${paras(5)}\n\n\`\`\`\n${'x'.repeat(LARGE_MARKDOWN_CHUNK_MAX_CHARS + 1000)}\n\`\`\`\n\n${paras(5, 9)}`
    const pieces = markdownPieces(text) ?? []
    expect(pieces.filter((p) => p.source)).toHaveLength(1)
    const drawn: string[] = []
    renderPieces(
      pieces,
      (t) => {
        drawn.push(t)
        return ''
      },
      new Map(),
    )
    expect(drawn.some((t) => t.includes('xxxxxxxx'))).toBe(false)
  })

  it('leaves a small text alone', () => {
    expect(markdownPieces('short reply')).toBeNull()
    expect(markdownPieces('x'.repeat(8 * 1024))).toBeNull()
  })
})

describe('the pieces draw the same page as the whole text', () => {
  const doc = (n: number) =>
    [
      `# Title ${n}`,
      'Intro with a [link](https://example.com/a), `code`, :tada: and a [ref link][r1].',
      '',
      '- [ ] open task',
      '- [x] done task',
      '  - nested',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1',
      '',
      '# not a heading',
      '```',
      '',
      '> quote',
      '>',
      '> ```',
      '> quoted code',
      '> ```',
      '',
      '1. one',
      '',
      '2. two',
      '',
      '$$x^2$$',
      '',
      '<b>looks like html</b>',
      '',
      '[r1]: https://example.com/ref "Title"',
      '',
      paras(9, n * 10),
      '',
    ].join('\n')
  const norm = (html: string) => html.replace(/>\s+</g, '><').replace(/\s+$/g, '')

  it('matches renderMarkdown of the whole text for 12 documents', () => {
    for (let n = 0; n < 12; n++) {
      const text = Array.from({ length: 3 }, (_, i) => doc(n * 3 + i)).join('\n')
      const pieces = markdownPieces(text, 1024) ?? []
      expect(pieces.length).toBeGreaterThan(2)
      const joined = pieces.map((p) => renderMarkdown(p.text)).join('')
      // the one allowed difference: a link definition is copied into every piece, and a definition draws nothing
      expect(norm(joined)).toBe(norm(renderMarkdown(text)))
    }
  })

  it('resolves a reference link in a later piece from a definition in an earlier one', () => {
    const text = `[late]: https://example.com/late\n\n${paras(30)}\n\nSee [late] here.`
    const pieces = markdownPieces(text, 1024) ?? []
    const html = pieces.map((p) => renderMarkdown(p.text)).join('')
    expect(html).toContain('<a href="https://example.com/late"')
  })

  it('draws task boxes in later pieces too', () => {
    const text = `${paras(30)}\n\n- [ ] later open\n- [x] later done`
    const html = (markdownPieces(text, 1024) ?? []).map((p) => renderMarkdown(p.text)).join('')
    expect(html).toContain('☐')
    expect(html).toContain('☑')
  })

  it('withMarkdownDefinitions adds the shared definitions after a piece', () => {
    expect(withMarkdownDefinitions('text', '[a]: https://example.com')).toBe('text\n\n[a]: https://example.com')
    expect(withMarkdownDefinitions('text', '')).toBe('text')
  })
})
