// memory.graph (frames-memory-graph.ts): every note the Memory screen may show, and the [[links]] between them, for the 3D
// graph. Links resolve exactly as memory.file resolves them (text.ts resolveLinks, visible files only), but each link is
// checked only against the files whose name could match it, so a few thousand notes build in well under a second. The answer
// fits one frame: notes and links are added until a cap or the frame's bytes would be passed, and `truncated` says so.
import {
  MAX_FRAME_BYTES,
  MEMORY_GRAPH_EDGES_MAX,
  MEMORY_GRAPH_NODES_MAX,
  MEMORY_GRAPH_TITLE_MAX,
  type MemoryGraphResultT,
  sanitizeExternal,
} from '@talos-app/protocol'
import { extractLinks, type FileIndex, resolveLinks } from './text.ts'

export type GraphBody = Omit<MemoryGraphResultT, 'v' | 'id' | 'ts' | 'type' | 'request_id'>

export type GraphInput = {
  roots: ReadonlyArray<{ id: string; label: string }>
  /** Visible files per root, with their titles (empty until read) and when they last changed. */
  files: ReadonlyMap<string, ReadonlyMap<string, { title: string; mtimeMs: number }>>
  /** A note's text (capped as memory.read caps it), or null when it cannot be read now. */
  read(rootId: string, path: string): string | null
  /** The full visibility check, as memory.file uses it. */
  visible(rootId: string, path: string): boolean
}

/** The frame's bytes, less room for the envelope and request id. */
const BUDGET = MAX_FRAME_BYTES - 4 * 1024
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')
const stem = (p: string) => p.toLowerCase().replace(/\.(md|markdown|txt)$/, '')
const lastOf = (p: string) => {
  const s = stem(p)
  return s.slice(s.lastIndexOf('/') + 1)
}

export function buildGraph(g: GraphInput): GraphBody {
  const roots = g.roots.slice(0, 20)
  const rootIndex = new Map(roots.map((r, i) => [r.id, i]))
  // each note checked now, as the Memory listing checks it (the walk can be behind a marker or a move)
  const seenVisible = new Map<string, boolean>()
  const visible = (r: string, p: string) => {
    const k = `${r}\0${p}`
    let v = seenVisible.get(k)
    if (v === undefined) {
      v = g.visible(r, p)
      seenVisible.set(k, v)
    }
    return v
  }
  // every visible note, newest first: past the cap (or the frame) the most recently changed are the ones kept
  const all: Array<{ r: string; p: string; t: string; m: number }> = []
  for (const r of roots)
    for (const [p, info] of g.files.get(r.id) ?? new Map<string, { title: string; mtimeMs: number }>()) {
      if (!visible(r.id, p)) continue
      const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
      all.push({ r: r.id, p, t: sanitizeExternal(info.title || name, MEMORY_GRAPH_TITLE_MAX), m: info.mtimeMs })
    }
  all.sort((a, b) => b.m - a.m)
  let truncated = all.length > MEMORY_GRAPH_NODES_MAX
  const newest = all.slice(0, MEMORY_GRAPH_NODES_MAX)

  // candidate files by the last part of their name, per root: the only ones a link can resolve to
  const byLast = new Map<string, Map<string, string[]>>()
  for (const n of newest) {
    let m = byLast.get(n.r)
    if (!m) {
      m = new Map()
      byLast.set(n.r, m)
    }
    const k = lastOf(n.p)
    const list = m.get(k)
    if (list) list.push(n.p)
    else m.set(k, [n.p])
  }
  const index = new Map(newest.map((n, i) => [`${n.r}\0${n.p}`, i]))
  const rootIds = roots.map((r) => r.id)

  // links, by index into `newest`
  const edges: Array<[number, number]> = []
  const seen = new Set<string>()
  outer: for (const [from, n] of newest.entries()) {
    const text = g.read(n.r, n.p)
    if (text === null) continue
    const tried = new Set<string>() // a note that names the same target many times resolves it once
    for (const link of extractLinks(text)) {
      const key = `${link.kind}\0${link.target}`
      if (tried.has(key)) continue
      tried.add(key)
      const want = lastOf(link.target.replace(/\\/g, '/').replace(/[#?].*$/, ''))
      const narrow: FileIndex = {
        has: (r, p) => index.has(`${r}\0${p}`),
        paths: (r) => byLast.get(r)?.get(want) ?? [],
        rootIds: () => rootIds,
      }
      const [hit] = resolveLinks([link], { rootId: n.r, path: n.p }, narrow, visible)
      if (!hit?.root_id || !hit.path) continue
      const to = index.get(`${hit.root_id}\0${hit.path}`)
      if (to === undefined || to === from) continue
      const pair = from < to ? `${from}-${to}` : `${to}-${from}`
      if (seen.has(pair)) continue
      seen.add(pair)
      edges.push([from, to])
      if (edges.length >= MEMORY_GRAPH_EDGES_MAX) {
        truncated = true
        break outer
      }
    }
  }

  // the k newest, listed in a steady order (folder, then path), their links renumbered: fit to the frame by k
  const body = (k: number): GraphBody => {
    const pick = newest
      .slice(0, k)
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.r !== b.n.r ? (a.n.r < b.n.r ? -1 : 1) : a.n.p < b.n.p ? -1 : a.n.p > b.n.p ? 1 : 0))
    const at = new Map(pick.map(({ i }, j) => [i, j]))
    return {
      roots: roots.map((r) => ({ id: r.id, label: r.label.slice(0, 40) })),
      nodes: pick.map(({ n }) => ({ r: rootIndex.get(n.r) as number, p: n.p, t: n.t })),
      edges: edges.flatMap(([a, b]) => {
        const x = at.get(a)
        const y = at.get(b)
        return x === undefined || y === undefined ? [] : [[x, y] as [number, number]]
      }),
      total_nodes: all.length,
      truncated: truncated || k < newest.length,
    }
  }
  let k = newest.length
  let out = body(k)
  while (k > 0 && bytes(out) > BUDGET) {
    k = Math.floor(k * 0.9)
    out = body(k)
  }
  return out
}
