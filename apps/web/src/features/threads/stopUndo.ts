// What Undo may resend after a stop. The thread reads "working" whenever main is busy and the newest row is the owner's, so
// the newest owner message can be an old instruction that has nothing to do with the turn that was stopped. Undo is offered
// only for a message that plainly started this turn.
import { type AttachmentRefT, type MessageT, RUN_PREFIX } from '@talos-app/protocol'
import { orderTimelineRows } from './Timeline.tsx'

/** A message older than this at the stop did not start the turn that was stopped. */
export const UNDO_MAX_AGE_MS = 120_000

/** How far a stamp may be ahead of now before it is not believed. */
const CLOCK_SLACK_MS = 5000

export type UndoTarget = { text: string; attachments: AttachmentRefT[]; replyTo?: string }

/**
 * The owner's message to send again, or null. All of: it is the newest row; it is the only owner message since the last
 * row that is not the owner's (two sent during the turn: the later one may still be delivered after the stop, and a resend
 * could double it); it is under two minutes old (on the relay's clock); it is a plain message (not a Run, a share or a voice note).
 */
export function undoTarget(messages: MessageT[], nowMs: number, clockOffsetMs = 0): UndoTarget | null {
  // Hook and event rows (integration events) are not the agent or the system speaking: they neither end a run of owner
  // messages nor stand between two of them.
  const rows = orderTimelineRows(messages, [], nowMs)
    .flatMap((r) => (r.message ? [r.message] : []))
    .filter((m) => m.author !== 'hook' && m.kind !== 'event')
  const last = rows.at(-1)
  if (!last || last.author !== 'owner') return null
  if (rows.at(-2)?.author === 'owner') return null
  // A stored row is stamped by the relay's clock, so it is compared with the relay's now (this phone's clock may be minutes
  // off); a local row not stored yet was stamped by this phone. A stamp from the future beyond the slack is too old.
  const age = (last.seq !== undefined ? nowMs + clockOffsetMs : nowMs) - Date.parse(last.created_at)
  if (!(age < UNDO_MAX_AGE_MS) || age < -CLOCK_SLACK_MS) return null
  if (last.kind !== 'text' || last.via !== 'app') return null
  if (last.share_content || last.share_label || (last.refs?.length ?? 0) > 0) return null
  const text = last.text ?? ''
  if (text.startsWith(RUN_PREFIX)) return null
  return { text, attachments: last.attachments ?? [], ...(last.reply_to ? { replyTo: last.reply_to } : {}) }
}
