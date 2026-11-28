// Message frames: the stored copy of an owner message, the agent reply, voice transcripts and delivery receipts.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import { type FrameOf, sanitizePaneLines } from '@talos-app/protocol'
import { useQuietLines } from '../features/threads/quietLines.ts'
import type { FrameContext } from './socket-frames-context.ts'

export function onMessageStored(ctx: FrameContext, frame: FrameOf<'message.stored'>, isCatchup: boolean): void {
  const { lostIds, upsertMessage, withSeq, bumpSeq, bumpUnread, noteUnreadSeq, findMessage, clearFailed } = ctx
  // Reconcile the optimistic row with the relay's stored copy (same id = client_msg_id).
  const prior = findMessage(frame.client_msg_id)
  upsertMessage({
    ...withSeq(frame.message, frame),
    ...(lostIds.has(frame.client_msg_id)
      ? { receipt: 'not_delivered' as const }
      : prior?.receipt
        ? { receipt: prior.receipt }
        : { receipt: 'sent' as const }),
  })
  clearFailed(frame.client_msg_id)
  bumpSeq(frame.message.seq !== undefined ? { relay: { seq: frame.message.seq } } : frame)
  // Same rule as the relay's `countsUnread`: a share, or a row the owner did not write (a hook row), is unread. The
  // owner's own message coming back as stored is not.
  if (!prior && (frame.message.via === 'share' || frame.message.author !== 'owner')) {
    const seq = frame.message.seq ?? frame.relay?.seq
    // A catch-up row is in `ready.unread` already: it is remembered (for a read mark that stops below it), not counted.
    if (isCatchup) noteUnreadSeq(frame.message.thread_id, seq)
    else bumpUnread(frame.message.thread_id, seq)
  }
  return
}

export function onReply(ctx: FrameContext, frame: FrameOf<'reply'>, isCatchup: boolean): void {
  const { upsertMessage, withSeq, bumpSeq, bumpUnread, noteUnreadSeq } = ctx
  upsertMessage(withSeq(frame.message, frame))
  bumpSeq(frame)
  // Catch-up replays are already counted in `ready.unread`; only live replies bump it. Either way the row is remembered
  // by seq, so a read mark from another device that stops below it leaves it unread.
  if (frame.message.author === 'agent' && !frame.silent) {
    if (isCatchup) noteUnreadSeq(frame.message.thread_id, frame.relay?.seq)
    else bumpUnread(frame.message.thread_id, frame.relay?.seq)
  }
  return
}

export function onTranscript(ctx: FrameContext, frame: FrameOf<'transcript'>): void {
  const { patchMessage, bumpSeq } = ctx
  patchMessage(frame.message_id, (m) => ({
    ...m,
    transcript: { text: frame.text, engine: frame.engine, status: frame.status },
  }))
  bumpSeq(frame)
  return
}

/** The last lines of a quiet pane for a notice (an ephemeral frame): kept in memory under the notice's id, cleaned again, never a row. */
export function onQuietLines(frame: FrameOf<'quiet.lines'>): void {
  const lines = sanitizePaneLines(frame.lines)
  if (lines.length > 0) useQuietLines.getState().set(frame.message_id, lines)
}

export function onReceipt(ctx: FrameContext, frame: FrameOf<'receipt'>): void {
  const { lostIds, patchMessage, bumpSeq } = ctx
  if (frame.state === 'not_delivered') lostIds.add(frame.message_id)
  // a receipt from a Mac that can undo carries the message's undo point (for "Undo to here"); one without keeps it
  patchMessage(frame.message_id, (m) => ({ ...m, receipt: frame.state, ...(frame.undo ? { undo: frame.undo } : {}) }))
  // A relay that stores receipts stamps them. One that is the newest stored frame must move `lastSeq`, or every later
  // hello asks for it again. A receipt from a relay that does not store them has no seq and moves nothing.
  bumpSeq(frame)
  return
}
