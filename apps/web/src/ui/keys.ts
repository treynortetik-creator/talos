// One Escape and input-method rule for every search box (and the Enter of the boxes that submit):
//   Esc with text in the box clears it (spaces count as text);
//   Esc on an empty box closes it, once;
//   a held key (`repeat`), a modified Esc (Shift, Ctrl, Alt, Meta) and an input-method key never close anything;
//   an input-method key (`isComposing`, or keyCode 229 as Safari sends it after the composition has ended) does nothing at all;
//   Enter during an input-method choice never submits, and a held Enter acts at most once.
//
// A box inside a Radix dialog or sheet needs two parts: the box's own handler (`searchBoxKeys`), and `keepEscapeInBox` on the
// surface's `onEscapeKeyDown`. Radix closes on Esc in a document capture listener that runs before any handler on the input, so
// only that prop can stop it. The box marks itself with `ESCAPE_BOX` and then decides everything itself.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

type KeyLike = {
  key: string
  isComposing?: boolean | undefined
  keyCode?: number | undefined
  repeat?: boolean | undefined
  shiftKey?: boolean | undefined
  ctrlKey?: boolean | undefined
  altKey?: boolean | undefined
  metaKey?: boolean | undefined
}

/** Put on a search box (spread it): marks it as owning Esc, for `keepEscapeInBox`. */
export const ESCAPE_BOX = { 'data-escape-box': '' } as const

/** The key belongs to an input method (a composition in progress, or the key that ended one). */
export function isImeKey(e: { isComposing?: boolean | undefined; keyCode?: number | undefined }): boolean {
  return e.isComposing === true || e.keyCode === 229
}

/** `ignore`: not Esc, or an input-method key: do nothing and touch nothing. `swallow`: consume it, do nothing. */
type EscapeIntent = 'ignore' | 'swallow' | 'clear' | 'close'

/** What an Esc key-down means for a box holding `text` (the raw value, never trimmed). The order of the checks is the rule. */
export function escapeIntent(e: KeyLike, text: string): EscapeIntent {
  if (e.key !== 'Escape') return 'ignore'
  if (isImeKey(e)) return 'ignore'
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return 'swallow'
  if (e.repeat) return 'swallow'
  return text !== '' ? 'clear' : 'close'
}

// A React event keeps `isComposing` on its native event; a plain object (a test, a native event) carries it itself.
const ime = (e: ReactKeyboardEvent | KeyLike) =>
  isImeKey('nativeEvent' in e ? (e.nativeEvent as { isComposing?: boolean; keyCode?: number }) : e) ||
  ('keyCode' in e && e.keyCode === 229)

/** `escapeIntent` for a React key event (whose input-method flag lives on its native event). */
export const reactEscapeIntent = (e: ReactKeyboardEvent, text: string): EscapeIntent =>
  ime(e) ? 'ignore' : escapeIntent(e, text)

/**
 * The `onKeyDown` of a search box. `onClose` is for a box that has something to close (a dialog, a search mode); without it
 * an empty-box Esc is left to the page, as before. `onEnter` runs once per fresh, non-input-method Enter.
 */
export function searchBoxKeys(o: {
  value: string
  onClear: () => void
  onClose?: () => void
  onEnter?: () => void
}): (e: ReactKeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter') {
      if (!o.onEnter || ime(e) || e.repeat) return
      o.onEnter()
      return
    }
    if (e.key !== 'Escape') return
    const intent = reactEscapeIntent(e, o.value)
    if (intent === 'ignore') return
    if (intent === 'close' && !o.onClose) return
    e.preventDefault()
    e.stopPropagation()
    if (intent === 'clear') o.onClear()
    else if (intent === 'close') o.onClose?.()
  }
}

/** `onEscapeKeyDown` for a Radix Dialog or Sheet that holds a search box: Esc from a marked box is the box's, never the surface's. */
export function keepEscapeInBox(e: Event): void {
  const t = e.target
  if (t instanceof Element && t.closest('[data-escape-box]')) e.preventDefault()
}
