// The two socket hubs and the Bus (spec 3.4): app sockets at /ws, the single bridge at /bridge. This file owns the state
// they share (the socket maps, the outbox to the bridge, presence, the timers) and the Bus. The work is split by concern:
//   hub-types.ts          socket shapes, constants, FrameRejected
//   hub-app-conn.ts       an app socket: handshake, limits, rate bucket, session and pairing checks
//   hub-app-frames.ts     what each app frame type does (then hub-chat/cards/config/history/undelivered.ts)
//   hub-bridge-conn.ts    the bridge socket: challenge, signed hello, supersede, close
//   hub-bridge-frames.ts  what each bridge frame type does, the durable writes, error routing
//   hub-status.ts         the derived `queued` status and stale `working` rows
//   hub-ready.ts          the `ready` frame
//   hub-helpers.ts        pure helpers
import {
  type Frame,
  type FrameOf,
  type FrameType,
  isInheritedName,
  isQuiet,
  type MessageT,
  newUlid,
  PROBLEMS_FEATURE,
  type PresenceT,
  type ThreadT,
  V2_READ_OWNER_FRAME_TYPES,
  V2_READ_RESPONSE_FOR,
  WS_CLOSE,
} from '@talos-app/protocol'
import { sessionActive, sessionEndReason, sessionPinned } from '../auth/contract.ts'
import { RateLimiter } from '../auth/limits.ts'
import type { AppFrameContext, BridgeFrameContext, Bus, RichPushInput } from '../services.ts'
import { AppRouter } from './apps.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import { EphemeralRouter } from './ephemeral.ts'
import { BridgeFeatures } from './features.ts'
import { fitDigest } from './fit.ts'
import { type AppConnCtx, appConnFrames } from './hub-app-conn.ts'
import { type AppFramesCtx, appFrames } from './hub-app-frames.ts'
import { type BridgeConnCtx, bridgeConnFrames } from './hub-bridge-conn.ts'
import { type BridgeFramesCtx, bridgeFrames } from './hub-bridge-frames.ts'
import type { CardsCtx } from './hub-cards.ts'
import { cardsFrames } from './hub-cards.ts'
import type { ChatCtx } from './hub-chat.ts'
import type { ConfigCtx } from './hub-config.ts'
import { countsUnread, errName, threadOf } from './hub-helpers.ts'
import type { HistoryCtx } from './hub-history.ts'
import { historyFrames } from './hub-history.ts'
import { type ReadyCtx, readyFrames } from './hub-ready.ts'
import { StatusTimers } from './hub-status.ts'
import {
  type AppConn,
  type AppHandler,
  BACKLOG_AFTER_MS,
  type BridgeConn,
  type BridgeHandler,
  CONSUMABLE,
  DEAD_MS,
  FrameRejected,
  HISTORY_FRAME_ID_MS,
  HISTORY_REQ_TTL_MS,
  type HubDeps,
  PAIRING_OUT,
  PING_MS,
  PRESENCE_WINDOW_MS,
  REF_TTL_MS,
  RESEND_MS,
  type Ref,
  SESSION_STOPPED_AFTER_MS,
  TWO_STAGE_KEY,
} from './hub-types.ts'
import type { UndeliveredCtx } from './hub-undelivered.ts'
import { undeliveredFrames } from './hub-undelivered.ts'
import { ScheduleRouter } from './schedules.ts'
import type { Store, StoredFrame } from './store.ts'
import { DAY_MS, mkFrame } from './util.ts'

// What other files import from hub.ts. The types and constants live in hub-types.ts, the helpers in hub-helpers.ts.
export type { AppConn, Conn, HubDeps, Ref } from './hub-types.ts'
export { FrameRejected } from './hub-types.ts'

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
  private status: StatusTimers
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
  private appConnCtx: AppConnCtx
  private appFramesCtx: AppFramesCtx
  private readyCtx: ReadyCtx
  private bridgeConnCtx: BridgeConnCtx
  private bridgeFramesCtx: BridgeFramesCtx

  /** When this hub started; a bridge cannot have been gone longer than this process has been up (see presence()). */
  private readonly upSince: number
  constructor(private d: HubDeps) {
    this.upSince = d.clock.now()
    this.config = d.store.getConfig()
    this.bridgeFeatures = new BridgeFeatures(d.store)
    this.readLimits = new RateLimiter(d.clock)
    this.status = new StatusTimers(d, {
      cfg: () => this.cfg(),
      fanOut: (frame) => this.fanOut(frame),
      bridgeOnline: () => this.bridgeOnline(),
    })
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
        t === 'search.query' ? 'search' : t === 'speak.request' ? 'speak' : t === 'fs.list' ? 'folders' : 'memory',
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
      bridgeHas: (feature) => this.bridgeFeatures.has(feature),
      socketLive: (id) => Boolean(this.apps.get(id)?.authed),
      deviceOf: (id) => {
        const c = this.apps.get(id)
        return c?.authed ? (c.session?.deviceId ?? c.deviceId) : null
      },
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
      cardTimers: this.cardTimers,
      expireCard: (card) => cardsFrames.expireCard.call(this.cardsCtx, card),
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
      eventMessage: (f) => historyFrames.eventMessage.call(this.historyCtx, f),
      readBudget: (a, name, ref) => this.readBudget(a, name, ref),
    }
    this.undeliveredCtx = {
      d,
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
      stampForApps: (frame) => this.stampForApps(frame),
      cfg: () => this.cfg(),
      notify: (intent, rich) => this.notify(intent, rich),
      clearQueuedTimer: (msgId) => this.status.clearQueuedTimer(msgId),
      bridgeIsTwoStage: () => this.bridgeIsTwoStage(),
      nativeApproveCard: (body) => this.nativeApproveCard(body),
      putCardBackToPending: (cardId, reason) => this.putCardBackToPending(cardId, reason),
      decisionCard: (type, f) => this.decisionCard(type, f),
      cardDecidedOnMac: (type, f) => this.cardDecidedOnMac(type, f),
    }
    this.readyCtx = {
      d,
      readyExtras: this.readyExtras,
      presence: () => this.presence(),
      cfg: () => this.cfg(),
      threads: () => this.threads(),
    }
    this.appConnCtx = {
      d,
      apps: this.apps,
      ephemeral: this.ephemeral,
      appRouter: this.appRouter,
      isStopped: () => this.stopped,
      track: (h) => this.track(h),
      sendApp: (a, frame) => this.sendApp(a, frame),
      appError: (a, code, message, ref) => this.appError(a, code, message, ref),
      refreshPairing: (a) => this.refreshPairing(a),
      ready: (forApp) => this.ready(forApp),
      sendCatchup: (a, since) => this.sendCatchup(a, since),
      onAppFrameBuiltin: (a, frame, raw) => appFrames.onAppFrameBuiltin.call(this.appFramesCtx, a, frame, raw),
      runAppHandlers: (a, frame, raw, strict) => this.runAppHandlers(a, frame, raw, strict),
    }
    this.appFramesCtx = {
      d,
      appHandlers: this.appHandlers,
      chatCtx: this.chatCtx,
      cardsCtx: this.cardsCtx,
      configCtx: this.configCtx,
      historyCtx: this.historyCtx,
      schedules: this.schedules,
      ephemeral: this.ephemeral,
      appRouter: this.appRouter,
      sendApp: (a, frame) => this.sendApp(a, frame),
      appError: (a, code, message, ref) => this.appError(a, code, message, ref),
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
      ownerDeviceOk: (a, deviceId, frameId) => this.ownerDeviceOk(a, deviceId, frameId),
      runAppHandlers: (a, frame, raw, strict) => this.runAppHandlers(a, frame, raw, strict),
      history: (a, frame, raw) => this.history(a, frame, raw),
      sendCatchup: (a, since) => this.sendCatchup(a, since),
    }
    this.bridgeConnCtx = {
      d,
      bridgeFeatures: this.bridgeFeatures,
      isStopped: () => this.stopped,
      track: (h) => this.track(h),
      getBridge: () => this.bridge,
      setBridge: (b) => {
        this.bridge = b
      },
      resetSessionStopped: () => {
        this.stoppedNotified = false
        if (this.stoppedTimer) this.d.clock.clearTimeout(this.stoppedTimer)
        this.stoppedTimer = null
      },
      armSessionStopped: () => this.armSessionStopped(),
      noteSupersede: () => this.noteSupersede(),
      sendBridge: (frame) => this.sendBridge(frame),
      ready: (forApp) => this.ready(forApp),
      broadcastPresence: () => this.broadcastPresence(),
      resendAllUnconsumed: () => this.resendAllUnconsumed(),
      resetStaleStatuses: () => this.status.resetStaleStatuses(),
      clearQueuedTimers: () => this.status.clearQueuedTimers(),
      onBridgeFrameBuiltin: (b, frame, raw) =>
        bridgeFrames.onBridgeFrameBuiltin.call(this.bridgeFramesCtx, b, frame, raw),
      runBridgeHandlers: (keyId, frame, raw) => this.runBridgeHandlers(keyId, frame, raw),
    }
    this.bridgeFramesCtx = {
      d,
      refs: this.refs,
      apps: this.apps,
      historyReqs: this.historyReqs,
      historyFrameIds: this.historyFrameIds,
      appRouter: this.appRouter,
      ephemeral: this.ephemeral,
      schedules: this.schedules,
      getConfig: () => this.config,
      setConfig: (config) => {
        this.config = config
      },
      cfg: () => this.cfg(),
      sendBridge: (frame) => this.sendBridge(frame),
      fanOut: (frame, onlyDeviceId, except) => this.fanOut(frame, onlyDeviceId, except),
      stampForApps: (frame) => this.stampForApps(frame),
      deliverStored: (stamped) => this.deliverStored(stamped),
      broadcastPresence: () => this.broadcastPresence(),
      notify: (intent, rich) => this.notify(intent, rich),
      scheduleCardExpiry: (cardId, expiresAt) => cardsFrames.scheduleCardExpiry.call(this.cardsCtx, cardId, expiresAt),
      addedInheritedThread: (frame) => this.addedInheritedThread(frame),
      rollbackRejectedResolve: (frame) => this.rollbackRejectedResolve(frame),
      noteTwoStageBridge: () => this.noteTwoStageBridge(),
      startQueuedTimer: (seq, type) => this.status.startQueuedTimer(seq, type),
      clearQueuedTimer: (msgId) => this.status.clearQueuedTimer(msgId),
      clearThreadQueued: (threadId) => this.status.clearThreadQueued(threadId),
      clearDerivedQueued: (threadId) => this.status.clearDerivedQueued(threadId),
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    this.armPing()
    this.armResend()
    for (const c of this.d.store.allPendingCards())
      cardsFrames.scheduleCardExpiry.call(this.cardsCtx, c.id, c.expires_at)
    if (this.d.store.getState('bridge_last_seen') && !this.bridge) this.armSessionStopped()
  }

  stop(): void {
    this.stopped = true
    this.schedules.stop()
    for (const h of this.timers) this.d.clock.clearTimeout(h)
    this.timers.clear()
    this.status.clearQueuedTimers()
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

  private ready(...args: Parameters<typeof readyFrames.ready>) {
    return readyFrames.ready.apply(this.readyCtx, args)
  }

  private readyExtras: Array<() => Record<string, unknown>> = []
  /** A module adds fields to the app's `ready` (the session module keeps the last session.state for it). */
  readyExtra(fn: () => Record<string, unknown>): void {
    this.readyExtras.push(fn)
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

  attachApp(...args: Parameters<typeof appConnFrames.attachApp>) {
    return appConnFrames.attachApp.apply(this.appConnCtx, args)
  }

  private sendCatchup(...args: Parameters<typeof historyFrames.sendCatchup>) {
    return historyFrames.sendCatchup.apply(this.historyCtx, args)
  }

  private appError(a: AppConn, code: string, message: string, ref?: unknown): void {
    this.sendApp(a, mkFrame(this.d.clock, 'error', { ...(typeof ref === 'string' ? { ref } : {}), code, message }))
  }

  private rememberRef(frameId: string, a: AppConn, threadId: string | null, volatile = false): void {
    const now = this.d.clock.now()
    this.refs.set(frameId, { socketId: a.id, threadId, at: now, ...(volatile ? { volatile } : {}) })
    if (this.refs.size > 2000) for (const [k, v] of this.refs) if (now - v.at > REF_TTL_MS) this.refs.delete(k)
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
      .map((f) => historyFrames.eventMessage.call(this.historyCtx, f))
      .filter((m): m is MessageT => m !== null)
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

  attachBridge(...args: Parameters<typeof bridgeConnFrames.attachBridge>) {
    return bridgeConnFrames.attachBridge.apply(this.bridgeConnCtx, args)
  }

  /** Durable frames from the bridge, over the socket or POST /bridge/post. Idempotent on the frame id. */
  processBridgeDurable(...args: Parameters<typeof bridgeFrames.processBridgeDurable>) {
    return bridgeFrames.processBridgeDurable.apply(this.bridgeFramesCtx, args)
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

  // ---- derived `queued` status (4.6) ------------------------------------------------------------------------------

  /** A session's turn ended: the 'working' rows it owned go idle (see StatusTimers.settleWorking). */
  settleWorking(scope: 'main' | { thread_id: string }): void {
    this.status.settleWorking(scope)
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
