// memory.graph (src/memory/graph.ts): every visible note and the [[links]] between them, resolved as memory.file resolves
// them, each pair once, never a note to itself, nothing to a hidden or missing note; titles cleaned; past the cap the most
// recently changed notes are kept and "Showing N of M" can be said. Neutral note names only.
import { describe, expect, test } from 'bun:test'
import { MAX_FRAME_BYTES, MemoryGraphResultFrame } from '@talos-app/protocol'
import { buildGraph, type GraphInput } from '../src/memory/graph.ts'

const notes = (o: Record<string, string>, root = 'notes') => {
  const files = new Map<string, Map<string, { title: string; mtimeMs: number }>>([[root, new Map()]])
  let t = 0
  for (const p of Object.keys(o)) files.get(root)?.set(p, { title: '', mtimeMs: ++t })
  const input: GraphInput = {
    roots: [{ id: root, label: 'Notes' }],
    files,
    read: (_r, p) => o[p] ?? null,
    visible: (_r, p) => !p.startsWith('hidden/'),
  }
  return input
}
const asFrame = (body: object) =>
  MemoryGraphResultFrame.safeParse({
    v: 1,
    id: '01JBF3V7Q8K2M4N6P8R0S2T458',
    ts: '2026-01-01T00:00:00.000Z',
    type: 'memory.graph_result',
    request_id: '01JBF3V7Q8K2M4N6P8R0S2T459',
    ...body,
  })

describe('the graph', () => {
  test('links between visible notes, each pair once, none to itself or to a hidden or missing note', () => {
    const g = buildGraph(
      notes({
        'a.md': '# Alpha\nsee [[b]] and [[b|again]] and [[a]] and [[missing]] and [[hidden/secret]]',
        'b.md': 'back to [[a]] and [c](sub/c.md)',
        'sub/c.md': 'plain',
        'hidden/secret.md': 'not shown',
      }),
    )
    const name = (i: number) => g.nodes[i]?.p
    // a note the walk listed but that may not be shown now (a private marker since) is not a node at all
    expect(g.nodes.map((n) => n.p)).toEqual(['a.md', 'b.md', 'sub/c.md'])
    const pairs = g.edges.map(([x, y]) => [name(x), name(y)].sort().join(' - ')).sort()
    expect(pairs).toEqual(['a.md - b.md', 'b.md - sub/c.md'])
    expect(g).toMatchObject({ total_nodes: 3, truncated: false })
    expect(asFrame(g).success).toBe(true)
  })

  test('titles are cleaned of control and direction characters, and a note with no title is named for its file', () => {
    const input = notes({ 'x.md': 'text', 'my-plan.md': 'text' })
    ;(input.files.get('notes') as Map<string, { title: string; mtimeMs: number }>).set('x.md', {
      title: 'Plan\u202e for \u0007today',
      mtimeMs: 1,
    })
    const g = buildGraph(input)
    const x = g.nodes.find((n) => n.p === 'x.md')
    expect(x?.t.includes('\u202e') || x?.t.includes('\u0007')).toBe(false)
    expect(g.nodes.find((n) => n.p === 'my-plan.md')?.t).toBe('my-plan')
  })

  test('past the cap the newest notes are kept, the total says how many there are, and it fits one frame', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 2300; i++) many[`n${String(i).padStart(4, '0')}.md`] = `[[n${String(i + 1).padStart(4, '0')}]]`
    const g = buildGraph(notes(many))
    expect(g.nodes.length).toBeLessThanOrEqual(2000)
    expect(g).toMatchObject({ total_nodes: 2300, truncated: true })
    expect(g.nodes.some((n) => n.p === 'n2299.md')).toBe(true) // the newest
    expect(g.nodes.some((n) => n.p === 'n0000.md')).toBe(false) // the oldest went
    expect(Buffer.byteLength(JSON.stringify(g))).toBeLessThan(MAX_FRAME_BYTES)
    expect(asFrame(g).success).toBe(true)
  })

  test('a garbled answer (a link to no note, a note in no folder) fails the frame check', () => {
    expect(
      asFrame({ roots: [], nodes: [{ r: 0, p: 'a.md', t: 'A' }], edges: [], total_nodes: 1, truncated: false }).success,
    ).toBe(false)
    expect(
      asFrame({
        roots: [{ id: 'notes', label: 'N' }],
        nodes: [{ r: 0, p: 'a.md', t: 'A' }],
        edges: [[0, 3]],
        total_nodes: 1,
        truncated: false,
      }).success,
    ).toBe(false)
  })
})
