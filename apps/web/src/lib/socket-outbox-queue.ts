// The signed outbox, loaded and kept: reading the saved queue at start, giving waiting messages their rows back,
// dropping an acked entry, the per-message lock, and the written mark.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import { INBOX_QUEUE } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { InboxPatch, OutboxEntry, OutboxKind, PendingVoice } from './socket-types.ts'
import { signedFor } from './unsent.ts'

export function createOutboxQueue(c: SocketCtx) {
  const { entryLocks, meta, now, queueKeptAt, storage, store, writtenOn } = c

  // ---- outbox --------------------------------------------------------------------------------------------------
  /**
   * Reads the saved queue. With a known device, only what that device signed is kept: a different sign-in proves a
   * different identity, and its waiting messages are removed rather than sent as this one (the owner is told).
   */
  async function loadOutbox(deviceId?: string) {
    const stored = await storage.all<OutboxEntry>('outbox')
    // A voice.ask belongs to one live call and a reload ends the call: never resend one from a previous page load.
    for (const e of stored) if (e.kind === 'voice.ask') await storage.del('outbox', e.id)
    let foreign = 0
    const mine: OutboxEntry[] = []
    for (const e of stored) {
      if (e.kind === 'voice.ask') continue
      const who = signedFor(e.bytes)
      if (deviceId !== undefined && who !== null && who !== deviceId) {
        foreign++
        await storage.del('outbox', e.id)
        continue
      }
      mine.push(e)
    }
    c.outbox = mine.sort((a, b) => a.order - b.order)
    try {
      const q = await storage.get<Array<[string, InboxPatch]>>('cache', INBOX_QUEUE)
      c.inboxQueue = new Map(Array.isArray(q) ? q : [])
    } catch {}
    const blobs = (await storage.all<PendingVoice>('blobs')).sort((a, b) => a.order - b.order)
    c.voiceQueue = []
    for (const v of blobs) {
      if (deviceId !== undefined && v.deviceId !== undefined && v.deviceId !== deviceId) {
        foreign++
        await storage.del('blobs', v.clientMsgId)
        continue
      }
      c.voiceQueue.push(v)
    }
    c.outboxOrder = Math.max(0, ...c.outbox.map((e) => e.order), ...c.voiceQueue.map((v) => v.order))
    restoreRows()
    c.refreshQueued()
    if (foreign > 0) noticeRemoved(foreign)
  }
  /** Tells the owner that waiting messages were removed instead of sent (a different sign-in, or a revoked key). */
  function noticeRemoved(n: number) {
    c.addSystemRow(
      `${n === 1 ? '1 message that was waiting was' : `${n} messages that were waiting were`} removed and not sent: ${
        n === 1 ? 'it was' : 'they were'
      } queued under a sign-in that is no longer this one.`,
      newId('m'),
    )
  }
  /**
   * After a session expired the cached chats were cleared, but the queue was kept: give every waiting message and voice
   * note its row back, so the owner can see it, and tap to retry one that fails.
   */
  function restoreRows() {
    const have = (threadId: string, id: string) =>
      c.rowsOf(store.getState().messages, threadId).some((m) => m.id === id)
    for (const e of c.outbox) {
      if (e.kind === 'voice.ask' || have(e.threadId, e.clientMsgId)) continue
      try {
        const f = JSON.parse(e.bytes) as Record<string, unknown>
        const created = typeof f.ts === 'string' ? f.ts : new Date(now()).toISOString()
        const base = {
          id: e.clientMsgId,
          thread_id: e.threadId,
          author: 'owner' as const,
          format: 'plain' as const,
          via: 'app' as const,
          created_at: created,
        }
        if (e.kind === 'message')
          c.upsertMessage({
            ...base,
            kind: 'text',
            text: typeof f.text === 'string' ? f.text : '',
            attachments: Array.isArray(f.attachments) ? (f.attachments as AttachmentRefT[]) : [],
            ...(typeof f.reply_to === 'string' ? { reply_to: f.reply_to } : {}),
          } as MessageT)
        else
          c.upsertMessage({
            ...base,
            kind: 'voice_note',
            attachments: f.attachment ? [f.attachment as AttachmentRefT] : [],
            transcript: { text: '', engine: '', status: 'pending' },
          } as MessageT)
      } catch {}
    }
    for (const v of c.voiceQueue) {
      if (have(v.threadId, v.clientMsgId)) continue
      c.upsertMessage({
        id: v.clientMsgId,
        thread_id: v.threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: v.createdAt ?? new Date(now()).toISOString(),
      })
    }
  }
  async function dropFromOutbox(frameId: string) {
    const e = c.outbox.find((x) => x.id === frameId)
    if (!e) return
    c.outbox = c.outbox.filter((x) => x.id !== frameId)
    await storage.del('outbox', frameId)
    c.refreshQueued()
  }

  async function dropVoiceAsks() {
    for (const e of c.outbox.filter((x) => x.kind === 'voice.ask')) await dropFromOutbox(e.id)
  }
  async function onAcked(frameId: string) {
    if (c.inboxSettled(frameId)) return
    const e = c.outbox.find((x) => x.id === frameId)
    await dropFromOutbox(frameId)
    if (e) writtenOn.delete(e.clientMsgId)
    if (e && e.kind !== 'voice.ask') c.patchMessage(e.clientMsgId, (m) => (m.receipt ? m : { ...m, receipt: 'sent' }))
  }

  function withEntryLock<T>(clientMsgId: string, fn: () => Promise<T>): Promise<T> {
    const run = (entryLocks.get(clientMsgId) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    entryLocks.set(clientMsgId, tail)
    void tail.then(() => {
      if (entryLocks.get(clientMsgId) === tail) entryLocks.delete(clientMsgId)
    })
    return run
  }

  /** When an older build's frame was signed: the earliest it could have been written to a socket. NaN if unreadable. */
  function signedAtOf(bytes: string): number {
    try {
      return Date.parse(String((JSON.parse(bytes) as { ts?: unknown }).ts))
    } catch {
      return Number.NaN
    }
  }

  /**
   * Saves that this entry is about to be written to a socket, before it is. Throws if that cannot be saved (it is then not
   * sent). `began` is the epoch of the caller: a close() since then means nothing may be written, and one that lands during
   * the save takes the row back out only if the close was a sign-out.
   */
  async function markWritten(e: OutboxEntry, began: number): Promise<OutboxEntry> {
    if (e.kind === 'voice.ask' || typeof e.writtenAt === 'number') return e
    if (c.epoch !== began) throw new TalosClientError('internal', 'Signed out')
    // An older build did not record the write: count from the signing time (the earliest it could have happened), not from now.
    const legacy = e.writtenAt === undefined ? signedAtOf(e.bytes) : Number.NaN
    const next: OutboxEntry = { ...e, writtenAt: Number.isFinite(legacy) ? legacy : now() }
    await storage.put('outbox', next.id, next)
    if (c.epoch !== began) {
      // A sign-out takes the row back out; an expired session keeps it, as it was before this mark.
      if (queueKeptAt.get(began)) await storage.put('outbox', e.id, e).catch(() => {})
      else await storage.del('outbox', next.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    c.outbox = c.outbox.map((x) => (x.id === e.id ? next : x))
    return next
  }

  /**
   * A text or voice message waits for an earlier voice note in its thread that is not on the wire yet: still to upload, or
   * uploaded and signed but not written to the current connection (one written to a socket that has since dropped counts as
   * not written: it is sent again on this one, and what follows it waits for that). One that has failed (shown with Retry and Delete) no longer holds
   * anything back. A question in a live call is never held: it belongs to a call that is happening now.
   */
  const holdsForVoice = (e: { kind: OutboxKind; threadId: string; order: number }) =>
    e.kind !== 'voice.ask' &&
    (c.voiceQueue.some(
      (v) => v.threadId === e.threadId && v.order < e.order && !meta.getState().failed[v.clientMsgId],
    ) ||
      c.outbox.some(
        (o) =>
          o.kind === 'voice_note' &&
          o.threadId === e.threadId &&
          o.order < e.order &&
          writtenOn.get(o.clientMsgId) !== c.connection &&
          !meta.getState().failed[o.clientMsgId],
      ))

  c.dropFromOutbox = dropFromOutbox
  c.dropVoiceAsks = dropVoiceAsks
  c.holdsForVoice = holdsForVoice
  c.loadOutbox = loadOutbox
  c.markWritten = markWritten
  c.noticeRemoved = noticeRemoved
  c.onAcked = onAcked
  c.signedAtOf = signedAtOf
  c.withEntryLock = withEntryLock
}
