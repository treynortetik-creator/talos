// Small pure helpers of the hub files: which thread a frame belongs to, whether it counts as unread, what a card push
// may show.
import { type CardT, cardNotice } from '@talos-app/protocol'
import type { RichPushInput } from '../services.ts'

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'error'
}

/** The thread a frame belongs to, for history, unread counts and error routing. */
export function threadOf(frame: Record<string, unknown>): string | undefined {
  const get = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined)
  const candidates = [
    frame.thread_id,
    get(frame.message, 'thread_id'),
    get(frame.card, 'thread_id'),
    get(frame.thread, 'id'),
    get(frame.event, 'thread'),
    get(frame.item, 'thread'),
  ]
  return candidates.find((c): c is string => typeof c === 'string')
}

/**
 * What a card push may show: the words `cardNotice` builds from the whole card. The card's id, risk and hash ride along
 * (so the phone can offer Approve) only when that text IS the whole card; a clipped, attached, payload-carrying or
 * outward-facing card gets its text and no button.
 */
export function cardRich(card: CardT): RichPushInput {
  const n = cardNotice(card)
  return {
    text: n.text,
    ...(n.complete ? { card: { id: card.id, risk: card.risk, payload_hash: card.payload_hash } } : {}),
    // A permission card the notification can't offer Approve for (a note it has no room for, a long call, a repeated id)
    // gets Open: the app shows it with its note, and Allow is a tap there.
    ...(card.kind === 'permission' && !n.complete ? { openOnly: true } : {}),
  }
}

export function countsUnread(frame: Record<string, unknown>): boolean {
  const msg = frame.message as { author?: string; via?: string } | undefined
  const author = msg?.author
  if (frame.type === 'reply') return !frame.silent
  // A share is an owner-authored row the owner has not seen yet: it counts as unread (Inbox badge).
  if (frame.type === 'message.stored') return msg?.via === 'share' || (author !== undefined && author !== 'owner')
  return frame.type === 'inbox.item'
}

/** Runs every hook; one that throws is logged and the rest still run. */
export function runHooks(
  hooks: ReadonlyArray<() => void>,
  log: { error(o: object, m: string): void },
  msg: string,
): void {
  for (const fn of hooks) {
    try {
      fn()
    } catch (e) {
      log.error({ err: errName(e) }, msg)
    }
  }
}
