// What the Clio graph draws (clioGraphLogic.ts): notes not in a hidden folder; with a search, the matches and their
// neighbours, and links between what is drawn; how linked a note is decides its size. Neutral note names only.
import { describe, expect, it } from 'vitest'
import { CLIO_TEXT, linkedTo, matchesOf, shownGraph } from '../../src/features/memory/clioGraphLogic.ts'
import type { MemoryGraph } from '../../src/lib/v2Client.ts'

const g: MemoryGraph = {
  roots: [
    { id: 'notes', label: 'Notes' },
    { id: 'journal', label: 'Journal' },
  ],
  nodes: [
    { root: 0, path: 'alpha.md', title: 'Alpha' },
    { root: 0, path: 'beta.md', title: 'Beta plan' },
    { root: 1, path: 'day.md', title: 'A day' },
    { root: 0, path: 'gamma.md', title: 'Gamma' },
  ],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
  total: 4,
  truncated: false,
}

describe('what the Clio graph draws', () => {
  it('everything, with each note sized by its links', () => {
    const s = shownGraph(g, new Set(), '')
    expect(s.nodes).toEqual([0, 1, 2, 3])
    expect(s.degree.get(1)).toBe(2)
  })

  it('a hidden folder takes its notes and their links away', () => {
    const s = shownGraph(g, new Set([1]), '')
    expect(s.nodes).toEqual([0, 1, 3])
    expect(s.edges).toEqual([[0, 1]])
  })

  it('a search keeps the matches and their neighbours', () => {
    expect([...matchesOf(g, 'plan')]).toEqual([1])
    expect(shownGraph(g, new Set(), 'plan').nodes.sort()).toEqual([0, 1, 2])
    expect(linkedTo(g, 1).sort()).toEqual([0, 2])
  })

  it('says how much is shown, and why when cut', () => {
    expect(CLIO_TEXT.meta(4, 4, 3)).toBe('4 notes · 3 links')
    expect(CLIO_TEXT.meta(2000, 2300, 10)).toBe('2000 of 2300 notes · 10 links')
    expect(CLIO_TEXT.truncated(2000, 2300)).toMatch(/^Showing 2000 of 2300 notes/)
  })
})
