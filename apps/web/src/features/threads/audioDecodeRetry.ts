// One reload for a decode error. `MediaError` code 3 (MEDIA_ERR_DECODE) can hit a clip whose bytes are fine: the same file plays
// when it is loaded again. So the first decode error of a loaded clip is answered by loading the same source once more at the
// spot it reached; the second one is a real failure and shows the usual line. The count is per loaded clip (its row key and
// source) and is cleared only when a different clip is loaded or the player is emptied, so a run of errors can never loop.
export const MEDIA_ERR_DECODE = 3

let spent: string | null = null

/** True the first time this clip hits a decode error (`code` 3); false for any other code, and for every later one. */
export function claimDecodeRetry(clip: string, code: number | undefined): boolean {
  if (code !== MEDIA_ERR_DECODE || spent === clip) return false
  spent = clip
  return true
}

/** A different clip was loaded, or the player was emptied: the next clip gets its own reload. */
export function resetDecodeRetry(): void {
  spent = null
}
