// The ONE request router for ephemeral app -> bridge reads (docs/V2-FEATURES.md V1.3, review finding 8). A signed read
// goes to the live bridge WITHOUT appendEvent; its answer goes back to the asking socket only, by request_id, within
// 30 s. Nothing here is ever stored: no event, no outbox row, no seen id. With the Mac offline the app gets
// `error{ref, mac_offline}` at once.
//
// Search and memory register here (WP-V0). Schedules (WP-S2) keep their own owner-frame rules in core/schedules.ts (seen
// ids, acks, rate limits) but their request_id map lives here: ScheduleRouter calls `expect()` and the hub routes
// `schedules.snapshot` / `schedule.detail` through `onResponse()`.
import { RateLimiter } from '../auth/limits.ts'
import type { Clock, Logger } from '../services.ts'

/** A request_id is answerable for 30 s. */
export const EPHEMERAL_TTL_MS = 30_000
/** Requests in flight per socket. */
export const EPHEMERAL_MAX_PER_SOCKET = 100
/** How long a routed frame id is remembered, so a late `error{ref}` is still recognised (and dropped, never stored). */
const FRAME_MEMORY_MS = 10 * 60_000

export interface EphemeralHost {
  clock: Clock
  log: Logger
  bridgeOnline(): boolean
  sendBridge(raw: Record<string, unknown>): void
  /** Sends to one authed app socket; false when it is gone. */
  sendToApp(socketId: string, raw: Record<string, unknown>): boolean
  appError(socketId: string, code: string, message: string, ref: string): void
}

type Route = { response: string; limit: string | null }
type Pending = { socketId: string; at: number; want: string; frameId: string }

export class EphemeralRouter {
  private routes = new Map<string, Route>()
  private responses = new Set<string>()
  private reqs = new Map<string, Pending>()
  /** frame id -> request_id, so an `error{ref}` from the bridge reaches the asker and is never stored. */
  private byFrame = new Map<string, { rid: string; at: number }>()
  private limits: RateLimiter

  constructor(private h: EphemeralHost) {
    this.limits = new RateLimiter(h.clock)
  }

  /** `limit` names a per-socket bucket in auth/limits.ts (null = none). */
  register(requestType: string, responseType: string, limit: string | null = null): void {
    this.routes.set(requestType, { response: responseType, limit })
    this.responses.add(responseType)
  }

  handles(type: string): boolean {
    return this.routes.has(type)
  }
  answers(type: string): boolean {
    return this.responses.has(type)
  }

  /** The hub has already checked the session's device against `device_id`. */
  onRequest(socketId: string, frame: { id: string; type: string; request_id: string }, raw: Record<string, unknown>) {
    const h = this.h
    const route = this.routes.get(frame.type)
    if (!route) return
    if (!h.bridgeOnline()) return h.appError(socketId, 'mac_offline', 'your Mac is offline', frame.id)
    if (route.limit) {
      const r = this.limits.take(route.limit, socketId)
      if (!r.ok)
        return h.appError(socketId, 'rate_limited', `too many requests, try again in ${r.retryAfterS}s`, frame.id)
    }
    this.prune()
    if (this.reqs.has(frame.request_id)) return // a resend of a request already in flight: one answer comes back
    let mine = 0
    for (const p of this.reqs.values()) if (p.socketId === socketId) mine++
    if (mine >= EPHEMERAL_MAX_PER_SOCKET)
      return h.appError(socketId, 'rate_limited', 'too many requests in flight', frame.id)
    this.reqs.set(frame.request_id, { socketId, at: h.clock.now(), want: route.response, frameId: frame.id })
    this.byFrame.set(frame.id, { rid: frame.request_id, at: h.clock.now() })
    h.sendBridge(raw)
  }

  /**
   * Records a request another module forwards itself (Schedules): its answer of type `want` is routed back by request_id
   * like any other. False when the socket already has EPHEMERAL_MAX_PER_SOCKET requests in flight.
   */
  expect(socketId: string, requestId: string, want: string, frameId: string): boolean {
    this.prune()
    let mine = 0
    for (const p of this.reqs.values()) if (p.socketId === socketId) mine++
    if (mine >= EPHEMERAL_MAX_PER_SOCKET) return false
    this.reqs.set(requestId, { socketId, at: this.h.clock.now(), want, frameId })
    this.byFrame.set(frameId, { rid: requestId, at: this.h.clock.now() })
    return true
  }

  /** An answer from the bridge: only to the socket that asked; unknown, expired or wrong-type answers are dropped. */
  onResponse(frame: { type: string; request_id: string }, raw: Record<string, unknown>): void {
    const p = this.reqs.get(frame.request_id)
    if (!p) return
    if (this.h.clock.now() - p.at > EPHEMERAL_TTL_MS) {
      this.forget(frame.request_id)
      return
    }
    if (p.want !== frame.type) return
    this.forget(frame.request_id)
    this.h.sendToApp(p.socketId, raw)
  }

  /**
   * `error{ref}` from the bridge for a routed read. Returns true when it was one of ours (delivered to the asker if it is
   * still connected, else dropped): such an error never becomes a stored system message.
   */
  onError(ref: string, raw: Record<string, unknown>): boolean {
    const known = this.byFrame.get(ref)
    if (known === undefined) return false
    const p = this.reqs.get(known.rid)
    // The entry is left to expire on its TTL, as WP-S2's map did: the error reaches the asker, nothing else changes.
    if (p && p.frameId === ref && this.h.clock.now() - p.at <= EPHEMERAL_TTL_MS) this.h.sendToApp(p.socketId, raw)
    return true
  }

  /** A socket closed: its requests can never be answered. */
  dropSocket(socketId: string): void {
    for (const [rid, p] of this.reqs) if (p.socketId === socketId) this.forget(rid)
  }

  prune(): void {
    const now = this.h.clock.now()
    for (const [rid, p] of this.reqs) if (p.at < now - EPHEMERAL_TTL_MS) this.forget(rid)
    for (const [id, f] of this.byFrame) if (f.at < now - FRAME_MEMORY_MS) this.byFrame.delete(id)
  }

  /** Requests in flight (tests); `wants` narrows to those answered by these frame types. */
  pending(wants?: readonly string[]): number {
    if (!wants) return this.reqs.size
    let n = 0
    for (const p of this.reqs.values()) if (wants.includes(p.want)) n++
    return n
  }

  private forget(rid: string) {
    this.reqs.delete(rid)
  }
}
