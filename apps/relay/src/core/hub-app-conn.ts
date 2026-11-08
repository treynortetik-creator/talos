// An app socket from first byte to close: the hello handshake, the size and rate limits, one frame at a time, and the
// checks every frame passes before a handler sees it (session alive, device pinned, "last used" noted).
// Handlers of the Hub class (hub.ts), which forwards to them. The frame-by-frame work is in hub-app-frames.ts.
import {
  type Frame,
  type FrameOf,
  MAX_FRAME_BYTES,
  MAX_FRAME_BYTES_UNAUTH,
  newUlid,
  parseFrameText,
  WS_CLOSE,
} from '@talos-app/protocol'
import { noteDeviceUse, type Session, sessionActive, sessionEndReason, sessionPinned } from '../auth/contract.ts'
import type { AppRouter } from './apps.ts'
import type { EphemeralRouter } from './ephemeral.ts'
import { errName } from './hub-helpers.ts'
import type { AppConn, Conn, FrameRejected, HubDeps } from './hub-types.ts'
import {
  BURST,
  HANDLERS_RUN_BEFORE_ACK,
  HANDSHAKE_MS,
  PAIRING_IN,
  QUEUE_CAP,
  RATE_PER_S,
  SHOWS_A_PERSON,
} from './hub-types.ts'
import { mkFrame } from './util.ts'

/** What the app-socket handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type AppConnCtx = {
  d: HubDeps
  apps: Map<string, AppConn>
  ephemeral: EphemeralRouter
  appRouter: AppRouter
  isStopped(): boolean
  track(h: unknown): void
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  appError(a: AppConn, code: string, message: string, ref?: unknown): void
  refreshPairing(a: AppConn): void
  ready(forApp: boolean): Record<string, unknown>
  sendCatchup(a: AppConn, since: number): void
  onAppFrameBuiltin(a: AppConn, frame: Frame, raw: Record<string, unknown>): Promise<void>
  runAppHandlers(
    a: AppConn,
    frame: Frame,
    raw: Record<string, unknown>,
    strict?: boolean,
  ): Promise<boolean | FrameRejected>
}

export const appConnFrames = {
  attachApp(
    this: AppConnCtx,
    conn: Conn,
    args: { session: Session | null; ip: string },
  ): { onMessage(text: string): void; onClose(): void } {
    const now = this.d.clock.now()
    const a: AppConn = {
      id: `a_${newUlid().slice(-10)}`,
      conn,
      ip: args.ip,
      session: args.session,
      deviceId: null,
      authed: false,
      visible: false,
      activeAt: 0,
      lastInbound: now,
      queue: [],
      draining: false,
      tokens: BURST,
      refilledAt: now,
      handshake: null,
      limited: false,
      helloSeq: 0,
    }
    this.apps.set(a.id, a)
    a.handshake = this.d.clock.setTimeout(() => {
      if (!a.authed) conn.close(WS_CLOSE.HANDSHAKE_TIMEOUT)
    }, HANDSHAKE_MS)
    this.track(a.handshake)
    return {
      onMessage: (text) => appConnFrames.onAppMessage.call(this, a, text),
      onClose: () => {
        this.d.clock.clearTimeout(a.handshake)
        this.apps.delete(a.id)
        this.ephemeral.dropSocket(a.id)
        this.appRouter.dropSocket(a.id)
      },
    }
  },

  onAppMessage(this: AppConnCtx, a: AppConn, text: string): void {
    a.lastInbound = this.d.clock.now()
    const limit = a.authed ? MAX_FRAME_BYTES : MAX_FRAME_BYTES_UNAUTH
    if (Buffer.byteLength(text) > limit) return void a.conn.close(WS_CLOSE.FRAME_TOO_LARGE)
    if (a.queue.length >= QUEUE_CAP) return void a.conn.close(WS_CLOSE.RATE_LIMITED)
    a.queue.push(text)
    if (!a.draining) void appConnFrames.drainApp.call(this, a)
  },

  /** One frame at a time, in order; a token bucket (30/s, burst 60) delays the rest instead of dropping them. */
  async drainApp(this: AppConnCtx, a: AppConn): Promise<void> {
    a.draining = true
    try {
      while (a.queue.length > 0 && !this.isStopped()) {
        await appConnFrames.takeToken.call(this, a)
        const text = a.queue.shift() as string
        try {
          await appConnFrames.handleAppText.call(this, a, text)
        } catch (e) {
          this.d.log.error({ err: errName(e), socket: a.id }, 'app frame handler failed')
          this.sendApp(a, mkFrame(this.d.clock, 'error', { code: 'internal', message: 'internal error' }))
        }
      }
    } finally {
      a.draining = false
    }
  },

  async takeToken(this: AppConnCtx, a: AppConn): Promise<void> {
    for (;;) {
      const now = this.d.clock.now()
      a.tokens = Math.min(BURST, a.tokens + (Math.max(0, now - a.refilledAt) / 1000) * RATE_PER_S) // a clock step back adds nothing, it never drains
      a.refilledAt = now
      if (a.tokens >= 1) {
        a.tokens -= 1
        return
      }
      await new Promise<void>((r) => this.track(this.d.clock.setTimeout(r, Math.ceil(1000 / RATE_PER_S))))
      if (this.isStopped()) return
    }
  },

  async handleAppText(this: AppConnCtx, a: AppConn, text: string): Promise<void> {
    const parsed = parseFrameText(text, { authenticated: a.authed, direction: 'app_to_relay' })
    if (!parsed.ok) {
      const rawId = (parsed.raw as { id?: unknown } | undefined)?.id
      if (!a.authed)
        return void a.conn.close(parsed.code === 'too_large' ? WS_CLOSE.FRAME_TOO_LARGE : WS_CLOSE.BAD_FRAME)
      return this.appError(a, parsed.code, parsed.message, rawId)
    }
    const raw = parsed.raw as Record<string, unknown>
    const frame = parsed.frame
    if (!a.authed) {
      if (frame.type !== 'hello' || frame.role !== 'app') return void a.conn.close(WS_CLOSE.UNAUTHORIZED)
      return appConnFrames.appHello.call(this, a, frame)
    }
    if (!sessionActive(a.session))
      return void a.conn.close(WS_CLOSE.UNAUTHORIZED, sessionEndReason(a.session) ?? undefined)
    if (!a.limited && !sessionPinned(a.session)) a.limited = true
    this.refreshPairing(a)
    if (a.limited && !PAIRING_IN.has(frame.type)) {
      return this.appError(a, 'device_not_pinned', 'this device is not pinned by your Mac yet', raw.id)
    }
    // "Last used" in Settings > Devices is for spotting a forgotten device, so only a frame that shows a person counts. A
    // ping, a pong, a hidden report and the relay's own session checks do not: a tab left open overnight is not in use.
    if (SHOWS_A_PERSON.has(frame.type) && (frame.type !== 'visibility' || frame.state === 'visible'))
      noteDeviceUse(a.session?.deviceId ?? null)
    await this.onAppFrameBuiltin(a, frame, raw)
    if (!HANDLERS_RUN_BEFORE_ACK.has(frame.type)) await this.runAppHandlers(a, frame, raw)
  },

  appHello(this: AppConnCtx, a: AppConn, frame: FrameOf<'hello'> & { role: 'app' }): void {
    // A tab that still holds a device key the owner has since replaced. Its reason lets the app keep the queue in the shared
    // storage (which belongs to the newer key); an app that does not know the reason treats it like no reason at all.
    if (a.session?.deviceId && a.session.deviceId !== frame.device_id)
      return void a.conn.close(WS_CLOSE.UNAUTHORIZED, 'device_changed')
    a.authed = true
    a.deviceId = frame.device_id
    a.visible = frame.visible
    a.activeAt = this.d.clock.now()
    this.d.clock.clearTimeout(a.handshake)
    a.helloSeq = frame.last_seq
    a.limited = !sessionPinned(a.session)
    this.sendApp(a, this.ready(!a.limited))
    if (!a.limited && frame.last_seq > 0) this.sendCatchup(a, frame.last_seq)
  },
}
