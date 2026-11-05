/** True when `s` has a C0/C1 control character (newline included): plain text fields must have none. */
export function hasControl(s: string | undefined): boolean {
  if (s === undefined) return false
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 32 || (c >= 127 && c <= 159)) return true
  }
  return false
}
