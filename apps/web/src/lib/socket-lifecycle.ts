// The page coming and going: online/offline, the app brought to the front (wake probe), and the activity report.
import { newId } from '@talos-app/protocol'
import { NoAnswerError } from './client.ts'
import { ACTIVITY_REPORT_MS, WAKE_PROBE_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function createSocketLifecycle(c: SocketCtx) {
  const { isVisible, meta, now, set, setMeta } = c

  function onOnline() {
    setMeta({ networkOffline: false })
    c.client.reconnect()
  }
  function onOffline() {
    setMeta({ networkOffline: true })
    set(() => ({ connection: 'offline' }))
    // Close the zombie socket so sends queue now instead of claiming "sent" until the ping times out.
    if (c.retryTimer) clearTimeout(c.retryTimer)
    c.retryTimer = null
    const s = c.ws
    c.ws = null
    c.ready = false
    c.stopPing()
    c.rejectAllPending(new NoAnswerError('internal', 'Offline'))
    try {
      s?.close()
    } catch {}
  }
  function onVisibility() {
    c.lastReportAt = now()
    c.send({ type: 'visibility', state: isVisible() ? 'visible' : 'hidden' })
    if (!isVisible() || c.closed) return
    // Coming back to the front: a phone that slept can hold a dead socket for ~25 s (until the next ping). Ask now, and
    // if nothing answers within a couple of seconds, drop it and reconnect. No socket and a retry pending: retry now.
    if (!c.ws) {
      // A session that was refused stays stopped: foregrounding must not start new refused attempts.
      if (meta.getState().authFailed) return
      if (c.retryTimer) clearTimeout(c.retryTimer)
      c.retryTimer = null
      c.attempt = 0
      c.connect()
      return
    }
    if (!c.canSend()) return
    const sock = c.ws
    const askedAt = c.pongs
    if (c.wakeTimer) clearTimeout(c.wakeTimer)
    c.send({ type: 'ping', nonce: newId('m').slice(2, 14) })
    c.wakeTimer = setTimeout(() => {
      c.wakeTimer = null
      if (c.ws !== sock || c.pongs > askedAt) return
      try {
        sock.close()
      } catch {}
      // A dead socket may not finish closing for a long time: run the close path ourselves (it ignores a later real one).
      sock.onclose?.({ code: 4000 } as CloseEvent)
    }, WAKE_PROBE_MS)
  }
  /** Pointer, key, touch or wheel while the screen is showing: tell the relay someone is here (at most once per ACTIVITY_REPORT_MS). */
  function onActivity() {
    if (!isVisible() || now() - c.lastReportAt < ACTIVITY_REPORT_MS) return
    // Only the presence frame: the wake probe in onVisibility is for coming back to the front, not for every tap.
    c.lastReportAt = now()
    c.send({ type: 'visibility', state: 'visible' })
  }

  c.onActivity = onActivity
  c.onOffline = onOffline
  c.onOnline = onOnline
  c.onVisibility = onVisibility
}
