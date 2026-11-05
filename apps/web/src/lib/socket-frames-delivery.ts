// Answers to what this device sent: the device pin, acks and errors.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import type { FrameOf } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { FrameContext } from './socket-frames-context.ts'

export function onDevicePinned(ctx: FrameContext, frame: FrameOf<'device.pinned'>): void {
  const { set, flushOutbox } = ctx
  const key = ctx.getKey()
  if (key && frame.device_id === key.deviceId) {
    set(() => ({ devicePinned: frame.ok }))
    if (frame.ok) void flushOutbox()
  }
  return
}

export function onAck(ctx: FrameContext, frame: FrameOf<'ack'>): void {
  const { pending, onAcked } = ctx
  // `lastSeq` only advances from stored frames (message.stored, replies, catch-up batches), never from an ack: an
  // ack can carry a seq above catch-up pages that are still arriving, and the next `hello` would skip them.
  const p = pending.get(frame.ref)
  if (p) {
    clearTimeout(p.timer)
    pending.delete(frame.ref)
    p.resolve(frame.seq)
  }
  void onAcked(frame.ref)
  return
}

export function onError(ctx: FrameContext, frame: FrameOf<'error'>): void {
  const {
    set,
    markFailed,
    addSystemRow,
    emit,
    settleConfig,
    mediaFetchIds,
    pending,
    historyErrors,
    inboxSettled,
    dropFromOutbox,
  } = ctx
  const outbox = ctx.getOutbox()
  if (frame.ref) {
    const fetchedMedia = mediaFetchIds.get(frame.ref)
    if (fetchedMedia !== undefined) {
      // a media.fetch the Mac (or the relay: mac_offline) refused: never a message row, but the file's chip hears it
      // now instead of waiting out its timeout. `media_id` rides along on the same `error` frame for the listeners.
      mediaFetchIds.delete(frame.ref)
      emit('error', { ...frame, media_id: fetchedMedia })
      return
    }
    const failHistory = historyErrors.get(frame.ref)
    if (failHistory) {
      failHistory(new TalosClientError(frame.code, frame.message))
      return
    }
    if (inboxSettled(frame.ref, frame.code === 'internal')) return
    if (!pending.has(frame.ref) && settleConfig(frame.ref, new TalosClientError(frame.code, frame.message))) return
    const p = pending.get(frame.ref)
    if (p) {
      clearTimeout(p.timer)
      pending.delete(frame.ref)
      p.reject(new TalosClientError(frame.code, frame.message, frame.fields))
    }
    // A server error never deletes a signed frame: it is the only copy of what the owner said.
    const held = outbox.find((x) => x.id === frame.ref)
    if (held) {
      // A refused voice.ask is never retried: the call that spoke it is over by the next `ready`.
      if (held.kind === 'voice.ask') {
        void dropFromOutbox(held.id)
        return
      }
      if (frame.code === 'device_not_pinned') set(() => ({ devicePinned: false }))
      else markFailed(held.clientMsgId, 'retry')
      if (frame.code === 'sig_invalid')
        addSystemRow('A message failed its security check and was kept. Tap it to retry.', frame.id, held.threadId)
      return
    }
  }
  if (frame.code === 'device_not_pinned') set(() => ({ devicePinned: false }))
  else if (frame.code === 'sig_invalid') addSystemRow('A message failed its security check and was dropped.', frame.id)
  return
}
