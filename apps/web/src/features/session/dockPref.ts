// Whether the docked Session panel is open on this desktop. Per device (localStorage), like the sidebar fold. Closed until
// the owner opens it. Phones never read this: their Session panel is a drawer from the header.
import { useSyncExternalStore } from 'react'

export const SESSION_DOCK_KEY = 'talos-session-dock'

const subs = new Set<() => void>()
function read(): boolean {
  try {
    return localStorage.getItem(SESSION_DOCK_KEY) === '1'
  } catch {
    return false
  }
}
let open = typeof window === 'undefined' ? false : read()

export function setSessionDockOpen(next: boolean) {
  open = next
  try {
    if (next) localStorage.setItem(SESSION_DOCK_KEY, '1')
    else localStorage.removeItem(SESSION_DOCK_KEY)
  } catch {}
  for (const s of subs) s()
}

export function toggleSessionDock() {
  setSessionDockOpen(!open)
}

/** Another tab on this device changed it: follow. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_DOCK_KEY && e.key !== null) return
    const v = read()
    if (v === open) return
    open = v
    for (const s of subs) s()
  })
}

export function useSessionDockOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    () => open,
    () => false,
  )
}
