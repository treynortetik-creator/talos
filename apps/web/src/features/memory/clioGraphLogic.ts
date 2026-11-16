// Clio graph's words, colours and what is shown (pure, testable apart from the 3D scene). The palette and the light ground
// are Portolan's own (the owner's viewer, ported as it is); a folder takes the next colour in turn.
import type { MemoryGraph } from '../../lib/v2Client.ts'

export const CLIO_TEXT = {
  title: 'Clio graph',
  back: 'Back to Clio',
  graphButton: 'Graph',
  loading: 'Asking your Mac for the graph…',
  offline: "Your Mac is offline, so the graph can't be drawn now.",
  failed: "Couldn't draw the graph. Try again from Clio.",
  unavailable: 'Update Talos on your Mac to see the graph.',
  empty: 'No notes yet. Pick folders in Settings, Memory folders.',
  noMatch: 'No note matches.',
  search: 'Find a note',
  legend: 'Folders',
  canvas: 'Your notes as a 3D graph. Drag to turn it, scroll to zoom, choose a note to see what it links to.',
  panel: 'Chosen note',
  open: 'Open note',
  pause: 'Pause',
  turn: 'Turn',
  links: (n: number) => (n === 1 ? '1 link' : `${n} links`),
  meta: (shown: number, total: number, links: number) =>
    `${shown === total ? `${total}` : `${shown} of ${total}`} ${total === 1 ? 'note' : 'notes'} · ${links} ${links === 1 ? 'link' : 'links'}`,
  truncated: (shown: number, total: number) =>
    `Showing ${shown} of ${total} notes: the most recently changed. Narrow it with Settings, Memory folders.`,
} as const

const LIGHT = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
  '#1e96b0',
  '#a45c2e',
  '#5c6ba0',
]
const DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
  '#1c96ab',
  '#c17a45',
  '#7c8bd4',
]

const dark = () =>
  typeof document !== 'undefined' &&
  (document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-color-scheme: dark)').matches))

const token = (name: string, fallback: string) => {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function graphColors() {
  const d = dark()
  const hues = d ? DARK : LIGHT
  return {
    ground: d ? token('--bg', '#141414') : '#e6e6e4',
    ink: d ? '#f2f2f0' : '#0e0e0e',
    ring: d ? '#f2f2f0' : '#2a2a2a',
    link: d ? '#f2f2f0' : '#333333',
    accent: token('--accent', '#eb6834'),
    folder: (i: number) => hues[i % hues.length] as string,
  }
}

const fold = (s: string) => s.normalize('NFKD').toLowerCase()

/** Notes whose title or path holds the search words. */
export function matchesOf(g: MemoryGraph, q: string): Set<number> {
  const w = fold(q.trim())
  const out = new Set<number>()
  if (!w) return out
  for (const [i, n] of g.nodes.entries()) if (fold(n.title).includes(w) || fold(n.path).includes(w)) out.add(i)
  return out
}

/** The notes a note links to or is linked from. */
export const linkedTo = (g: MemoryGraph, i: number): number[] =>
  g.edges.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : []))

export type Shown = { nodes: number[]; edges: Array<[number, number]>; degree: Map<number, number> }

/** What is drawn: notes not in a hidden folder; with a search, the matches and their neighbours; links between those. */
export function shownGraph(g: MemoryGraph, hiddenFolders: ReadonlySet<number>, q: string): Shown {
  let keep = new Set(g.nodes.flatMap((n, i) => (hiddenFolders.has(n.root) ? [] : [i])))
  if (q.trim()) {
    const m = matchesOf(g, q)
    const near = new Set<number>()
    for (const [a, b] of g.edges) {
      if (m.has(a) && keep.has(b)) near.add(b)
      if (m.has(b) && keep.has(a)) near.add(a)
    }
    keep = new Set([...keep].filter((i) => m.has(i) || near.has(i)))
  }
  const edges = g.edges.filter(([a, b]) => keep.has(a) && keep.has(b))
  const degree = new Map<number, number>()
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  return { nodes: [...keep], edges, degree }
}
