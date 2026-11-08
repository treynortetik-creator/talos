// Sizes, limits and timings of the socket client, and the errors its queue raises. Nothing here reads state.
/** Re-sign a queued frame once it is this old: the Mac's own limit is 8 days, and this leaves two days to get it there. */
export const RESIGN_AFTER_MS = 6 * 24 * 3600_000
/** The relay's default for how long it keeps uploaded media (BUFFER_DAYS). A voice note signed longer ago than this may point at media it has deleted. */
export const MEDIA_KEPT_MS = 7 * 24 * 3600_000

/** A queued voice note that waited so long that the recording it points at is probably gone from the relay. */
export class MediaGoneError extends Error {}
/** A Run (a message with `intent: 'run'`, protocol run.ts) that waited in the queue longer than a day: the tap approved a script for that moment, so it is not sent. */
export class RunStaleError extends Error {
  /** The frame was written to a socket before: the Mac may have it, and may have run it. */
  constructor(readonly written: boolean) {
    super('run stale')
  }
}
/**
 * How long the relay and the Mac remember a message id (about 8 days; this leaves a day to spare). Past it, a message that
 * was written to a socket but never acked cannot be told from one the Mac already has, so it is not sent again on its own.
 */
export const DEDUPE_WINDOW_MS = 7 * 24 * 3600_000

export const SNAPSHOT = 'snapshot'
export const APP_REQUEST_SETTLE_MS = 5_000
export const INBOX_QUEUE = 'inbox-queue'
export const HISTORY_PAGE = 50
export const REQUEST_TIMEOUT_MS = 12_000
/** The most the relay's `ready.ts` may move the clock we sign with (an hour: a phone further off than that is wrong, not skewed). */
export const MAX_CLOCK_OFFSET_MS = 3600_000
/** The relay's upload cap (core/index.ts): bigger files are refused before they are read into memory. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** The protocol's cap on one message's text (`frames.ts` message.text, `models.ts` Message.text). */
export const MAX_MESSAGE_CHARS = 32_000
/** The relay closes the socket (1009) on a frame over this; a signed frame past it is never sent (it would loop forever). */
export const MAX_SIGNED_FRAME_BYTES = 256 * 1024
export const utf8 = new TextEncoder()
/** The relay counts bytes on the wire (UTF-8), not UTF-16 units: a CJK character is 1 unit and 3 bytes. */
export function overFrameLimit(frame: string): boolean {
  if (frame.length > MAX_SIGNED_FRAME_BYTES) return true // a unit is at least one byte
  if (frame.length * 3 <= MAX_SIGNED_FRAME_BYTES) return false // and at most three
  return utf8.encode(frame).length > MAX_SIGNED_FRAME_BYTES
}
/** After the app comes back to the front: how long a ping may go unanswered before the socket is called dead. */
export const WAKE_PROBE_MS = 2_500
export const TERMINAL_UPLOAD = new Set([400, 413, 415])
/**
 * How many uploads of one voice note may fail in a row, on one connection that stays up, before it is shown as failed.
 * Every try starts with a live, confirmed socket, so a failure is the upload path itself (the relay answered the socket and
 * refused the upload, a daily upload limit, a recording that cannot be read), not a lost connection: a dropped socket
 * does not count, and a new connection starts the count again. Nothing the relay sends says how long such a refusal lasts
 * (its 429 has no Retry-After), so this is a judgement: one failure may be a blip, a second one a coincidence, a third
 * is a pattern. With the default 10 s between tries that is about 20 s of waiting before the text behind it is released.
 */
export const VOICE_UPLOAD_TRIES = 3

/** How long a config.patch waits for the Mac to apply it after the relay stored it. */
export const CONFIG_APPLY_MS = 20_000

/**
 * Events that mean a person is at the screen. The relay counts a visible client as present for 60 s after its last report.
 * `scroll` is deliberately absent: the timeline sets scrollTop itself on every new row, so a scroll event cannot tell a
 * person from the app and an idle screen would keep muting pushes. Wheel and touch already cover a person scrolling.
 */
export const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const
/** At most one activity report per this long (well inside the relay's 60 s presence window). */
export const ACTIVITY_REPORT_MS = 15_000
