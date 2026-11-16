// Types and constants the inbound frame families share.
import type { Frame } from '@talos-app/protocol'
import { MAX_FUTURE_MS } from './history-store.ts'
import type { BacklogItem } from './notify.ts'
import { say } from './owner-words.ts'

export type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

export type Item = { raw: Record<string, unknown>; frame: Frame; receivedAt: number; owner?: OwnerCheck }

export type OwnerCheck = { ok: true; deviceId: string } | { ok: false; reason: string; deviceId?: string }

/** Owner READS (history, search, memory) are interactive and never queued by the app: a few minutes, not the durable 8 days. */
export const READ_MAX_AGE_MS = 5 * 60_000

/** A frame that verified but whose `ts` is outside the window: almost always a phone clock that is off, never a forgery. */
export const CLOCK_OFF_MESSAGE = "This device's clock is off. Set it to automatic date and time, then try again."

/** How far a phone's `ts` may sit past the relay's stamp before the phone, and not the Mac, is named as the clock that is off. */
const PHONE_AHEAD_OF_RELAY_MS = 60_000

const about = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000))
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`
}

/**
 * The words for a `stale` refusal: whose clock is off and by about how much, when that can be told. `tsMs` is when the
 * device signed the frame, `nowMs` this Mac's clock, `relayStampMs` the relay's `received_at` for the same frame (a third
 * clock). The stamp is unsigned, so it only chooses the wording here and never whether the frame is accepted.
 *
 * Only a frame signed in this Mac's future gets a number. A device cannot sign later than the relay receives, so a `ts`
 * past the stamp is that device's clock running fast; a `ts` that agrees with the stamp while this Mac is behind both is
 * the Mac's. A frame that is too OLD may just have waited (a queued tap, a replay), so no clock is blamed for it.
 */
export function clockOffMessage(tsMs: number, nowMs: number, relayStampMs?: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= nowMs + MAX_FUTURE_MS) return CLOCK_OFF_MESSAGE
  if (relayStampMs === undefined || !Number.isFinite(relayStampMs))
    return `This device's clock is about ${about(tsMs - nowMs)} ahead of ${say({ mac: "your Mac's", linux: "your computer's" })}. Set both to automatic date and time, then try again.`
  if (tsMs - relayStampMs >= PHONE_AHEAD_OF_RELAY_MS)
    return `This device's clock is about ${about(tsMs - relayStampMs)} fast. Set it to automatic date and time, then try again.`
  return say({
    mac: `Your Mac's clock is about ${about(tsMs - nowMs)} slow. Set the Mac to automatic date and time, then try again.`,
    linux: `Your computer's clock is about ${about(tsMs - nowMs)} slow. Set your computer to automatic date and time, then try again.`,
  })
}

export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'")

/** The most one backlog notification carries (UTF-8 bytes of its messages). A guess, not Claude Code's real limit. */
export const BACKLOG_PART_BYTES = 256 * 1024

export const backlogRowBytes = (e: BacklogItem | undefined) =>
  e
    ? Buffer.byteLength(e.text) +
      Buffer.byteLength(e.shared ?? '') +
      Buffer.byteLength((e.noteFiles ?? []).join(', ')) +
      300
    : 0
