// Writing one outbox entry to the socket: re-signing an old frame, the failure messages, and the rule for a message
// that may already be delivered.
import { newUlid, ORIGINAL_TS_FEATURE, RUN_MAX_AGE_MS, signOwnerFrame } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import { DEDUPE_WINDOW_MS, MEDIA_KEPT_MS, MediaGoneError, RESIGN_AFTER_MS, RunStaleError } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { OutboxEntry } from './socket-types.ts'

export function createOutboxSend(c: SocketCtx) {
  const { discarding, queueKeptAt, signedTs, storage, store, writtenOn } = c

  /**
   * Signs again if old, saves the written mark and writes to the socket, as one step under the message's lock. Nothing is
   * written if the message was discarded or acked meanwhile. True when it went to the socket.
   */
  function sendEntry(clientMsgId: string, began: number, restartOf?: (cur: OutboxEntry) => boolean): Promise<boolean> {
    return c.withEntryLock(clientMsgId, async () => {
      // Another flush wrote it while this one waited for the lock: not a second time on the same socket (a tap on retry is the exception).
      if (!restartOf && writtenOn.get(clientMsgId) === c.connection) return true
      const cur = c.outbox.find((x) => x.clientMsgId === clientMsgId)
      if (c.epoch !== began || !cur || discarding.has(clientMsgId)) return false
      const fresh = await freshEntry(cur, restartOf?.(cur) ?? false, began)
      if (discarding.has(clientMsgId)) return false
      const marked = await c.markWritten(fresh, began)
      if (c.epoch !== began || !c.canSend() || discarding.has(clientMsgId)) return false
      c.ws?.send(marked.bytes)
      writtenOn.set(clientMsgId, c.connection)
      return true
    })
  }

  /** A send that could not be prepared: a voice note whose recording is gone cannot be fixed by trying again. */
  function sendFailed(e: OutboxEntry, err: unknown) {
    if (err instanceof MediaGoneError) {
      c.markFailed(e.clientMsgId, 'final')
      c.addSystemRow(
        'A voice note waited too long to send and its recording is no longer on the server. Discard it and record it again.',
        `media_gone_${e.clientMsgId}`,
        e.threadId,
      )
      return
    }
    if (err instanceof RunStaleError) {
      c.markFailed(e.clientMsgId, 'final')
      // A Run that was written to a socket before may have reached the Mac and run; one that never was did not.
      c.addSystemRow(
        err.written
          ? 'A Run waited more than a day and its delivery was never confirmed, so it may already have run. Check before you ask for it again.'
          : 'A Run waited more than a day and was not sent. If you still want it, ask your agent to post the script again.',
        `run_stale_${e.clientMsgId}`,
        e.threadId,
      )
      return
    }
    c.markFailed(e.clientMsgId, 'retry')
  }

  function holdAsAmbiguous(e: OutboxEntry) {
    c.markFailed(e.clientMsgId, 'retry')
    c.addSystemRow(
      'A message was not sent again on its own: it may already have been delivered, and Talos can no longer check. Tap it to send it again.',
      `ambiguous_${e.clientMsgId}`,
      e.threadId,
    )
  }

  /** True when this entry was written to a socket (or may have been) longer ago than the relay and the Mac remember ids. */
  function mayAlreadyBeDelivered(e: OutboxEntry): boolean {
    if (e.kind === 'voice.ask' || e.writtenAt === null) return false // never written: nothing can have been delivered
    // an older build did not record it: the signing time is the earliest it could have been written
    const wrote = e.writtenAt === undefined ? c.signedAtOf(e.bytes) : e.writtenAt
    return Number.isFinite(wrote) ? Date.parse(signedTs()) - wrote > DEDUPE_WINDOW_MS : true
  }

  /**
   * The Mac refuses a signature older than 8 days. A message that waited that long (a session that expired while the
   * phone sat idle, say) is signed again, with a new frame id and time but the same client message id, by the same device
   * key, before it is sent. The relay and the Mac both drop a repeat of a client message id, so a message the Mac already
   * has is not delivered twice. Anything younger goes out with its original bytes.
   */
  async function freshEntry(e: OutboxEntry, restart: boolean, began: number): Promise<OutboxEntry> {
    if (e.kind === 'voice.ask') return e
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(e.bytes) as Record<string, unknown>
    } catch {
      return e
    }
    const signedAt = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN
    // The recording was uploaded before this was first signed; the relay deletes media after BUFFER_DAYS, and sending it
    // would point the Mac at nothing. It is shown as failed instead. A note signed again has a new `ts`, so its age is
    // counted from `original_ts` (the first signing) when it has one, and this runs before the early return below.
    const firstSigned = typeof parsed.original_ts === 'string' ? Date.parse(parsed.original_ts) : Number.NaN
    const mediaAt = Number.isFinite(firstSigned) ? firstSigned : signedAt
    if (parsed.type === 'voice_note' && Number.isFinite(mediaAt) && Date.parse(signedTs()) - mediaAt >= MEDIA_KEPT_MS)
      throw new MediaGoneError()
    // Same clock-free rule: the age is the saved frame's own first signing time, so a reload cannot reset it.
    if (
      parsed.type === 'message' &&
      parsed.intent === 'run' &&
      Number.isFinite(mediaAt) &&
      Date.parse(signedTs()) - mediaAt >= RUN_MAX_AGE_MS
    )
      throw new RunStaleError(e.writtenAt !== null)
    if (!Number.isFinite(signedAt) || (!restart && Date.parse(signedTs()) - signedAt < RESIGN_AFTER_MS)) return e
    const k = await c.ensureKey()
    if (parsed.device_id !== k.deviceId) return e // another identity's frame is never signed as this one
    const { osig: _old, original_ts: firstWritten, ...rest } = parsed
    // The Mac reads `ts` as when this was signed. A Mac that lists the feature also gets when the words were first written
    // (kept through every later re-sign); an older one would refuse the unknown field, so it gets none.
    const original = typeof firstWritten === 'string' ? firstWritten : parsed.ts
    const tellsOriginal = store.getState().presence.features?.includes(ORIGINAL_TS_FEATURE)
    const signed = await signOwnerFrame(
      { ...rest, id: newUlid(), ts: signedTs(), ...(tellsOriginal ? { original_ts: original } : {}) } as never,
      k.privateKey,
    )
    // The dedupe memory counts from the first write, so a normal re-sign keeps it; the owner's tap on a message that may
    // already be delivered starts over (that memory is gone), as a message never written.
    const next: OutboxEntry = {
      ...e,
      id: (signed as { id: string }).id,
      bytes: JSON.stringify(signed),
      // an older build's entry keeps counting from when it was signed, not from this re-sign
      ...(restart ? { writtenAt: null } : e.writtenAt === undefined ? { writtenAt: signedAt } : {}),
    }
    if (c.epoch !== began) throw new TalosClientError('internal', 'Signed out')
    await storage.put('outbox', next.id, next) // the new row is saved before the old one goes
    if (c.epoch !== began) {
      // A sign-out drops the new row; an expired session keeps the message, so the new row replaces the old one.
      await storage.del('outbox', queueKeptAt.get(began) ? e.id : next.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    c.outbox = c.outbox.map((x) => (x.id === e.id ? next : x))
    await storage.del('outbox', e.id).catch(() => {})
    return next
  }

  c.holdAsAmbiguous = holdAsAmbiguous
  c.mayAlreadyBeDelivered = mayAlreadyBeDelivered
  c.sendEntry = sendEntry
  c.sendFailed = sendFailed
}
