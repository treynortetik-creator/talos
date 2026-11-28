// The Mac's side of the terminal view (piece 1: the owner watches the agent's tmux pane, read-only; docs/PROTOCOL.md, "The
// terminal stream"). One control-mode client per watched session (control.ts), one 256 KiB ring per watched session shared by
// its viewers (ring.ts), memory only; a credit window per viewer; the pane is NEVER stalled: output is always read and the
// ring keeps filling, and a viewer that cannot keep up gets a fresh keyframe (a skip ahead) instead of the bytes it missed.
//
// The offsets: the stream's absolute byte offset counts every `%output` byte of the pane. `term.out{at}` carries the offset of its
// first byte; `term.key{at}` is a picture exact for `at`; `term.ack{upto}` and `term.resume{from}` are in the same offsets.
// There is no typing path here: nothing in this file writes to a pane, and the control client's stdin takes only the read commands of control.ts (writeControl).
//
// Time goes through the bridge's clock only (the 16 ms coalescing, the idle and the maximum time), so a test drives it with a
// fake one. The frames that open, resume and close a view were verified by the caller (inbound-term.ts): signature, pinned
// device, freshness, and an id never seen before.
import {
  b64urlEncode,
  type Frame,
  newUlid,
  TERM_COALESCE_MS,
  TERM_IDLE_S,
  TERM_KEY_MAX_BYTES,
  TERM_MAX_OPEN,
  TERM_MAX_S,
  TERM_OPEN_MAX_AGE_MS,
  TERM_OUT_MAX_BYTES,
  TERM_RING_BYTES,
  TERM_WINDOW_BYTES,
  TERM_WINDOW_FRAMES,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import type { Logger } from '../log.ts'
import type { TermAudit } from './audit.ts'
import type { OpenSource, PaneSource } from './control.ts'
import { Ring } from './ring.ts'

type Watch = {
  session: string
  source: PaneSource
  ring: Ring
  views: Set<View>
  flush: unknown
}

type View = {
  termId: string
  deviceId: string
  target: string
  watch: Watch
  /** The next offset to send, and the offset the page has acked up to, and where each frame not yet acked ends. */
  next: number
  acked: number
  inflight: number[]
  needKey: boolean
  keying: boolean
  lastKeyAt: number
  rapidKeys: number
  keyWait: unknown
  /** The last picture had to wait for the gap (so it does not start the count over). */
  waited: boolean
  /** Who needs the next keyframe: the page (a resume), or the Mac (an overrun, a resize, the first one). Only the page's count against it. */
  keyFor: 'page' | 'mac'
  idle: unknown
  max: unknown
  bytes: number
  frames: number
  closed: boolean
}

export type TermServiceDeps = {
  clock: Clock
  log: Logger
  /** Sends a frame to the relay without storing it; false when the relay is not connected. */
  send(frame: Frame): boolean
  openSource: OpenSource
  audit: TermAudit
  /** The tmux session a target names (`main` or a thread id), or null when it has none to show. */
  sessionOf(target: string): string | null
  /** Is this device still pinned and not revoked? Asked now and then while its views are open. Absent: always. */
  deviceOk?(deviceId: string): boolean
  idleS?: number
  maxS?: number
}

/** A keyframe asked for sooner than this after the last one waits; a viewer that keeps asking is closed (why `keyframe`). */
export const KEY_MIN_GAP_MS = 2000
const KEY_RAPID_MAX = 5
const GONE_MAX = 1000
const DEVICE_CHECK_MS = 1000

const env = (clock: Clock) => ({ v: 1 as const, id: newUlid(), ts: new Date(clock.now()).toISOString() })

export class TermService {
  readonly available = true
  private views = new Map<string, View>()
  private watches = new Map<string, Watch>()
  private opening = new Map<string, Promise<Watch | 'no_pane' | 'unavailable'>>()
  private stopped = false
  /**
   * Views the relay said are gone (their page's socket closed) before their open was handled: that frame is handled at once, while an
   * open waits for its signature check. Remembered for the two minutes an open stays valid, so a tap-then-leave opens nothing and
   * holds no tmux client for nobody.
   */
  private gone = new Map<string, number>()
  /** Opens that passed their check and are waiting for a control client to start, by session: a watch they are about to join is not idle. */
  private starting = new Map<string, number>()

  constructor(private d: TermServiceDeps) {
    d.audit.closeOrphans(d.clock.now())
  }

  // ---- what a test or the status line may read --------------------------------------------------------------------

  goneCount(): number {
    return this.gone.size
  }
  viewCount(): number {
    return this.views.size
  }
  watchCount(): number {
    return this.watches.size
  }
  /** The stream offset reached on a session's pane (how many output bytes were read), or null when it is not watched. */
  head(session: string): number | null {
    return this.watches.get(session)?.ring.head ?? null
  }
  /** Where a view's next frame starts and where the page has acked to; null for an id that is not open. */
  position(termId: string): { next: number; acked: number; inflight: number } | null {
    const v = this.views.get(termId)
    return v ? { next: v.next, acked: v.acked, inflight: v.inflight.length } : null
  }

  // ---- frames from the page (verified by the caller) ---------------------------------------------------------------

  async open(frame: { term_id: string; target: string }, deviceId: string): Promise<void> {
    const d = this.d
    const termId = frame.term_id
    if (this.stopped) return void this.sendClosed(termId, 'restart')
    const left = this.gone.get(termId)
    if (left !== undefined && d.clock.now() - left <= TERM_OPEN_MAX_AGE_MS)
      return void this.sendClosed(termId, 'refused')
    const same = this.views.get(termId)
    if (same) {
      // The closed we answer makes the relay drop its binding for this id, so the view that holds it ends too: relay and Mac stay in step.
      d.log.security('terminal open repeats an id in use', { term_id: termId })
      return void this.closeView(same, 'refused', true)
    }
    if (this.views.size >= TERM_MAX_OPEN) return void this.sendClosed(termId, 'too_many')
    const session = d.sessionOf(frame.target)
    if (!session) return void this.sendClosed(termId, 'no_pane')
    // Counted before the first await: two opens at once must not both pass the limit.
    const reserve: View = {
      termId,
      deviceId,
      target: frame.target,
      watch: undefined as unknown as Watch,
      next: 0,
      acked: 0,
      inflight: [],
      needKey: true,
      keying: false,
      lastKeyAt: Number.NEGATIVE_INFINITY,
      rapidKeys: 0,
      keyWait: null,
      waited: false,
      keyFor: 'mac',
      idle: null,
      max: null,
      bytes: 0,
      frames: 0,
      closed: false,
    }
    this.views.set(termId, reserve)
    this.starting.set(session, (this.starting.get(session) ?? 0) + 1)
    const watch = await this.watchFor(session)
    const stillStarting = (this.starting.get(session) ?? 1) - 1
    if (stillStarting > 0) this.starting.set(session, stillStarting)
    else this.starting.delete(session)
    if (watch === 'no_pane' || watch === 'unavailable' || this.stopped || reserve.closed) {
      if (this.views.get(termId) === reserve) this.views.delete(termId)
      if (!reserve.closed)
        this.sendClosed(termId, watch === 'no_pane' ? 'no_pane' : watch === 'unavailable' ? 'unsupported' : 'restart')
      // the viewer left (or the Mac stopped) while the control client was starting: it must not be left running for nobody
      if (watch !== 'no_pane' && watch !== 'unavailable') this.dropIfEmpty(watch)
      return
    }
    reserve.watch = watch
    watch.views.add(reserve)
    const idleMs = (d.idleS ?? TERM_IDLE_S) * 1000
    const maxMs = (d.maxS ?? TERM_MAX_S) * 1000
    reserve.idle = d.clock.setTimeout(() => this.closeView(reserve, 'idle', true), idleMs)
    reserve.max = d.clock.setTimeout(() => this.closeView(reserve, 'max', true), maxMs)
    d.audit.open({ term_id: termId, tier: 'view', device_id: deviceId, target: frame.target, opened_at: d.clock.now() })
    const size = watch.source.size()
    d.send({
      ...env(d.clock),
      type: 'term.opened',
      term_id: termId,
      tier: 'view',
      cols: size.cols,
      rows: size.rows,
      idle_s: d.idleS ?? TERM_IDLE_S,
      max_s: d.maxS ?? TERM_MAX_S,
    })
    this.pump(reserve)
  }

  /** The page asks again from offset `from` (after a lag, or a reconnect on the same connection). */
  resume(termId: string, from: number, deviceId: string): void {
    const v = this.views.get(termId)
    if (!v || v.closed || !v.watch) return
    if (v.deviceId !== deviceId)
      return void this.d.log.security('terminal resume from another device', { term_id: termId })
    this.touch(v)
    const ring = v.watch.ring
    v.acked = from
    v.inflight = []
    if (from >= ring.start && from <= ring.head) {
      v.next = from
      v.needKey = false
    } else {
      v.needKey = true // fallen out of the ring (or from an offset this stream never reached): a fresh keyframe
      v.keyFor = 'page'
    }
    this.pump(v)
  }

  /** The owner closed the view. */
  close(termId: string, deviceId: string): void {
    const v = this.views.get(termId)
    if (!v || v.closed) return
    if (v.deviceId !== deviceId)
      return void this.d.log.security('terminal close from another device', { term_id: termId })
    this.closeView(v, 'closed', false)
  }

  /** The credit: the page has drawn up to `upto`. Also its sign of life (a page that is looking sends it now and then). */
  ack(termId: string, upto: number): void {
    const v = this.views.get(termId)
    if (!v || v.closed || !v.watch) return
    this.touch(v)
    this.sweepDevices()
    if (upto > v.acked) v.acked = Math.min(upto, v.next)
    v.inflight = v.inflight.filter((end) => end > v.acked)
    this.pump(v)
  }

  /** The relay says the viewer's connection closed: nobody is there. Said once, and not answered. */
  viewerGone(termId: string, why: string): void {
    const now = this.d.clock.now()
    for (const [id, at] of this.gone) if (now - at > TERM_OPEN_MAX_AGE_MS) this.gone.delete(id)
    // bounded: when full the oldest goes (a Map keeps insertion order)
    while (this.gone.size >= GONE_MAX) this.gone.delete(this.gone.keys().next().value as string)
    this.gone.set(termId, now)
    const v = this.views.get(termId)
    if (v && !v.closed) this.closeView(v, why === 'mac_offline' ? 'mac_offline' : 'socket_closed', false)
  }

  /** A device was revoked: its views end at once, and each page is told. */
  endDevice(deviceId: string): void {
    for (const v of [...this.views.values()]) if (v.deviceId === deviceId) this.closeView(v, 'revoked', true)
    this.sweepWatches()
  }

  private lastDeviceCheck = Number.NEGATIVE_INFINITY
  /** A revoke made where this process cannot be told (the devices file, from the CLI) is noticed here, at most once a second. */
  private sweepDevices(): void {
    const now = this.d.clock.now()
    if (!this.d.deviceOk || now - this.lastDeviceCheck < DEVICE_CHECK_MS) return
    this.lastDeviceCheck = now
    for (const v of [...this.views.values()]) if (!this.d.deviceOk(v.deviceId)) this.closeView(v, 'revoked', true)
  }

  /** Every view ends (the relay's socket closed: its pages are gone, so nobody can be told). New views may open later. */
  endAll(why: string, tell: boolean): void {
    for (const v of [...this.views.values()]) this.closeView(v, why, tell)
    this.sweepWatches()
  }

  /** A watch with no viewer and no open about to join it stops its control client (a view closed while it was still starting). */
  private sweepWatches(): void {
    for (const w of [...this.watches.values()]) this.dropIfEmpty(w)
  }
  private dropIfEmpty(w: Watch): void {
    if (w.views.size === 0 && (this.starting.get(w.session) ?? 0) === 0) this.dropWatch(w)
  }

  /** The bridge is stopping: every view ends, each page is told while it still can be, and no new one opens. */
  stopAll(why = 'restart'): void {
    this.stopped = true
    this.endAll(why, true)
  }

  // ---- the watch of one session ------------------------------------------------------------------------------------

  private watchFor(session: string): Promise<Watch | 'no_pane' | 'unavailable'> {
    const have = this.watches.get(session)
    if (have) return Promise.resolve(have)
    let p = this.opening.get(session)
    if (!p) {
      p = this.d.openSource(session).then((s) => {
        this.opening.delete(session)
        if ('error' in s) return s.error === 'unavailable' ? ('unavailable' as const) : ('no_pane' as const)
        const watch: Watch = { session, source: s, ring: new Ring(TERM_RING_BYTES), views: new Set(), flush: null }
        this.watches.set(session, watch)
        s.onOutput((data) => {
          watch.ring.push(data)
          // coalesced: at most one flush per 16 ms, whatever the pane prints
          watch.flush ??= this.d.clock.setTimeout(() => {
            watch.flush = null
            this.sweepDevices()
            for (const v of [...watch.views]) this.pump(v)
          }, TERM_COALESCE_MS)
        })
        s.onResize(() => {
          // The pane's size changed under the view (the Mac's own window, never a remote one: a remote viewer cannot resize it).
          // Each page is told the new size and then gets a fresh picture.
          for (const v of [...watch.views]) {
            const size = s.size()
            this.d.send({
              ...env(this.d.clock),
              type: 'term.opened',
              term_id: v.termId,
              tier: 'view',
              cols: size.cols,
              rows: size.rows,
              idle_s: this.d.idleS ?? TERM_IDLE_S,
              max_s: this.d.maxS ?? TERM_MAX_S,
            })
            v.needKey = true
            v.keyFor = 'mac'
            v.inflight = []
            v.acked = v.next
            this.pump(v)
          }
        })
        s.onEnd(() => {
          for (const v of [...watch.views]) this.closeView(v, 'pane_gone', true)
          this.dropWatch(watch)
        })
        return watch
      })
      this.opening.set(session, p)
    }
    return p
  }

  private dropWatch(w: Watch): void {
    if (this.watches.get(w.session) === w) this.watches.delete(w.session)
    if (w.flush) this.d.clock.clearTimeout(w.flush)
    w.flush = null
    w.source.close()
  }

  // ---- sending -----------------------------------------------------------------------------------------------------

  private pump(v: View): void {
    if (v.closed || !v.watch) return
    const ring = v.watch.ring
    for (;;) {
      if (v.inflight.length >= TERM_WINDOW_FRAMES) return // window full: the pane is still read, the ring keeps filling
      if (!v.needKey && v.next < ring.start) {
        v.needKey = true
        v.keyFor = 'mac'
      } // the ring has moved past what this viewer has not been sent
      if (v.needKey) {
        if (!v.keying && !this.keyGate(v)) void this.sendKey(v)
        return
      }
      const room = v.acked + TERM_WINDOW_BYTES - v.next
      if (v.next >= ring.head || room <= 0) return
      const data = ring.slice(v.next, Math.min(TERM_OUT_MAX_BYTES, room))
      this.d.send({
        ...env(this.d.clock),
        type: 'term.out',
        term_id: v.termId,
        at: v.next,
        bytes_b64: b64urlEncode(data),
      })
      v.next += data.length
      v.inflight.push(v.next)
      v.bytes += data.length
      v.frames++
    }
  }

  /**
   * True while a keyframe must wait: one was sent less than KEY_MIN_GAP_MS ago. The wait is a timer, and a viewer that has to wait
   * again and again (KEY_RAPID_MAX times in a row) is not served forever: its view closes with why `keyframe`.
   */
  private keyGate(v: View): boolean {
    const wait = v.lastKeyAt + KEY_MIN_GAP_MS - this.d.clock.now()
    if (wait <= 0) return false
    if (v.keyWait === null) {
      // Only a viewer that keeps asking is counted: a keyframe the Mac needs (an overrun on a fast log, a window being dragged) is
      // paced by the gap, which caps its cost at one per KEY_MIN_GAP_MS, and never closes a viewer that did nothing.
      if (v.keyFor === 'page' && ++v.rapidKeys > KEY_RAPID_MAX) {
        this.closeView(v, 'keyframe', true)
        return true
      }
      v.waited = true
      v.keyWait = this.d.clock.setTimeout(() => {
        v.keyWait = null
        this.pump(v)
      }, wait)
    }
    return true
  }

  private async sendKey(v: View): Promise<void> {
    v.keying = true
    let snap: Awaited<ReturnType<PaneSource['snapshot']>> = null
    try {
      snap = await v.watch.source.snapshot()
    } catch (e) {
      this.d.log.warn('terminal keyframe failed', { error: (e as Error).message })
    }
    v.keying = false
    if (v.closed) return
    if (!snap) return // tmux did not answer: the pane's end, if that is it, closes the view through onEnd
    if (snap.bytes.length > TERM_KEY_MAX_BYTES) {
      // the source cuts a picture to fit, so this is a bug and not a pane: never send what the relay and the page refuse
      this.d.log.warn('terminal keyframe over the cap; view closed', { bytes: snap.bytes.length })
      this.closeView(v, 'keyframe', true)
      return
    }
    if (!v.waited) v.rapidKeys = 0 // asked after the gap on its own: not asking again and again, so the count starts over
    v.waited = false
    v.lastKeyAt = this.d.clock.now()
    this.d.send({
      ...env(this.d.clock),
      type: 'term.key',
      term_id: v.termId,
      at: snap.at,
      bytes_b64: b64urlEncode(snap.bytes),
    })
    v.bytes += snap.bytes.length
    v.frames++
    // the picture replaces everything before it: the stream goes on from `at`, and the credit counts from there
    v.next = snap.at
    v.acked = snap.at
    v.inflight = [snap.at]
    v.needKey = false
    v.keyFor = 'mac'
    this.pump(v)
  }

  private sendClosed(termId: string, why: string): void {
    this.d.send({ ...env(this.d.clock), type: 'term.closed', term_id: termId, why })
  }

  // ---- ending ------------------------------------------------------------------------------------------------------

  /** Any word from the page moves the idle time on. */
  private touch(v: View): void {
    this.d.clock.clearTimeout(v.idle)
    v.idle = this.d.clock.setTimeout(() => this.closeView(v, 'idle', true), (this.d.idleS ?? TERM_IDLE_S) * 1000)
  }

  private closeView(v: View, why: string, tell: boolean): void {
    if (v.closed) return
    v.closed = true
    this.d.clock.clearTimeout(v.idle)
    this.d.clock.clearTimeout(v.max)
    this.d.clock.clearTimeout(v.keyWait)
    if (this.views.get(v.termId) === v) this.views.delete(v.termId)
    if (tell) this.sendClosed(v.termId, why)
    if (!v.watch) return
    this.d.audit.close(v.termId, this.d.clock.now(), why, v.bytes, v.frames)
    v.watch.views.delete(v)
    this.dropIfEmpty(v.watch) // the last viewer left: the control client stops
  }
}
