// M2.1: at most three live app iframes per page. The newest views win; an older one drops back to a poster
// ("Load app" brings it back and sends the oldest live one to a poster instead).
import { useSyncExternalStore } from 'react'
import { MAX_LIVE_FRAMES } from './limits.ts'

let live: string[] = [] // oldest first
const subs = new Set<() => void>()
const emit = () => {
  for (const s of subs) s()
}

/** Takes a slot (or refreshes it). Returns the id that lost its slot, if any. */
export function acquireSlot(id: string): string | undefined {
  live = live.filter((x) => x !== id)
  live.push(id)
  let evicted: string | undefined
  if (live.length > MAX_LIVE_FRAMES) evicted = live.shift()
  emit()
  return evicted
}

export function releaseSlot(id: string) {
  if (!live.includes(id)) return
  live = live.filter((x) => x !== id)
  emit()
}

export const resetSlots = () => {
  live = []
  emit()
}

const subscribe = (cb: () => void) => {
  subs.add(cb)
  return () => void subs.delete(cb)
}

export function useHasSlot(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => live.includes(id),
    () => false,
  )
}
