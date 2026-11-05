// Message frames: the stored copy of an owner message, the agent reply, voice transcripts and delivery receipts.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import { type FrameOf, ownValue } from '@talos-app/protocol'
import type { FrameContext } from './socket-frames-context.ts'

export function onMessageStored(ctx: FrameContext, frame: FrameOf<'message.stored'>, isCatchup: boolean): void {
  const { lostIds, upsertMessage, withSeq, bumpSeq, bumpUnread, findMessage, clearFailed } = ctx
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
  if (!isCatchup && !prior && (frame.message.via === 'share' || frame.message.author !== 'owner'))
    bumpUnread(frame.message.thread_id)
  return
}

export function onReply(ctx: FrameContext, frame: FrameOf<'reply'>, isCatchup: boolean): void {
  const { set, upsertMessage, withSeq, bumpSeq } = ctx
  upsertMessage(withSeq(frame.message, frame))
  bumpSeq(frame)
  // Catch-up replays are already counted in `ready.unread`; only live replies bump it.
  if (!isCatchup && frame.message.author === 'agent' && !frame.silent) {
    const tid = frame.message.thread_id
    set((s) => ({ unread: { ...s.unread, [tid]: (ownValue(s.unread, tid) ?? 0) + 1 } }))
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

export function onReceipt(ctx: FrameContext, frame: FrameOf<'receipt'>): void {
  const { lostIds, patchMessage } = ctx
  if (frame.state === 'not_delivered') lostIds.add(frame.message_id)
  patchMessage(frame.message_id, (m) => ({ ...m, receipt: frame.state }))
  return
}
