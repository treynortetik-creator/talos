// The remote terminal, piece 1 (the "view" tier): the owner watches the agent's tmux pane from the web or the iPhone app, read-only.
// A stream of its own beside the chat path. None of these frames is durable or consumable: the relay never stores one, gives
// one a `relay.seq`, replays one on a bridge hello or pushes one (apps/relay/src/core/term.ts), and the Mac keeps the pane's bytes
// in memory only (apps/bridge/src/term). Opening, resuming and closing are owner-signed and bound to one device; the credit
// (`term.ack`) is unsigned; what the Mac sends back is unsigned too and goes to the one socket that opened the view.
//
// Bytes are the pane's own, base64url without padding in a JSON string, so a code point split across two frames stays split:
// the page decodes them as UTF-8 in streaming mode. `at` is the stream's absolute byte offset (the first byte of a `term.out`,
// the point a `term.key` is exact for), and `term.ack{upto}` / `term.resume{from}` count in the same offsets. Every schema is
// strict with no `.default()`, so a frame that parses is exactly what was sent. There is no typing path at all in this tier:
// there is no frame that writes to the pane, and the tier field accepts nothing but 'view' (the typing and shell tiers are
// later pieces and must not parse as this one).
import { z } from 'zod'
import { b64urlDecode } from './encoding.ts'
import { ownerFrame, strictFrame } from './frame-base.ts'
import { ThreadId } from './ids.ts'

/** The bridge's hello and the relay's `ready` list this: the Mac can show a pane read-only (and the relay carries the stream). */
export const TERM_VIEW_FEATURE = 'term-view/1'

/** A `term.out` carries at most this many raw bytes (the Mac coalesces the pane's output every 16 ms into frames this size or less). */
export const TERM_OUT_MAX_BYTES = 16 * 1024
/** A `term.key` (a keyframe: clear screen plus the pane's history and screen) carries at most this many raw bytes. Far under the 256 KiB frame cap. */
export const TERM_KEY_MAX_BYTES = 128 * 1024
/** The Mac keeps this many raw bytes of a watched pane's output, in memory, shared by every viewer of that pane. */
export const TERM_RING_BYTES = 256 * 1024
/** Credit window per viewer: at most this many frames or this many bytes not yet acked. */
export const TERM_WINDOW_FRAMES = 8
export const TERM_WINDOW_BYTES = 64 * 1024
/** The Mac coalesces a pane's output for this long before it sends. */
export const TERM_COALESCE_MS = 16
/** The relay stops sending to a socket that has this many bytes waiting (`term.closed{why:'lag'}`); the page resumes by offset. */
export const TERM_SOCKET_BUFFER_MAX = 512 * 1024
/** Views open at once across the owner's account. */
export const TERM_MAX_OPEN = 4
/** A signed `term.open` older than this (or this far ahead) is refused: the Mac checks, with the phone's clock skew allowed. */
export const TERM_OPEN_MAX_AGE_MS = 2 * 60_000
/** A view closes after this long with no word from the page (its acks and heartbeats count), and after this long in all. */
export const TERM_IDLE_S = 10 * 60
export const TERM_MAX_S = 60 * 60
/** Pane size bounds the frames accept (the pane keeps its own size; a remote viewer never resizes it). */
export const TERM_SIZE_MAX = 1000

export const TERM_TIERS = ['view'] as const

/** Why a view ended, in `term.closed{why}`. The field is a word, not a closed list: an unknown one still ends the view on the page. */
export const TERM_CLOSE_WHY = [
  'closed', // the owner closed it
  'idle', // no word from the page for TERM_IDLE_S
  'max', // TERM_MAX_S in all
  'lag', // the relay dropped output for this socket; the page resumes by offset (the view is still open)
  'no_pane', // that session has no pane running
  'pane_gone', // the agent's pane ended
  'resized', // the pane's size changed under the view
  'socket_closed', // the page's connection went away
  'restart', // the Mac's bridge restarted
  'mac_offline', // the Mac went away
  'unsupported', // this Mac does not list term-view/1
  'too_many', // already TERM_MAX_OPEN views
  'refused', // the open was refused (signature, device, age, replay)
  'revoked', // the device that opened it was revoked
  'keyframe', // the page needed a new picture again and again, or one could not be made small enough
] as const

/** `tm_` + a ULID, chosen by the page for each open and never reused. */
export const TermId = z.string().regex(/^tm_[0-9A-HJKMNP-TV-Z]{26}$/)

const OFFSET = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const SIZE = z.number().int().min(1).max(TERM_SIZE_MAX)

/** Characters a base64url string (no padding) of `rawBytes` bytes takes. */
export const termB64Chars = (rawBytes: number): number =>
  Math.floor(rawBytes / 3) * 4 + (rawBytes % 3 ? (rawBytes % 3) + 1 : 0)

/** Base64url, no padding, no standard-alphabet characters, no length no byte count makes, and at most `maxBytes` once decoded. */
const bytesB64 = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(termB64Chars(maxBytes))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((s) => s.length % 4 !== 1)

/** The raw bytes of a frame's `bytes_b64`. Throws on anything the schema refuses. */
export const termBytes = (b64: string): Uint8Array => b64urlDecode(b64)

export const TermOpenFrame = ownerFrame('term.open', {
  term_id: TermId,
  tier: z.literal('view'),
  target: z.union([z.literal('main'), ThreadId]),
  cols: SIZE,
  rows: SIZE,
})
export const TermResumeFrame = ownerFrame('term.resume', { term_id: TermId, from: OFFSET })
export const TermCloseFrame = ownerFrame('term.close', { term_id: TermId })
export const TermAckFrame = strictFrame('term.ack', { term_id: TermId, upto: OFFSET })
export const TermOpenedFrame = strictFrame('term.opened', {
  term_id: TermId,
  tier: z.literal('view'),
  cols: SIZE,
  rows: SIZE,
  idle_s: z.number().int().min(1).max(86_400),
  max_s: z.number().int().min(1).max(86_400),
})
export const TermKeyFrame = strictFrame('term.key', {
  term_id: TermId,
  at: OFFSET,
  bytes_b64: bytesB64(TERM_KEY_MAX_BYTES),
})
export const TermOutFrame = strictFrame('term.out', {
  term_id: TermId,
  at: OFFSET,
  bytes_b64: bytesB64(TERM_OUT_MAX_BYTES),
})
export const TermClosedFrame = strictFrame('term.closed', {
  term_id: TermId,
  why: z.string().regex(/^[a-z][a-z_]{0,23}$/),
})

/** App -> relay -> Mac. */
export const TERM_APP_FRAME_TYPES = ['term.open', 'term.resume', 'term.close', 'term.ack'] as const
/** The three the owner signs. */
export const TERM_OWNER_FRAME_TYPES = ['term.open', 'term.resume', 'term.close'] as const
/** Mac -> relay -> app (the relay also sends `term.closed` itself, for a lag). */
export const TERM_BRIDGE_FRAME_TYPES = ['term.opened', 'term.key', 'term.out', 'term.closed'] as const
export const TERM_FRAME_TYPES = [...TERM_APP_FRAME_TYPES, ...TERM_BRIDGE_FRAME_TYPES] as const

export type TermCloseWhy = (typeof TERM_CLOSE_WHY)[number]
