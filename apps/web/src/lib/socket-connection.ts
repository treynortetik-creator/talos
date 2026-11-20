// The WebSocket: connect, hello/ready, ping and pong, reconnect backoff, the session probe, and the wire send
// helper.
import { newId, newUlid, parseFrame, WIDE_FEATURES_FEATURE, WS_CLOSE } from '@talos-app/protocol'
import { NoAnswerError, TalosClientError } from './client.ts'
import { endReasonOf, HttpError } from './http.ts'
import { MAX_CLOCK_OFFSET_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import { unknownOfFrame, unknownOfOpenCards, unknownOfParsed, unknownOfReady } from './unknownFrames.ts'

/** Why the link drops, for the console (owner, 2026-11-15): every close with its code and reason, counted for this page. */
const drops = { count: 0, codes: {} as Record<number, number>, since: Date.now() }
function noteDrop(code: number, reason: string, wasReady: boolean) {
  drops.count += 1
  drops.codes[code] = (drops.codes[code] ?? 0) + 1
  const mins = Math.max(1, Math.round((Date.now() - drops.since) / 60_000))
  console.info(
    `[talos] relay link closed: code ${code}${reason ? ` (${reason})` : ''}${wasReady ? '' : ', before it was ready'}; ${drops.count} drop(s) in ${mins} min`,
    drops.codes,
  )
  ;(globalThis as { __talosDrops?: typeof drops }).__talosDrops = drops
}

/** How long after a 1012 close the client keeps retrying on the short delay before the normal backoff resumes. */
const RESTART_WINDOW_MS = 30_000

export function createSocketConnection(c: SocketCtx) {
  const { WS, baseMs, http, info, isOnline, isVisible, maxMs, now, pending, rnd, set, setMeta, store } = c

  const canSend = () => c.ws?.readyState === WS?.OPEN && c.ready

  // ---- sockets -------------------------------------------------------------------------------------------------
  function send(fields: Record<string, unknown>) {
    if (!canSend()) return
    c.ws?.send(JSON.stringify({ v: 1, id: newUlid(), ts: new Date(now()).toISOString(), ...fields }))
  }

  function wsUrl(): string {
    if (c.opts.wsUrl) return c.opts.wsUrl
    const l = location
    return `${l.protocol === 'https:' ? 'wss:' : 'ws:'}//${l.host}/ws`
  }

  function connect() {
    if (c.closed || !WS || !c.key || c.ws) return
    if (!isOnline()) {
      set(() => ({ connection: 'offline' }))
      setMeta({ networkOffline: true })
      return
    }
    setMeta({ networkOffline: false, retryAt: null })
    set(() => ({ connection: 'connecting' }))
    const sock = new WS(wsUrl())
    c.ws = sock
    c.ready = false
    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          v: 1,
          type: 'hello',
          id: newUlid(),
          ts: new Date(now()).toISOString(),
          role: 'app',
          device_id: c.key?.deviceId,
          last_seq: store.getState().lastSeq,
          visible: isVisible(),
          // this build reads a features list of up to FEATURES_MAX: the relay then sends the bridge's whole list
          client: { ...info, features: [WIDE_FEATURES_FEATURE] },
        }),
      )
    }
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(ev.data)
      } catch {
        return
      }
      const res = parseFrame(raw, { direction: 'relay_to_app' })
      if (!res.ok) {
        c.noteUnknown(unknownOfFrame(raw))
        return
      }
      const frame = res.frame
      c.noteUnknown(unknownOfParsed(raw)) // an error code from a newer build: delivered as 'internal', still noted (O5)
      if (frame.type === 'ping') {
        send({ type: 'pong', nonce: frame.nonce })
        return
      }
      if (frame.type === 'pong') {
        c.lastPong = now()
        c.pongs++
        return
      }
      if (frame.type === 'ready') {
        const relayNow = Date.parse(frame.ts)
        if (Number.isFinite(relayNow)) {
          const off = relayNow - now()
          // Clamped: `ready.ts` is the relay's word, and the Mac's window is only 5 min wide, so a relay that lied about
          // the time could otherwise choose where inside the window (days ahead) a signature falls.
          c.clockOffset =
            Math.abs(off) < 30_000 ? 0 : Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, off))
          // The screens read it from the store: a card's expiry is the relay's time, not this device's.
          if ((store.getState().clockOffset ?? 0) !== c.clockOffset) set(() => ({ clockOffset: c.clockOffset }))
        }
        c.ready = true
        c.connection++
        c.attempt = 0
        c.restartUntil = 0
        c.lastPong = now()
        set(() => ({ connection: 'online' }))
        setMeta({ retryAt: null, authFailed: false, authReason: null, lastCloseCode: null })
        c.dispatch(frame)
        // After dispatch: the frame's threads are stored, so a card in one of them is filed there on the first connect too.
        for (const u of unknownOfOpenCards(raw)) c.noteUnknown(u)
        for (const u of unknownOfReady(raw, frame)) c.noteUnknown(u) // a thread, status or session field left out
        for (const [eventId, patch] of c.inboxQueue) c.applyInboxPatch(eventId, patch) // the snapshot predates them
        c.readsOnReady(frame) // and the read marks made while the socket was down
        startPing(frame.policy.ping_ms)
        void c.flushOutbox()
        c.flushInbox()
        c.flushMediaFetches()
        return
      }
      c.dispatch(frame)
    }
    sock.onclose = (ev) => {
      // Every frame the relay sent on it has arrived: an inbox change still unanswered there goes out again. Not for the
      // close the wake probe runs by hand: that socket may still be open, and its grace covers it.
      if (c.closedByHand.has(sock)) c.closedByHand.delete(sock)
      else c.inboxSocketClosed(sock)
      if (c.ws !== sock) return
      const wasReady = c.ready
      c.ws = null
      socketGone(sock)
      if (c.closed) return
      setMeta({ lastCloseCode: ev.code })
      noteDrop(ev.code, ev.reason, wasReady)
      if (ev.code === 4401 || ev.code === 4403) {
        set(() => ({ connection: 'offline' }))
        setMeta({ authFailed: true, authReason: ev.reason ? ev.reason : null })
        return
      }
      // only a socket that was up opens the window: a 1012 at every dial (a proxy, a broken relay) must not redial for ever
      if (ev.code === WS_CLOSE.RESTARTING && wasReady) c.restartUntil = now() + RESTART_WINDOW_MS
      scheduleReconnect()
      // An expired session is refused with HTTP 401 before the upgrade, which a browser only reports as close code 1006.
      if (!wasReady && c.attempt >= 2) void probeSession()
    }
    sock.onerror = () => {}
  }

  /** After repeated refused connections, ask /api/me whether the session is gone; if so stop and flag authFailed. */
  async function probeSession() {
    if (c.probing) return
    c.probing = true
    try {
      await http.get('/api/me')
    } catch (e) {
      if (e instanceof HttpError && e.status === 401 && !c.closed) {
        if (c.retryTimer) clearTimeout(c.retryTimer)
        c.retryTimer = null
        set(() => ({ connection: 'offline' }))
        setMeta({ authFailed: true, authReason: endReasonOf(e.body), retryAt: null })
      }
    } finally {
      c.probing = false
    }
  }

  function startPing(ms: number) {
    stopPing()
    c.pingTimer = setInterval(() => {
      if (!canSend()) return
      if (now() - c.lastPong > ms * 2.5) {
        c.ws?.close()
        return
      }
      send({ type: 'ping', nonce: newId('m').slice(2, 14) })
    }, ms)
  }
  function stopPing() {
    if (c.pingTimer) clearInterval(c.pingTimer)
    c.pingTimer = null
  }

  function scheduleReconnect() {
    if (c.closed) return
    if (c.retryTimer) clearTimeout(c.retryTimer)
    if (!isOnline()) {
      set(() => ({ connection: 'offline' }))
      setMeta({ networkOffline: true, retryAt: null })
      return
    }
    // The relay said 1012 ("restarting", a deploy): it is back in about a second, so for 30 s retry on a short fixed delay
    // that does not grow the backoff and does not show "unreachable".
    const restarting = now() < c.restartUntil
    set(() => ({ connection: restarting ? 'connecting' : 'unreachable' }))
    const delay = restarting ? 250 + rnd() * 500 : Math.min(maxMs, baseMs * 2 ** c.attempt) * (0.75 + rnd() * 0.5)
    if (!restarting) c.attempt++
    setMeta({ retryAt: now() + delay })
    c.retryTimer = setTimeout(() => {
      c.retryTimer = null
      connect()
    }, delay)
  }

  /**
   * The socket is no longer ours (it closed, or `reconnect()` let go of it): no request sent on it will be answered. Every
   * request still waiting hears that now, not after its own timer. An inbox change keeps its place until the socket closes.
   */
  function socketGone(sock: WebSocket | null) {
    c.ready = false
    stopPing()
    c.inboxSocketGone(sock)
    rejectAllPending(new NoAnswerError('internal', 'Connection lost'))
    // A history page is sent back to the socket that asked for it: with that socket gone it will not come. Failing the
    // request also clears what it left behind (the `latestRequests` entry a newest-page request holds until it ends).
    for (const fail of [...c.historyErrors.values()]) fail(new TalosClientError('internal', 'Connection lost'))
  }

  function rejectAllPending(err: Error) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
      pending.delete(id)
    }
  }

  c.canSend = canSend
  c.connect = connect
  c.rejectAllPending = rejectAllPending
  c.send = send
  c.socketGone = socketGone
  c.stopPing = stopPing
}
