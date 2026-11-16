// Sub-threads in the thread lists (docs/THREADS.md "Sub-threads"): a thread with a live parent is drawn under it, as an
// accordion row that opens and closes. Which parents are open is remembered per device (localStorage), like the sidebar's
// own fold. While a parent is closed, its row counts its sub-threads' unread replies with its own.
import type { ThreadT } from '@talos-app/protocol'
import { useSyncExternalStore } from 'react'

export type ThreadGroup<T extends Pick<ThreadT, 'id' | 'parent_id'>> = { thread: T; subs: T[] }

/**
 * Each thread with the sub-threads drawn under it, in list order. A thread whose parent is not in `threads` (archived, or a
 * hand edit naming a missing or nested thread) is drawn at the top level. `threads` is the list as shown, already sorted.
 */
export function groupSubThreads<T extends Pick<ThreadT, 'id' | 'parent_id'>>(threads: readonly T[]): ThreadGroup<T>[] {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const isTop = (t: T) => {
    const p = t.parent_id ? byId.get(t.parent_id) : undefined
    // one level: a parent that is itself under another thread does not hold sub-threads
    return !p || p.id === t.id || (p.parent_id !== undefined && byId.has(p.parent_id))
  }
  const groups = new Map<string, ThreadGroup<T>>()
  for (const t of threads) if (isTop(t)) groups.set(t.id, { thread: t, subs: [] })
  for (const t of threads) if (!isTop(t)) groups.get(t.parent_id as string)?.subs.push(t)
  return [...groups.values()]
}

/** The list in drawn order: each parent followed by its sub-threads. The keyboard's thread numbers follow it. */
export function inDrawnOrder<T extends Pick<ThreadT, 'id' | 'parent_id'>>(threads: readonly T[]): T[] {
  return groupSubThreads(threads).flatMap((g) => [g.thread, ...g.subs])
}

/** The count a parent's row shows: its own unread, plus its sub-threads' while it is closed. */
export function rolledUpUnread(
  group: ThreadGroup<Pick<ThreadT, 'id' | 'parent_id'>>,
  unread: Readonly<Record<string, number>>,
  open: boolean,
): number {
  const own = (id: string) => (Object.hasOwn(unread, id) ? Math.max(0, unread[id] ?? 0) : 0)
  return own(group.thread.id) + (open ? 0 : group.subs.reduce((n, s) => n + own(s.id), 0))
}

// ---- which parents are open (per device) ---------------------------------------------------------------------------------

export const SUBTHREADS_OPEN_KEY = 'talos-subthreads-open'

const listeners = new Set<() => void>()
function read(): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SUBTHREADS_OPEN_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 64) : [])
  } catch {
    return new Set()
  }
}
let open: ReadonlySet<string> = typeof window === 'undefined' ? new Set() : read()

export function setSubThreadsOpen(parentId: string, next: boolean) {
  if (open.has(parentId) === next) return
  const s = new Set(open)
  if (next) s.add(parentId)
  else s.delete(parentId)
  open = s
  try {
    localStorage.setItem(SUBTHREADS_OPEN_KEY, JSON.stringify([...s]))
  } catch {}
  for (const l of listeners) l()
}

/** Another tab on this device opened or closed one: follow. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SUBTHREADS_OPEN_KEY && e.key !== null) return
    open = read()
    for (const l of listeners) l()
  })
}

/** The parents open on this device. */
export function useOpenSubThreads(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => open,
    () => open,
  )
}
