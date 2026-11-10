// Desktop keys (8.8): every chord comes from the keymap table (lib/keymap.ts), matched on event.code. Cmd/Ctrl chords keep working in the
// message box and other fields (switching thread while typing is useful) unless the field uses that chord itself; plain keys never act
// globally. Enter / Shift+Enter live in the composer. Never a paste chord (Cmd+V, Cmd+Shift+V, Shift+Insert): dictation and paste tools
// send those into the composer, and none of them is in the table.
import { useEffect } from 'react'
import { chordMatches, DEFAULT_KEYMAP, isActive, isMacPlatform, type KeyEntry } from './keymap.ts'
import { detectShell } from './native/detect.ts'

const isField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function useGlobalKeys(
  handlers: {
    /** Run the entry. Return false when it did nothing here, so the browser keeps the key. */
    onAction: (entry: KeyEntry) => unknown
  },
  opts: { keymap?: readonly KeyEntry[]; macApp?: boolean; mac?: boolean } = {},
) {
  const keymap = opts.keymap ?? DEFAULT_KEYMAP
  const macApp = opts.macApp ?? detectShell() === 'desktop'
  // Cmd on a Mac (and in the Mac app), Ctrl elsewhere: on a Mac Ctrl+F, Ctrl+K and Ctrl+J are text-editing keys.
  const mac = opts.mac ?? (macApp || isMacPlatform())
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing) return
      for (const entry of keymap) {
        if (!entry.chord || !isActive(entry, macApp) || !chordMatches(ev, entry.chord, mac)) continue
        if (!entry.inField && isField(ev.target)) return
        if (ev.repeat && !entry.repeat) {
          ev.preventDefault() // a held chord must not hand its repeats to the browser (Ctrl+J, Ctrl+F)
          return
        }
        if (handlers.onAction(entry) !== false && entry.id !== 'close') ev.preventDefault()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handlers, keymap, macApp, mac])
}
