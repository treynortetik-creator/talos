// Which panes are open beside a thread, in what order, and which are folded to their title bar: per thread, on this device
// only (one storage key holding every thread's layout; another device keeps its own). Storage can be blocked or throw, so
// every read and write is wrapped, and the layout then simply lasts until the page is reloaded.
import { useCallback, useSyncExternalStore } from 'react'

export const PANE_IDS = ['library', 'terminal'] as const
export type PaneId = (typeof PANE_IDS)[number]
export type PaneLayout = { open: PaneId[]; collapsed: PaneId[] }

export const PANES_KEY = 'talos.panes'
/** Threads whose layout is kept; the oldest is forgotten past this. */
const KEEP_THREADS = 200
const EMPTY: PaneLayout = { open: [], collapsed: [] }

const isPane = (v: unknown): v is PaneId => typeof v === 'string' && (PANE_IDS as readonly string[]).includes(v)
/** Files and Pages became the Library (owner, 2026-11-15): a layout this device kept from before opens it. */
const renamed = (v: unknown): unknown => (v === 'files' || v === 'pages' ? 'library' : v)
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
let memory: Record<string, PaneLayout> | null = null

function clean(v: unknown): PaneLayout {
  const o = (v && typeof v === 'object' ? v : {}) as { open?: unknown; collapsed?: unknown }
  const open = [...new Set(Array.isArray(o.open) ? o.open.map(renamed).filter(isPane) : [])]
  const collapsed = [...new Set(Array.isArray(o.collapsed) ? o.collapsed.map(renamed).filter(isPane) : [])].filter(
    (p) => open.includes(p),
  )
  return { open, collapsed }
}

function load(): Record<string, PaneLayout> {
  if (memory) return memory
  let raw: unknown = {}
  try {
    raw = JSON.parse(globalThis.localStorage?.getItem(PANES_KEY) ?? '{}')
  } catch {
    raw = {}
  }
  // no prototype: a thread called "constructor" or "__proto__" is a key like any other
  const out: Record<string, PaneLayout> = Object.create(null)
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [id, l] of Object.entries(raw)) if (typeof id === 'string' && id.length <= 64) out[id] = clean(l)
  memory = out
  return out
}

function save(next: Record<string, PaneLayout>) {
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_THREADS))) delete next[id]
  memory = next
  try {
    globalThis.localStorage?.setItem(PANES_KEY, JSON.stringify(next))
  } catch {
    // private window or blocked storage: the layout lasts until the page is reloaded
  }
  for (const l of listeners) l()
}

/** The layout of one thread. */
export function paneLayout(threadId: string): PaneLayout {
  const all = load()
  return Object.hasOwn(all, threadId) ? (all[threadId] as PaneLayout) : EMPTY
}

/** Changes one thread's layout; a thread with no pane open is forgotten. */
export function setPaneLayout(threadId: string, change: (l: PaneLayout) => PaneLayout) {
  const all: Record<string, PaneLayout> = Object.assign(Object.create(null), load())
  const next = clean(change(paneLayout(threadId)))
  delete all[threadId] // re-added last: the most recently changed thread is the last one forgotten
  if (next.open.length > 0) all[threadId] = next
  save(all)
}

export const openPane = (threadId: string, p: PaneId) =>
  setPaneLayout(threadId, (l) => ({
    open: l.open.includes(p) ? l.open : [...l.open, p],
    collapsed: l.collapsed.filter((x) => x !== p),
  }))
export const closePane = (threadId: string, p: PaneId) =>
  setPaneLayout(threadId, (l) => ({
    open: l.open.filter((x) => x !== p),
    collapsed: l.collapsed.filter((x) => x !== p),
  }))
export const togglePane = (threadId: string, p: PaneId) =>
  paneLayout(threadId).open.includes(p) ? closePane(threadId, p) : openPane(threadId, p)
export const setPaneCollapsed = (threadId: string, p: PaneId, collapsed: boolean) =>
  setPaneLayout(threadId, (l) => ({
    open: l.open,
    collapsed: collapsed ? [...l.collapsed, p] : l.collapsed.filter((x) => x !== p),
  }))

/** One thread's layout, kept current. */
export function usePaneLayout(threadId: string): PaneLayout {
  const get = useCallback(() => paneLayout(threadId), [threadId])
  return useSyncExternalStore(subscribe, get, get)
}

/** Tests: forget what was read, so the next read comes from storage again. */
export function resetPanesForTests() {
  memory = null
}
