// Dictation: send one recording to the relay, get words back. The words are plain display text for the message box,
// exactly like typed ones; nothing here sends a message.
import { endReasonOf } from '../../lib/http.ts'

export type DictateFailure =
  | 'offline'
  | 'unreachable' // the relay itself could not be reached
  | 'signed_out'
  | 'too_large'
  | 'unsupported'
  | 'rate_limited'
  | 'daily_cap'
  | 'daily_used_up' // nothing is left today: no shorter recording would fit
  | 'upstream_refused'
  | 'upstream_unreachable'
  | 'upstream_timeout'
  | 'disabled'
  | 'other'

export class DictateError extends Error {
  constructor(
    readonly kind: DictateFailure,
    /** For `signed_out`: why the relay ended the session (`expired`, `revoked`, ...), when it said. */
    readonly reason: string | null = null,
    /** For `daily_cap`: how many bytes of today's allowance are left, when the relay said. */
    readonly leftBytes: number | null = null,
  ) {
    super(kind)
  }
}

const BY_CODE: Record<string, DictateFailure> = {
  too_large: 'too_large',
  unsupported_type: 'unsupported',
  rate_limited: 'rate_limited',
  daily_cap: 'daily_cap',
  upstream_refused: 'upstream_refused',
  upstream_unreachable: 'upstream_unreachable',
  upstream_timeout: 'upstream_timeout',
  dictate_disabled: 'disabled',
}

/** Plain words for each failure. They never include anything the owner said. */
export const FAILURE_TEXT: Record<DictateFailure, string> = {
  offline: "You're offline, so the recording can't be turned into text yet.",
  unreachable: "Couldn't reach the relay. Check your connection.",
  signed_out: 'You were signed out, so the recording was dropped.',
  too_large: 'That recording is too long to transcribe (over 25 MB).',
  unsupported: "This device's recording format isn't supported for dictation.",
  rate_limited: "You've dictated a lot this hour. Wait a bit, or send it as a voice note.",
  daily_used_up: "Today's dictation limit is used up. Send it as a voice note, or try again later.",
  daily_cap:
    "This recording is too long for what's left of today's dictation limit. Try a shorter one, or try again later.", // used when the relay gave no number
  upstream_refused: 'The transcription service refused the recording.',
  upstream_unreachable: "The relay couldn't reach the transcription service.",
  upstream_timeout: 'The transcription service took too long.',
  disabled: 'Dictation is turned off on this relay.',
  other: "Couldn't turn the recording into text.",
}

/** "424 KB" or "3.5 MB". */
const sizeWords = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`
    : `${Math.max(1, Math.floor(bytes / 1024))} KB`

/** The words for a failure. For the daily cap with a known amount left, the text is built here from the number; nothing the relay wrote is shown. */
export function failureText(failure: DictateFailure, leftBytes: number | null = null): string {
  if (failure === 'daily_cap' && leftBytes !== null && leftBytes > 0)
    return `Only about ${sizeWords(leftBytes)} of today's dictation limit is left, and this recording is bigger. Try a shorter one, or try again later.`
  return FAILURE_TEXT[failure]
}

/** POSTs the recording to /api/dictate. Throws `DictateError`; the caller keeps the recording to try again. */
export async function transcribe(blob: Blob, signal?: AbortSignal): Promise<string> {
  let res: Response
  try {
    res = await fetch('/api/dictate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Talos-CSRF': '1' },
      body: blob,
      ...(signal ? { signal } : {}),
    })
  } catch {
    throw new DictateError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable')
  }
  const body = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null
  if (res.status === 401) throw new DictateError('signed_out', endReasonOf(body))
  if (res.status === 403) throw new DictateError('other')
  if (res.status === 429 && body?.error === 'daily_cap') {
    const { used_up: usedUp, left_bytes: left } = body as { used_up?: unknown; left_bytes?: unknown }
    if (usedUp === true) throw new DictateError('daily_used_up')
    const leftBytes = typeof left === 'number' && Number.isFinite(left) && left > 0 ? left : null
    throw new DictateError('daily_cap', null, leftBytes)
  }
  if (!res.ok) throw new DictateError(BY_CODE[String(body?.error)] ?? (res.status === 413 ? 'too_large' : 'other'))
  if (typeof body?.text !== 'string') throw new DictateError('other')
  return body.text
}

/** The box's text with `words` added at its end: a space between, unless the box is empty or already ends in white space. */
export function appendWords(current: string, words: string): string {
  const w = words.trim()
  const gap = current === '' || /\s$/.test(current) ? '' : ' '
  return current + gap + w
}
