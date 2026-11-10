// The relay carries `fs.listing` and can write what it likes into it. The app saves the folder it ASKED for, never the one the
// answer names: a listing for another path is dropped, so is one whose home changed after the first, and a name that is
// not one folder name (a slash, `.`, `..`) is left out.
import { describe, expect, it } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createSocketFolders } from '../../src/lib/socketFolders.ts'

const listing = (over: Record<string, unknown> = {}) => ({
  home: '/Users/alex',
  path: '/Users/alex/Projects',
  parent: '/Users/alex',
  entries: [{ name: 'alpha' }],
  more: 0,
  ...over,
})
const clientWith = (answers: Array<Record<string, unknown>>) => {
  const asked: Array<Record<string, unknown>> = []
  const c = createSocketFolders({
    ask: async (f) => {
      asked.push(f)
      return answers.shift() ?? listing()
    },
  })
  return { c, asked }
}

describe('a forged listing', () => {
  it('a listing for another path than the one asked is refused, not shown', async () => {
    const { c } = clientWith([listing({ path: '/Users/alex/.ssh' })])
    const e = await c.list('/Users/alex/Projects', false).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TalosClientError)
  })

  it('a listing that echoes the asked path (even with a trailing slash) is fine', async () => {
    const { c } = clientWith([listing()])
    expect((await c.list('/Users/alex/Projects', false)).path).toBe('/Users/alex/Projects')
  })

  it('home is pinned by the first answer: a later listing with another home is refused', async () => {
    const { c } = clientWith([listing({ path: undefined, entries: [] }), listing({ home: '/srv/mallory' })])
    expect((await c.list(null, false)).home).toBe('/Users/alex')
    const e = await c.list('/Users/alex/Projects', false).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TalosClientError)
  })

  it('names that are not one folder name are dropped: a slash, a dot, two dots, an empty or control-character name', async () => {
    const names = ['ok', 'a/b', '.', '..', '../x', '', 'tab\there', 'also ok']
    const { c } = clientWith([listing({ entries: names.map((name) => ({ name })) })])
    expect((await c.list('/Users/alex/Projects', false)).entries).toEqual(['ok', 'also ok'])
  })

  it('a parent that is not the folder above the listed one is dropped to null', async () => {
    const { c } = clientWith([listing({ parent: '/etc' })])
    expect((await c.list('/Users/alex/Projects', false)).parent).toBeNull()
  })
})
