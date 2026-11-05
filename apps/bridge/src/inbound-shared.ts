// Types and constants the inbound frame families share.
import type { Frame } from '@talos-app/protocol'
import type { BacklogItem } from './notify.ts'

export type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

export type Item = { raw: Record<string, unknown>; frame: Frame; receivedAt: number; owner?: OwnerCheck }

export type OwnerCheck = { ok: true; deviceId: string } | { ok: false; reason: string; deviceId?: string }

/** Owner READS (history, search, memory) are interactive and never queued by the app: a few minutes, not the durable 8 days. */
export const READ_MAX_AGE_MS = 5 * 60_000

/** A frame that verified but whose `ts` is outside the window: almost always a phone clock that is off, never a forgery. */
export const CLOCK_OFF_MESSAGE = "This device's clock is off. Set it to automatic date and time, then try again."

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
