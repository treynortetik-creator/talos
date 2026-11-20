// The client methods that send, retry and discard messages.

import { newId } from '@talos-app/protocol'
import { NotSentError, TalosClientError } from './client.ts'
import { MAX_MESSAGE_CHARS, overFrameLimit } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { SocketClient } from './socket-types.ts'

export function createClientSend(
  c: SocketCtx,
): Pick<SocketClient, 'outboxSize' | 'retryMessage' | 'discardMessage' | 'fetchMedia' | 'onFrame' | 'sendMessage'> {
  const { discarding, listeners, now, set, store } = c
  return {
    outboxSize: () => c.outbox.length,
    retryMessage(clientMsgId) {
      const e = c.outbox.find((x) => x.clientMsgId === clientMsgId)
      if (!e) return
      if (overFrameLimit(e.bytes)) return // can never succeed: the owner can Edit or Delete it
      c.clearFailed(clientMsgId)
      c.refreshQueued()
      if (store.getState().devicePinned && c.canSend()) {
        const began = c.epoch
        // The owner's tap decides, even for one that may already be delivered: that one is signed again and sent.
        void c.sendEntry(clientMsgId, began, c.mayAlreadyBeDelivered).catch((err) => {
          if (c.epoch === began) c.sendFailed(e, err)
        })
      }
    },
    async discardMessage(clientMsgId) {
      // Flagged first, so a flush half way through this message writes nothing more; then it waits for that step to end.
      discarding.add(clientMsgId)
      try {
        await c.withEntryLock(clientMsgId, async () => {
          for (const e of c.outbox.filter((x) => x.clientMsgId === clientMsgId)) await c.dropFromOutbox(e.id)
        })
      } finally {
        discarding.delete(clientMsgId)
      }
      c.clearFailed(clientMsgId)
      set((st) => ({
        messages: Object.fromEntries(
          Object.entries(st.messages).map(([t, list]) => [t, list.filter((m) => m.id !== clientMsgId)]),
        ),
      }))
      c.refreshQueued()
      void c.flushOutbox() // what waited behind it can go
    },
    fetchMedia(mediaId) {
      void c.fetchMediaSigned(mediaId)
    },
    onFrame(type, listener) {
      const s = listeners.get(type) ?? new Set()
      s.add(listener as never)
      listeners.set(type, s)
      return () => void s.delete(listener as never)
    },
    async sendMessage({ threadId, text, attachments = [], replyTo, intent, runBlock, runWhere, requireLive }) {
      // Checked before anything is stored: a retry of a message the protocol can never accept would fail forever.
      if (text.length > MAX_MESSAGE_CHARS)
        throw new TalosClientError(
          'too_large',
          `That message is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}.`,
        )
      if (requireLive && !(store.getState().devicePinned && c.canSend()))
        throw new NotSentError('mac_offline', "You're offline.")
      const clientMsgId = newId('m')
      const owned = attachments.map(c.ownerAttachment)
      c.upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'text',
        text,
        format: 'plain',
        attachments,
        ...(replyTo ? { reply_to: replyTo } : {}),
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      const fields: Record<string, unknown> = { text, attachments: owned }
      if (replyTo) fields.reply_to = replyTo
      if (intent) fields.intent = intent
      if (runBlock) fields.run_block = runBlock
      if (runWhere) fields.run_where = runWhere
      try {
        return await c.enqueue('message', threadId, clientMsgId, fields)
      } catch (e) {
        // Nothing was queued: the row shown for it goes too, and the caller gets the words back.
        set((st) => ({
          messages: { ...st.messages, [threadId]: c.rowsOf(st.messages, threadId).filter((m) => m.id !== clientMsgId) },
        }))
        throw e
      }
    },
  }
}
