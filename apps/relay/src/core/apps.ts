// MCP Apps relay routing (spec M3.4, M4.6). An app view's `app.request` is signed by a pinned device and goes to the live
// bridge only; the bridge's `app.response` goes back to the socket that asked, by request_id. Neither is ever stored,
// replayed or consumable: with the Mac offline the asker gets `app.response failed mac_offline` at once. Everything an
// app says is third-party code's, so this layer trusts nothing in it beyond the frame schema and the pinned-device check
// the hub already made.
import { RateLimiter } from '../auth/limits.ts'
import type { Clock, Logger } from '../services.ts'
import { mkFrame } from './util.ts'

/** `request_id -> socket` is kept this long (spec M3.4). */
export const APP_REQUEST_MAP_MS = 15 * 60_000
/** Requests in flight per socket; the bridge enforces the real per-view cap of 3. */
export const APP_MAX_IN_FLIGHT_PER_SOCKET = 100

export interface AppsHost {
  clock: Clock
  log: Logger
  bridgeOnline(): boolean
  sendBridge(raw: Record<string, unknown>): void
  /** Sends to one authed app socket; false when it is gone. */
  sendToApp(socketId: string, raw: Record<string, unknown>): boolean
  /** The socket is still connected and authed. */
  socketLive(socketId: string): boolean
  appError(socketId: string, code: string, message: string, ref: string): void
}

type Pending = { socketId: string; viewId: string; at: number }
type RequestFrame = { id: string; view_id: string; request_id: string }
type ResponseFrame = { view_id: string; request_id: string; state: string }

export class AppRouter {
  private reqs = new Map<string, Pending>()
  /** frame id -> the request it carried, so a bridge `error{ref}` for it reaches the asker and is never stored. */
  private byFrame = new Map<string, Pending & { requestId: string }>()
  private limits: RateLimiter

  constructor(private h: AppsHost) {
    this.limits = new RateLimiter(h.clock)
  }

  /** The hub has already checked the session's device against `device_id` and that the socket is pinned. */
  onRequest(socketId: string, frame: RequestFrame, raw: Record<string, unknown>): void {
    const h = this.h
    this.prune()
    const fail = (code: string, message: string): void => {
      h.sendToApp(
        socketId,
        mkFrame(h.clock, 'app.response', {
          view_id: frame.view_id,
          request_id: frame.request_id,
          state: 'failed',
          error: { code, message },
        }),
      )
    }
    // The bridge's error names only the frame id, so an id must map to exactly one request: a reused id (another socket, or
    // the same socket under a new request_id) would steal that error route. An exact resend is absorbed.
    const seen = this.byFrame.get(frame.id)
    if (seen) {
      if (seen.socketId === socketId && seen.requestId === frame.request_id) return
      h.appError(socketId, 'bad_frame', 'frame id already used', frame.id)
      return
    }
    const rate = this.limits.take('app_request', socketId)
    if (!rate.ok) {
      fail('rate_limited', `too many app requests, try again in ${rate.retryAfterS}s`)
      return
    }
    if (!h.bridgeOnline()) {
      fail('mac_offline', 'your Mac is offline')
      return
    }
    const known = this.reqs.get(frame.request_id)
    if (known) {
      // A resend on the same socket gets one answer, not two. Another live socket may not take the id over: it would
      // read (or steal) the answer. A dead socket's id is free (a reconnecting tab retries under the same request_id).
      if (known.socketId === socketId) return
      if (h.socketLive(known.socketId)) {
        h.appError(socketId, 'bad_frame', 'request_id already in use', frame.id)
        return
      }
    }
    let mine = 0
    for (const p of this.reqs.values()) if (p.socketId === socketId) mine++
    if (!known && mine >= APP_MAX_IN_FLIGHT_PER_SOCKET) {
      fail('too_many_pending', 'too many app requests in flight')
      return
    }
    const entry = { socketId, viewId: frame.view_id, at: h.clock.now() }
    this.reqs.set(frame.request_id, entry)
    this.byFrame.set(frame.id, { ...entry, requestId: frame.request_id })
    try {
      h.sendBridge(raw)
    } catch (e) {
      // nothing was sent: do not hold a route for an answer that cannot come
      this.reqs.delete(frame.request_id)
      this.byFrame.delete(frame.id)
      throw e
    }
  }

  /**
   * The bridge's answer: only to the socket that asked, only while the id is known and fresh, only for the view it was
   * asked on. `pending_card` keeps the route (the card's outcome follows); `done` and `failed` end it.
   */
  onResponse(frame: ResponseFrame, raw: Record<string, unknown>): void {
    this.prune()
    const p = this.reqs.get(frame.request_id)
    if (!p) return
    if (p.viewId !== frame.view_id) return
    if (frame.state !== 'pending_card') this.reqs.delete(frame.request_id)
    this.h.sendToApp(p.socketId, raw)
  }

  /**
   * `error{ref}` from the bridge about an app.request it could not take (an older bridge that does not know the frame,
   * `sig_invalid`, a pause). True when the ref was one of ours: the asker gets a failed `app.response` and nothing is
   * stored, so a bridge that cannot do apps cannot fill the owner's thread with "action rejected" rows.
   */
  onError(frame: { ref?: string | undefined; code: string }): boolean {
    if (!frame.ref) return false
    this.prune()
    const f = this.byFrame.get(frame.ref)
    if (!f) return false
    const live = this.reqs.get(f.requestId)
    if (live && live.socketId === f.socketId) {
      this.reqs.delete(f.requestId)
      const known: Record<string, string> = {
        sig_invalid: 'sig_invalid',
        rate_limited: 'rate_limited',
        mac_offline: 'mac_offline',
      }
      this.h.sendToApp(
        f.socketId,
        mkFrame(this.h.clock, 'app.response', {
          view_id: f.viewId,
          request_id: f.requestId,
          state: 'failed',
          error: {
            code: known[frame.code] ?? 'tool_failed',
            message: 'Your Mac could not take this app request. Update Talos on your Mac.',
          },
        }),
      )
    }
    return true
  }

  /** A socket closed: its answers have nowhere to go. */
  dropSocket(socketId: string): void {
    for (const [rid, p] of this.reqs) if (p.socketId === socketId) this.reqs.delete(rid)
    for (const [fid, f] of this.byFrame) if (f.socketId === socketId) this.byFrame.delete(fid)
  }

  prune(): void {
    const now = this.h.clock.now()
    for (const [rid, p] of this.reqs) {
      if (p.at > now)
        p.at = now // the clock stepped back: age from now, so the entry still expires (never lives forever)
      else if (now - p.at > APP_REQUEST_MAP_MS) this.reqs.delete(rid)
    }
    for (const [fid, f] of this.byFrame) {
      if (f.at > now) f.at = now
      else if (now - f.at > APP_REQUEST_MAP_MS) this.byFrame.delete(fid)
    }
  }

  /** Requests in flight (tests). */
  pending(): number {
    return this.reqs.size
  }
}
