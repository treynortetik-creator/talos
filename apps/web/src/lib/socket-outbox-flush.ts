// The flush: offline voice notes are uploaded and signed first, then every queued frame goes out in order.

import { HttpError } from './http.ts'
import { overFrameLimit, TERMINAL_UPLOAD, VOICE_UPLOAD_TRIES } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function createOutboxFlush(c: SocketCtx) {
  const { discarding, meta, storage, store, uploadFailures, voiceRetryMs, writtenOn } = c

  /** A flush on a timer: a good socket may never reconnect, so a step that failed would otherwise wait for one. */
  function scheduleFlushRetry() {
    if (c.closed) return
    if (c.voiceRetryTimer) clearTimeout(c.voiceRetryTimer)
    c.voiceRetryTimer = setTimeout(() => {
      c.voiceRetryTimer = null
      c.round++
      void flushOutbox()
    }, voiceRetryMs)
  }

  /** The next voice note this flush has not looked at, that is not failed and was not already tried in this round. */
  const nextVoice = (seen: Set<string>) =>
    c.voiceQueue.find(
      (v) =>
        !seen.has(v.clientMsgId) &&
        !meta.getState().failed[v.clientMsgId] &&
        uploadFailures.get(v.clientMsgId)?.round !== c.round,
    )

  /** Notes an upload failure; true when it was the last try, and the note should be shown as failed. */
  function uploadFailed(clientMsgId: string, onConnection: number): boolean {
    const before = uploadFailures.get(clientMsgId)
    const count = (before?.connection === onConnection ? before.count : 0) + 1
    uploadFailures.set(clientMsgId, { connection: onConnection, count, round: c.round })
    return count >= VOICE_UPLOAD_TRIES
  }

  async function flushOutbox() {
    if (c.flushing) {
      c.flushAgain = true
      return
    }
    if (!c.canSend() || !store.getState().devicePinned) return
    c.flushing = true
    const began = c.epoch
    const onConnection = c.connection
    try {
      // Offline voice notes first need their upload and signature; they keep their place by `order`. The queue is read
      // again after each one, so a note queued while another uploads is picked up by this same flush.
      const seen = new Set<string>()
      for (let v = nextVoice(seen); v; v = nextVoice(seen)) {
        seen.add(v.clientMsgId)
        try {
          const att = await c.uploadMediaNow(v.blob, {
            name: v.name,
            ...(v.durationMs ? { durationMs: v.durationMs } : {}),
            ...(v.waveform ? { waveform: v.waveform } : {}),
          })
          if (c.epoch !== began) return // signed out during the upload: the queue is gone, write nothing
          const stored = await c.withEntryLock(v.clientMsgId, async () => {
            if (discarding.has(v.clientMsgId) || !c.voiceQueue.some((x) => x.clientMsgId === v.clientMsgId))
              return false
            const signed = await c.signAndStore(
              'voice_note',
              v.threadId,
              v.clientMsgId,
              { attachment: c.ownerAttachment(att) },
              v.order,
            )
            if (c.epoch !== began) {
              // A close that keeps the queue landed while this was signed: the row would point at an upload the relay sweeps
              // after a week, and the recording is the only copy on this device. Drop the row and keep the recording; the
              // next sign-in uploads it again.
              await storage.del('outbox', signed.id).catch(() => {})
              return false
            }
            c.voiceQueue = c.voiceQueue.filter((x) => x.clientMsgId !== v.clientMsgId)
            await storage.del('blobs', v.clientMsgId)
            return true
          })
          uploadFailures.delete(v.clientMsgId)
          if (stored) c.patchMessage(v.clientMsgId, (m) => ({ ...m, attachments: [att] }))
        } catch (e) {
          if (c.epoch !== began) return
          if (e instanceof HttpError && TERMINAL_UPLOAD.has(e.status)) {
            // A permanent refusal (400/413/415): retrying can never work, so stop and say so.
            c.voiceQueue = c.voiceQueue.filter((x) => x.clientMsgId !== v.clientMsgId)
            uploadFailures.delete(v.clientMsgId)
            await storage.del('blobs', v.clientMsgId)
            c.markFailed(v.clientMsgId, 'final')
            continue
          }
          // Network error, 429, 5xx, a recording that cannot be read: this note waits for the next round (the next ready or
          // the timer below) and the others go on. Each try that ends with the socket still the same one counts; after
          // VOICE_UPLOAD_TRIES the note is shown as failed with Retry and Delete, keeping its recording, and the text
          // behind it is released.
          if (c.canSend() && c.connection === onConnection && uploadFailed(v.clientMsgId, onConnection))
            c.markFailed(v.clientMsgId, 'retry')
        }
      }
      c.refreshQueued()
      for (const e of c.outbox.slice().sort((a, b) => a.order - b.order)) {
        if (!c.canSend()) break
        if (meta.getState().failed[e.clientMsgId]) continue // waits for the owner's tap
        if (writtenOn.get(e.clientMsgId) === c.connection) continue // already on this connection, waiting for its ack
        // Behind a voice note in its thread that has not uploaded: it goes after it, in the order the owner made them.
        if (c.holdsForVoice(e)) continue
        // A frame the relay would drop the connection over (1009) is never sent: an old build could have stored one, and it
        // would otherwise reconnect-and-resend in a loop that blocks every message behind it.
        if (overFrameLimit(e.bytes)) {
          c.markFailed(e.clientMsgId, 'final')
          continue
        }
        // Written before, never acked, and old enough that the dedupe memory is gone: sending it again could reach the agent
        // twice, and not sending it would lose it. So it waits for the owner, who is told, and a tap sends it again.
        if (c.mayAlreadyBeDelivered(e)) {
          c.holdAsAmbiguous(e)
          continue
        }
        try {
          await c.sendEntry(e.clientMsgId, began)
        } catch (err) {
          if (c.epoch !== began) return
          c.sendFailed(e, err) // could not re-sign or save it: shown as failed, tap to try again
          continue
        }
        if (c.epoch !== began) return
      }
    } finally {
      c.flushing = false
      // A flush asked for while this one ran is for the connection that is current now, even if this one began before a
      // close and a start: it must not be dropped with the old epoch.
      if (c.flushAgain) {
        c.flushAgain = false
        void flushOutbox()
      } else if (
        c.epoch === began &&
        !c.voiceRetryTimer &&
        c.voiceQueue.some((v) => !meta.getState().failed[v.clientMsgId])
      ) {
        scheduleFlushRetry() // a note still to upload: the next ready may be far off
      }
    }
  }

  c.flushOutbox = flushOutbox
  c.scheduleFlushRetry = scheduleFlushRetry
}
