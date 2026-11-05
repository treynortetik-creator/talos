// What macOS says about the Mac app's notification permission, as the shell last told the page (`notify_permission`).
// 'unknown' until the first message; a browser or the iPhone app never receives one. Settings > Notifications reads it.
import { useSyncExternalStore } from 'react'

export type MacNotifyPermission = 'unknown' | 'granted' | 'denied' | 'not_asked'
let current: MacNotifyPermission = 'unknown'
const subs = new Set<() => void>()

export function setMacNotifyPermission(p: MacNotifyPermission) {
  if (p === current) return
  current = p
  for (const s of subs) s()
}

export const getMacNotifyPermission = (): MacNotifyPermission => current

export function useMacNotifyPermission(): MacNotifyPermission {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    getMacNotifyPermission,
    () => 'unknown' as MacNotifyPermission,
  )
}
