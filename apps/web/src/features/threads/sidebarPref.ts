// Whether the desktop sidebar is the full panel or the slim rail. Per device (localStorage), like the Session panel's open / closed choice.
// Phones never read this: they have the bottom bar and the header menu.
import { useSyncExternalStore } from 'react'

export const SIDEBAR_PREF_KEY = 'talos-sidebar-collapsed'

const subs = new Set<() => void>()
const before = new Set<() => void>()

/** Runs just before the value changes (this tab or another), so the sidebar can note where focus is before rows unmount. */
export function onBeforeSidebarChange(cb: () => void): () => void {
  before.add(cb)
  return () => void before.delete(cb)
}
function announce() {
  for (const b of before) b()
}
function read(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PREF_KEY) === '1'
  } catch {
    return false
  }
}
let collapsed = typeof window === 'undefined' ? false : read()

export function setSidebarCollapsed(next: boolean) {
  if (next !== collapsed) announce()
  collapsed = next
  try {
    if (next) localStorage.setItem(SIDEBAR_PREF_KEY, '1')
    else localStorage.removeItem(SIDEBAR_PREF_KEY)
  } catch {}
  for (const s of subs) s()
}

export function toggleSidebar() {
  setSidebarCollapsed(!collapsed)
}

/** Another tab on this device changed it: follow. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SIDEBAR_PREF_KEY && e.key !== null) return
    const v = read()
    if (v === collapsed) return
    announce()
    collapsed = v
    for (const s of subs) s()
  })
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    () => collapsed,
    () => false,
  )
}
