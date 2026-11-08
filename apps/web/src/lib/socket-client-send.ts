// The client methods that send, retry and discard messages.

import { newId } from '@talos-app/protocol'
import { TalosClientError, type VoiceAskArgs } from './client.ts'
import { MAX_MESSAGE_CHARS, overFrameLimit } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { PendingVoice, SocketClient } from './socket-types.ts'

export function createClientSend(
  c: SocketCtx,
): Pick<
  SocketClient,
  | 'outboxSize'
  | 'retryMessage'
  | 'discardMessage'
  | 'fetchMedia'
  | 'reportPresence'
  | 'onFrame'
  | 'sendMessage'
  | 'sendVoiceNote'
  | 'queueVoiceNote'
  | 'sendVoiceAsk'
> {
  const { discarding, listeners, now, queueKeptAt, set, storage, store, uploadFailures } = c
  return {
    outboxSize: () => c.outbox.length + c.voiceQueue.length,
    retryMessage(clientMsgId) {
      // A voice note that failed to upload: it starts over with a full set of tries.
      if (c.voiceQueue.some((x) => x.clientMsgId === clientMsgId)) {
        uploadFailures.delete(clientMsgId)
        c.clearFailed(clientMsgId)
        c.refreshQueued()
        void c.flushOutbox()
        return
      }
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
          const v = c.voiceQueue.find((x) => x.clientMsgId === clientMsgId)
          if (v) {
            c.voiceQueue = c.voiceQueue.filter((x) => x.clientMsgId !== clientMsgId)
            uploadFailures.delete(clientMsgId)
            await storage.del('blobs', clientMsgId)
          }
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
    reportPresence() {
      c.onActivity()
    },
    onFrame(type, listener) {
      const s = listeners.get(type) ?? new Set()
      s.add(listener as never)
      listeners.set(type, s)
      return () => void s.delete(listener as never)
    },
    async sendMessage({ threadId, text, attachments = [], replyTo, intent, runBlock }) {
      // Checked before anything is stored: a retry of a message the protocol can never accept would fail forever.
      if (text.length > MAX_MESSAGE_CHARS)
        throw new TalosClientError(
          'too_large',
          `That message is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}.`,
        )
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
    async sendVoiceNote({ threadId, attachment }) {
      const clientMsgId = newId('m')
      c.upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [attachment],
        transcript: { text: '', engine: '', status: 'pending' },
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      try {
        return await c.enqueue('voice_note', threadId, clientMsgId, { attachment: c.ownerAttachment(attachment) })
      } catch (e) {
        // Nothing was queued: the row shown for it goes too, so there is no note that looks sent but is not.
        set((st) => ({
          messages: { ...st.messages, [threadId]: c.rowsOf(st.messages, threadId).filter((m) => m.id !== clientMsgId) },
        }))
        throw e
      }
    },
    async queueVoiceNote({ threadId, blob, durationMs, waveform, name }) {
      const clientMsgId = newId('m')
      const began = c.epoch
      const owner = await c.ensureKey()
      const entry: PendingVoice = {
        deviceId: owner.deviceId,
        createdAt: new Date(now()).toISOString(),
        clientMsgId,
        threadId,
        mime: blob.type,
        name,
        blob,
        order: ++c.outboxOrder,
        ...(durationMs ? { durationMs } : {}),
        ...(waveform ? { waveform } : {}),
      }
      // Saved before it joins the queue or shows a row: a recording that could not be saved says so (the caller sees the
      // throw) and never turns up later on its own.
      if (c.epoch !== began || (c.closed && !queueKeptAt.get(c.epoch - 1)))
        throw new TalosClientError('internal', 'Signed out')
      try {
        await storage.put('blobs', clientMsgId, entry)
      } catch (e) {
        await storage.del('blobs', clientMsgId).catch(() => {})
        throw e
      }
      if (c.epoch !== began) {
        await storage.del('blobs', clientMsgId).catch(() => {})
        throw new TalosClientError('internal', 'Signed out')
      }
      c.voiceQueue.push(entry)
      c.upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      c.refreshQueued()
      void c.flushOutbox()
      return { clientMsgId, state: c.sendState() }
    },
    async sendVoiceAsk(args: VoiceAskArgs) {
      return c.enqueue('voice.ask', args.threadId, args.delegationId, {
        voice_session_id: args.voiceSessionId,
        delegation_id: args.delegationId,
        thread_id: args.threadId,
        question: args.question,
        transcript_tail: args.transcriptTail,
      })
    },
  }
}
