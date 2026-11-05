// Desktop keys (8.8): Ctrl/Cmd+1..9 switch threads in config order (matched on event.code), Cmd+Shift+K starts a call,
// Cmd/Ctrl+Backslash folds the sidebar, Esc closes the detail panel. Enter / Shift+Enter live in the composer.
import { useEffect } from 'react'

export function useGlobalKeys(handlers: {
  onThread: (index: number) => void
  onCall?: () => void
  /** Cmd/Ctrl+K (no Shift, no Alt): open search. */
  onSearch?: () => void
  /** Cmd/Ctrl+Backslash (no Shift, no Alt): fold or unfold the sidebar. */
  onSidebar?: () => void
  onEscape?: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (mod && !e.altKey && !e.shiftKey && digit) {
        e.preventDefault()
        handlers.onThread(Number(digit[1]) - 1)
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK' && handlers.onSearch) {
        e.preventDefault()
        handlers.onSearch()
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'Backslash' && handlers.onSidebar) {
        e.preventDefault()
        // A toggle: a held key must not strobe the layout (the other chords here navigate, so repeats are harmless).
        if (!e.repeat) handlers.onSidebar()
        return
      }
      // Never a paste chord (Cmd+V, Cmd+Shift+V, Shift+Insert): dictation and paste tools send those into the composer.
      if (e.metaKey && e.shiftKey && !e.altKey && e.code === 'KeyK' && handlers.onCall) {
        e.preventDefault()
        handlers.onCall()
        return
      }
      if (e.key === 'Escape') handlers.onEscape?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handlers])
}
