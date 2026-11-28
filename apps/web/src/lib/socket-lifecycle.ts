// The page coming and going: online/offline, the app back in front or focused (the socket probe), and the activity report.
import { newId, newUlid } from '@talos-app/protocol'
import { NoAnswerError } from './client.ts'
import { ACTIVITY_REPORT_MS, EAGER_DIAL_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function createSocketLifecycle(c: SocketCtx) {
  const { isVisible, meta, now, set, setMeta } = c

  function onOnline() {
    setMeta({ networkOffline: false })
    probeSocket('online')
  }
  function onOffline() {
    setMeta({ networkOffline: true })
    set(() => ({ connection: 'offline' }))
    // Close the zombie socket so sends queue now instead of claiming "sent" until the ping times out.
    if (c.retryTimer) clearTimeout(c.retryTimer)
    c.retryTimer = null
    c.clearLinkTimers()
    const s = c.ws
    c.ws = null
    c.ready = false
    c.stopPing()
    c.rejectAllPending(new NoAnswerError('internal', 'Offline'))
    // Left open while inbox changes sent on it wait for their answer (a closing socket drops every frame); its grace
    // ends the wait if the network is really gone.
    if (!c.inboxLetGo(s))
      try {
        s?.close()
      } catch {}
  }
  function onVisibility() {
    c.lastReportAt = now()
    c.lastPointer = null // the first pointermove after coming back only records where the cursor is
    c.send({ type: 'visibility', state: isVisible() ? 'visible' : 'hidden' })
    if (!isVisible() || c.closed) return
    probeSocket('back')
  }
  function onFocus() {
    if (isVisible()) probeSocket('back')
  }
  /** A page restored from the back-forward cache: its socket was frozen with it. A first load is not one. */
  function onPageShow(e?: Event) {
    if ((e as PageTransitionEvent | undefined)?.persisted) probeSocket('back')
  }

  /**
   * The page came back (online, to the front, focused, restored from the cache): find out whether the link still works, and
   * replace it only if not. A healthy socket is left exactly as it is: no new socket, nothing rejected, nothing written again.
   * A phone that slept can hold a dead socket for ~25 s (until the next ping), so ask now, and if the pong with this ask's
   * nonce is not back within wakeProbeMs (WAKE_PROBE_MS), let go of it and dial at once. Events that arrive together share one probe.
   */
  function probeSocket(reason: 'online' | 'back') {
    if (c.closed) return
    const sock = c.ws
    if (!sock) {
      // A session that was refused stays stopped: coming back must not start new refused attempts.
      if (meta.getState().authFailed) return
      // A retry is already scheduled: focus and visibility events (they come by the dozen in a bad hour) dial at once only
      // every EAGER_DIAL_MS, so an outage gets no dial storm and no /api/me storm. The network coming back always dials.
      if (reason === 'back' && c.retryTimer && now() - c.lastEagerDialAt < EAGER_DIAL_MS) return
      c.lastEagerDialAt = now()
      if (c.retryTimer) clearTimeout(c.retryTimer)
      c.retryTimer = null
      c.connect() // the wait is cut short; the backoff step is kept (only a link that lasts STABLE_MS starts it over)
      return
    }
    if (c.wakeTimer) return // a probe of this socket is already out
    const state = sock.readyState
    // Closing: its real close is on the way, with its code (a 4401 or 4403 must still stop the session). Not ours to cut short.
    if (state === c.WS?.CLOSING || state === c.WS?.CLOSED) return
    if (!c.ready) {
      // Still dialling. It carries nothing, so replacing it loses nothing, but a slow handshake is not a dead one: a trigger
      // may replace a connecting dial only after DIAL_GIVE_UP_MS. An open socket waiting for `ready` is never cut by the page
      // coming back (only 'online' may, after that long); otherwise the dial's own timer (HANDSHAKE_GIVE_UP_MS) ends it.
      if (state === c.WS?.OPEN && reason === 'back') return
      if (now() - c.dialAt >= c.dialGiveUpMs) replaceSocket(sock)
      return
    }
    const nonce = newId('m').slice(2, 14)
    try {
      sock.send(JSON.stringify({ v: 1, id: newUlid(), ts: new Date(now()).toISOString(), type: 'ping', nonce }))
    } catch {
      replaceSocket(sock) // it cannot even carry the ask: dead, never read as fine
      return
    }
    c.probeNonce = nonce
    c.wakeTimer = setTimeout(() => {
      c.wakeTimer = null
      c.probeNonce = null
      if (c.ws !== sock) return // it closed, or was replaced, meanwhile: nothing left to decide
      replaceSocket(sock)
    }, c.wakeProbeMs)
  }

  /**
   * Lets go of a socket that no longer answers and dials a new one now, the way a person's Retry does: the socket is not
   * "closed" (no drop is logged, the backoff step does not grow, nothing flashes "unreachable"), it is replaced.
   */
  function replaceSocket(sock: WebSocket) {
    if (c.ws !== sock || c.closed) return
    c.client.reconnect()
  }
  /**
   * Pointer, key, touch or wheel while the screen is showing: tell the relay someone is here (at most once per
   * ACTIVITY_REPORT_MS). A pointermove counts only when the pointer really moved on the screen: one at the same spot is the
   * page reflowing under a still cursor, and counting it would keep an owner who walked away "here", so the relay would
   * hold the push. The first pointermove (after load, or after the page was hidden) only records where the cursor is.
   */
  function onActivity(e?: Event) {
    if (e?.type === 'pointermove') {
      const p = e as PointerEvent
      const last = c.lastPointer
      c.lastPointer = { x: p.screenX, y: p.screenY }
      // under a sub-pixel: zoom and display scaling can make the same spot fractional
      if (!last || (Math.abs(last.x - p.screenX) < 1 && Math.abs(last.y - p.screenY) < 1)) return
    }
    if (!isVisible() || now() - c.lastReportAt < ACTIVITY_REPORT_MS) return
    // Only the presence frame: the wake probe in onVisibility is for coming back to the front, not for every tap.
    c.lastReportAt = now()
    c.send({ type: 'visibility', state: 'visible' })
  }

  c.onActivity = onActivity
  c.onFocus = onFocus
  c.onPageShow = onPageShow
  c.onOffline = onOffline
  c.onOnline = onOnline
  c.onVisibility = onVisibility
}
