// The flush: every queued frame goes out in order.

import { overFrameLimit } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function createOutboxFlush(c: SocketCtx) {
  const { meta, store, flushRetryMs, writtenOn } = c

  /** A flush on a timer: a good socket may never reconnect, so a step that failed would otherwise wait for one. */
  function scheduleFlushRetry() {
    if (c.closed) return
    if (c.flushRetryTimer) clearTimeout(c.flushRetryTimer)
    c.flushRetryTimer = setTimeout(() => {
      c.flushRetryTimer = null
      void flushOutbox()
    }, flushRetryMs)
  }

  /** Sends every queued frame. False when the session ended meanwhile. */
  async function sendQueued(began: number): Promise<boolean> {
    for (const e of c.outbox.slice().sort((a, b) => a.order - b.order)) {
      if (!c.canSend()) break
      if (meta.getState().failed[e.clientMsgId]) continue // waits for the owner's tap
      if (writtenOn.get(e.clientMsgId) === c.connection) continue // already on this connection, waiting for its ack
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
        if (c.epoch !== began) return false
        c.sendFailed(e, err) // could not re-sign or save it: shown as failed, tap to try again
        continue
      }
      if (c.epoch !== began) return false
    }
    return true
  }

  async function flushOutbox() {
    if (c.flushing) {
      c.flushAgain = true
      return
    }
    if (!c.canSend() || !store.getState().devicePinned) return
    c.flushing = true
    const began = c.epoch
    try {
      if (!(await sendQueued(began))) return
      c.refreshQueued()
    } finally {
      c.flushing = false
      // A flush asked for while this one ran is for the connection that is current now, even if this one began before a
      // close and a start: it must not be dropped with the old epoch.
      if (c.flushAgain) {
        c.flushAgain = false
        void flushOutbox()
      }
    }
  }

  c.flushOutbox = flushOutbox
  c.scheduleFlushRetry = scheduleFlushRetry
}
