// A sheet opened from a button, with no Radix trigger, has nowhere to hand focus back to on close, so focus falls to the page.
// This remembers what had focus when the sheet mounted and puts it back when the sheet closes.
import { useRef } from 'react'

export function useRestoreFocus() {
  const from = useRef<HTMLElement | null>(null)
  if (from.current === null && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
    from.current = document.activeElement
  return {
    onCloseAutoFocus: (e: Event) => {
      const el = from.current
      if (el?.isConnected) {
        e.preventDefault()
        el.focus()
      }
    },
  }
}
