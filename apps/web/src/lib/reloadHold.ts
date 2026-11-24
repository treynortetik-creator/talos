// Work in flight that a reload for a new build must not interrupt: a message or Run being signed and saved or written to the
// socket and not yet acked, a card answer or setting change waiting for its ack. The socket client holds while it works;
// UpdateReady (features/pwa) waits for none. Kept apart from appUpdate.ts: the socket layer imports this, and appUpdate reads
// the build's own version (import.meta.env).
import { createStore } from 'zustand/vanilla'

/** A hold older than this lets go by itself: a hung device store must not block the very reload that would cure it. */
export const HOLD_CAP_MS = 30_000

export const reloadHolds = createStore<{ holds: number }>(() => ({ holds: 0 }))

/**
 * Marks work in flight until the returned function is called, or HOLD_CAP_MS passes; no reload happens meanwhile. Calling the
 * returned function twice releases once.
 */
export function holdReload(): () => void {
  let done = false
  const release = () => {
    if (done) return
    done = true
    clearTimeout(cap)
    reloadHolds.setState((s) => ({ holds: Math.max(0, s.holds - 1) }))
  }
  const cap = setTimeout(release, HOLD_CAP_MS)
  reloadHolds.setState((s) => ({ holds: s.holds + 1 }))
  return release
}

// A message written to the socket is in flight until its ack, one hold per message (the same id again takes over the hold).
const ackHolds = new Map<string, () => void>()
export function holdUntilAck(key: string): void {
  ackHolds.get(key)?.()
  ackHolds.set(key, holdReload())
}
export function releaseAck(key: string): void {
  ackHolds.get(key)?.()
  ackHolds.delete(key)
}
/** The socket is gone (or the session ended): nothing written to it is awaiting an ack on it any more. */
export function releaseAllAcks(): void {
  for (const release of ackHolds.values()) release()
  ackHolds.clear()
}

/** Tests only. */
export function resetReloadHolds(): void {
  releaseAllAcks()
  reloadHolds.setState({ holds: 0 })
}
