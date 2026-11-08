// The WebSocket: connect, hello/ready, ping and pong, reconnect backoff, the session probe, and the wire send
// helper.
import { newId, newUlid, parseFrame } from '@talos-app/protocol'
import { NoAnswerError } from './client.ts'
import { endReasonOf, HttpError } from './http.ts'
import { MAX_CLOCK_OFFSET_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import { unknownOfFrame, unknownOfOpenCards } from './unknownFrames.ts'

export function createSocketConnection(c: SocketCtx) {
  const { WS, baseMs, http, inboxInFlight, info, isOnline, isVisible, maxMs, now, pending, rnd, set, setMeta, store } =
    c

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
          client: info,
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
        }
        c.ready = true
        c.connection++
        c.round++
        c.attempt = 0
        c.lastPong = now()
        set(() => ({ connection: 'online' }))
        setMeta({ retryAt: null, authFailed: false, authReason: null, lastCloseCode: null })
        c.dispatch(frame)
        // After dispatch: the frame's threads are stored, so a card in one of them is filed there on the first connect too.
        for (const u of unknownOfOpenCards(raw)) c.noteUnknown(u)
        inboxInFlight.clear() // a new connection: nothing sent on the old one will be answered
        for (const [eventId, patch] of c.inboxQueue) c.applyInboxPatch(eventId, patch) // the snapshot predates them
        startPing(frame.policy.ping_ms)
        void c.flushOutbox()
        c.flushInbox()
        c.flushMediaFetches()
        return
      }
      c.dispatch(frame)
    }
    sock.onclose = (ev) => {
      if (c.ws !== sock) return
      const wasReady = c.ready
      c.ws = null
      c.ready = false
      stopPing()
      inboxInFlight.clear()
      rejectAllPending(new NoAnswerError('internal', 'Connection lost'))
      if (c.closed) return
      setMeta({ lastCloseCode: ev.code })
      if (ev.code === 4401 || ev.code === 4403) {
        set(() => ({ connection: 'offline' }))
        setMeta({ authFailed: true, authReason: ev.reason ? ev.reason : null })
        return
      }
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
    set(() => ({ connection: 'unreachable' }))
    const delay = Math.min(maxMs, baseMs * 2 ** c.attempt) * (0.75 + rnd() * 0.5)
    c.attempt++
    setMeta({ retryAt: now() + delay })
    c.retryTimer = setTimeout(() => {
      c.retryTimer = null
      connect()
    }, delay)
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
  c.stopPing = stopPing
}
