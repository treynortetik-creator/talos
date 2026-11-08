// "An approval is open": while the full-screen approval sheet owns the screen, nothing else may draw over it (the now-playing pill,
// the new-reply banner and its toast viewport, the undo strip). One counter, read through `useApprovalOpen`, written by the sheet.
import { useSyncExternalStore } from 'react'

let open = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

/** Called by the sheet while it is mounted; returns the release. Counted, so two sheets never clear each other. */
export function enterApproval(): () => void {
  open++
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    open--
    emit()
  }
}

export const approvalIsOpen = (): boolean => open > 0

export function useApprovalOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    approvalIsOpen,
    () => false,
  )
}
