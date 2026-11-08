// The Mac companion and the page's own jump banner share one job: telling the owner a reply landed in another thread. The
// page stays the authority. While the companion says he delivers (`companion_replies {on:true}`), a reply the page would
// have toasted is HELD instead, listed to him in `companion_state.held`, and dropped when he says he showed it (`shown`). The
// moment he stops, or the shell is lost, the page toasts what is still held (one toast, the newest). A reply it held is
// never lost. Memory only: a reloaded page, a browser and the phone read as off, with nothing held.
import { COMPANION_ROWS_MAX } from '@talos-app/protocol'

/** What a toast would say; the same shape as the jump banner's `Banner`. */
export type HeldBanner = { key: string; threadId: string; name: string; snippet: string }
export type HeldRef = { thread_id: string; seq: number }

type Held = HeldBanner & { seq: number }

let on = false
let epoch: number | null = null
let seqCounter = 0
let viewing: string | null = null
let held = new Map<string, Held>() // one per thread: the newest
let sink: ((b: HeldBanner) => void) | null = null
const subs = new Set<() => void>()

const changed = () => {
  for (const s of subs) s()
}

export const companionRepliesOn = (): boolean => on
/** The epoch of the "on" being applied, or null while off. Frames carry it so the shell can tell a stale frame from a fresh one. */
export const repliesEpoch = (): number | null => (on ? epoch : null)
export const viewingThread = (): string | null => viewing

/** The replies the page holds for him, oldest first, at most `COMPANION_ROWS_MAX`. */
export function heldReplies(): HeldRef[] {
  return [...held.values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-COMPANION_ROWS_MAX)
    .map((h) => ({ thread_id: h.threadId, seq: h.seq }))
}

/** True when the companion takes the reply (the page shows no toast); false when it should toast as always. */
export function holdReply(b: HeldBanner): boolean {
  if (!on) return false
  seqCounter += 1
  held.set(b.threadId, { ...b, seq: seqCounter })
  changed()
  return true
}

/** The thread the person is looking at (a card page counts as its thread). Opening a thread reads its held reply. */
export function setViewingThread(id: string | null) {
  if (id === viewing) return
  viewing = id
  if (id !== null) held.delete(id)
  changed()
}

function flush() {
  if (held.size === 0 || !sink) return
  let newest: Held | null = null
  for (const h of held.values()) if (!newest || h.seq > newest.seq) newest = h
  held = new Map()
  changed()
  if (newest) sink({ key: newest.key, threadId: newest.threadId, name: newest.name, snippet: newest.snippet })
}

/**
 * The shell's word. `shown` are replies the companion has put in front of the person: the page forgets those (and anything
 * older in the same thread). Going off, or `shown` and off together, toasts whatever is left.
 */
export function setCompanionReplies(value: boolean, shown: readonly HeldRef[] = [], newEpoch?: number) {
  let dropped = false
  for (const s of shown) {
    const h = held.get(s.thread_id)
    if (h && h.seq <= s.seq) {
      held.delete(s.thread_id)
      dropped = true
    }
  }
  const was = on
  on = value
  if (value && newEpoch !== undefined && newEpoch !== epoch) {
    epoch = newEpoch
    dropped = true
  }
  if (dropped) changed()
  if (was && !on) flush()
  else if (was !== on) changed()
}

/** The jump banner's toast. A held reply that was waiting for a sink (the shell mounts later) shows the moment one registers. */
export function onHeldToast(fn: (b: HeldBanner) => void): () => void {
  sink = fn
  if (!on) flush()
  return () => {
    if (sink === fn) sink = null
  }
}

export function subscribeCompanionReplies(fn: () => void): () => void {
  subs.add(fn)
  return () => void subs.delete(fn)
}

/** Tests: back to a page that never heard from a shell. */
export function resetCompanionRepliesForTest() {
  on = false
  epoch = null
  seqCounter = 0
  viewing = null
  held = new Map()
  sink = null
  subs.clear()
}
