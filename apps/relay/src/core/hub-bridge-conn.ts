// The bridge socket from first byte to close: the challenge, the signed hello, the size limit, one frame at a time, and what
// a hello and a close change (the old socket superseded, presence, stale statuses, the outbox resend).
// Handlers of the Hub class (hub.ts), which forwards to them. The frame-by-frame work is in hub-bridge-frames.ts.
import {
  type Frame,
  MAX_FRAME_BYTES,
  MAX_FRAME_BYTES_UNAUTH,
  newChallengeNonce,
  newUlid,
  parseFrameText,
  WS_CLOSE,
} from '@talos-app/protocol'
import { bridgeKeyActive, verifyBridgeHello } from '../auth/contract.ts'
import { type BridgeFeatures, noteBridgeMain } from './features.ts'
import { errName } from './hub-helpers.ts'
import type { BridgeConn, Conn, HubDeps } from './hub-types.ts'
import { HANDSHAKE_MS } from './hub-types.ts'
import { mkFrame } from './util.ts'

/** What the bridge-socket handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type BridgeConnCtx = {
  d: HubDeps
  bridgeFeatures: BridgeFeatures
  isStopped(): boolean
  track(h: unknown): void
  getBridge(): BridgeConn | null
  setBridge(b: BridgeConn | null): void
  /** A bridge is back: the session-stopped timer and its "already told" mark are cleared. */
  resetSessionStopped(): void
  armSessionStopped(): void
  /** Runs the onBridgeGone hooks (the session module drops its busy and turn picture). */
  bridgeGone(): void
  /** A hello from `by` replaced the connected bridge. */
  noteSupersede(by: string): void
  /** A verified standby hello came in from `standby`: a replaced bridge that is still alive. */
  noteStandby(standby: string): void
  /**
   * Presence says "superseded" from the moment a replaced bridge is seen alive (its standby hello is turned away) until a
   * hello finds the slot empty. Returns whether the mark changed.
   */
  setSuperseded(on: boolean): boolean
  sendBridge(frame: Record<string, unknown>): void
  ready(forApp: boolean): Record<string, unknown>
  broadcastPresence(): void
  resendAllUnconsumed(): void
  resetStaleStatuses(): void
  clearQueuedTimers(): void
  onBridgeFrameBuiltin(b: BridgeConn, frame: Frame, raw: Record<string, unknown>): Promise<void>
  runBridgeHandlers(keyId: string, frame: Frame, raw: Record<string, unknown>): Promise<void>
}

/**
 * Closes a socket that has not signed in, and marks it so nothing it sends afterwards is read. A close is a handshake:
 * until the peer answers it (or the library gives up, 30 s later) its frames keep arriving, and each one used to be
 * parsed, and a hello among them checked, logged and counted as a failure. One refusal is the end of the socket.
 */
function refuseBridge(b: BridgeConn, code: number): void {
  b.refused = true
  b.conn.close(code)
}

/** The ctx of each hub's bridge sockets, set by its first attachBridge, so a rotation reaches the connected bridge. */
const ctxByDeps = new WeakMap<HubDeps, BridgeConnCtx>()
/** How long after a rotation's 200 the old key's socket is closed: the answer reaches the CLI first. */
export const KEY_ROTATED_CLOSE_DELAY_MS = 1500

/**
 * A rotation made `activeKeyId` the bridge key: a connected bridge that signed in with another key is closed with 1012, which
 * the real bridge answers by dialling straight back with its new key (not with 4409, which would park it as a standby). The
 * close comes after the rotation's answer is on its way, and looks at the socket again when it fires.
 */
export function closeBridgeNotOnKey(d: HubDeps, activeKeyId: string): void {
  const ctx = ctxByDeps.get(d)
  if (!ctx) return // no bridge socket has ever attached
  const h = d.clock.setTimeout(() => {
    const b = ctx.getBridge()
    if (b?.authed && !b.closed && b.keyId !== activeKeyId) b.conn.close(WS_CLOSE.RESTARTING, 'key rotated')
  }, KEY_ROTATED_CLOSE_DELAY_MS)
  ctx.track(h)
}

export const bridgeConnFrames = {
  attachBridge(
    this: BridgeConnCtx,
    conn: Conn,
    args: { ip: string; relayHost: string },
  ): { onMessage(text: string): void; onClose(): void } {
    ctxByDeps.set(this.d, this)
    const b: BridgeConn = {
      id: `b_${newUlid().slice(-10)}`,
      conn,
      ip: args.ip,
      authed: false,
      refused: false,
      closed: false,
      keyId: '',
      lastInbound: this.d.clock.now(),
      handshake: null,
      features: [],
    }
    const nonce = newChallengeNonce()
    const serverTime = Math.floor(this.d.clock.now() / 1000)
    conn.send(
      JSON.stringify(
        mkFrame(this.d.clock, 'challenge', { nonce, server_time: serverTime, relay_host: args.relayHost, protocol: 1 }),
      ),
    )
    b.handshake = this.d.clock.setTimeout(() => {
      if (!b.authed) refuseBridge(b, WS_CLOSE.HANDSHAKE_TIMEOUT)
    }, HANDSHAKE_MS)
    this.track(b.handshake)
    let chain: Promise<void> = Promise.resolve()
    return {
      onMessage: (text) => {
        if (b.refused) return
        b.lastInbound = this.d.clock.now()
        const limit = b.authed ? MAX_FRAME_BYTES : MAX_FRAME_BYTES_UNAUTH
        if (Buffer.byteLength(text) > limit)
          return b.authed ? void conn.close(WS_CLOSE.FRAME_TOO_LARGE) : refuseBridge(b, WS_CLOSE.FRAME_TOO_LARGE)
        chain = chain.then(() =>
          bridgeConnFrames.handleBridgeText
            .call(this, b, text, { nonce, relay_host: args.relayHost, server_time: serverTime })
            .catch((e) => {
              this.d.log.error({ err: errName(e) }, 'bridge frame handler failed')
            }),
        )
      },
      onClose: () => {
        b.closed = true
        if (this.isStopped()) return
        this.d.clock.clearTimeout(b.handshake)
        if (this.getBridge() === b) {
          this.setBridge(null)
          this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
          this.clearQueuedTimers()
          this.resetStaleStatuses()
          this.bridgeGone()
          this.broadcastPresence()
          this.armSessionStopped()
        }
      },
    }
  },

  async handleBridgeText(
    this: BridgeConnCtx,
    b: BridgeConn,
    text: string,
    challenge: { nonce: string; relay_host: string; server_time: number },
  ): Promise<void> {
    // Frames queued behind the one that got this socket refused (they arrived while it was being checked) are dropped too.
    if (b.refused) return
    const parsed = parseFrameText(text, { authenticated: b.authed, direction: 'bridge_to_relay' })
    if (!parsed.ok) {
      const rawId = (parsed.raw as { id?: unknown } | undefined)?.id
      if (!b.authed)
        return refuseBridge(b, parsed.code === 'too_large' ? WS_CLOSE.FRAME_TOO_LARGE : WS_CLOSE.UNAUTHORIZED)
      return this.sendBridge(
        mkFrame(this.d.clock, 'error', {
          ...(typeof rawId === 'string' ? { ref: rawId } : {}),
          code: parsed.code,
          message: parsed.message,
        }),
      )
    }
    const raw = parsed.raw as Record<string, unknown>
    const frame = parsed.frame
    if (!b.authed) {
      if (frame.type !== 'hello' || frame.role !== 'bridge') return refuseBridge(b, WS_CLOSE.UNAUTHORIZED)
      const res = await verifyBridgeHello({
        hello: { key_id: frame.key_id, sig: frame.sig },
        challenge,
        ip: b.ip,
        activeOnly: true,
      })
      if (!res.ok) {
        this.d.log.warn({ ip: b.ip }, 'bridge hello refused')
        return refuseBridge(b, WS_CLOSE.UNAUTHORIZED)
      }
      // The socket may have gone while the signature was being checked: closed by the 10 s handshake deadline, or by the peer.
      // Either way it stays gone; a socket that closed must never become the bridge (it would hold the slot as a ghost).
      if (b.refused || b.closed) return
      // A rotation may have finished while the signature was being checked: the hello must still be the ACTIVE key's, or an
      // old-key socket would replace the real bridge, which has already moved on to the new key.
      if (!bridgeKeyActive(res.keyId)) return refuseBridge(b, WS_CLOSE.UNAUTHORIZED)
      // A bridge that was replaced asks to come back without replacing anyone: while another one is connected it is turned
      // away the way a replaced one is (4409), so two live bridges never trade the slot. With the slot empty it is an
      // ordinary hello.
      const holder = this.getBridge()
      if (frame.standby) this.noteStandby(b.ip)
      if (frame.standby && holder && holder !== b && holder.authed) {
        // A replaced bridge that is still alive proves two bridges use this key (a bridge that only redialled over its own
        // dead socket never asks again): presence says so until a hello finds the slot empty. The push is noteStandby's.
        if (this.setSuperseded(true)) {
          this.d.log.warn(
            { holder_ip: holder.ip, standby_ip: b.ip },
            'two bridges are connected with the same key; the older one waits as a standby',
          )
          this.broadcastPresence()
        }
        return void b.conn.close(WS_CLOSE.SUPERSEDED)
      }
      // The Mac's clock against ours, sampled as it answers our challenge (its hello is sent the moment the challenge
      // arrives): new cards' expiry on the relay is shifted by it (store.putCard). Under 5 s is noise and counts as none.
      const skew = this.d.clock.now() - Date.parse(frame.ts)
      this.d.store.setState('mac_clock_skew_ms', String(Number.isFinite(skew) && Math.abs(skew) >= 5_000 ? skew : 0))
      if (Number.isFinite(skew) && Math.abs(skew) > 120_000)
        this.d.log.warn({ skew_s: Math.round(skew / 1000) }, "the Mac's clock is off; card expiry follows the relay's")
      this.bridgeFeatures.onHello(frame.client.features ?? [], new Date(this.d.clock.now()).toISOString())
      return bridgeConnFrames.bridgeHello.call(this, b, res.keyId, frame.client.features ?? [])
    }
    // The key was checked at hello; it is checked again on every frame (from memory), so a socket opened with a key that has
    // since been rotated out ends at its next frame. The grace is for HTTP calls in flight, not for sockets. It ends with 1012
    // ("come straight back"), not 4401: in the 1.5 s before the rotation's own close this is the REAL bridge, which then redials
    // at once with its new key; a stolen old key gains nothing from it, since a hello needs the active key.
    if (!bridgeKeyActive(b.keyId)) return refuseBridge(b, WS_CLOSE.RESTARTING)
    await this.onBridgeFrameBuiltin(b, frame, raw)
    await this.runBridgeHandlers(b.keyId, frame, raw)
  },

  bridgeHello(this: BridgeConnCtx, b: BridgeConn, keyId: string, features: string[]): void {
    b.authed = true
    b.keyId = keyId
    b.features = features
    this.d.clock.clearTimeout(b.handshake)
    const old = this.getBridge()
    if (old && old !== b) {
      this.setBridge(null) // so the old socket's close does not arm the session-stopped timer
      old.conn.close(WS_CLOSE.SUPERSEDED)
      this.d.log.info({ old_ip: old.ip, new_ip: b.ip }, 'a new bridge hello replaced the connected one')
      this.noteSupersede(b.ip)
    } else this.setSuperseded(false)
    this.setBridge(b)
    this.resetSessionStopped()
    this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
    // The relay may have restarted while the bridge was down: no 'working' row survives a new bridge.
    this.resetStaleStatuses()
    // nor Main's state from the last one: a new bridge says its own in its first beat (no stale sign-in banner meanwhile)
    noteBridgeMain(this.d.store, undefined)
    b.conn.send(JSON.stringify(this.ready(false)))
    this.broadcastPresence()
    this.resendAllUnconsumed()
  },
}
