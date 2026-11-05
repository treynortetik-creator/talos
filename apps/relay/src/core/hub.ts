// The two socket hubs and the Bus (spec 3.4): app sockets at /ws, the single bridge at /bridge. Owns the replay buffer
// writes, the durable outbox to the bridge (two-stage ack), card checks, step-up checks, presence, derived `queued`
// status, ref -> socket error forwarding and the supersede / session-stopped alarms.
import {
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  CONSUMABLE_FRAME_TYPES,
  CUSTOM_THEMES_FEATURE,
  cardNotice,
  type Frame,
  type FrameOf,
  type FrameType,
  isInheritedName,
  isQuiet,
  MAX_FRAME_BYTES,
  MAX_FRAME_BYTES_UNAUTH,
  type MessageT,
  markdownToPlain,
  NATIVE_ACT_TYPE,
  newChallengeNonce,
  newId,
  newUlid,
  ownValue,
  PROBLEMS_FEATURE,
  type PresenceT,
  parseFrameText,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  type ThreadT,
  threadSessionMode,
  V2_READ_OWNER_FRAME_TYPES,
  V2_READ_RESPONSE_FOR,
  WS_CLOSE,
  withLegacyMirror,
} from '@talos-app/protocol'
import {
  noteDeviceUse,
  type Session,
  sessionActive,
  sessionEndReason,
  sessionPinned,
  verifyBridgeHello,
} from '../auth/contract.ts'
import { RateLimiter } from '../auth/limits.ts'
import type { RelayEnv } from '../env.ts'
import type { AppFrameContext, BridgeFrameContext, Bus, Clock, Logger, RichPushInput } from '../services.ts'
import { AppRouter } from './apps.ts'
import { checkNewCard } from './cards.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import { EphemeralRouter } from './ephemeral.ts'
import { BridgeFeatures, relayFeatureList } from './features.ts'
import { fitDigest } from './fit.ts'
import type { CardsCtx } from './hub-cards.ts'
import { cardsFrames } from './hub-cards.ts'
import type { ChatCtx } from './hub-chat.ts'
import { chatFrames } from './hub-chat.ts'
import type { ConfigCtx } from './hub-config.ts'
import { configFrames } from './hub-config.ts'
import type { HistoryCtx } from './hub-history.ts'
import { historyFrames } from './hub-history.ts'
import type { UndeliveredCtx } from './hub-undelivered.ts'
import { undeliveredFrames } from './hub-undelivered.ts'
import type { FileMediaStore } from './media.ts'
import type { CorePush } from './push.ts'
import { isScheduleOwnerType, ScheduleRouter } from './schedules.ts'
import type { Store, StoredFrame } from './store.ts'
import { DAY_MS, longTimeout, mkFrame } from './util.ts'

/** App frames whose module handlers do the durable write, so the hub runs them before it acks (see `inbox.update`). */
const HANDLERS_RUN_BEFORE_ACK: ReadonlySet<string> = new Set(['inbox.update'])

export interface Conn {
  send(text: string): void
  close(code: number, reason?: string): void
  terminate(): void
}

const CATCHUP_PAGE = 200
const REF_TTL_MS = 10 * 60_000
const HANDSHAKE_MS = 10_000
const PING_MS = 25_000
const DEAD_MS = 75_000
const QUEUE_CAP = 500
const TWO_STAGE_KEY = 'bridge_two_stage' // set once the bridge sends a `consumed` ack
const BURST = 60
const RATE_PER_S = 30
const BACKLOG_AFTER_MS = 15 * 60_000
const SESSION_STOPPED_AFTER_MS = 5 * 60_000
const QUEUED_AFTER_MS = 30_000
const RESEND_MS = [5_000, 30_000, 120_000]
// session.control is consumable once the bridge records its result (docs/CLAUDE-CODE.md C2.5); the protocol lists it apart.
// thread.session.control (docs/OPTION-C.md) follows the same rule.
const CONSUMABLE = new Set<string>([
  ...CONSUMABLE_FRAME_TYPES,
  'session.control',
  'thread.session.control',
  'agent.recover',
])

/** What an UNPINNED app socket may receive and send: enough to finish pairing and nothing of the owner's data. */
const PAIRING_OUT = new Set(['ready', 'presence', 'device.pinned', 'ack', 'error', 'ping', 'pong'])
const PAIRING_IN = new Set(['hello', 'ping', 'pong', 'visibility'])
/**
 * App frames that show a person at the device, for the "last used" time. An action the owner took (send, resolve a card,
 * change a setting, mark unread, ask the voice agent) or a "visible" report, which the app sends on a touch, a key or a
 * return to the screen. Not here: ping/pong, catch-up, history, media and read marks, which an app sends by itself.
 */
const SHOWS_A_PERSON = new Set([
  'message',
  'voice_note',
  'card.resolve',
  'config.patch',
  'thread.unread',
  'voice.ask',
  'visibility',
])

export type AppConn = {
  id: string
  conn: Conn
  ip: string
  session: Session | null
  deviceId: string | null
  authed: boolean
  visible: boolean
  /** Relay clock time of the last sign someone is at this screen: a hello, or any visibility frame (the web app re-sends one on activity). */
  activeAt: number
  lastInbound: number
  queue: string[]
  draining: boolean
  tokens: number
  refilledAt: number
  handshake: unknown
  /** The session's device is not pinned (yet): it gets an empty `ready` and may only finish pairing. */
  limited: boolean
  helloSeq: number
}
type BridgeConn = {
  id: string
  conn: Conn
  ip: string
  authed: boolean
  keyId: string
  lastInbound: number
  handshake: unknown
  /** `hello.client.features`, echoed in `ready` and `presence` (docs/SCHEDULES.md S1.5). */
  features: string[]
}

const HISTORY_REQ_TTL_MS = 2 * 60_000
const HISTORY_FRAME_ID_MS = 24 * 3600_000

export type Ref = { socketId: string; threadId: string | null; at: number; volatile?: boolean }
type AppHandler = (frame: never, ctx: AppFrameContext) => void | Promise<void>
type BridgeHandler = (frame: never, ctx: BridgeFrameContext) => void | Promise<void>

/** A rejection with a protocol error code (WS: error frame; HTTP: 400). */
export class FrameRejected extends Error {
  constructor(
    readonly code: 'bad_frame' | 'internal',
    message: string,
  ) {
    super(message)
  }
}

/** A visible screen with no activity report for this long is not someone being there (pushes go to the phone). */
export const PRESENCE_WINDOW_MS = 60_000

export type HubDeps = {
  store: Store
  clock: Clock
  log: Logger
  env: RelayEnv
  push: CorePush
  media: FileMediaStore
  /** How long after its last activity report a visible screen still counts as someone being there. Default 60 s. */
  presenceWindowMs?: number
}

export class Hub implements Bus {
  private apps = new Map<string, AppConn>()
  private bridge: BridgeConn | null = null
  private appHandlers = new Map<string, AppHandler[]>()
  private bridgeHandlers = new Map<string, BridgeHandler[]>()
  private refs = new Map<string, Ref>()
  private historyReqs = new Map<string, Ref & { frameId: string }>()
  /**
   * Frame ids of history requests, kept 24 h after the route expires: a late Mac error for one is dropped, never stored.
   * Best-effort and in memory on purpose: after a restart a late error (the Mac's read queue slow across a deploy) is
   * stored like any other late Mac error. That error is fixed text with no history content, so losing the list leaks
   * nothing; it only saves a stray row.
   */
  private historyFrameIds = new Map<string, number>()
  private readLimits: RateLimiter
  private queuedTimers = new Map<string, { handle: unknown; threadId: string }>()
  private cardTimers = new Map<string, unknown>()
  private timers = new Set<unknown>()
  private supersedes: number[] = []
  private lastSupersedeAlarm = 0
  private stoppedTimer: unknown = null
  private stoppedNotified = false
  private pingTimer: unknown = null
  private resendTimer: unknown = null
  private resendLong = false
  private stopped = false
  private config: ReturnType<Store['getConfig']>
  /** The shared request router for ephemeral reads (docs/V2-FEATURES.md V1.3); Schedules' request map lives in it. */
  readonly ephemeral: EphemeralRouter
  /** MCP Apps request routing (core/apps.ts): app.request to the bridge, app.response back to the asking socket. */
  readonly appRouter: AppRouter
  private bridgeFeatures: BridgeFeatures
  private twoStageBridge = false
  private schedules: ScheduleRouter
  private chatCtx: ChatCtx
  private cardsCtx: CardsCtx
  private configCtx: ConfigCtx
  private historyCtx: HistoryCtx
  private undeliveredCtx: UndeliveredCtx

  /** When this hub started; a bridge cannot have been gone longer than this process has been up (see presence()). */
  private readonly upSince: number
  constructor(private d: HubDeps) {
    this.upSince = d.clock.now()
    this.config = d.store.getConfig()
    this.bridgeFeatures = new BridgeFeatures(d.store)
    this.readLimits = new RateLimiter(d.clock)
    const sendToApp = (id: string, raw: Record<string, unknown>) => {
      const a = this.apps.get(id)
      if (!a?.authed) return false
      this.sendApp(a, raw)
      return true
    }
    const appError = (id: string, code: string, message: string, ref: string) => {
      const a = this.apps.get(id)
      if (a) this.appError(a, code, message, ref)
    }
    this.ephemeral = new EphemeralRouter({
      clock: d.clock,
      log: d.log,
      bridgeOnline: () => this.bridgeOnline(),
      sendBridge: (raw) => this.sendBridge(raw),
      sendToApp,
      appError,
    })
    for (const t of V2_READ_OWNER_FRAME_TYPES)
      this.ephemeral.register(
        t,
        V2_READ_RESPONSE_FOR[t],
        t === 'search.query' ? 'search' : t === 'speak.request' ? 'speak' : 'memory',
      )
    this.appRouter = new AppRouter({
      clock: d.clock,
      log: d.log,
      bridgeOnline: () => this.bridgeOnline(),
      sendBridge: (raw) => this.sendBridge(raw),
      sendToApp,
      socketLive: (id) => Boolean(this.apps.get(id)?.authed),
      appError,
    })
    this.schedules = new ScheduleRouter({
      store: d.store,
      clock: d.clock,
      log: d.log,
      bridgeOnline: () => this.bridgeOnline(),
      sendBridge: (raw) => this.sendBridge(raw),
      sendToApp,
      fanOut: (raw) => this.fanOut(raw),
      appError,
      appAck: (id, ref) => {
        const a = this.apps.get(id)
        if (a) this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref }))
      },
      rememberRef: (frameId, id) => {
        const a = this.apps.get(id)
        if (a) this.rememberRef(frameId, a, null, true)
      },
      notify: (intent) => this.notify(intent),
      anyVisible: () => this.anyVisible(),
      quietNow: () => {
        const cfg = this.cfg()
        return isQuiet(new Date(this.d.clock.now()), cfg.quiet_window, cfg.timezone)
      },
      track: (h) => this.track(h),
      requests: this.ephemeral,
    })

    this.chatCtx = {
      d,
      ownerDeviceOk: (a, deviceId, frameId) => this.ownerDeviceOk(a, deviceId, frameId),
      acceptOwner: (a, frame, raw, threadId, extraKeys, alsoWrite) =>
        this.acceptOwner(a, frame, raw, threadId, extraKeys, alsoWrite),
      sendApp: (a, frame) => this.sendApp(a, frame),
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
    }
    this.cardsCtx = {
      d,
      bridgeFeatures: this.bridgeFeatures,
      ownerDeviceOk: (a, deviceId, frameId) => this.ownerDeviceOk(a, deviceId, frameId),
      acceptOwner: (a, frame, raw, threadId, extraKeys, alsoWrite) =>
        this.acceptOwner(a, frame, raw, threadId, extraKeys, alsoWrite),
      appError: (a, code, message, ref) => this.appError(a, code, message, ref),
      sendApp: (a, frame) => this.sendApp(a, frame),
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
      stampForApps: (frame) => this.stampForApps(frame),
      enqueueRow: (stamped, ttlMs) => this.enqueueRow(stamped, ttlMs),
      afterEnqueue: (stamped) => this.afterEnqueue(stamped),
      expireCard: (card) => this.expireCard(card),
      agentConfig: () => this.agentConfig(),
      nativeApproveCard: (body) => this.nativeApproveCard(body),
      putCardBackToPending: (cardId, reason) => this.putCardBackToPending(cardId, reason),
    }
    this.configCtx = {
      d,
      ownerDeviceOk: (a, deviceId, frameId) => this.ownerDeviceOk(a, deviceId, frameId),
      acceptOwner: (a, frame, raw, threadId, extraKeys, alsoWrite) =>
        this.acceptOwner(a, frame, raw, threadId, extraKeys, alsoWrite),
      appError: (a, code, message, ref) => this.appError(a, code, message, ref),
      sendApp: (a, frame) => this.sendApp(a, frame),
      agentConfig: () => this.agentConfig(),
      bridgeOnline: () => this.bridgeOnline(),
      toBridge: (frame, opts) => this.toBridge(frame, opts),
    }
    this.historyCtx = {
      d,
      historyReqs: this.historyReqs,
      historyFrameIds: this.historyFrameIds,
      readLimits: this.readLimits,
      ownerDeviceOk: (a, deviceId, frameId) => this.ownerDeviceOk(a, deviceId, frameId),
      appError: (a, code, message, ref) => this.appError(a, code, message, ref),
      sendApp: (a, frame) => this.sendApp(a, frame),
      sendBridge: (frame) => this.sendBridge(frame),
      rememberRef: (frameId, a, threadId, volatile) => this.rememberRef(frameId, a, threadId, volatile),
      bridgeOnline: () => this.bridgeOnline(),
      pruneHistoryReqs: () => this.pruneHistoryReqs(),
      eventMessage: (f) => this.eventMessage(f),
      readBudget: (a, name, ref) => this.readBudget(a, name, ref),
    }
    this.undeliveredCtx = {
      d,
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
      stampForApps: (frame) => this.stampForApps(frame),
      cfg: () => this.cfg(),
      notify: (intent, rich) => this.notify(intent, rich),
      clearQueuedTimer: (msgId) => this.clearQueuedTimer(msgId),
      bridgeIsTwoStage: () => this.bridgeIsTwoStage(),
      nativeApproveCard: (body) => this.nativeApproveCard(body),
      putCardBackToPending: (cardId, reason) => this.putCardBackToPending(cardId, reason),
      decisionCard: (type, f) => this.decisionCard(type, f),
      cardDecidedOnMac: (type, f) => this.cardDecidedOnMac(type, f),
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    this.armPing()
    this.armResend()
    for (const c of this.d.store.allPendingCards()) this.scheduleCardExpiry(c.id, c.expires_at)
    if (this.d.store.getState('bridge_last_seen') && !this.bridge) this.armSessionStopped()
  }

  stop(): void {
    this.stopped = true
    this.schedules.stop()
    for (const h of this.timers) this.d.clock.clearTimeout(h)
    this.timers.clear()
    for (const t of this.queuedTimers.values()) this.d.clock.clearTimeout(t.handle)
    this.queuedTimers.clear()
    for (const [, h] of this.cardTimers) this.d.clock.clearTimeout(h)
    this.cardTimers.clear()
    if (this.stoppedTimer) this.d.clock.clearTimeout(this.stoppedTimer)
    this.stoppedTimer = null
    if (this.pingTimer) this.d.clock.clearTimeout(this.pingTimer)
    this.pingTimer = null
    if (this.resendTimer) this.d.clock.clearTimeout(this.resendTimer)
    this.resendTimer = null
    for (const a of this.apps.values()) a.conn.close(1001)
    this.bridge?.conn.close(1001)
  }

  /** Fire-and-forget push: a decrypt or SQLite error in the push path must never become an unhandled rejection. */
  private notify(intent: Parameters<HubDeps['push']['notify']>[0], rich?: RichPushInput): void {
    this.d.push
      .notify(intent, rich ? { rich } : undefined)
      .catch((e) => this.d.log.error({ err: errName(e), template: intent.template }, 'push failed'))
  }

  private track(h: unknown) {
    this.timers.add(h)
  }

  agentConfig() {
    return this.config
  }
  private cfg() {
    return this.config ?? DEFAULT_AGENT_CONFIG
  }

  /**
   * Someone is at a screen right now: an authed socket that is visible AND showed activity within the presence window
   * (PRESENCE_WINDOW_MS). A tab left open on a Mac, or a screen left on with nobody there, stops muting pushes once the
   * window passes. An older app that never reports activity counts for at most one window after its last visibility frame.
   */
  anyVisible(): boolean {
    const now = this.d.clock.now()
    const window = this.d.presenceWindowMs ?? PRESENCE_WINDOW_MS
    for (const a of this.apps.values())
      if (a.authed && !a.limited && a.visible && now - a.activeAt < window) return true
    return false
  }
  bridgeOnline(): boolean {
    return Boolean(this.bridge?.authed)
  }
  appCount(): number {
    return [...this.apps.values()].filter((a) => a.authed).length
  }

  // ---- Bus -------------------------------------------------------------------------------------------------------

  onAppFrame<T extends FrameType>(
    type: T,
    handler: (frame: FrameOf<T>, ctx: AppFrameContext) => void | Promise<void>,
  ): void {
    this.appHandlers.set(type, [...(this.appHandlers.get(type) ?? []), handler as unknown as AppHandler])
  }
  onBridgeFrame<T extends FrameType>(
    type: T,
    handler: (frame: FrameOf<T>, ctx: BridgeFrameContext) => void | Promise<void>,
  ): void {
    this.bridgeHandlers.set(type, [...(this.bridgeHandlers.get(type) ?? []), handler as unknown as BridgeHandler])
  }

  async toApps(
    frame: Record<string, unknown>,
    opts: { durable?: boolean; onlyDeviceId?: string; once?: string } = {},
  ): Promise<void> {
    const full = this.complete(frame)
    if (opts.durable && opts.once) {
      // The seen id is written with the event, so a caller that retries after the frame committed (its own bookkeeping
      // failed, or the process died first) finds the key and sends nothing: one stored frame, one live fan-out.
      const store = this.d.store
      const once = opts.once
      const stamped = store.db.transaction((): StoredFrame | null => {
        if (store.seen(once) !== undefined) return null
        const s = this.stampForApps(full)
        store.remember(once, s.relay.seq)
        return s
      })()
      if (stamped) this.fanOut(stamped, opts.onlyDeviceId)
      return
    }
    const out = opts.durable ? this.stampForApps(full) : full
    this.fanOut(out, opts.onlyDeviceId)
  }

  async toBridge(
    frame: Record<string, unknown>,
    opts: { durable: boolean; ttl_s?: number; resume?: boolean; alsoWrite?: () => void },
  ): Promise<{ queued: boolean }> {
    const full = fitDigest(this.complete(frame), new Date(this.d.clock.now()).toISOString())
    if (!opts.durable) {
      if (!this.bridgeOnline()) return { queued: false }
      this.sendBridge(full)
      return { queued: false }
    }
    const ttlMs = Math.min((opts.ttl_s ?? this.d.env.BUFFER_DAYS * 86_400) * 1000, this.d.env.BUFFER_DAYS * DAY_MS)
    const store = this.d.store
    // The event and its outbox row are one transaction: a failed write leaves no event behind, so the caller's retry
    // with the same frame id is a first attempt. `resume` is for a caller that generated the id itself and keeps it until
    // the send is confirmed (the hook pass): its retry may come after the commit, or after an older build stored the
    // event and lost the outbox row, and then finds its own event of the same type and only finishes the row; a frame
    // that is already queued is left alone. Anyone else, and any id that belongs to a different kind of frame, gets the
    // unique-index error: an id someone else chose is never taken for a retry.
    const queuedNow = store.db.transaction((): StoredFrame | null => {
      opts.alsoWrite?.() // the caller's own writes (a spent token, a seen mark) commit or roll back with the event
      const found = store.getEventByFrameId(String(full.id))
      if (found && opts.resume && found.type === full.type) {
        const { _thread, ...prior } = found
        if (store.outboxRow(prior.id)) return null
        this.enqueueRow(prior, ttlMs)
        return prior
      }
      const s = store.appendEvent({ frame: full, audience: 'bridge', threadId: threadOf(full) })
      this.enqueueRow(s, ttlMs)
      return s
    })()
    if (queuedNow) this.afterEnqueue(queuedNow)
    return { queued: !this.bridgeOnline() }
  }

  private complete(frame: Record<string, unknown>): Record<string, unknown> {
    return { ...mkFrame(this.d.clock, String(frame.type)), ...frame }
  }

  private stampForApps(frame: Record<string, unknown>): StoredFrame {
    return this.d.store.appendEvent({
      frame,
      audience: 'app',
      threadId: threadOf(frame),
      countsUnread: countsUnread(frame),
    })
  }

  private fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void {
    const text = JSON.stringify(frame)
    const type = String(frame.type)
    for (const a of this.apps.values()) {
      if (!a.authed || a.id === except) continue
      if (onlyDeviceId && a.deviceId !== onlyDeviceId) continue
      this.refreshPairing(a)
      if (a.limited && !PAIRING_OUT.has(type)) continue
      a.conn.send(text)
    }
  }

  private sendApp(a: AppConn, frame: Record<string, unknown>): void {
    const full = this.complete(frame)
    if (a.limited && !PAIRING_OUT.has(String(full.type))) return
    a.conn.send(JSON.stringify(full))
  }

  /**
   * A socket outlives the request that authenticated it, so the auth store is re-read: a dead session is closed with
   * 4401 (revoke, logout, logout-all, expiry), a device the Mac un-pinned drops back to pairing-only, and a device the
   * Mac just pinned gets its real `ready`.
   */
  revalidateApps(): void {
    for (const a of [...this.apps.values()]) {
      if (!a.authed) continue
      if (!sessionActive(a.session)) {
        a.conn.close(WS_CLOSE.UNAUTHORIZED, sessionEndReason(a.session) ?? undefined)
        this.apps.delete(a.id)
        continue
      }
      if (!a.limited && !sessionPinned(a.session)) a.limited = true
      else this.refreshPairing(a)
    }
  }

  /** The Mac pinned this socket's device since the last frame: hand over the real `ready` and what it missed. */
  private refreshPairing(a: AppConn): void {
    if (!a.limited || !sessionPinned(a.session)) return
    a.limited = false
    this.sendApp(a, this.ready(true))
    if (a.helloSeq > 0) this.sendCatchup(a, a.helloSeq)
  }

  private sendBridge(frame: Record<string, unknown>): void {
    if (this.bridge?.authed) this.bridge.conn.send(JSON.stringify(frame))
  }

  // ---- outbox to the bridge -------------------------------------------------------------------------------------

  /** Writes the outbox row for a stored frame; safe inside a transaction. `afterEnqueue` is the live half. */
  private enqueueRow(stamped: StoredFrame, ttlMs: number): void {
    const type = String(stamped.type)
    this.d.store.enqueueOutbox({
      frameId: stamped.id,
      seq: stamped.relay.seq,
      type,
      consumable: CONSUMABLE.has(type),
      ttlMs,
    })
  }

  /** The live half: send to the Mac if it is here, re-arm the resend timer, tell the apps the queue changed. */
  private afterEnqueue(stamped: StoredFrame): void {
    if (this.bridgeOnline()) this.deliverStored(stamped)
    if (this.resendLong) this.armResend()
    this.broadcastPresence()
  }

  /** Sends a stored frame to the bridge; a hook.event that waited more than 15 minutes goes out as `backlog`. */
  private deliverStored(stamped: StoredFrame): void {
    // An older Mac drops a frame type it does not know and would answer nothing: keep problem reports until it says it can file them.
    if (stamped.type === 'problem.item' && !this.bridgeFeatures.has(PROBLEMS_FEATURE)) return
    let out = stamped
    if (stamped.type === 'hook.event' && stamped.delivery !== 'backlog') {
      const age = this.d.clock.now() - Date.parse(stamped.relay.received_at)
      if (age > BACKLOG_AFTER_MS) {
        out = { ...stamped, delivery: 'backlog' }
        this.d.store.rewriteEvent(out)
      }
    }
    this.sendBridge(out)
  }

  /**
   * The resend loop ticks every second while the outbox has frames and every 30 s while it is empty (`afterEnqueue` brings it
   * back to a second), so an idle relay does almost nothing.
   */
  private armResend(delayMs = 1000): void {
    if (this.stopped) return
    if (this.resendTimer) this.d.clock.clearTimeout(this.resendTimer)
    this.resendLong = delayMs > 1000
    this.resendTimer = this.d.clock.setTimeout(() => {
      this.resendDue()
      this.armResend(this.d.store.outboxDepth() > 0 ? 1000 : 30_000)
    }, delayMs)
  }

  private resendDue(): void {
    if (!this.bridgeOnline()) return
    const now = this.d.clock.now()
    for (const row of this.d.store.outboxDue(now)) {
      this.deliverStored(row.frame)
      this.d.store.touchOutbox(row.frame_id, now + (RESEND_MS[row.attempts + 1] ?? RESEND_MS[RESEND_MS.length - 1]!))
    }
  }

  /** On every bridge hello: all unconsumed frames, in relay.seq order, original bytes. */
  private resendAllUnconsumed(): void {
    for (const row of this.d.store.outboxAll()) {
      if (row.consumable || !row.delivered) this.deliverStored(row.frame)
    }
  }

  // ---- presence ---------------------------------------------------------------------------------------------------

  presence(): PresenceT {
    // A redeploy stops the hub before it writes the close time, so the stored time can be days old for a bridge that is
    // only waiting out its reconnect backoff. Never report it as gone for longer than this process has been up (the same
    // clamp HealthWatch.downSince applies), or the app says "asleep, last seen 3 d ago" on a healthy Mac.
    const stored = Number(this.d.store.getState('bridge_last_seen') ?? 0)
    const last = this.bridgeOnline() ? this.d.clock.now() : stored > 0 ? Math.max(stored, this.upSince) : 0
    return {
      bridge_online: this.bridgeOnline(),
      last_seen: last ? new Date(last).toISOString() : null,
      queue_depth: this.d.store.outboxDepth(),
      ...this.bridgeFeatures.presence(),
    }
  }

  private broadcastPresence(): void {
    this.fanOut(mkFrame(this.d.clock, 'presence', this.presence()))
  }

  // ---- ready ------------------------------------------------------------------------------------------------------

  private readyExtras: Array<() => Record<string, unknown>> = []
  /** A module adds fields to the app's `ready` (the session module keeps the last session.state for it). */
  readyExtra(fn: () => Record<string, unknown>): void {
    this.readyExtras.push(fn)
  }

  private ready(forApp: boolean): Record<string, unknown> {
    const base = mkFrame(this.d.clock, 'ready', {
      session_id: `sess_${newUlid().slice(-12)}`,
      policy: { max_frame_bytes: MAX_FRAME_BYTES, ping_ms: PING_MS },
      server_seq: this.d.store.maxSeq(),
      presence: this.presence(),
      features: [
        ...new Set([
          SCHEDULES_FEATURE,
          SCHEDULES_FEATURE_V2,
          CONFIG_PROPOSE_FEATURE,
          CUSTOM_THEMES_FEATURE,
          ...relayFeatureList(),
        ]),
      ].slice(0, 20),
    })
    if (!forApp) return base
    const cfg = this.cfg()
    return {
      ...base,
      agent_config: withLegacyMirror(cfg), // R1-1: an older app requires a top-level mirror; drop after the next release
      threads: this.threads(),
      open_cards: this.d.store.openCards(this.d.clock.now()),
      unread: this.d.store.unreadByThread(),
      read_upto: this.d.store.readByThread(),
      not_delivered: this.d.store.notDelivered(),
      statuses: this.d.store.allStatuses(),
      ...Object.assign({}, ...this.readyExtras.map((f) => f())),
    }
  }

  /**
   * A thread this frame would ADD whose id every object already has (`constructor`). Threads the relay already holds are
   * edits and pass, and so does the first config.sync (the relay holds none yet, so nothing can be said to be new).
   */
  private addedInheritedThread(frame: Frame): string | undefined {
    if (frame.type === 'thread.upsert') {
      const known = new Set([...this.threads(), ...this.d.store.listThreads()].map((t) => t.id))
      return !known.has(frame.thread.id) && isInheritedName(frame.thread.id) ? frame.thread.id : undefined
    }
    if (frame.type === 'config.sync' && this.config) {
      const known = new Set(this.config.threads.map((t) => t.id))
      return frame.config.threads.find((t) => !known.has(t.id) && isInheritedName(t.id))?.id
    }
    return undefined
  }

  /** config.sync is authoritative; before the first sync, the agent-created threads the relay knows about. */
  private threads(): ThreadT[] {
    if (this.config) return this.config.threads
    const extra = this.d.store.listThreads().filter((t) => !DEFAULT_AGENT_CONFIG.threads.some((x) => x.id === t.id))
    return [...DEFAULT_AGENT_CONFIG.threads, ...extra]
  }

  // ---- app sockets ------------------------------------------------------------------------------------------------

  attachApp(
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
      onMessage: (text) => this.onAppMessage(a, text),
      onClose: () => {
        this.d.clock.clearTimeout(a.handshake)
        this.apps.delete(a.id)
        this.ephemeral.dropSocket(a.id)
        this.appRouter.dropSocket(a.id)
      },
    }
  }

  private onAppMessage(a: AppConn, text: string): void {
    a.lastInbound = this.d.clock.now()
    const limit = a.authed ? MAX_FRAME_BYTES : MAX_FRAME_BYTES_UNAUTH
    if (Buffer.byteLength(text) > limit) return void a.conn.close(WS_CLOSE.FRAME_TOO_LARGE)
    if (a.queue.length >= QUEUE_CAP) return void a.conn.close(WS_CLOSE.RATE_LIMITED)
    a.queue.push(text)
    if (!a.draining) void this.drainApp(a)
  }

  /** One frame at a time, in order; a token bucket (30/s, burst 60) delays the rest instead of dropping them. */
  private async drainApp(a: AppConn): Promise<void> {
    a.draining = true
    try {
      while (a.queue.length > 0 && !this.stopped) {
        await this.takeToken(a)
        const text = a.queue.shift() as string
        try {
          await this.handleAppText(a, text)
        } catch (e) {
          this.d.log.error({ err: errName(e), socket: a.id }, 'app frame handler failed')
          this.sendApp(a, mkFrame(this.d.clock, 'error', { code: 'internal', message: 'internal error' }))
        }
      }
    } finally {
      a.draining = false
    }
  }

  private async takeToken(a: AppConn): Promise<void> {
    for (;;) {
      const now = this.d.clock.now()
      a.tokens = Math.min(BURST, a.tokens + (Math.max(0, now - a.refilledAt) / 1000) * RATE_PER_S) // a clock step back adds nothing, it never drains
      a.refilledAt = now
      if (a.tokens >= 1) {
        a.tokens -= 1
        return
      }
      await new Promise<void>((r) => this.track(this.d.clock.setTimeout(r, Math.ceil(1000 / RATE_PER_S))))
      if (this.stopped) return
    }
  }

  private async handleAppText(a: AppConn, text: string): Promise<void> {
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
      return this.appHello(a, frame)
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
  }

  private appError(a: AppConn, code: string, message: string, ref?: unknown): void {
    this.sendApp(a, mkFrame(this.d.clock, 'error', { ...(typeof ref === 'string' ? { ref } : {}), code, message }))
  }

  private appHello(a: AppConn, frame: FrameOf<'hello'> & { role: 'app' }): void {
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
  }

  private sendCatchup(a: AppConn, since: number): void {
    const store = this.d.store
    const floor = store.floor()
    if (floor !== null && since + 1 < floor) {
      this.sendApp(a, mkFrame(this.d.clock, 'catchup.reset', { min_seq: floor }))
      since = floor - 1
    } else if (since > store.maxSeq()) {
      // The app is ahead of us (volume lost or restored): resync it from what we have.
      const min = floor ?? 1
      this.sendApp(a, mkFrame(this.d.clock, 'catchup.reset', { min_seq: min }))
      since = min - 1
    }
    if (store.countAppEventsAfter(since) > CATCHUP_PAGE) this.sendCatchupSummary(a, since)
    const frames = store.appEventsAfter(since, CATCHUP_PAGE)
    if (frames.length === 0) return
    const last = (frames[frames.length - 1] as StoredFrame).relay.seq
    this.sendApp(
      a,
      mkFrame(this.d.clock, 'catchup.batch', {
        from_seq: since + 1,
        to_seq: last,
        frames,
        more: store.countAppEventsAfter(last) > 0,
      }),
    )
  }

  private sendCatchupSummary(a: AppConn, since: number): void {
    const store = this.d.store
    const unread = store.unreadByThread()
    const lastAt = store.lastEventAtByThread()
    const open = store.openCards(this.d.clock.now())
    const needs = new Set(open.map((c) => c.thread_id))
    const ids = new Set([...Object.keys(unread), ...Object.keys(lastAt)])
    this.sendApp(
      a,
      mkFrame(this.d.clock, 'catchup.summary', {
        since_seq: since,
        threads: [...ids].map((t) => ({
          thread_id: t,
          unread: ownValue(unread, t) ?? 0,
          last_ts: ownValue(lastAt, t) ? new Date(ownValue(lastAt, t) as number).toISOString() : null,
          needs_you: needs.has(t),
        })),
        open_cards: open.length,
      }),
    )
  }

  private rememberRef(frameId: string, a: AppConn, threadId: string | null, volatile = false): void {
    const now = this.d.clock.now()
    this.refs.set(frameId, { socketId: a.id, threadId, at: now, ...(volatile ? { volatile } : {}) })
    if (this.refs.size > 2000) for (const [k, v] of this.refs) if (now - v.at > REF_TTL_MS) this.refs.delete(k)
  }

  private async onAppFrameBuiltin(a: AppConn, frame: Frame, raw: Record<string, unknown>): Promise<void> {
    const store = this.d.store
    switch (frame.type) {
      case 'ping':
        return this.sendApp(a, mkFrame(this.d.clock, 'pong', { nonce: frame.nonce }))
      case 'visibility':
        a.visible = frame.state === 'visible'
        a.activeAt = this.d.clock.now()
        return
      case 'message':
      case 'voice_note':
        return chatFrames.onOwnerMessage.call(this.chatCtx, a, frame, raw)
      case 'card.resolve':
        return cardsFrames.onCardResolve.call(this.cardsCtx, a, frame, raw)
      case 'config.patch':
        return configFrames.onConfigPatch.call(this.configCtx, a, frame, raw)
      case 'agent.recover':
        return configFrames.onAgentRecover.call(this.configCtx, a, frame, raw)
      case 'voice.ask': {
        // The core NEVER queues this for the bridge. Only the voice module may emit it, and only after it has matched
        // the frame to a live call, a delegation it created and the call's own thread (spec 6.3). Without the voice
        // module (no OPENAI_API_KEY) there is no such call, so the frame is refused rather than forwarded.
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        a.activeAt = this.d.clock.now()
        if (!this.appHandlers.has('voice.ask'))
          return this.appError(a, 'bad_frame', 'live voice is not available', frame.id)
        return
      }
      case 'inbox.update': {
        // The inbox row itself is written by the hooks module's handler. That write runs first and the ack follows it, so an
        // app is never told "done" for a change that was not saved; a failed write leaves no seen id and the retry is a
        // first attempt. The event and its seen id are one transaction, like an owner message.
        const dup = store.seen(`of:${frame.id}`)
        if (dup !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: dup }))
        const handled = await this.runAppHandlers(a, frame, raw, true)
        if (handled instanceof FrameRejected) return this.appError(a, handled.code, handled.message, frame.id)
        if (!handled) {
          this.appError(a, 'internal', 'The relay could not save that. Nothing changed; try again.', frame.id)
          return
        }
        let stamped: StoredFrame
        try {
          stamped = store.db.transaction((): StoredFrame => {
            const s = store.appendEvent({ frame: raw, audience: 'app', threadId: undefined })
            store.remember(`of:${frame.id}`, s.relay.seq)
            return s
          })()
        } catch (e) {
          this.d.log.error({ err: errName(e), type: frame.type }, 'inbox frame not stored')
          this.appError(a, 'internal', 'The relay could not save that. Nothing changed; try again.', frame.id)
          return
        }
        this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: stamped.relay.seq }))
        this.fanOut(stamped, undefined, a.id)
        return
      }
      case 'schedules.list':
      case 'schedule.get':
      case 'schedule.patch':
      case 'schedule.run_now':
      case 'schedule.control': {
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        if (!isScheduleOwnerType(frame.type)) return
        return this.schedules.onOwnerFrame(a.id, frame as never, raw)
      }
      case 'thread.read':
        store.setRead(frame.thread_id, frame.up_to_seq)
        return this.fanOut(raw, undefined, a.id)
      case 'thread.unread': {
        // The read mark only rises, so this is the one frame that lowers it (store.markUnread). EVERY device, the sender
        // included, gets the relay's answer: the sender cannot work out the new mark or count by itself.
        const r = store.markUnread(frame.thread_id)
        return this.fanOut(
          mkFrame(this.d.clock, 'thread.unread', {
            thread_id: frame.thread_id,
            ...(r.up_to_seq !== undefined ? { up_to_seq: r.up_to_seq } : {}),
            count: r.count,
          }),
        )
      }
      case 'catchup.request':
        return this.sendCatchup(a, frame.since_seq)
      case 'history.request':
        return this.history(a, frame, raw)
      case 'media.fetch':
        return historyFrames.onMediaFetch.call(this.historyCtx, a, frame, raw)
      // docs/V2-FEATURES.md V1.3: signed reads, never stored, routed back to this socket only
      case 'search.query':
      case 'memory.tree':
      case 'memory.read':
      case 'memory.search':
      case 'speak.request':
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        return this.ephemeral.onRequest(a.id, frame, raw)
      // MCP Apps (spec M3.4): signed, never stored or replayed, answered to this socket only
      case 'app.request':
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        return this.appRouter.onRequest(a.id, frame, raw)
      case 'pong':
      case 'error':
      case 'hello':
        return
      default:
        return
    }
  }

  private ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean {
    if (a.session?.deviceId && a.session.deviceId !== deviceId) {
      this.appError(a, 'unauthorized', 'frame signed by a device other than this session', frameId)
      return false
    }
    return true
  }

  /**
   * Stores an owner frame (never its step-up token), queues it for the bridge, and only then acks it. The event, the seen
   * ids, any `alsoWrite` change and the outbox row are one transaction: if the write fails nothing is left behind, so
   * the app's retry is a first attempt, not a duplicate. The app gets an `error` tied to the frame (it keeps the message
   * and offers a retry) and this returns null. Sends happen after the commit.
   */
  private acceptOwner(
    a: AppConn,
    frame: { id: string; type: string },
    raw: Record<string, unknown>,
    threadId: string | null,
    extraKeys: string[] = [],
    alsoWrite?: () => void,
  ): StoredFrame | null {
    const { stepup_token: _drop, ...clean } = raw
    let stamped: StoredFrame
    try {
      stamped = this.d.store.db.transaction((): StoredFrame => {
        const s = this.d.store.appendEvent({ frame: clean, audience: 'both', threadId: threadId ?? undefined })
        this.d.store.remember(`of:${frame.id}`, s.relay.seq)
        for (const k of extraKeys) this.d.store.remember(k, s.relay.seq)
        alsoWrite?.()
        this.enqueueRow(s, this.d.env.BUFFER_DAYS * DAY_MS)
        return s
      })()
    } catch (e) {
      this.d.log.error({ err: errName(e), type: frame.type }, 'owner frame not stored')
      this.appError(a, 'internal', 'The relay could not save that. Nothing was sent; try again.', frame.id)
      return null
    }
    this.rememberRef(frame.id, a, threadId)
    this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: stamped.relay.seq }))
    this.afterEnqueue(stamped)
    return stamped
  }

  // ---- history ----------------------------------------------------------------------------------------------------

  /** The thread's newest messages as the app would see them (the voice module seeds a call from these). */
  recentMessages(threadId: string, limit: number): MessageT[] {
    return this.d.store
      .threadEvents(threadId, null, limit)
      .map((f) => this.eventMessage(f))
      .filter((m): m is MessageT => m !== null)
  }

  private eventMessage(f: StoredFrame): MessageT | null {
    const seq = f.relay.seq
    let m: MessageT | null = null
    if (f.type === 'message') {
      const x = f as unknown as FrameOf<'message'>
      m = {
        id: x.client_msg_id,
        thread_id: x.thread_id,
        author: 'owner',
        kind: 'text',
        text: x.text,
        format: 'plain',
        attachments: x.attachments,
        via: 'app',
        created_at: f.relay.received_at,
        ...(x.reply_to ? { reply_to: x.reply_to } : {}),
        ...(x.share_content ? { share_content: x.share_content } : {}),
      }
    } else if (f.type === 'voice_note') {
      const x = f as unknown as FrameOf<'voice_note'>
      m = {
        id: x.client_msg_id,
        thread_id: x.thread_id,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [x.attachment],
        via: 'app',
        created_at: f.relay.received_at,
      }
    } else if (f.type === 'reply' || f.type === 'message.stored') {
      const msg = (f as unknown as { message: MessageT }).message
      // Owner rows come from a `message` frame, except a share: it has no such frame, so it is kept (docs/V2-FEATURES.md V4.4).
      if (f.type === 'message.stored' && msg.author === 'owner' && msg.via !== 'share') return null
      m = { ...msg }
    }
    if (!m) return null
    const meta = this.d.store.getMeta(m.id)
    return {
      ...m,
      seq,
      ...(meta.receipt ? { receipt: meta.receipt } : {}),
      ...(meta.transcript ? { transcript: meta.transcript } : {}),
    }
  }

  /**
   * Runs the module handlers for an app frame. With `strict`, says whether every one of them finished without error, or
   * returns the refusal (`FrameRejected`) a handler threw: that one is final, where any other failure is worth a retry.
   */
  private async runAppHandlers(
    a: AppConn,
    frame: Frame,
    raw: Record<string, unknown>,
    strict = false,
  ): Promise<boolean | FrameRejected> {
    const hs = this.appHandlers.get(frame.type)
    if (!hs) return true
    let ok = true
    const ctx: AppFrameContext = {
      socketId: a.id,
      deviceId: a.deviceId,
      raw,
      reply: (f) => this.sendApp(a, f),
    }
    for (const h of hs) {
      try {
        await h(frame as never, ctx)
      } catch (e) {
        if (strict && e instanceof FrameRejected) return e
        this.d.log.error({ err: errName(e), type: frame.type }, 'app frame handler failed')
        if (strict) ok = false
      }
    }
    return ok
  }

  // ---- bridge socket ---------------------------------------------------------------------------------------------

  attachBridge(
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
          this.handleBridgeText(b, text, { nonce, relay_host: args.relayHost, server_time: serverTime }).catch((e) => {
            this.d.log.error({ err: errName(e) }, 'bridge frame handler failed')
          }),
        )
      },
      onClose: () => {
        if (this.stopped) return
        this.d.clock.clearTimeout(b.handshake)
        if (this.bridge === b) {
          this.bridge = null
          this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
          this.clearQueuedTimers()
          this.resetStaleStatuses()
          this.broadcastPresence()
          this.armSessionStopped()
        }
      },
    }
  }

  private async handleBridgeText(
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
      return this.bridgeHello(b, res.keyId, frame.client.features ?? [])
    }
    await this.onBridgeFrameBuiltin(b, frame, raw)
    await this.runBridgeHandlers(b.keyId, frame, raw)
  }

  /** Module handlers for a bridge frame; also used for frames that arrive over POST /bridge/post. */
  async runBridgeHandlers(keyId: string, frame: Frame, raw: Record<string, unknown>): Promise<void> {
    const hs = this.bridgeHandlers.get(frame.type)
    if (!hs) return
    const ctx: BridgeFrameContext = { keyId, raw, reply: (f) => this.sendBridge(this.complete(f)) }
    for (const h of hs) {
      try {
        await h(frame as never, ctx)
      } catch (e) {
        this.d.log.error({ err: errName(e), type: frame.type }, 'bridge frame handler failed')
      }
    }
  }

  private bridgeHello(b: BridgeConn, keyId: string, features: string[]): void {
    b.authed = true
    b.keyId = keyId
    b.features = features
    this.d.clock.clearTimeout(b.handshake)
    const old = this.bridge
    if (old && old !== b) {
      this.bridge = null // so the old socket's close does not arm the session-stopped timer
      old.conn.close(WS_CLOSE.SUPERSEDED)
      this.noteSupersede()
    }
    this.bridge = b
    this.stoppedNotified = false
    if (this.stoppedTimer) this.d.clock.clearTimeout(this.stoppedTimer)
    this.stoppedTimer = null
    this.d.store.setState('bridge_last_seen', String(this.d.clock.now()))
    // The relay may have restarted while the bridge was down: no 'working' row survives a new bridge.
    this.resetStaleStatuses()
    b.conn.send(JSON.stringify(this.ready(false)))
    this.broadcastPresence()
    this.resendAllUnconsumed()
  }

  private noteSupersede(): void {
    const now = this.d.clock.now()
    this.supersedes = this.supersedes.filter((t) => now - t < 3_600_000)
    this.supersedes.push(now)
    if (this.supersedes.length >= 3 && now - this.lastSupersedeAlarm > 3_600_000) {
      this.lastSupersedeAlarm = now
      this.notify({ template: 'bridge_key' })
    }
  }

  private armSessionStopped(): void {
    if (this.stoppedTimer || this.stoppedNotified || this.stopped) return
    this.stoppedTimer = this.d.clock.setTimeout(() => {
      this.stoppedTimer = null
      if (this.bridgeOnline() || this.stoppedNotified) return
      this.stoppedNotified = true
      this.notify({ template: 'session_stopped' })
    }, SESSION_STOPPED_AFTER_MS)
  }

  private async onBridgeFrameBuiltin(_b: BridgeConn, frame: Frame, raw: Record<string, unknown>): Promise<void> {
    const store = this.d.store
    switch (frame.type) {
      case 'ping':
        return this.sendBridge(mkFrame(this.d.clock, 'pong', { nonce: frame.nonce }))
      case 'pong':
      case 'hello':
        return
      case 'ack': {
        // A schedule frame's ack has no seq and no outbox row: it goes to the socket that sent the frame.
        const ref = this.refs.get(frame.ref)
        if (ref?.volatile) {
          if (this.d.clock.now() - ref.at <= REF_TTL_MS) this.apps.get(ref.socketId)?.conn.send(JSON.stringify(raw))
          return
        }
        return this.onBridgeAck(frame)
      }
      case 'app.response':
        return this.appRouter.onResponse(frame, raw)
      case 'schedules.snapshot':
      case 'schedule.detail':
        return this.schedules.onBridgeResponse(frame, raw)
      case 'schedule.status':
        return this.schedules.onStatus(frame, raw)
      case 'replay.request': {
        const wanted = new Set(frame.ids)
        for (const row of store.outboxAll())
          if (wanted.has(row.frame_id) && (row.consumable || !row.delivered)) this.deliverStored(row.frame)
        return
      }
      case 'error':
        return this.forwardError(frame, raw)
      case 'receipt':
        store.setReceipt(frame.message_id, frame.state)
        if (frame.state === 'seen') this.clearQueuedTimer(frame.message_id)
        return this.fanOut(raw)
      case 'status': {
        store.setStatus(frame)
        this.clearThreadQueued(frame.thread_id)
        return this.fanOut(raw)
      }
      case 'search.results':
      case 'memory.listing':
      case 'memory.file':
      case 'memory.results':
      case 'speak.result':
        return this.ephemeral.onResponse(frame, raw)
      case 'health.beat':
        // WP-V1 (core/health.ts) reads it through a bridge handler; the relay keeps the last one (V2.3, rule 1)
        return this.d.store.setState('health_beat', JSON.stringify(frame.beat))
      case 'history.page': {
        const ref = this.historyReqs.get(frame.request_id)
        this.historyReqs.delete(frame.request_id)
        const a = ref ? this.apps.get(ref.socketId) : undefined
        if (a?.authed) a.conn.send(JSON.stringify(raw))
        return
      }
      case 'reply':
      case 'card.create':
      case 'card.update':
      case 'transcript':
      case 'thread.upsert':
      case 'thread.archive':
      case 'config.sync':
      case 'inbox.update':
      case 'app.update':
      case 'device.pinned': {
        try {
          const { seq } = this.processBridgeDurable(frame, raw)
          this.sendBridge(mkFrame(this.d.clock, 'ack', { ref: frame.id, seq }))
        } catch (e) {
          if (e instanceof FrameRejected) {
            this.sendBridge(mkFrame(this.d.clock, 'error', { ref: frame.id, code: e.code, message: e.message }))
          } else throw e
        }
        return
      }
      default:
        return
    }
  }

  /** The bridge acked a frame it received (`delivered`) or pushed into Claude (`consumed`). */
  private onBridgeAck(frame: FrameOf<'ack'>): void {
    if (frame.stage === 'consumed') this.noteTwoStageBridge()
    const row = this.d.store.outboxRow(frame.ref)
    if (!row) return
    if (frame.stage === 'consumed') {
      this.d.store.dropOutbox(frame.ref)
      this.d.store.dropWorkFrame(frame.ref)
      this.startQueuedTimer(row.seq, row.type)
    } else {
      this.d.store.markDelivered(frame.ref)
      if (!row.consumable) this.d.store.dropOutbox(frame.ref)
    }
    this.broadcastPresence()
  }

  /** Durable frames from the bridge, over the socket or POST /bridge/post. Idempotent on the frame id. */
  processBridgeDurable(frame: Frame, raw: Record<string, unknown>): { seq: number; duplicate: boolean } {
    const store = this.d.store
    const dup = store.seen(`bf:${frame.id}`)
    if (dup !== undefined) return { seq: dup, duplicate: true }
    const threadId = threadOf(raw)
    let reject: string | null = null
    if (frame.type === 'card.create') reject = checkNewCard(frame.card)
    if (reject) throw new FrameRejected('bad_frame', `card rejected: ${reject}`)
    const inherited = this.addedInheritedThread(frame)
    if (inherited) throw new FrameRejected('bad_frame', `thread id "${inherited}" is a name every object already has`)

    // The event, the seen id and the frame's own row are one transaction. If any write fails nothing is kept, no
    // dedupe id included, so the bridge's resend of the same frame is a first attempt and not an ack for nothing.
    // The pushes and timers come after the commit.
    let applyConfig = false
    const stamped = store.db.transaction((): StoredFrame => {
      const s = store.appendEvent({ frame: raw, audience: 'app', threadId, countsUnread: countsUnread(raw) })
      store.remember(`bf:${frame.id}`, s.relay.seq)
      switch (frame.type) {
        case 'card.create':
          store.putCard(frame.card)
          break
        case 'card.update':
          store.setCardState(frame.card_id, {
            state: frame.state,
            ...(frame.resolution ? { resolution: frame.resolution } : {}),
            ...(frame.result ? { result: frame.result } : {}),
          })
          break
        case 'transcript':
          store.setTranscript(frame.message_id, { text: frame.text, engine: frame.engine, status: frame.status })
          break
        case 'thread.upsert':
          store.upsertThread(frame.thread)
          break
        case 'thread.archive':
          store.archiveThread(frame.thread_id)
          break
        case 'config.sync':
          if (!this.config || frame.rev >= this.config.rev) {
            store.setConfig(frame.config)
            applyConfig = true
          }
          break
        default:
          break
      }
      return s
    })()

    switch (frame.type) {
      case 'reply':
        this.clearThreadQueued(frame.message.thread_id)
        this.clearDerivedQueued(frame.message.thread_id)
        if (!frame.silent) {
          this.notify(
            {
              template: frame.voice_delegation_id ? 'answer_ready' : 'reply',
              thread_id: frame.message.thread_id,
            },
            frame.message.text && !frame.voice_delegation_id
              ? { text: frame.message.format === 'plain' ? frame.message.text : markdownToPlain(frame.message.text) }
              : undefined,
          )
        }
        break
      case 'card.create':
        this.scheduleCardExpiry(frame.card.id, Date.parse(frame.card.expires_at))
        this.notify(
          {
            template: 'needs_you',
            thread_id: frame.card.thread_id,
            card_id: frame.card.id,
            expires_at: frame.card.expires_at,
          },
          cardRich(frame.card),
        )
        break
      case 'config.sync':
        if (applyConfig) this.config = frame.config
        break
      case 'device.pinned':
        if (frame.ok) this.notify({ template: 'device_pinned' })
        break
      default:
        break
    }
    this.fanOut(stamped)
    return { seq: stamped.relay.seq, duplicate: false }
  }

  /** error{ref} from the bridge -> the socket that sent `ref` (10 min), else a system message in the frame's thread. */
  private forwardError(frame: FrameOf<'error'>, raw: Record<string, unknown>): void {
    if (!frame.ref) return
    if (this.ephemeral.onError(frame.ref, raw)) return // a read's error: to the asker or nowhere, never stored
    if (this.appRouter.onError(frame)) return // an app request's error: to the asker as a failed app.response
    // A history request's error (unsigned, forged, replayed): to the asker or nowhere, never stored as a system message.
    for (const h of this.historyReqs.values()) {
      if (h.frameId !== frame.ref) continue
      const asker = this.apps.get(h.socketId)
      if (asker?.authed) asker.conn.send(JSON.stringify(raw))
      return
    }
    // A history request whose route already expired (a slow Mac answering late): to nobody, never a thread message.
    if (this.historyFrameIds.has(frame.ref)) return
    const ref = this.refs.get(frame.ref)
    const a = ref && this.d.clock.now() - ref.at <= REF_TTL_MS ? this.apps.get(ref.socketId) : undefined
    // A read's refusal (media.fetch) is the asker's alone: it must never touch a stored frame that shares the id.
    if (ref?.volatile) {
      if (a?.authed) a.conn.send(JSON.stringify(raw))
      return
    }
    this.rollbackRejectedResolve(frame)
    const wasNativeTap =
      (this.d.store.getEventByFrameId(frame.ref) as { type?: string } | null)?.type === NATIVE_ACT_TYPE
    if (a?.authed) return void a.conn.send(JSON.stringify(raw))
    // A schedule error is never stored or turned into a thread message: nobody asked for it any more.
    if (ref?.volatile || this.d.store.seen(`sf:${frame.ref}`) !== undefined) return
    const ev = this.d.store.getEventByFrameId(frame.ref)
    const threadId = ref?.threadId ?? ev?._thread ?? this.cfg().default_thread
    const message: MessageT = {
      id: newId('m'),
      thread_id: threadId,
      author: 'system',
      kind: 'text',
      text: `An action was rejected (${frame.code}): ${frame.message}`,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(this.d.clock.now()).toISOString(),
    }
    const stamped = this.stampForApps(mkFrame(this.d.clock, 'message.stored', { client_msg_id: message.id, message }))
    this.fanOut(stamped)
    // The relay told the phone "ok" when it queued a notification tap. The Mac has now refused it, and the owner may be
    // away from the app: a row in the thread alone would leave them thinking it went through. Say so with a push.
    if (wasNativeTap) this.notify({ template: 'action_failed', thread_id: threadId })
  }

  // ---- derived `queued` status (4.6) ------------------------------------------------------------------------------

  private startQueuedTimer(seq: number, type: string): void {
    if (type !== 'message' && type !== 'voice_note') return
    const ev = this.d.store.getEventBySeq(seq)
    if (!ev) return
    const msgId = String(ev.client_msg_id)
    const threadId = String(ev.thread_id)
    this.clearQueuedTimer(msgId)
    const handle = this.d.clock.setTimeout(() => {
      this.queuedTimers.delete(msgId)
      if (!this.bridgeOnline()) return
      const got = this.d.store.getMeta(msgId).receipt
      if (got === 'seen' || got === 'not_delivered') return
      const status = {
        thread_id: threadId,
        state: 'queued' as const,
        label: 'Busy with another task',
        since: new Date(this.d.clock.now()).toISOString(),
      }
      this.d.store.setStatus(status, true)
      this.fanOut(mkFrame(this.d.clock, 'status', status))
    }, QUEUED_AFTER_MS)
    this.queuedTimers.set(msgId, { handle, threadId })
  }
  private clearQueuedTimer(msgId: string): void {
    const t = this.queuedTimers.get(msgId)
    if (t) this.d.clock.clearTimeout(t.handle)
    this.queuedTimers.delete(msgId)
  }
  /** A reply means the message was handled: a derived `queued` row (ours, not the bridge's) goes idle. */
  private clearDerivedQueued(threadId: string): void {
    const cur = this.d.store.getStatus(threadId)
    if (!cur || !cur.derived || cur.state !== 'queued') return
    this.setIdle(threadId)
  }
  /**
   * A session's turn ended (its `busy` went true -> false): the 'working' rows it owned cannot be true any more, and an
   * interrupted turn (Stop) or a worker that replied without `set_status idle` would leave them standing. `main` owns
   * every thread that is not dedicated; a thread session owns only its own thread.
   */
  settleWorking(scope: 'main' | { thread_id: string }): void {
    const cfg = this.cfg()
    for (const s of this.d.store.allStatuses()) {
      if (s.state !== 'working') continue
      const dedicated = threadSessionMode(cfg, s.thread_id) === 'dedicated'
      if (scope === 'main' ? dedicated : s.thread_id !== scope.thread_id) continue
      this.setIdle(s.thread_id)
    }
  }
  private setIdle(threadId: string): void {
    const status = { thread_id: threadId, state: 'idle' as const, since: new Date(this.d.clock.now()).toISOString() }
    this.d.store.setStatus(status)
    this.fanOut(mkFrame(this.d.clock, 'status', status))
  }
  /** The bridge dropped (or a new one authed): 'working' and derived 'queued' rows cannot be true any more. */
  private resetStaleStatuses(): void {
    for (const s of this.d.store.allStatuses()) {
      if (s.state === 'working') this.setIdle(s.thread_id)
      else if (s.state === 'queued' && this.d.store.getStatus(s.thread_id)?.derived) this.setIdle(s.thread_id)
    }
  }
  private clearThreadQueued(threadId: string): void {
    for (const [id, t] of this.queuedTimers) if (t.threadId === threadId) this.clearQueuedTimer(id)
  }
  private clearQueuedTimers(): void {
    for (const id of [...this.queuedTimers.keys()]) this.clearQueuedTimer(id)
  }

  // ---- card expiry ------------------------------------------------------------------------------------------------

  private scheduleCardExpiry(cardId: string, expiresAt: number): void {
    const prev = this.cardTimers.get(cardId)
    if (prev) this.d.clock.clearTimeout(prev)
    longTimeout(
      this.d.clock,
      () => {
        this.cardTimers.delete(cardId)
        const card = this.d.store.getCard(cardId)
        if (card?.state === 'pending') this.expireCard(card)
      },
      expiresAt - this.d.clock.now(),
      (h) => this.cardTimers.set(cardId, h),
    )
  }

  private expireCard(card: CardT): void {
    if (this.d.store.getCard(card.id)?.state !== 'pending') return
    this.d.store.setCardState(card.id, { state: 'expired' })
    const stamped = this.stampForApps(
      mkFrame(this.d.clock, 'card.update', { card_id: card.id, state: 'expired', reason: 'expired' }),
    )
    this.fanOut(stamped)
  }

  // ---- keep-alive -------------------------------------------------------------------------------------------------

  private armPing(): void {
    if (this.stopped) return
    this.pingTimer = this.d.clock.setTimeout(() => {
      const now = this.d.clock.now()
      const ping = () => JSON.stringify(mkFrame(this.d.clock, 'ping', { nonce: newUlid().slice(-8) }))
      this.revalidateApps() // belt and braces: a revoke the routes did not announce still ends within one tick
      for (const a of this.apps.values()) {
        if (!a.authed) continue
        if (now - a.lastInbound > DEAD_MS) a.conn.terminate()
        else a.conn.send(ping())
      }
      const b = this.bridge
      if (b?.authed) {
        if (now - b.lastInbound > DEAD_MS) b.conn.terminate()
        else b.conn.send(ping())
      }
      this.armPing()
    }, PING_MS)
  }

  // ---- sweeper ----------------------------------------------------------------------------------------------------

  /** Retention (spec 5.4): events, media files, seen ids older than the buffer window. */
  /** A history request the Mac never answered (offline mid-request, crash) must not stay in memory forever. */
  private pruneHistoryReqs(): void {
    const cutoff = this.d.clock.now() - HISTORY_REQ_TTL_MS
    for (const [id, ref] of this.historyReqs) if (ref.at < cutoff) this.historyReqs.delete(id)
    // frame ids outlive the route (a laptop waking after hours still must not get its error stored); capped
    const idCutoff = this.d.clock.now() - HISTORY_FRAME_ID_MS
    for (const [id, at] of this.historyFrameIds) {
      if (at >= idCutoff && this.historyFrameIds.size <= 5000) break
      this.historyFrameIds.delete(id)
    }
  }

  /** Pending history requests (tests). */
  pendingHistoryRequests(): number {
    return this.historyReqs.size
  }

  /** Pending schedule request_ids (tests). */
  pendingScheduleRequests(): number {
    return this.schedules.pending()
  }

  /**
   * The bridge has sent a `consumed` ack, so it acks in two stages and a frame it only acked `delivered` is one it may not
   * have pushed into Claude: it died first, or pushed it and its `consumed` ack was dropped on a socket already down. The
   * relay cannot tell those apart; any reconnect before day 7 heals the second (the relay resends, the Mac acks again).
   * Kept in the store (no schema change), so a restart forgets nothing. A bridge that only ever says
   * `delivered` never sets it, and the end-of-buffer report and day-6 warning treat its frames as they always have.
   */
  private noteTwoStageBridge(): void {
    if (this.twoStageBridge) return
    if (this.d.store.getState(TWO_STAGE_KEY) !== '1') this.d.store.setState(TWO_STAGE_KEY, '1')
    this.twoStageBridge = true
  }

  private bridgeIsTwoStage(): boolean {
    this.twoStageBridge ||= this.d.store.getState(TWO_STAGE_KEY) === '1'
    return this.twoStageBridge
  }

  sweep(): void {
    this.pruneHistoryReqs()
    this.ephemeral.prune()
    this.appRouter.prune()
    // Reports and warnings are courtesies: whatever they hit, the retention below still runs.
    try {
      this.reportUndelivered()
      this.warnDeadMac()
    } catch (e) {
      this.d.log.warn({ err: errName(e) }, 'dead-mac report failed')
    }
    const res = this.d.store.sweep({
      bufferMs: this.d.env.BUFFER_DAYS * DAY_MS,
      dedupMs: 8 * DAY_MS,
      decisionCard: (type, body) => this.decisionCard(type, body as Record<string, unknown>),
    })
    this.d.media.removeFiles(res.mediaIds)
    if (res.events > 0 || res.mediaIds.length > 0) {
      this.d.log.info({ events: res.events, media: res.mediaIds.length }, 'retention sweep')
    }
  }

  // ---- frame families ------------------------------------------------------------------------------------------
  // The handlers live in hub-*.ts, one file per family, and run on a small context object (see `this.*Ctx`). Each
  // method here forwards to its handler with the same arguments.

  acceptNativeAct(...args: Parameters<typeof cardsFrames.acceptNativeAct>) {
    return cardsFrames.acceptNativeAct.apply(this.cardsCtx, args)
  }

  private rollbackRejectedResolve(...args: Parameters<typeof cardsFrames.rollbackRejectedResolve>) {
    return cardsFrames.rollbackRejectedResolve.apply(this.cardsCtx, args)
  }

  private nativeApproveCard(...args: Parameters<typeof cardsFrames.nativeApproveCard>) {
    return cardsFrames.nativeApproveCard.apply(this.cardsCtx, args)
  }

  private putCardBackToPending(...args: Parameters<typeof cardsFrames.putCardBackToPending>) {
    return cardsFrames.putCardBackToPending.apply(this.cardsCtx, args)
  }

  private readBudget(...args: Parameters<typeof historyFrames.readBudget>) {
    return historyFrames.readBudget.apply(this.historyCtx, args)
  }

  private history(...args: Parameters<typeof historyFrames.history>) {
    return historyFrames.history.apply(this.historyCtx, args)
  }

  private decisionCard(...args: Parameters<typeof undeliveredFrames.decisionCard>) {
    return undeliveredFrames.decisionCard.apply(this.undeliveredCtx, args)
  }

  private cardDecidedOnMac(...args: Parameters<typeof undeliveredFrames.cardDecidedOnMac>) {
    return undeliveredFrames.cardDecidedOnMac.apply(this.undeliveredCtx, args)
  }

  private reportUndelivered(...args: Parameters<typeof undeliveredFrames.reportUndelivered>) {
    return undeliveredFrames.reportUndelivered.apply(this.undeliveredCtx, args)
  }

  private warnDeadMac(...args: Parameters<typeof undeliveredFrames.warnDeadMac>) {
    return undeliveredFrames.warnDeadMac.apply(this.undeliveredCtx, args)
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'error'
}

/** The thread a frame belongs to, for history, unread counts and error routing. */
export function threadOf(frame: Record<string, unknown>): string | undefined {
  const get = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined)
  const candidates = [
    frame.thread_id,
    get(frame.message, 'thread_id'),
    get(frame.card, 'thread_id'),
    get(frame.thread, 'id'),
    get(frame.event, 'thread'),
    get(frame.item, 'thread'),
  ]
  return candidates.find((c): c is string => typeof c === 'string')
}

/**
 * What a card push may show: the words `cardNotice` builds from the whole card. The card's id, risk and hash ride along
 * (so the phone can offer Approve) only when that text IS the whole card; a clipped, attached, payload-carrying or
 * outward-facing card gets its text and no button.
 */
function cardRich(card: CardT): RichPushInput {
  const n = cardNotice(card)
  return {
    text: n.text,
    ...(n.complete ? { card: { id: card.id, risk: card.risk, payload_hash: card.payload_hash } } : {}),
    // A permission card the app shows without Allow is deny-only: its push gets Open, not an Approve that opens a card with
    // nothing to approve.
    ...(card.kind === 'permission' && !n.complete ? { openOnly: true } : {}),
  }
}

function countsUnread(frame: Record<string, unknown>): boolean {
  const msg = frame.message as { author?: string; via?: string } | undefined
  const author = msg?.author
  if (frame.type === 'reply') return !frame.silent
  // A share is an owner-authored row the owner has not seen yet: it counts as unread (Inbox badge).
  if (frame.type === 'message.stored') return msg?.via === 'share' || (author !== undefined && author !== 'owner')
  return frame.type === 'inbox.item'
}
