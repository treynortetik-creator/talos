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
import { verifyBridgeHello } from '../auth/contract.ts'
import type { BridgeFeatures } from './features.ts'
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
  noteSupersede(): void
  sendBridge(frame: Record<string, unknown>): void
  ready(forApp: boolean): Record<string, unknown>
  broadcastPresence(): void
  resendAllUnconsumed(): void
  resetStaleStatuses(): void
  clearQueuedTimers(): void
  onBridgeFrameBuiltin(b: BridgeConn, frame: Frame, raw: Record<string, unknown>): Promise<void>
  runBridgeHandlers(keyId: string, frame: Frame, raw: Record<string, unknown>): Promise<void>
}

export const bridgeConnFrames = {
  attachBridge(
    this: BridgeConnCtx,
    conn: Conn,
    args: { ip: string; relayHost: string },
  ): { onMessage(text: string): void; onClose(): void } {
    const b: BridgeConn = {
      id: `b_${newUlid().slice(-10)}`,
      conn,
      ip: args.ip,
      authed: false,
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
      if (!b.authed) conn.close(WS_CLOSE.HANDSHAKE_TIMEOUT)
    }, HANDSHAKE_MS)
    this.track(b.handshake)
    let chain: Promise<void> = Promise.resolve()
    return {
      onMessage: (text) => {
        b.lastInbound = this.d.clock.now()
        const limit = b.authed ? MAX_FRAME_BYTES : MAX_FRAME_BYTES_UNAUTH
        if (Buffer.byteLength(text) > limit) return void conn.close(WS_CLOSE.FRAME_TOO_LARGE)
        chain = chain.then(() =>
          bridgeConnFrames.handleBridgeText
            .call(this, b, text, { nonce, relay_host: args.relayHost, server_time: serverTime })
            .catch((e) => {
              this.d.log.error({ err: errName(e) }, 'bridge frame handler failed')
            }),
        )
      },
      onClose: () => {
        if (this.isStopped()) return
        this.d.clock.clearTimeout(b.handshake)
        if (this.getBridge() === b) {
          this.setBridge(null)
          this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
          this.clearQueuedTimers()
          this.resetStaleStatuses()
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
    const parsed = parseFrameText(text, { authenticated: b.authed, direction: 'bridge_to_relay' })
    if (!parsed.ok) {
      const rawId = (parsed.raw as { id?: unknown } | undefined)?.id
      if (!b.authed)
        return void b.conn.close(parsed.code === 'too_large' ? WS_CLOSE.FRAME_TOO_LARGE : WS_CLOSE.UNAUTHORIZED)
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
      if (frame.type !== 'hello' || frame.role !== 'bridge') return void b.conn.close(WS_CLOSE.UNAUTHORIZED)
      const res = await verifyBridgeHello({ hello: { key_id: frame.key_id, sig: frame.sig }, challenge, ip: b.ip })
      if (!res.ok) {
        this.d.log.warn({ ip: b.ip }, 'bridge hello refused')
        return void b.conn.close(WS_CLOSE.UNAUTHORIZED)
      }
      this.bridgeFeatures.onHello(frame.client.features ?? [], new Date(this.d.clock.now()).toISOString())
      return bridgeConnFrames.bridgeHello.call(this, b, res.keyId, frame.client.features ?? [])
    }
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
      this.noteSupersede()
    }
    this.setBridge(b)
    this.resetSessionStopped()
    this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
    // The relay may have restarted while the bridge was down: no 'working' row survives a new bridge.
    this.resetStaleStatuses()
    b.conn.send(JSON.stringify(this.ready(false)))
    this.broadcastPresence()
    this.resendAllUnconsumed()
  },
}
