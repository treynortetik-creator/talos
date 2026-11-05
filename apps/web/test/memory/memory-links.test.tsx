/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Memory links in the browser. The note is read by the real bridge helpers (extractLinks + resolveLinks over a file index)
// and the result goes through the real renderNote, so the bridge-to-app contract is what is under test, not a hand-written
// list. Older bridges are modelled by the code they shipped (see oldBridgeLinks).

import { scanLinks } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { extractLinks, type FileIndex, type RawLink, resolveLinks } from '../../../bridge/src/memory/text.ts'
import { MemoryScreen } from '../../src/features/memory/index.tsx'
import { frontmatterParts, linkPlan, pickBar, renderNote, splitFrontmatter } from '../../src/features/memory/logic.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createSocketMemory } from '../../src/lib/socketMemory.ts'
import { macFrom, type Step } from './captured.ts'

afterEach(cleanup)

const A = { text: 'Alpha', root_id: 'notes', path: 'Alpha.md' }
const B = { text: 'Beta', root_id: 'notes', path: 'Beta.md' }
const GONE = { text: 'Gone', root_id: null, path: null }
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

const FILES = [
  'Note.md',
  'Alpha.md',
  'Beta.md',
  'a.md',
  'b.md',
  'foo.md',
  'one.md',
  'two.md',
  'sub/x.md',
  'people/foo.md',
]
const index: FileIndex = { has: (_r, p) => FILES.includes(p), paths: () => FILES, rootIds: () => ['notes'] }
const resolve = (raw: RawLink[], from = 'Note.md') =>
  resolveLinks(raw, { rootId: 'notes', path: from }, index, () => true)

/**
 * `extractLinks` exactly as the first release of the memory browser shipped it (commit 794fc5c6, apps/bridge/src/memory/text.ts):
 * only fenced blocks are removed, every wiki link is listed before any relative one, and nothing else is code.
 */
function oldBridgeLinks(text: string): RawLink[] {
  const src = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '')
  const out: RawLink[] = []
  const seen = new Set<string>()
  const add = (l: RawLink) => {
    const k = `${l.kind}\0${l.text}\0${l.target}`
    if (seen.has(k) || out.length >= 5000) return
    seen.add(k)
    out.push(l)
  }
  for (const m of src.matchAll(/\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g)) {
    const target = (m[1] as string).split('#')[0]?.trim() ?? ''
    if (target) add({ kind: 'wiki', target, text: (m[2] ?? m[1]) as string })
  }
  for (const m of src.matchAll(/(?<!!)\[([^\]\n]{1,200})\]\(([^()\s]{1,400})(?:\s+"[^"]*")?\)/g)) {
    const raw = (m[2] as string).split('#')[0] ?? ''
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('//')) continue
    let target = raw
    try {
      target = decodeURI(raw)
    } catch {
      // keep it raw
    }
    if (/\.(md|markdown|txt)$/i.test(target)) add({ kind: 'rel', target, text: m[1] as string })
  }
  return out
}

/** One note through the real chain: what the Mac lists for it, and the HTML the app makes from that list. */
function show(text: string, opts: { from?: string; listed?: ReturnType<typeof resolve>; complete?: boolean } = {}) {
  const from = opts.from ?? 'Note.md'
  const listed = opts.listed ?? resolve(extractLinks(text), from)
  const plan = linkPlan(text, listed, from, opts.complete ?? true)
  const html = renderNote(splitFrontmatter(text).body, listed, plan)
  const box = document.createElement('div')
  box.innerHTML = html
  const opens = [...box.querySelectorAll('a[data-mem-link]')].map(
    (a) => `${a.textContent}>${listed[Number(a.getAttribute('data-mem-link'))]?.path}`,
  )
  const grey = [...box.querySelectorAll('[data-testid="memory-link-null"]')].map((a) => a.textContent)
  return { html, listed, opens, grey, box }
}

describe('repeat links', () => {
  it('every copy of a link renders, not just the first', () => {
    const html = renderNote('[[Alpha]] then [[Alpha]] and again [[Alpha]]\n\n[[Gone]] [[Gone]]', [A, GONE])
    expect(count(html, /data-mem-link="0"/g)).toBe(3)
    expect(count(html, /memory-link-null/g)).toBe(2)
    expect(html).not.toContain('[[')
  })
  it('two different targets behind one label keep their own slots, and repeats follow the right one', () => {
    const one = { text: 'x', root_id: 'notes', path: 'one.md' }
    const two = { text: 'x', root_id: 'notes', path: 'two.md' }
    const html = renderNote('[[one|x]] [[two|x]] [[one|x]] [[two|x]]', [one, two])
    expect([...html.matchAll(/data-mem-link="(\d)"/g)].map((m) => m[1])).toEqual(['0', '1', '0', '1'])
  })
  it('relative markdown links repeat too; ones the Mac never lists stay as written', () => {
    const html = renderNote('[Alpha](Alpha.md) [Alpha](Alpha.md) ![Alpha](Alpha.md) [pic](p.png)', [A])
    expect(count(html, /data-mem-link="0"/g)).toBe(2)
    expect(html).toContain('[pic](p.png)')
    expect(html).not.toContain('<img')
  })
  it('a link past the Mac cap (not listed) stays plain text instead of stealing another slot', () => {
    const html = renderNote('[[Alpha]] [[Omega]] [[Alpha]]', [A])
    expect(count(html, /data-mem-link="0"/g)).toBe(2)
    expect(html).toContain('[[Omega]]')
  })
})

describe('the right note opens (slots follow what the Mac listed, not order or label)', () => {
  it('same label, one relative and one wiki link, code between them: each opens its own note', () => {
    expect(show('[x](a.md) `code` [[b|x]]').opens).toEqual(['x>a.md', 'x>b.md'])
    expect(show('[[b|x]] `code` [x](a.md)').opens).toEqual(['x>b.md', 'x>a.md'])
    expect(show('[x](a.md) [[b|x]] [x](a.md) [[b|x]]').opens).toEqual(['x>a.md', 'x>b.md', 'x>a.md', 'x>b.md'])
  })
  it('a link the Mac listed under another label than the one in the note is not matched by position', () => {
    // a stale list: the note now says Beta where the list has Alpha
    const r = show('[[Beta]]', { listed: [A] })
    expect(r.opens).toEqual([])
    expect(r.html).toContain('[[Beta]]')
  })
  it('a note link written like a slot address is an ordinary web link and takes no entry', () => {
    const r = show('[Alpha](Alpha.md) [spoof](https://memory.invalid/i/0 "t")', { listed: [A] })
    expect(r.opens).toEqual(['Alpha>Alpha.md'])
    const spoof = [...r.box.querySelectorAll('a')].find((a) => a.textContent === 'spoof')
    expect(spoof?.getAttribute('href')).toBe('https://memory.invalid/i/0')
    expect(spoof?.hasAttribute('data-mem-link')).toBe(false)
    expect(spoof?.getAttribute('target')).toBe('_blank')
  })
  it('two renders back to back do not share a list', () => {
    const one = renderNote('[[Alpha]]', [A])
    const two = renderNote('[[Alpha]]', [{ ...GONE, text: 'Alpha' }])
    expect(one).toContain('data-mem-link="0"')
    expect(two).toContain('memory-link-null')
    expect(renderNote('[[Alpha]]', [A])).toBe(one)
  })
})

describe('an older bridge (lists links in code, wiki before relative)', () => {
  const old = (text: string, from = 'Note.md') => show(text, { listed: resolve(oldBridgeLinks(text), from), from })
  it('swapped order with the same label: each link still opens its own note', () => {
    expect(old('[x](a.md) `code` [[b|x]]').opens.sort()).toEqual(['x>a.md', 'x>b.md'])
    const r = old('[x](a.md) [[b|x]]')
    expect(r.opens).toEqual(['x>a.md', 'x>b.md'])
  })
  it('an entry listed only for a link in code is never given to a real link', () => {
    const r = old('`[[Alpha]]` and [[Beta]] and [[Alpha]]')
    expect(r.opens).toEqual(['Beta>Beta.md', 'Alpha>Alpha.md'])
    const same = old('`[x](a.md)` then [x](b.md)')
    // two entries, same label, only one is a real link: unclear, so the real link stays plain text, never a.md
    expect(same.opens).not.toContain('x>a.md')
  })
  it('properties plus a link that is in code for the new reader: the real copy still opens', () => {
    const r = old('---\nrel: [[Alpha]]\n---\n`[[Beta]]` and [[Beta]] and [[Alpha]]')
    expect(r.opens).toEqual(['Beta>Beta.md', 'Alpha>Alpha.md'])
  })
})

describe('code is left as typed, and no placeholder address ever reaches the reader', () => {
  const clean = (html: string) => expect(html).not.toMatch(/memory\.invalid|data-mem-slot/)
  const cases: Array<[string, string, string]> = [
    ['inline code', 'Write `[[Alpha]]` or ``[b](b.md) ` x`` then [[Beta]]', '`[[Alpha]]`'],
    ['an unclosed fence', 'before [[Beta]]\n```\n[[Alpha]] [b](b.md)\n', '[[Alpha]]'],
    ['a four-space indented block', 'para\n\n    [[Alpha]] [b](b.md)\n\nthen [[Beta]]', '[[Alpha]]'],
    [
      'a fence in a list item with a blank line inside',
      '- item\n\n  ```\n  code\n\n  [[Alpha]]\n  ```\n\n[[Beta]]',
      '[[Alpha]]',
    ],
    ['a four-backtick fence around a three-backtick one', '````\n```\n[[Alpha]]\n```\n````\n[[Beta]]', '[[Alpha]]'],
    ['a tilde fence', '~~~\n[[Alpha]]\n~~~\n[[Beta]]', '[[Alpha]]'],
    ['a fence in a block quote', '> ```\n> [[Alpha]]\n> ```\n\n[[Beta]]', '[[Alpha]]'],
  ]
  for (const [name, text, literal] of cases) {
    it(`${name}`, () => {
      const r = show(text)
      clean(r.html)
      expect(r.html).toContain(literal.replace(/`/g, ''))
      expect(r.opens.some((o) => o.startsWith('Alpha'))).toBe(false)
      expect(r.listed.some((l) => l.text === 'Alpha')).toBe(false) // the Mac did not list it either
    })
  }
  it('the first chunk of a long note ends inside a fence the next chunk closes', () => {
    const full = 'intro [[Beta]]\n```\n[[Alpha]] [x](a.md)\nmore code\n```\nafter [[Beta]]\n'
    const cut = full.slice(0, full.indexOf('more code'))
    const listed = resolve(extractLinks(full))
    for (const [t, complete] of [
      [cut, false],
      [full, true],
    ] as const) {
      const r = show(t, { listed, complete })
      clean(r.html)
      expect(r.html).toContain('[[Alpha]] [x](a.md)')
      expect(r.opens.every((o) => o === 'Beta>Beta.md')).toBe(true)
    }
  })
  it('a note link inside the label of an outside link is not a second link in the same anchor', () => {
    const html = renderNote('[see [[Alpha]]](https://e.com/x)', [A])
    expect(count(html, /<a\b/g)).toBe(1)
    expect(html).toContain('see [[Alpha]]')
  })
  it('hostile text: raw HTML, an attribute name and a slot-looking address in the note do nothing', () => {
    const r = show(
      '[[Alpha|<a data-mem-slot="0">x</a>]] <a data-mem-slot="0" href="https://e.com">y</a> [z](https://memory.invalid/i/0)',
      { listed: [{ ...A, text: '<a data-mem-slot="0">x</a>' }] },
    )
    // only the one listed link is a note link; the HTML is text; the address is an ordinary outside link
    expect(r.box.querySelectorAll('a[data-mem-link]').length).toBe(1)
    expect(r.box.querySelectorAll('a[data-mem-slot]').length).toBe(0)
    expect(r.html).toContain('&lt;a data-mem-slot')
    const z = [...r.box.querySelectorAll('a')].find((a) => a.textContent === 'z')
    expect(z?.getAttribute('href')).toBe('https://memory.invalid/i/0')
    expect(z?.hasAttribute('data-mem-link')).toBe(false)
  })
})

describe('what a reader sees as a link matches what the Mac listed', () => {
  it('code in a link label: relative, wiki and a table cell', () => {
    const r = show('[`foo`](foo.md) [[foo|`bar`]]')
    expect(r.opens).toEqual(['foo>foo.md', 'bar>foo.md'])
    expect(r.box.querySelectorAll('a code').length).toBe(2)
    const t = show('| a | b |\n| --- | --- |\n| x | [[foo\\|`bar`]] |\n')
    expect(t.opens).toEqual(['bar>foo.md'])
    expect(t.box.querySelectorAll('table a code').length).toBe(1)
  })
  it('backticks do not pair across list items, CRLF paragraphs or an escape', () => {
    expect(show('- run `foo\n- see [[Alpha]] and `bar`').opens).toEqual(['Alpha>Alpha.md'])
    expect(show('run `foo\r\n\r\nsee [[Alpha]] and `bar`\r\n').opens).toEqual(['Alpha>Alpha.md'])
    expect(show('a \\` [[Alpha]] \\` `[[Beta]]`').opens).toEqual(['Alpha>Alpha.md'])
  })
  it('a closing run of another length does not close a code span', () => {
    expect(show('``a ` b [[Alpha]] c [[Beta]]').opens).toEqual(['Alpha>Alpha.md', 'Beta>Beta.md'])
    expect(show('``a` [[Alpha]] b` [[Beta]]').opens).toEqual(['Beta>Beta.md']) // the single ticks pair
    expect(show('``a ` [[Alpha]] `` [[Beta]]').opens).toEqual(['Beta>Beta.md'])
  })
  it('![[Gone]] stays visible: a missing link is grey text, never an image that vanishes', () => {
    const r = show('![[Gone]] and ![[Alpha]]', { listed: [GONE, A] })
    expect(r.html).toContain('Gone')
    expect(r.grey).toEqual(['Gone'])
    expect(r.html).not.toContain('<img')
    expect(r.opens).toEqual(['Alpha>Alpha.md'])
    expect(show('![[Gone]]', { listed: [] }).html).toContain('![[Gone]]')
  })
  it('a backtick in the properties does not change which body links are listed or shown', () => {
    const text = '---\ntitle: it`s\nrel: [[Alpha]]\n---\n[[Beta]] and `x` [[Alpha]] `y`'
    const r = show(text)
    expect(r.listed.map((l) => l.text)).toEqual(['Alpha', 'Beta'])
    expect(r.opens).toEqual(['Beta>Beta.md', 'Alpha>Alpha.md'])
  })
  it('a title after the address is part of the link', () => {
    expect(show('[x](a.md "Title") and [y](b.md \'t\')').opens).toEqual(['x>a.md'])
  })
})

describe('the scanner and the renderer agree on a corpus of real shapes', () => {
  // text, the exact links that must be live (label>file, in page order), and the cells of every table row when there is one
  const corpus: Array<{ text: string; opens: string[]; cells?: number }> = [
    {
      text: '# T\n[[Alpha]] and [x](a.md) and `[[Beta]]`.\n\n```md\n[[Beta]]\n```\n',
      opens: ['Alpha>Alpha.md', 'x>a.md'],
    },
    {
      text: '- one [[Alpha]]\n  - two `[[Beta]]` [b](b.md)\n\n1. three [[foo]]\n',
      opens: ['Alpha>Alpha.md', 'b>b.md', 'foo>foo.md'],
    },
    { text: '> quote [[Alpha]]\n> `[[Beta]]` [[foo]]\n', opens: ['Alpha>Alpha.md', 'foo>foo.md'] },
    {
      text: '| a | b |\n| - | - |\n| [[Alpha\\|A]] | `[[Beta]]` |\n| [x](a.md) | [[foo|bar]] |\n',
      opens: ['A>Alpha.md', 'x>a.md', 'bar>foo.md'],
      cells: 6,
    },
    {
      // the shape of a real "who owes what" table: an alias bar that is not escaped sits inside one cell
      text: '| Owner | Commitment | Date |\n|---|---|---|\n| Ann | Chase [[Alpha|Al]] for his notes | immediate |\n| Bo | Call [[Beta]] | later |\n',
      opens: ['Al>Alpha.md', 'Beta>Beta.md'],
      cells: 9,
    },
    { text: 'Setext\n======\n[[Alpha]] `x\n\n`y [[Beta]]\n', opens: ['Alpha>Alpha.md', 'Beta>Beta.md'] },
    { text: '    [[Beta]]\n\n[[Alpha]]\n\n\ttab [[foo]]\n', opens: ['Alpha>Alpha.md'] },
    {
      text: '`a` [[Alpha]] ``b ` c`` [[Beta]] ```\ncode\n``` [[foo]]\n',
      // the line that starts with ``` opens a fenced block (it may interrupt a paragraph), so [[foo]] on it is code
      opens: ['Alpha>Alpha.md', 'Beta>Beta.md'],
    },
  ]
  for (const [i, c] of corpus.entries()) {
    it(`note ${i + 1}: exactly these links are live, in this order, and nothing else`, () => {
      const r = show(c.text)
      expect(r.opens).toEqual(c.opens)
      // everything the Mac listed with a target is shown; nothing the Mac did not list became a link
      const listedPaths = r.listed.filter((l) => l.path).map((l) => l.text)
      expect(new Set(r.opens.map((o) => o.split('>')[0]))).toEqual(new Set(listedPaths))
      expect(r.html).not.toMatch(/memory\.invalid|data-mem-slot/)
      if (c.cells !== undefined) expect(r.box.querySelectorAll('th,td')).toHaveLength(c.cells)
    })
  }
  it('random notes: a link is only ever made for something the scanner found', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const bits = [
      '`',
      '``',
      '```',
      '~~~',
      '\n',
      '\n\n',
      '  ',
      '    ',
      '- ',
      '> ',
      '| ',
      ' | ',
      '[[Alpha]]',
      '[[Beta|x]]',
      '[x](a.md)',
      '![[Gone]]',
      '\\',
      'text ',
      '1. ',
      '# ',
    ]
    for (let n = 0; n < 400; n++) {
      let text = ''
      for (let k = 0; k < 14; k++) text += bits[Math.floor(rnd() * bits.length)]
      const r = show(text)
      const found = new Set(scanLinks(text).map((l) => l.text))
      for (const o of r.opens) expect(found.has(o.split('>')[0] as string)).toBe(true)
      expect(r.html).not.toMatch(/memory\.invalid|data-mem-slot/)
    }
  })
})

describe('tables', () => {
  it('an escaped bar inside a table cell still makes a live link', () => {
    const md = '| who | note |\n| --- | --- |\n| a | [[people/foo\\|Foo]] |\n| b | [[people/foo\\|Foo]] |\n'
    const r = show(md)
    expect(r.opens).toEqual(['Foo>people/foo.md', 'Foo>people/foo.md'])
    expect(r.html).toContain('<table>')
    expect(r.html).not.toContain('[[')
  })
  // the shape of a real meeting note ("who owes what"): a wiki link with an alias bar that is not escaped, inside one cell
  const owes =
    '| Owner | Commitment | Date |\n|---|---|---|\n| Ann | Chase [[Alpha|Al]] for his notes | immediate |\n| Bo | Call [[Beta]] | by Friday |\n'
  it('a bar inside [[name|alias]] does not split the cell: three cells per row, the link is live, no text is lost', () => {
    const r = show(owes)
    const rows = [...r.box.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent))
    expect(rows).toEqual([
      ['Owner', 'Commitment', 'Date'],
      ['Ann', 'Chase Al for his notes', 'immediate'],
      ['Bo', 'Call Beta', 'by Friday'],
    ])
    expect(r.opens).toEqual(['Al>Alpha.md', 'Beta>Beta.md'])
    expect(r.html).not.toContain('[[')
  })
  it('the same table with the bar escaped renders the same cells', () => {
    const r = show(owes.replace('[[Alpha|Al]]', '[[Alpha\\|Al]]'))
    expect([...r.box.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent))).toEqual([
      ['Owner', 'Commitment', 'Date'],
      ['Ann', 'Chase Al for his notes', 'immediate'],
      ['Bo', 'Call Beta', 'by Friday'],
    ])
    expect(r.opens).toEqual(['Al>Alpha.md', 'Beta>Beta.md'])
  })
  it('an older bridge that listed the unescaped-bar link never gets its entry given to the wrong cell', () => {
    const text = owes
    const r = show(text, { listed: resolve(oldBridgeLinks(text)) })
    expect(r.opens.length).toBeGreaterThan(0)
    expect(r.opens.every((o) => o === 'Al>Alpha.md' || o === 'Beta>Beta.md')).toBe(true)
    expect([...r.box.querySelectorAll('td')].map((c) => c.textContent)).toContain('immediate')
  })
  it('a bar outside [[..]] still splits; a code span or fence keeps its text', () => {
    const r = show('| a | b |\n| - | - |\n| x | y | z |\n| `[[Alpha|q]]` | [[Beta]] |\n')
    expect([...r.box.querySelectorAll('tr')].map((tr) => tr.children.length)).toEqual([2, 2, 2])
    expect(r.opens).toEqual(['Beta>Beta.md'])
    expect(show('```\n| [[Alpha|q]] |\n```\n').html).toContain('[[Alpha|q]]')
    expect(show('a [[Alpha|q]] | b\n').opens).toEqual(['q>Alpha.md'])
  })
  it('a relative link with an escaped bar in its label is live in a cell', () => {
    const r = show('| a | b |\n| - | - |\n| [x\\|y](a.md) | z |\n')
    expect(r.opens).toEqual(['x|y>a.md'])
    expect(r.box.querySelectorAll('td')).toHaveLength(2)
  })
  it('a note that already holds the private-use character the renderer borrows is shown unchanged', () => {
    const r = show('| a | b |\n| - | - |\n| \ue000 [[Alpha|Al]] | \ue000 |\n')
    expect([...r.box.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['\ue000 Al', '\ue000'])
  })
})

describe('the borrowed character never reaches a link address', () => {
  const href = (md: string) => show(md).box.querySelector('a[href^="http"]')?.getAttribute('href')
  it('a reference definition keeps a real bar in its address (encoded), as markdown-it alone gives it', () => {
    expect(href('[docs]\n\n[docs]: https://e.com/a[[b|c]]\n')).toBe('https://e.com/a%5B%5Bb%7Cc%5D%5D')
    expect(href('[docs]\n\n[docs]: https://e.com/a "t[[b|c]]"\n')).toBe('https://e.com/a')
  })
  it('an inline address and a note with a table beside the definition are the same', () => {
    expect(href('[x](https://e.com/a[[b|c]])')).toBe(href('[docs]\n\n[docs]: https://e.com/a[[b|c]]\n'))
    expect(href('| a |\n| - |\n| [[Alpha|Al]] |\n\n[docs]\n\n[docs]: https://e.com/a[[b|c]]\n')).toBe(
      'https://e.com/a%5B%5Bb%7Cc%5D%5D',
    )
  })
})

describe('a note that holds every character the renderer could borrow', () => {
  const all = (() => {
    let s = ''
    for (let c = 0xf8fe; c >= 0xe000; c--) s += String.fromCharCode(c)
    return s
  })()
  const table = '| a | b |\n| - | - |\n| x [[Alpha|Al]] | [[Beta]] |\n\n'
  it('opens only notes the Mac listed for that text, never a wrong one', () => {
    const r = show(table + all)
    for (const o of r.opens) expect(['Al>Alpha.md', 'Beta>Beta.md']).toContain(o)
    expect(r.html).not.toMatch(/memory\.invalid|data-mem-slot/)
  })
  it('picking the character is one pass: the work is counted, not timed', () => {
    // The old picker searched the whole note once per candidate (6399 searches). Nothing here reads a clock: string reads are
    // counted while pickBar runs. One pass reads each character once and starts no search; the number of searches does not
    // depend on the size of the note.
    const counted = ['charCodeAt', 'codePointAt', 'at'] as const
    const searches = [
      'indexOf',
      'lastIndexOf',
      'includes',
      'search',
      'match',
      'matchAll',
      'replace',
      'replaceAll',
      'split',
      'slice',
      'substring',
      'startsWith',
      'endsWith',
    ] as const
    const tally = (src: string) => {
      const proto = String.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
      const saved: Array<[string, (...a: unknown[]) => unknown]> = []
      const n = { reads: 0, searches: 0 }
      const wrap = (name: string, key: 'reads' | 'searches') => {
        const orig = proto[name] as (...a: unknown[]) => unknown
        saved.push([name, orig])
        proto[name] = function (this: unknown, ...args: unknown[]) {
          n[key]++
          return orig.apply(this, args)
        }
      }
      const reTest = RegExp.prototype.test
      const reExec = RegExp.prototype.exec
      RegExp.prototype.test = function (this: RegExp, s: string) {
        n.searches++
        return reTest.call(this, s)
      }
      RegExp.prototype.exec = function (this: RegExp, s: string) {
        n.searches++
        return reExec.call(this, s)
      }
      for (const c of counted) wrap(c, 'reads')
      for (const c of searches) wrap(c, 'searches')
      let got: string
      try {
        got = pickBar(src)
      } finally {
        for (const [name, orig] of saved) proto[name] = orig
        RegExp.prototype.test = reTest
        RegExp.prototype.exec = reExec
      }
      return { ...n, got }
    }
    const sizes = [40 * 1024, 400 * 1024].map((bytes) => {
      const text = `${'word '.repeat(Math.ceil(bytes / 5))}\n\n${all}`
      return { len: text.length, ...tally(text) }
    })
    for (const r of sizes) {
      expect(r.got).toBe('')
      expect(r.reads, 'each character is read at most once').toBeLessThanOrEqual(r.len)
      expect(r.searches, 'no search over the note').toBeLessThanOrEqual(8)
    }
    expect(sizes[1]?.searches).toBe(sizes[0]?.searches)
    expect(sizes[1]?.len).toBeGreaterThan((sizes[0]?.len ?? 0) * 8)
  })
  it('a note missing one of them still gets a character, however large', () => {
    expect(pickBar(`${'word '.repeat(1000)}${all.replace('\ue123', '')}`)).toBe('\ue123')
  })
})

describe('an address inside a link label', () => {
  it('<javascript:..> in the label of a listed relative link is not turned into a link', () => {
    const r = show('[<javascript:alert(1)>](a.md)')
    expect(r.html).not.toMatch(/href="javascript/i)
    expect(r.box.querySelectorAll('a')).toHaveLength(1)
    expect(r.box.querySelector('a')?.hasAttribute('data-mem-link')).toBe(true)
  })
  it('a plain note link next to it still opens its note', () => {
    expect(show('[x](a.md) <javascript:alert(1)>').opens).toEqual(['x>a.md'])
  })
})

describe('frontmatter links', () => {
  it('splits a value into text and links; unlisted ones are grey and lose their brackets', () => {
    const text = '---\nrel: see [[Alpha]], [[Gone]] and [[Nope|nick]]!\n---\n'
    const plan = linkPlan(text, [A, GONE], 'Note.md')
    expect(frontmatterParts('see [[Alpha]], [[Gone]] and [[Nope|nick]]!', plan)).toEqual([
      { text: 'see ' },
      { text: 'Alpha', link: { index: 0 } },
      { text: ', ' },
      { text: 'Gone', link: { index: 1 } },
      { text: ' and ' },
      { text: 'nick', link: { index: -1 } },
      { text: '!' },
    ])
  })
  it('an unindented YAML list keeps its items', () => {
    const r = splitFrontmatter('---\nrelated:\n- "[[Alpha]]"\n- "[[Beta]]"\n---\nbody')
    expect(r.rows).toEqual([['related', '[[Alpha]], [[Beta]]']])
  })
  it('a link in the properties and the same link in the body share one entry', () => {
    const text = '---\nrel: "[[Alpha]]"\n---\n[[Alpha]]'
    const plan = linkPlan(text, [A], 'Note.md')
    expect(frontmatterParts('[[Alpha]]', plan)[0]?.link?.index).toBe(0)
    expect(count(renderNote('[[Alpha]]', [A], plan), /data-mem-link="0"/g)).toBe(1)
  })
})

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

describe('the note screen', () => {
  const file = (text: string, links: unknown[]): Step => ({
    asked: 'memory.read',
    frame: {
      v: 1,
      id: '01J00000000000000000000099',
      ts: '2026-10-29T12:00:00.000Z',
      type: 'memory.file',
      request_id: '01J10000000000000000000099',
      root_id: 'notes',
      path: 'Links.md',
      mime: 'text/markdown',
      text,
      offset: 0,
      next_offset: null,
      size: text.length,
      mtime: '2026-10-20T12:00:00.000Z',
      sha256: 'a'.repeat(64),
      links,
    },
  })
  const TEXT = '---\ntitle: T\nrelated: "[[Alpha]]" and [[Gone]]\n---\n# T\n[[Beta]] [[Beta]] `[[Beta]]` [[Beta]]\n'
  it('shows property links as links (click opens) and grey text, and every body copy', async () => {
    const user = userEvent.setup()
    const client = createFakeClient()
    ;(client as { memory: unknown }).memory = createSocketMemory({
      ask: macFrom([file(TEXT, [A, GONE, B])]).ask as never,
    })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/memory?r=notes&n=Links.md']}>
          <MemoryScreen />
          <Where />
        </MemoryRouter>
      </ClientProvider>,
    )
    const front = await screen.findByTestId('memory-frontmatter')
    expect(front.textContent).not.toContain('[[')
    expect(
      within(front)
        .getAllByTestId('memory-link-null')
        .map((n) => n.textContent),
    ).toEqual(['Gone'])
    const body = screen.getByTestId('memory-body')
    expect(body.querySelectorAll('[data-mem-link]')).toHaveLength(3)
    expect(body.querySelector('code')?.textContent).toBe('[[Beta]]')
    await user.click(within(front).getByRole('button', { name: 'Alpha' }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('n=Alpha.md'))
  })
})
