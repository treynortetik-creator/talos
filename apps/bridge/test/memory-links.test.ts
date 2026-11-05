// Memory links on the Mac side: what counts as a link, how `[[../x]]` resolves, and how many a note may list.
import { describe, expect, test } from 'bun:test'
import { MEMORY_LINKS_MAX_BYTES } from '@talos-app/protocol'
import { capLinks, extractLinks, type FileIndex, resolveLinks } from '../src/memory/text.ts'

const FILES = [
  'people/foo.md',
  'people/bar baz.md',
  'concepts/index.md',
  'concepts/deep/leaf.md',
  'top.md',
  'private/secret.md',
]
const index: FileIndex = {
  has: (_r, p) => FILES.includes(p),
  paths: () => FILES,
  rootIds: () => ['wiki'],
}
const resolve = (
  text: string,
  from = 'concepts/index.md',
  visible = (_r: string, p: string) => !p.startsWith('private/'),
) => resolveLinks(extractLinks(text), { rootId: 'wiki', path: from }, index, visible).map((l) => l.path)

describe('relative wiki links', () => {
  test('[[../people/foo]] and [[./deep/leaf]] resolve against the note folder', () => {
    expect(resolve('[[../people/foo]] [[./deep/leaf]] [[../top]]')).toEqual([
      'people/foo.md',
      'concepts/deep/leaf.md',
      'top.md',
    ])
  })
  test('a link that climbs out of the root is grey, however it is spelled', () => {
    expect(resolve('[[../../people/foo]] [[../../../top]] [[../../..]] [[a/../../top]] [[..\\..\\top]]')).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
    // from the top folder, one ../ is already out
    expect(resolve('[[../top]]', 'top.md')).toEqual([null])
    expect(resolve('[[../../../../etc/passwd]]', 'a.md')).toEqual([null])
  })
  test('a relative link to a hidden note is still path:null', () => {
    expect(resolve('[[../private/secret]]')).toEqual([null])
  })
  test('relative means exact: ../foo does not fall back to a note named foo elsewhere', () => {
    expect(resolve('[[../foo]]')).toEqual([null])
  })
  test('plain names still resolve as before', () => {
    expect(resolve('[[foo]] [[people/foo]] [[foo.md]] [[/people/foo]]')).toEqual([
      'people/foo.md',
      'people/foo.md',
      'people/foo.md',
      'people/foo.md',
    ])
  })
})

describe('the root is a wall, whatever the file index says', () => {
  // an index that claims every path exists: only the guard in resolveLinks stands between a link and the outside
  const liar: FileIndex = {
    has: () => true,
    paths: () => ['../outside.md', '../../x/outside.md', '/abs/outside.md', 'a/../../outside.md', 'inside.md'],
    rootIds: () => ['wiki'],
  }
  const out = (text: string, from = 'concepts/index.md') =>
    resolveLinks(extractLinks(text), { rootId: 'wiki', path: from }, liar, () => true).map((l) => l.path)
  test('relative links and ../ wiki links that leave the root are null even if the index says yes', () => {
    expect(out('[a](../../outside.md) [b](../../../x/outside.md) [c](a/../../../outside.md)')).toEqual([
      null,
      null,
      null,
    ])
    expect(out('[[../../outside]] [[../../../x/outside]] [[a/../../outside]]')).toEqual([null, null, null])
    expect(out('[[../outside]]', 'top.md')).toEqual([null])
  })
  test('a name that happens to start with two dots is a name, not a climb', () => {
    const idx: FileIndex = { has: (_r, p) => p === '..notes.md', paths: () => ['..notes.md'], rootIds: () => ['wiki'] }
    const r = resolveLinks(extractLinks('[x](..notes.md)'), { rootId: 'wiki', path: 'top.md' }, idx, () => true)
    expect(r.map((l) => l.path)).toEqual(['..notes.md'])
  })
})

describe('what is a link', () => {
  test('an escaped bar in a table cell is the alias bar, not part of the name', () => {
    const l = extractLinks('| a | [[people/foo\\|Foo]] | [[people/bar baz\\|Baz]] |')
    expect(l.map((x) => [x.target, x.text])).toEqual([
      ['people/foo', 'Foo'],
      ['people/bar baz', 'Baz'],
    ])
    expect(resolve('| [[people/foo\\|Foo]] |')).toEqual(['people/foo.md'])
  })
  test('links inside inline code and fences are not links; code next to a link does not hide it', () => {
    const t =
      'Use `[[people/foo]]` or ``[[x]] with ` inside`` here.\n```\n[[fenced]]\n```\n[[top]] and `a` [[people/foo]] `b`'
    expect(extractLinks(t).map((x) => x.target)).toEqual(['top', 'people/foo'])
    expect(extractLinks('`[a](b.md)` [c](d.md)').map((x) => x.target)).toEqual(['d.md'])
  })
  test('the shared rule: indented and unclosed code, list items, a label with code, a title, an image', () => {
    const t = [
      '    [[indented]]',
      '',
      '- run `foo',
      '- see [[people/foo]] and `bar`',
      '',
      '[`label`](top.md "Title") ![img](people/foo.md)',
      '',
      '```',
      '[[unclosed]]',
    ].join('\n')
    expect(extractLinks(t).map((x) => `${x.kind}:${x.target}`)).toEqual(['wiki:people/foo', 'rel:top.md'])
    expect(extractLinks(t).map((x) => x.text)).toEqual(['people/foo', '`label`'])
  })
  test('a lone backtick does not swallow the rest of the note', () => {
    expect(extractLinks('it`s [[top]]\n\nand [[people/foo]] `x`').map((x) => x.target)).toEqual(['top', 'people/foo'])
  })
})

describe('the link budget', () => {
  const link = (i: number) => ({ text: `Note ${i}`, root_id: 'wiki', path: `concepts/note-${i}.md` })
  test('704 distinct links (the biggest real page) fit; the cap is whole links only', () => {
    const all = Array.from({ length: 704 }, (_, i) => link(i))
    expect(capLinks(all, MEMORY_LINKS_MAX_BYTES)).toHaveLength(704)
    const some = capLinks(all, 1000)
    expect(some.length).toBeGreaterThan(0)
    expect(some.length).toBeLessThan(704)
    expect(some).toEqual(all.slice(0, some.length))
    expect(Buffer.byteLength(JSON.stringify(some))).toBeLessThanOrEqual(1000)
  })
  test('a hostile note cannot push the list past the cap', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ ...link(i), text: 'x'.repeat(200) }))
    const kept = capLinks(many, MEMORY_LINKS_MAX_BYTES)
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(MEMORY_LINKS_MAX_BYTES)
  })
})
