// Signed history reads and media re-uploads, routed to the Mac and the answer routed back to the asking socket.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks are in hub.ts; some
// handlers here run their own device, seen-id, step-up or card-state checks, so read both when auditing trust.
import type { FrameOf, MessageT } from '@talos-app/protocol'
import type { RateLimiter } from '../auth/limits.ts'
import type { AppConn, HubDeps, Ref } from './hub.ts'
import type { StoredFrame } from './store.ts'
import { mkFrame } from './util.ts'

/** What the history handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type HistoryCtx = {
  d: HubDeps
  historyReqs: Map<string, Ref & { frameId: string }>
  historyFrameIds: Map<string, number>
  readLimits: RateLimiter
  ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean
  appError(a: AppConn, code: string, message: string, ref?: unknown): void
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  sendBridge(frame: Record<string, unknown>): void
  rememberRef(frameId: string, a: AppConn, threadId: string | null, volatile?: boolean): void
  bridgeOnline(): boolean
  pruneHistoryReqs(): void
  eventMessage(f: StoredFrame): MessageT | null
  readBudget(a: AppConn, name: 'history' | 'media_fetch', ref: string): boolean
}

export const historyFrames = {
  /** Takes one token from this socket's `name` bucket; at the limit the app is told and the frame goes no further. */
  readBudget(this: HistoryCtx, a: AppConn, name: 'history' | 'media_fetch', ref: string): boolean {
    const r = this.readLimits.take(name, a.id)
    if (r.ok) return true
    this.appError(a, 'rate_limited', `too many requests, try again in ${r.retryAfterS}s`, ref)
    return false
  },

  history(this: HistoryCtx, a: AppConn, frame: FrameOf<'history.request'>, raw: Record<string, unknown>): void {
    const store = this.d.store
    // A signed request must come from this session's own device (the Mac checks the signature itself; this stops a
    // session from relaying another device's frame). An unsigned one (an old app) is forwarded: the Mac answers it with
    // an "update the app" error and no data.
    if (frame.device_id !== undefined && !this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    // Every signed read has a per-socket budget; history had only the 30 frames/s one, so a stolen session cookie could
    // keep the Mac's read queue busy with forged requests.
    if (!this.readBudget(a, 'history', frame.id)) return
    // A request id is good once, whichever side answers. The Mac refuses a reused id for the pages it serves; the pages
    // the relay serves from its own buffer (scroll-back by seq) had no such check, so captured bytes sent again on a new
    // socket were answered. Same code and words as the Mac's refusal, to the asker only, nothing stored.
    // Kept in the store, not in memory: it survives a restart and the 5000-id cap, and the sweeper ages it out.
    if (store.seen(`hq:${frame.id}`) !== undefined) {
      this.appError(a, 'sig_invalid', 'That request was already used.', frame.id)
      return
    }
    store.rememberSeen(`hq:${frame.id}`)
    this.historyFrameIds.set(frame.id, this.d.clock.now())
    // The search context view (docs/V2-FEATURES.md V3.2): paging by message id is the Mac's, always forwarded.
    if (frame.before_id !== undefined || frame.after_id !== undefined || frame.around_id !== undefined) {
      if (!this.bridgeOnline()) {
        this.sendApp(
          a,
          mkFrame(this.d.clock, 'history.page', {
            request_id: frame.request_id,
            thread_id: frame.thread_id,
            messages: [],
            has_more: false,
            unavailable: 'mac_offline',
          }),
        )
        return
      }
      this.pruneHistoryReqs()
      this.historyFrameIds.set(frame.id, this.d.clock.now())
      this.historyReqs.set(frame.request_id, {
        socketId: a.id,
        threadId: frame.thread_id,
        at: this.d.clock.now(),
        frameId: frame.id,
      })
      this.sendBridge(raw)
      return
    }
    let before: number | null = frame.before_seq ?? null
    if (before === null && frame.before_ts) {
      const r = store.db
        .prepare('select min(seq) m from core_events where created_at >= ?')
        .get(Date.parse(frame.before_ts)) as { m: number | null }
      before = r.m
    }
    const rows = store.threadEvents(frame.thread_id, before, frame.limit + 1)
    const page = rows.slice(0, frame.limit).reverse()
    const messages = page.map((f) => this.eventMessage(f)).filter((m): m is MessageT => m !== null)
    const respond = (extra: Record<string, unknown>) =>
      this.sendApp(
        a,
        mkFrame(this.d.clock, 'history.page', {
          request_id: frame.request_id,
          thread_id: frame.thread_id,
          messages,
          has_more: false,
          ...extra,
        }),
      )
    if (rows.length > frame.limit) {
      respond({ has_more: true })
      return
    }
    if (store.floor() === null) {
      respond({})
      return
    } // nothing was ever pruned: the buffer holds the whole history
    if (!this.bridgeOnline()) {
      respond({ unavailable: 'mac_offline' })
      return
    }
    this.pruneHistoryReqs()
    this.historyFrameIds.set(frame.id, this.d.clock.now())
    this.historyReqs.set(frame.request_id, {
      socketId: a.id,
      threadId: frame.thread_id,
      at: this.d.clock.now(),
      frameId: frame.id,
    })
    this.sendBridge(raw)
  },

  /** The `media.fetch` frame: device check, read budget, id check, then forwarded to the Mac. The `case` of that name in Hub.onAppFrameBuiltin. */
  onMediaFetch(this: HistoryCtx, a: AppConn, frame: FrameOf<'media.fetch'>, raw: Record<string, unknown>) {
    const store = this.d.store
    // Signed like a history read: this session's own device only. An unsigned one (an old app) is forwarded; the Mac
    // answers it with an "update the app" error and uploads nothing.
    if (frame.device_id !== undefined && !this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    if (!this.readBudget(a, 'media_fetch', frame.id)) return
    // A frame id the store already holds belongs to a stored frame (a card decision, a message): never reuse it.
    if (store.getEventByFrameId(frame.id))
      return this.appError(a, 'bad_frame', 'that request id is already used', frame.id)
    if (!this.bridgeOnline()) return this.appError(a, 'mac_offline', 'your Mac is offline', frame.id)
    this.rememberRef(frame.id, a, null, true) // the Mac's refusal goes back to this socket, never into a thread
    return this.sendBridge(raw)
  },
}
