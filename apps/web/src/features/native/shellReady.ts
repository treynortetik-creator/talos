// Something the page's own parts may need after every `ready` the page sends to the Mac app: the app forgets what the page
// told it when a new document loads, so a part that told it something (where the Terminal pane's slot is) says it again.
const listeners = new Set<() => void>()

/** Called by attach.ts right after it has sent `ready`. */
export function shellReadySent(): void {
  for (const l of [...listeners]) l()
}

/** Runs `cb` after every `ready` the page sends; returns the unsubscribe. */
export function onShellReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
