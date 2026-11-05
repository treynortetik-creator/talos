// The one rule for links in a note, shared by the bridge and the app: what is code, what is a link, how the app pairs its
// reading with the Mac's list, and that a hostile note costs time in proportion to its size.
import { describe, expect, test } from 'vitest'
import { frontmatterRows, linkKey, planLinks, relLink, scanLinks, splitNote, wikiLink } from '../src/memory-links.ts'

const names = (t: string) => scanLinks(t).map((l) => `${l.kind === 'wiki' ? 'w' : 'r'}:${l.target}`)

describe('what is code', () => {
  test('inline spans: same-length run closes; other lengths do not; an escaped tick is plain', () => {
    expect(names('`[[A]]` [[B]] ``[[C]] ` x`` [[D]]')).toEqual(['w:B', 'w:D'])
    expect(names('``a ` [[A]] `` [[B]]')).toEqual(['w:B'])
    expect(names('``a ` b [[A]] c [[B]]')).toEqual(['w:A', 'w:B'])
    expect(names('a \\` [[A]] \\` `[[B]]` [[C]]')).toEqual(['w:A', 'w:C'])
    expect(names('`a` [[A]] `b` [[B]] `c')).toEqual(['w:A', 'w:B'])
  })
  test('fences: unclosed runs to the end, longer fences hold shorter ones, a shorter closer does not close', () => {
    expect(names('[[A]]\n```\n[[B]]\n')).toEqual(['w:A'])
    expect(names('````\n```\n[[B]]\n```\n````\n[[A]]')).toEqual(['w:A'])
    expect(names('~~~\n[[B]]\n```\n[[C]]\n~~~\n[[A]]')).toEqual(['w:A'])
    expect(names('```md\n[[B]]\n``\n[[C]]\n```\n[[A]]')).toEqual(['w:A'])
    expect(names('``` x`y\n[[A]]\n')).toEqual(['w:A']) // a backtick in the info string: not a fence, so plain text
  })
  test('indented blocks are code unless they continue a paragraph', () => {
    expect(names('p\n\n    [[B]]\n\n[[A]]')).toEqual(['w:A'])
    expect(names('p\n    [[A]] still the paragraph')).toEqual(['w:A'])
    expect(names('\t[[B]]\n[[A]]')).toEqual(['w:A'])
  })
  test('containers: a fence in a list item with a blank line inside, in a quote, and a lazy line', () => {
    expect(names('- item\n\n  ```\n  code\n\n  [[B]]\n  ```\n\n[[A]]')).toEqual(['w:A'])
    expect(names('1. one\n\n   ~~~\n   [[B]]\n\n   [[C]]\n   ~~~\n2. [[A]]')).toEqual(['w:A'])
    expect(names('> ```\n> [[B]]\n> ```\n\n[[A]]')).toEqual(['w:A'])
    expect(names('- a `b\ncontinued [[B]] c` d [[A]]')).toEqual(['w:A'])
    // the item ends, so the fence ends with it
    expect(names('- ```\n  [[B]]\n[[A]]')).toEqual(['w:A'])
  })
  test('a backtick never pairs across list items, paragraphs or CRLF paragraphs', () => {
    expect(names('- run `foo\n- see [[A]] and `bar`')).toEqual(['w:A'])
    expect(names('run `foo\r\n\r\nsee [[A]] and `bar`\r\n')).toEqual(['w:A'])
    expect(names('# head `x\n[[A]] `y')).toEqual(['w:A'])
    expect(names('a `b\n\n[[A]]\n\nc` d')).toEqual(['w:A'])
  })
  test('tables: a span stays in its cell, cells past the header are dropped, an escaped bar is not a split', () => {
    expect(names('| a | b |\n| - | - |\n| `x | [[A]] | y` |\n')).toEqual(['w:A'])
    expect(names('| a | b |\n| - | - |\n| [[A\\|al]] | `[[B]]` | [[Z]] |\n')).toEqual(['w:A'])
  })
  test('a bar inside [[..]] does not split a cell; a bar outside it does', () => {
    expect(names('| a | b |\n| - | - |\n| [[x|`y`]] | z |\n')).toEqual(['w:x'])
    // the third cell is past the two-column header, so it is dropped; the link in it is not a link
    expect(names('| a | b |\n| - | - |\n| [[x|y]] | [[b]] | [[Z]] |\n')).toEqual(['w:x', 'w:b'])
    expect(names('| a | b |\n| - | - |\n| x | [[p|q]] |\n| `[[c|d]]` | [[e|f]] |\n')).toEqual(['w:p', 'w:e'])
    expect(names('| a | b |\n| - | - |\n| [[x | y]] | [[b]] |\n')).toEqual(['w:x', 'w:b'])
  })
  test('escapes and images', () => {
    expect(names('\\[[A]] ![x](a.md) \\![y](b.md) [[C]]')).toEqual(['r:b.md', 'w:C'])
    expect(names('![[A]]')).toEqual(['w:A'])
  })
})

describe('what is a link, and in what order', () => {
  test('order is first appearance across both kinds, not wiki-then-relative', () => {
    expect(names('[x](a.md) `c` [[b|x]]')).toEqual(['r:a.md', 'w:b'])
    expect(names('[[b|x]] [x](a.md) [[b|x]] [x](a.md)')).toEqual(['w:b', 'r:a.md'])
  })
  test('code in a label belongs to the label', () => {
    const l = scanLinks('[`foo`](foo.md) [[foo|`bar`]]')
    expect(l.map((x) => x.text)).toEqual(['`foo`', '`bar`'])
  })
  test('the optional title clause; bad shapes are not links', () => {
    expect(
      names('[x](a.md "Title") [y](b.md\n"t") [z](c.md "a\nb") [q](d.png) [w](https://e.com/a.md) [v](/abs.md)'),
    ).toEqual(['r:a.md'])
    expect(relLink('x', 'a%20b.md#h')?.target).toBe('a b.md')
    expect(relLink('x', '../up.md')?.target).toBe('../up.md')
    expect(relLink('a [b] c', 'a.md')).toBeNull()
    expect(wikiLink('#only')).toBeNull()
    expect(wikiLink('a\\', 'al')).toEqual({ kind: 'wiki', target: 'a', text: 'al' })
  })
  test('properties come first, and a backtick there does not touch the body', () => {
    const t = '---\ntitle: it`s\nrel: [[F]]\nrelated:\n- "[[G]]"\n---\n[[B]] and `x` [[C]] `y`'
    expect(names(t)).toEqual(['w:F', 'w:G', 'w:B', 'w:C'])
    expect(splitNote(t).front).toContain('title')
    expect(frontmatterRows('a: 1\nb:\n- x\n- y')).toEqual([
      ['a', '1'],
      ['b', 'x, y'],
    ])
  })
  test('the list is bounded', () => {
    const t = Array.from({ length: 50 }, (_, i) => `[[n${i}]]`).join(' ')
    expect(scanLinks(t, 10)).toHaveLength(10)
  })
})

describe('cost stays proportional to size', () => {
  // No millisecond limit anywhere in here. A wall clock on a busy machine says nothing about the scanner, so every figure is
  // the user CPU time of the scan itself, and every limit is a ratio between figures taken in the same run: the same
  // scan on a smaller input, and a plain-prose note of the same size (which tells how fast this machine is right now).
  // A check that fails is measured once more and passes if the second try is within the limit; a quadratic scan fails both.
  const KIB = 1024
  const SMALL = 32 * KIB
  const BIG = 256 * KIB
  // growth: 8x the input may cost up to 3x the linear 8x (a quadratic scan costs 64x)
  const GROWTH = 8 * 3
  // against prose: one pass over a hostile note may cost this many times a pass over prose of the same size
  const VS_PROSE = 60
  const cpu = (t: string) => {
    const a = process.cpuUsage()
    scanLinks(t)
    return process.cpuUsage(a).user / 1000
  }
  const best = (t: string, tries: number) => {
    let m = Number.POSITIVE_INFINITY
    for (let i = 0; i < tries; i++) m = Math.min(m, cpu(t))
    return m
  }
  const prose = (n: number) => 'plain [[a]] text\n'.repeat(Math.ceil(n / 17))
  type Reading = { ok: boolean; why: string }
  /** One reading of a shape: CPU time at two sizes against the prose reference taken just before. */
  const read = (make: (n: number) => string): Reading => {
    const refS = best(prose(SMALL), 2)
    const small = Math.max(best(make(SMALL), 2), refS)
    const refB = best(prose(BIG), 2)
    const bigText = make(BIG)
    expect(bigText.length).toBeGreaterThan(BIG * 0.95)
    const big = best(bigText, 1)
    const detail = `small ${small.toFixed(1)} ms, big ${big.toFixed(1)} ms, prose ${refB.toFixed(1)} ms`
    if (big > small * GROWTH)
      return { ok: false, why: `grew ${(big / small).toFixed(1)}x for 8x the input (${detail})` }
    if (big > Math.max(refB, 1) * VS_PROSE)
      return { ok: false, why: `${(big / Math.max(refB, 1)).toFixed(1)}x the cost of prose (${detail})` }
    return { ok: true, why: detail }
  }
  const proportional = (make: (n: number) => string) => {
    const first = read(make)
    if (first.ok) return first
    const second = read(make)
    return second.ok ? second : { ok: false, why: `${first.why}; again: ${second.why}` }
  }
  // Every shape ends in a real character or a real link: a run of markers alone is a thematic break and takes no list path.
  const shapes: Record<string, (bytes: number) => string> = {
    'backticks then text': (n) => `${'`'.repeat(n / 4)}${'plain text '.repeat(n / 15)}`,
    'alternating lengths': (n) => '`a``b```c````d'.repeat(n / 14),
    'open brackets': (n) => '['.repeat(n),
    'wiki starts': (n) => '[[a'.repeat(n / 3),
    'rel starts': (n) => '[x](y '.repeat(n / 6),
    'quotes on one line': (n) => `${'> '.repeat(n / 2)}x`,
    'list markers on one line': (n) => `${'- '.repeat(n / 2)}x`,
    'plus markers, then empty lines': (n) => `${'+ '.repeat(n / 4)}x\n${'\n'.repeat(n / 2)}`,
    'numbered markers on one line': (n) => `${'1. '.repeat(n / 3)}x`,
    'deep list, then a line of spaces': (n) => `${'- '.repeat(5000)}x\n${' '.repeat(n)}y`,
    'deep list, then a line of tabs': (n) => `${'- '.repeat(5000)}x\n${'\t'.repeat(n)}y`,
    'deep quote, then a line of spaces': (n) => `${'> '.repeat(5000)}x\n${' '.repeat(n)}`,
    'deep list, many indented lines': (n) => `${'- '.repeat(100)}x\n${`${' '.repeat(220)}y\n`.repeat(n / 222)}`,
    'deep quote, many lines': (n) => `${'> '.repeat(100)}x\n${`${'> '.repeat(100)}y\n`.repeat(n / 202)}`,
    'thematic breaks': (n) => `${'- '.repeat(n / 2)}`,
    'breaks behind quotes': (n) => `${'> - '.repeat(n / 4)}x`,
    'many empty lines': (n) => '\n'.repeat(n),
    'fence churn': (n) => '```\n~~~\n'.repeat(n / 8),
    'table rows': (n) => `| a | b |\n| - | - |\n${'| `x | y |\n'.repeat(n / 11)}`,
    'wiki links with bars in cells': (n) => `| a | b |\n| - | - |\n${'| [[a|b]] | [[c|d]] |\n'.repeat(n / 22)}`,
    'unclosed wiki links in cells': (n) => `| a | b |\n| - | - |\n${'| [[a'.repeat(n / 5)}\n`,
    escapes: (n) => '\\`'.repeat(n / 2),
    'ticks and links on one line': (n) => '`[[a]]'.repeat(n / 6),
    'long yaml list': (n) => `---\nk:\n${'- a\n'.repeat(n / 4)}---\n[[a]]`,
    'long yaml continuation': (n) => `---\nk: v\n${'  more\n'.repeat(n / 7)}---\n[[a]]`,
  }
  for (const [name, make] of Object.entries(shapes)) {
    test(name, () => {
      const r = proportional(make)
      expect(r.ok, r.why).toBe(true)
    }, 120_000)
  }
  test('doubling the input roughly doubles the work (no k*N term)', () => {
    const one = `${'- '.repeat(100)}x\n${'plain [[a]] text\n'.repeat(4000)}`
    const run = () => {
      cpu(one)
      const t1 = Math.max(best(one, 2), best(prose(one.length), 2))
      const t8 = best(one.repeat(8), 2)
      return { ok: t8 <= t1 * 8 * 2.5, why: `one ${t1.toFixed(1)} ms, eight ${t8.toFixed(1)} ms` }
    }
    const first = run()
    const r = first.ok ? first : run()
    expect(r.ok, r.why).toBe(true)
  })
  test('nesting is capped at the depth markdown-it stops at; a link past the cap is still found', () => {
    expect(names(`${'- '.repeat(150)}[[A]]`)).toEqual(['w:A'])
    expect(names(`${'> '.repeat(150)}[[A]] and \`[[B]]\``)).toEqual(['w:A'])
    expect(names(`${'- '.repeat(50)}[[A]]\n\n${' '.repeat(120)}[[B]]`)).toEqual(['w:A'])
  })
  test('a long yaml list is joined once and in order', () => {
    const rows = frontmatterRows(`k:\n${'- a\n- "b"\n'.repeat(3)}j: 1\n  more\n  text`)
    expect(rows).toEqual([
      ['k', 'a, b, a, b, a, b'],
      ['j', '1 more text'],
    ])
  })
})

describe('pairing the app’s reading with the Mac’s list', () => {
  const entry = (text: string, path: string | null) => ({ text, path })
  test('the same scanner on both sides: positional, repeats share an entry', () => {
    const t = '[x](a.md) `c` [[b|x]] [x](a.md)'
    const plan = planLinks(t, [entry('x', 'a.md'), entry('x', 'b.md')], 'n.md')
    expect(plan.slotOf({ kind: 'rel', target: 'a.md', text: 'x' })).toBe(0)
    expect(plan.slotOf({ kind: 'wiki', target: 'b', text: 'x' })).toBe(1)
  })
  test('a list cut short by the size cap: the front is matched, the rest is plain', () => {
    const t = '[[a]] [[b]] [[c]]'
    const plan = planLinks(t, [entry('a', 'a.md'), entry('b', 'b.md')], 'n.md')
    expect(plan.slotOf({ kind: 'wiki', target: 'c', text: 'c' })).toBe(-1)
    expect(plan.slotOf({ kind: 'wiki', target: 'b', text: 'b' })).toBe(1)
  })
  test('an older bridge (wiki before relative, links in code): never a wrong entry', () => {
    const t = '[x](a.md) `code` [[b|x]]'
    const old = [entry('x', 'b.md'), entry('x', 'a.md')] // wiki first
    const plan = planLinks(t, old, 'n.md')
    expect(plan.slotOf({ kind: 'rel', target: 'a.md', text: 'x' })).toBe(1)
    expect(plan.slotOf({ kind: 'wiki', target: 'b', text: 'x' })).toBe(0)
    // an extra entry for a link in code, same label as a real one: cannot tell, so nothing is guessed
    const two = planLinks('`[[a|x]]` [[b|x]]', [entry('x', 'a.md'), entry('x', 'b.md')], 'n.md')
    expect(two.slotOf({ kind: 'wiki', target: 'b', text: 'x' })).toBe(1) // the file name settles it
    const same = planLinks('`[[a|x]]` [[a2|x]]', [entry('x', null), entry('x', null)], 'n.md')
    expect(same.slotOf({ kind: 'wiki', target: 'a2', text: 'x' })).toBe(-1)
  })
  test('a relative link carries the folder of the note; ../ and case', () => {
    const plan = planLinks(
      '[x](../up/Y.md) [[../up/y|z]] [[Y]]',
      [entry('x', 'up/Y.md'), entry('z', 'up/Y.md'), entry('Y', 'up/Y.md')],
      'dir/n.md',
    )
    expect(plan.slotOf({ kind: 'rel', target: '../up/Y.md', text: 'x' })).toBe(0)
    expect(plan.slotOf({ kind: 'wiki', target: '../up/y', text: 'z' })).toBe(1)
    expect(plan.slotOf({ kind: 'wiki', target: 'Y', text: 'Y' })).toBe(2)
    const wrong = planLinks('[x](a.md)', [entry('x', 'other/a.md')], 'n.md')
    expect(wrong.slotOf({ kind: 'rel', target: 'a.md', text: 'x' })).toBe(-1)
  })
  test('only the first chunk is loaded: matched by label and file name, never by position', () => {
    const t = '[[a]] [[a]] [[b]]'
    const plan = planLinks(t, [entry('a', 'a.md'), entry('b', 'b.md'), entry('c', 'c.md')], 'n.md', false)
    expect(plan.slotOf({ kind: 'wiki', target: 'a', text: 'a' })).toBe(0)
    expect(plan.slotOf({ kind: 'wiki', target: 'b', text: 'b' })).toBe(1)
  })
  test('an empty list and a hostile key match nothing', () => {
    const plan = planLinks('[[a]]', [], 'n.md')
    expect(plan.slotOf({ kind: 'wiki', target: 'a', text: 'a' })).toBe(-1)
    expect(linkKey({ kind: 'wiki', target: 'a', text: 'b' })).not.toBe(
      linkKey({ kind: 'wiki', target: 'b', text: 'a' }),
    )
  })
})
