// Schedule frame routing (docs/SCHEDULES.md S4). The relay never stores the registry, a snapshot, a prompt or a run record:
// owner frames are forwarded to the live bridge WITHOUT appendEvent, request/response frames are routed back to the asking
// socket by request_id, schedule.status is fanned out and never stored. The only things written are seq-less seen ids
// (`sf:<frame id>`, `sa:<alert key>`) in core_dedup.
import {
  type FrameOf,
  HEARTBEAT_FEATURE,
  HEARTBEAT_OWNER_FRAME_TYPES,
  HEARTBEAT_TEST_WAIT_MS,
  type PushIntent,
  SCHEDULE_OWNER_FRAME_TYPES,
} from '@talos-app/protocol'
import { RateLimiter } from '../auth/limits.ts'
import type { Clock, Logger } from '../services.ts'
import type { EphemeralRouter } from './ephemeral.ts'
import type { Store } from './store.ts'

// A request_id is answerable for 30 s (S4.2), 100 in flight per socket: both kept by the shared router, core/ephemeral.ts
// (docs/V2-FEATURES.md V1.3, which lifted this module's own map into it).
const ALERT_REPEAT_MS = 24 * 3600_000
const HOLD_POLL_MS = 60_000

type OwnerType = (typeof SCHEDULE_OWNER_FRAME_TYPES)[number] | (typeof HEARTBEAT_OWNER_FRAME_TYPES)[number]
const ANSWERS = ['schedules.snapshot', 'schedule.detail', 'heartbeat.test_result'] as const
/** A test result is answerable for the 200 s the sheet waits (the test itself may run 150 s), plus a little. */
const HEARTBEAT_ANSWER_TTL_MS = HEARTBEAT_TEST_WAIT_MS + 10_000

/** What the router needs from the hub (it owns sockets, the ref map and push). */
export interface ScheduleHost {
  store: Store
  clock: Clock
  log: Logger
  bridgeOnline(): boolean
  sendBridge(raw: Record<string, unknown>): void
  /** True when the live bridge listed `feature` in its hello. */
  bridgeHas(feature: string): boolean
  /** True while the app socket is connected and authed. */
  socketLive(socketId: string): boolean
  /** Sends to one authed app socket; false when it is gone. */
  sendToApp(socketId: string, raw: Record<string, unknown>): boolean
  fanOut(raw: Record<string, unknown>): void
  appError(socketId: string, code: string, message: string, ref: string): void
  appAck(socketId: string, ref: string): void
  rememberRef(frameId: string, socketId: string): void
  notify(intent: PushIntent): void
  anyVisible(): boolean
  quietNow(): boolean
  track(handle: unknown): void
  /** The hub's shared request router: schedule reads are answered by request_id through it. */
  requests: EphemeralRouter
}

export function isScheduleOwnerType(t: string): t is OwnerType {
  return (
    (SCHEDULE_OWNER_FRAME_TYPES as readonly string[]).includes(t) ||
    (HEARTBEAT_OWNER_FRAME_TYPES as readonly string[]).includes(t)
  )
}

export class ScheduleRouter {
  private limits: RateLimiter
  private held = new Set<PushIntent['template']>()
  private holdTimer: unknown = null
  private stopped = false

  constructor(private h: ScheduleHost) {
    this.limits = new RateLimiter(h.clock)
  }

  stop(): void {
    this.stopped = true
    if (this.holdTimer) this.h.clock.clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  /** The hub has already run `ownerDeviceOk`. */
  onOwnerFrame(
    socketId: string,
    frame: Record<string, unknown> & { id: string; type: OwnerType },
    raw: Record<string, unknown>,
  ): void {
    const h = this.h
    // A duplicate is acked once more, with no seq (the config.patch path stores a seq, which does not fit here).
    if (h.store.seen(`sf:${frame.id}`) !== undefined) {
      h.appAck(socketId, frame.id)
      return
    }
    if (!h.bridgeOnline()) {
      h.appError(socketId, 'mac_offline', 'your Mac is offline', frame.id)
      return
    }
    // An older bridge does not know this frame and would stay silent: say so now instead of leaving the sheet to time out.
    if (frame.type === 'heartbeat.test' && !h.bridgeHas(HEARTBEAT_FEATURE)) {
      h.appError(socketId, 'scheduler_unavailable', 'Update Talos on your Mac to test a heartbeat.', frame.id)
      return
    }
    if (frame.type === 'heartbeat.test') {
      const admitted = this.admitTest(socketId, frame)
      if (admitted !== 'forward') {
        if (admitted === 'handled') {
          h.store.rememberSeen(`sf:${frame.id}`)
          h.rememberRef(frame.id, socketId)
          h.appAck(socketId, frame.id)
        }
        return
      }
    } else {
      const limited = this.rateLimit(socketId, frame)
      if (limited) {
        h.appError(socketId, 'rate_limited', limited, frame.id)
        return
      }
    }
    const isRead = frame.type === 'schedules.list' || frame.type === 'schedule.get'
    if (isRead) {
      const want = frame.type === 'schedules.list' ? 'schedules.snapshot' : 'schedule.detail'
      if (!h.requests.expect(socketId, String(frame.request_id), want, frame.id)) {
        h.appError(socketId, 'rate_limited', 'too many schedule requests in flight', frame.id)
        return
      }
    }
    h.store.rememberSeen(`sf:${frame.id}`)
    h.rememberRef(frame.id, socketId)
    h.sendBridge(raw)
  }

  /**
   * `heartbeat.test`, in this order: who owns the request_id, room in flight, THEN the rate-limit token, so a refused request
   * never spends one. 'forward' = new work for the Mac; 'handled' = the same test, already running or already answered, so the
   * Mac is not asked again; 'refused' = the owner was told why.
   */
  private admitTest(
    socketId: string,
    frame: Record<string, unknown> & { id: string },
  ): 'forward' | 'handled' | 'refused' {
    const h = this.h
    const rid = String(frame.request_id)
    if (h.requests.wasDelivered(rid)) return 'handled' // answered already: not run again
    const owner = h.requests.liveOwner(rid)
    if (owner === socketId) return 'handled' // the same socket asking again: it is already running
    if (owner !== undefined) {
      // another socket: refused while that one is connected; once it is gone this is the owner's reconnect, and the answer
      // (kept in memory for the request's lifetime, never stored) goes to the new socket
      if (h.socketLive(owner)) {
        h.appError(socketId, 'bad_frame', 'that request id is already in use', frame.id)
        return 'refused'
      }
      h.requests.rebind(rid, socketId)
      return 'handled'
    }
    if (!h.requests.hasRoom(socketId)) {
      h.appError(socketId, 'rate_limited', 'too many requests in flight', frame.id)
      return 'refused'
    }
    const limited = this.rateLimit(socketId, frame as never)
    if (limited) {
      h.appError(socketId, 'rate_limited', limited, frame.id)
      return 'refused'
    }
    h.requests.expect(socketId, rid, 'heartbeat.test_result', frame.id, HEARTBEAT_ANSWER_TTL_MS, true)
    return 'forward'
  }

  private rateLimit(socketId: string, frame: Record<string, unknown> & { type: OwnerType }): string | null {
    const take = (name: string, key: string) => {
      const r = this.limits.take(name, key)
      return r.ok ? null : `too many requests, try again in ${r.retryAfterS}s`
    }
    switch (frame.type) {
      case 'schedules.list':
      case 'schedule.get':
        return take('sched_read', socketId)
      case 'schedule.patch':
        return take('sched_patch', '*')
      case 'schedule.run_now':
        return take('sched_run_now', '*')
      case 'heartbeat.test':
        return take('heartbeat_test', '*')
      case 'schedule.control':
        return (frame.action === 'retry_headless' ? take('sched_retry', '*') : null) ?? take('sched_control', '*')
    }
  }

  /** schedules.snapshot / schedule.detail: only to the socket that asked; unknown or expired ids are dropped. */
  onBridgeResponse(
    frame: FrameOf<'schedules.snapshot'> | FrameOf<'schedule.detail'> | FrameOf<'heartbeat.test_result'>,
    raw: Record<string, unknown>,
  ): void {
    this.h.requests.onResponse(frame, raw)
  }

  /** schedule.status: to every authed app socket, never stored. An alert may push (S2.2). */
  onStatus(frame: FrameOf<'schedule.status'>, raw: Record<string, unknown>): void {
    this.h.fanOut(raw)
    const alert = frame.alert
    if (!alert) return
    if (this.h.anyVisible()) return
    const key = `sa:${alert.kind}:${alert.key}`
    const last = this.h.store.seenAt(key)
    if (last !== undefined && this.h.clock.now() - last < ALERT_REPEAT_MS) return
    this.h.store.rememberSeen(key)
    const template = alert.kind === 'job_failed' ? 'schedule_failed' : 'scheduler_stuck'
    if (this.h.quietNow()) {
      this.hold(template)
      return
    }
    this.h.notify({ template })
  }

  /** Held through the quiet window like hooks (SPEC 7.4): one push per template once the window ends. */
  private hold(template: PushIntent['template']): void {
    this.held.add(template)
    if (this.holdTimer || this.stopped) return
    const poll = () => {
      this.holdTimer = null
      if (this.stopped) return
      if (this.h.quietNow()) {
        this.holdTimer = this.h.clock.setTimeout(poll, HOLD_POLL_MS)
        this.h.track(this.holdTimer)
        return
      }
      const templates = [...this.held]
      this.held.clear()
      if (!this.h.anyVisible()) for (const template of templates) this.h.notify({ template })
    }
    this.holdTimer = this.h.clock.setTimeout(poll, HOLD_POLL_MS)
    this.h.track(this.holdTimer)
  }

  prune(): void {
    this.h.requests.prune()
  }

  /** Schedule requests in flight (tests). */
  pending(): number {
    return this.h.requests.pending(ANSWERS)
  }
}
