// The signed outbox, loaded and kept: reading the saved queue at start, giving waiting messages their rows back,
// dropping an acked entry, the per-message lock, and the written mark.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { isArchivedVoice } from './archivedVoice.ts'
import { TalosClientError } from './client.ts'
import { ACKED_REFS_MAX, INBOX_QUEUE } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { InboxPatch, OutboxEntry } from './socket-types.ts'
import { signedFor } from './unsent.ts'

/** The line shown when a voice note that was waiting to be sent is removed on start (voice input is archived). */
export const VOICE_NOTE_REMOVED_NOTE = 'An unsent voice note was removed (voice notes are off)'

export function createOutboxQueue(c: SocketCtx) {
  const { entryLocks, now, queueKeptAt, storage, store, writtenOn } = c

  // ---- outbox --------------------------------------------------------------------------------------------------
  /**
   * Reads the saved queue. With a known device, only what that device signed is kept: a different sign-in proves a
   * different identity, and its waiting messages are removed rather than sent as this one (the owner is told).
   */
  async function loadOutbox(deviceId?: string) {
    const stored = await storage.all<OutboxEntry | { id: string; kind: string }>('outbox')
    // Voice input is archived (docs/archived/voice.md): a voice note or live-call question that an older build left in the
    // queue, or a recording it left waiting to upload, is never sent. They are removed, with one line saying so.
    const removed = await dropArchivedVoice(stored)
    let foreign = 0
    const mine: OutboxEntry[] = []
    for (const e of stored as OutboxEntry[]) {
      if (isArchivedVoice(e)) continue
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
    c.outboxOrder = Math.max(0, ...c.outbox.map((e) => e.order))
    restoreRows()
    c.refreshQueued()
    if (foreign > 0) noticeRemoved(foreign)
    if (removed > 0) c.addSystemRow(VOICE_NOTE_REMOVED_NOTE, newId('m'))
  }
  /**
   * Deletes the archived voice entries from the saved queue (and the recordings kept for upload), and takes the rows shown
   * for the notes out of the timeline. Returns how many voice notes (not live-call questions) there were.
   */
  async function dropArchivedVoice(stored: Array<{ id: string; kind: string }>): Promise<number> {
    const ids = new Set<string>()
    for (const e of stored) {
      if (!isArchivedVoice(e)) continue
      await storage.del('outbox', e.id)
      const id = (e as Partial<OutboxEntry>).clientMsgId
      if (e.kind === 'voice_note' && id) ids.add(id)
    }
    for (const v of await storage.all<{ clientMsgId: string }>('blobs')) {
      await storage.del('blobs', v.clientMsgId)
      ids.add(v.clientMsgId)
    }
    if (ids.size > 0)
      c.set((st) => ({
        messages: Object.fromEntries(
          Object.entries(st.messages).map(([t, list]) => [t, list.filter((m) => !ids.has(m.id))]),
        ),
      }))
    return ids.size
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
   * After a session expired the cached chats were cleared, but the queue was kept: give every waiting message
   * its row back, so the owner can see it, and tap to retry one that fails.
   */
  function restoreRows() {
    const have = (threadId: string, id: string) =>
      c.rowsOf(store.getState().messages, threadId).some((m) => m.id === id)
    for (const e of c.outbox) {
      if (have(e.threadId, e.clientMsgId)) continue
      try {
        const f = JSON.parse(e.bytes) as Record<string, unknown>
        c.upsertMessage({
          id: e.clientMsgId,
          thread_id: e.threadId,
          author: 'owner',
          format: 'plain',
          via: 'app',
          created_at: typeof f.ts === 'string' ? f.ts : new Date(now()).toISOString(),
          kind: 'text',
          text: typeof f.text === 'string' ? f.text : '',
          attachments: Array.isArray(f.attachments) ? (f.attachments as AttachmentRefT[]) : [],
          ...(typeof f.reply_to === 'string' ? { reply_to: f.reply_to } : {}),
        } as MessageT)
      } catch {}
    }
  }
  async function dropFromOutbox(frameId: string) {
    const e = c.outbox.find((x) => x.id === frameId)
    if (!e) return
    c.outbox = c.outbox.filter((x) => x.id !== frameId)
    // The screen follows memory at once; the stored copy goes after. Under load an IndexedDB delete took over 10 s, and a
    // message waiting on it still showed as queued. (A reload before the delete lands sends the stored copy again, and the
    // relay and the Mac drop a repeat of its client message id.)
    c.refreshQueued()
    await storage.del('outbox', frameId)
  }

  async function onAcked(frameId: string) {
    if (c.inboxSettled(frameId)) return
    const e = c.outbox.find((x) => x.id === frameId)
    // Before the storage write below: the Mac's refusal can be the very next frame, and must find the row.
    if (e) {
      c.ackedRefs.set(frameId, { clientMsgId: e.clientMsgId, threadId: e.threadId })
      // Oldest out first. Past this, or after a reload, the relay's own stored row is what tells the owner.
      for (const k of c.ackedRefs.keys()) {
        if (c.ackedRefs.size <= ACKED_REFS_MAX) break
        c.ackedRefs.delete(k)
      }
    }
    // the row's receipt first, like the queue: neither waits on the storage delete
    if (e) writtenOn.delete(e.clientMsgId)
    if (e) c.patchMessage(e.clientMsgId, (m) => (m.receipt ? m : { ...m, receipt: 'sent' }))
    await dropFromOutbox(frameId)
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
    if (typeof e.writtenAt === 'number') return e
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

  c.dropFromOutbox = dropFromOutbox
  c.loadOutbox = loadOutbox
  c.markWritten = markWritten
  c.noticeRemoved = noticeRemoved
  c.onAcked = onAcked
  c.signedAtOf = signedAtOf
  c.withEntryLock = withEntryLock
}
