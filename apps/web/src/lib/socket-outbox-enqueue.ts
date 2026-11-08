// Putting a new owner frame in the queue: signing it, saving it before it can be sent, and sending it when the
// socket is up.
import { type AttachmentRefT, type DeviceKey, newUlid, OwnerAttachmentRef, signOwnerFrame } from '@talos-app/protocol'
import { type SendResult, TalosClientError } from './client.ts'
import { ensureDeviceKey } from './deviceKey.ts'
import { overFrameLimit } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { OutboxEntry, OutboxKind } from './socket-types.ts'

export function createOutboxEnqueue(c: SocketCtx) {
  const { queueKeptAt, set, signedTs, storage, store } = c

  async function signAndStore(
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
    order = ++c.outboxOrder,
  ): Promise<OutboxEntry> {
    const began = c.epoch
    const k = await ensureKey()
    const frame = {
      v: 1,
      type: kind,
      id: newUlid(),
      ts: signedTs(),
      ...(kind === 'voice.ask' ? {} : { thread_id: threadId, client_msg_id: clientMsgId }),
      ...fields,
      device_id: k.deviceId,
    }
    const signed = await signOwnerFrame(frame, k.privateKey)
    const bytes = JSON.stringify(signed)
    if (overFrameLimit(bytes)) throw new TalosClientError('too_large', 'That is too big to send as a message.')
    // Signed out while this was being signed: nothing may be written to the queue after that. A close that keeps the queue
    // (an expiry) lets the row be saved: it is sent after the next sign-in.
    if (c.epoch !== began && !queueKeptAt.get(began)) throw new TalosClientError('internal', 'Signed out')
    const entry: OutboxEntry = { id: signed.id, order, kind, clientMsgId, threadId, bytes, writtenAt: null }
    // Written before it joins the in-memory queue: a frame that is not saved must not be sent later by a flush, or the
    // owner (told "couldn't send") would retry and the agent would get it twice.
    try {
      await storage.put('outbox', entry.id, entry)
    } catch (e) {
      await storage.del('outbox', entry.id).catch(() => {}) // a write that failed late must not come back after a reload
      throw e
    }
    if (c.epoch !== began) {
      // An expired session keeps the row: it is loaded and sent after the next sign-in (or removed there with a notice if
      // the device key changed), and the closed client reports it as queued (it cannot send). A sign-out's wipe may have
      // run before this write landed: take the row back out.
      if (queueKeptAt.get(began)) return entry
      await storage.del('outbox', entry.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    c.outbox.push(entry)
    c.outbox.sort((a, b) => a.order - b.order)
    c.refreshQueued()
    return entry
  }

  async function ensureKey(): Promise<DeviceKey> {
    c.key ??= await ensureDeviceKey(storage)
    set((s) => (s.deviceId === c.key?.deviceId ? {} : { deviceId: c.key?.deviceId ?? null }))
    return c.key
  }

  function ownerAttachment(a: AttachmentRefT) {
    return OwnerAttachmentRef.parse({
      media_id: a.media_id,
      kind: a.kind,
      role: a.role ?? 'attachment',
      mime: a.mime,
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.waveform !== undefined ? { waveform: a.waveform } : {}),
    })
  }

  function sendState(): SendResult['state'] {
    if (!store.getState().devicePinned) return 'held_unpinned'
    return c.canSend() ? 'sent' : 'queued'
  }

  async function enqueue(
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
  ): Promise<SendResult> {
    const began = c.epoch
    const entry = await signAndStore(kind, threadId, clientMsgId, fields)
    const state = sendState()
    if (state === 'sent') {
      // Behind a voice note that is not on the wire yet: it is queued, and the flush sends both in order.
      if (c.holdsForVoice(entry)) {
        void c.flushOutbox()
        return { clientMsgId, state: 'queued' }
      }
      try {
        if (!(await c.sendEntry(clientMsgId, began))) return { clientMsgId, state: 'queued' }
      } catch {
        // The entry is saved and queued; a write that could not be saved just means it goes out on a later flush.
        // Throwing here would tell the caller "not sent" about a message that will be sent.
        if (c.epoch === began) c.scheduleFlushRetry()
        return { clientMsgId, state: 'queued' }
      }
    }
    return { clientMsgId, state }
  }

  c.enqueue = enqueue
  c.ensureKey = ensureKey
  c.ownerAttachment = ownerAttachment
  c.sendState = sendState
  c.signAndStore = signAndStore
}
