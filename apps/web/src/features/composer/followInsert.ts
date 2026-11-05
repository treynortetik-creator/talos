// When should the composer scroll itself to the end of its text? Only when the caret sits at the very end after a change:
// dictation, a paste (including one that replaces a selection with something shorter), or a tool writing the value all
// leave the caret there, and the end is where the owner is looking. A change with the caret anywhere else must never move
// the view, so the owner can fix a word in a long message without being thrown. (Backspacing at the end already scrolls
// there natively, so following it too changes nothing.)
export function followsInsert(
  ta: Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd'>,
  shown: string,
  next: string,
): boolean {
  if (next === shown || ta.value !== next) return false
  return ta.selectionStart === next.length && ta.selectionEnd === next.length
}
