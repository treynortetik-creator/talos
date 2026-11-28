// The remote terminal's view through the relay (docs/PROTOCOL.md, "The terminal stream"). The owner watches the agent's tmux
// pane from the web or the phone, read-only. Like ephemeral.ts nothing here is ever stored: no appendEvent, no outbox row, no
// push, no `relay.seq`, no seen id, and nothing is re-sent when the Mac says hello again. Unlike ephemeral.ts it is a
// subscription: one `term_id` is bound to one app socket and the one device behind it, from the signed `term.open` until the Mac
// ends it, the owner closes it, the socket closes or the Mac goes away. What the Mac sends for an id goes to that socket and
// no other.
//
// Flow control. The Mac keeps a credit window per viewer (8 frames or 64 KiB not yet acked) and never stops reading the pane. The
// relay checks the same window on what it forwards, and the socket's own backlog: a socket with more than 512 KiB waiting, or
// a Mac that sends past the window, gets `term.closed{why:'lag'}` once and no more output for that id until the page resumes by
// offset (`term.resume`). That socket only: the view stays open at the Mac, the pane and the other viewers are unaffected.
import {
  TERM_MAX_OPEN,
  TERM_OPEN_MAX_AGE_MS,
  TERM_SOCKET_BUFFER_MAX,
  TERM_VIEW_FEATURE,
  TERM_WINDOW_BYTES,
  TERM_WINDOW_FRAMES,
} from '@talos-app/protocol'
import type { Clock, Logger } from '../services.ts'
import { mkFrame } from './util.ts'

export interface TermHost {
  clock: Clock
  log: Logger
  bridgeOnline(): boolean
  /** The live Mac lists this feature in its hello. */
  bridgeHas(feature: string): boolean
  sendBridge(raw: Record<string, unknown>): void
  /** Sends to one authed app socket; false when it is gone. */
  sendToApp(socketId: string, raw: Record<string, unknown>): boolean
  appError(socketId: string, code: string, message: string, ref: string): void
  /** Bytes the socket has queued and not yet written; 0 when the socket cannot say. */
  buffered(socketId: string): number
}

type Sub = {
  socketId: string
  /** The device behind the socket when the view was opened: the only device that may resume or close it. */
  deviceId: string
  /** The open frame's id, so a Mac `error{ref}` about it reaches the asker. */
  openFrameId: string
  opened: boolean
  /** The relay has dropped output for this id and said so; nothing more goes until `term.resume`. */
  lagging: boolean
  /** Where the page has acked up to, the offset the last forwarded frame reached, and the end offset of each frame not yet acked. */
  acked: number
  reach: number
  inflight: number[]
}

/** Frame ids remembered at once (within the open window); a frame past it is refused, never traded for an older id. */
export const TERM_FORWARDED_MAX = 256

/** The raw length of a base64url string with no padding. */
const rawLen = (chars: number): number => Math.floor((chars * 3) / 4)

export class TermRouter {
  private subs = new Map<string, Sub>()
  /**
   * Every term frame id this relay passed to the Mac, with the socket that sent it, for the TERM_OPEN_MAX_AGE_MS an open stays valid:
   * an `error{ref}` for one of them (a refused resume or close, an open refused after its socket closed) goes to that socket if it is
   * still there and is otherwise dropped. It must never fall through to the chat path, which would store it as a system message.
   */
  private forwarded = new Map<string, { socketId: string; at: number }>()

  constructor(private h: TermHost) {}

  /** Views open now (tests, and the limit). */
  count(): number {
    return this.subs.size
  }

  /** `term.open`, `term.resume` or `term.close` from an app socket whose device the hub has checked against `device_id`. */
  onApp(
    socketId: string,
    deviceId: string,
    frame: { id: string; type: string; term_id: string; from?: number },
    raw: Record<string, unknown>,
  ): void {
    const h = this.h
    const sub = this.subs.get(frame.term_id)
    if (frame.type === 'term.open') {
      this.open(socketId, deviceId, frame, raw)
      return
    }
    const via = (f: Record<string, unknown>) => {
      this.remember(frame.id, socketId)
      h.sendBridge(f)
    }
    // resume and close act only on a view this very socket opened, signed by the device that opened it
    if (!sub || sub.socketId !== socketId || sub.deviceId !== deviceId) {
      h.appError(socketId, 'bad_frame', 'that terminal is not open on this connection', frame.id)
      return
    }
    if (!h.bridgeOnline()) {
      this.end(frame.term_id, 'mac_offline', true)
      return
    }
    // a close is never refused for room: a full set (one page's resume loop can fill it) must not keep another view running. It is
    // still remembered, so its refusal is routed and never stored. Bounded: each close ends a view, and views come only from opens,
    // which room() still gates.
    if (frame.type === 'term.close') {
      via(raw)
      this.subs.delete(frame.term_id)
      return
    }
    if (!this.room()) {
      h.appError(socketId, 'rate_limited', 'too many terminal requests; try again in a moment', frame.id)
      return
    }
    // resume: output may flow again from the offset the page asked for
    sub.lagging = false
    sub.inflight = []
    sub.acked = frame.from ?? 0
    sub.reach = frame.from ?? 0
    via(raw)
  }

  /** Room for one more remembered id once the expired ones are gone. A full set refuses the new frame: an old id is never traded for it. */
  private room(): boolean {
    const now = this.h.clock.now()
    for (const [id, f] of this.forwarded) if (now - f.at > TERM_OPEN_MAX_AGE_MS) this.forwarded.delete(id)
    return this.forwarded.size < TERM_FORWARDED_MAX
  }

  private remember(frameId: string, socketId: string): void {
    this.forwarded.set(frameId, { socketId, at: this.h.clock.now() })
  }

  private open(
    socketId: string,
    deviceId: string,
    frame: { id: string; term_id: string },
    raw: Record<string, unknown>,
  ) {
    const h = this.h
    if (!h.bridgeOnline()) return h.appError(socketId, 'mac_offline', 'your Mac is offline', frame.id)
    if (this.subs.has(frame.term_id)) return h.appError(socketId, 'bad_frame', 'that terminal id is in use', frame.id)
    if (!h.bridgeHas(TERM_VIEW_FEATURE)) {
      h.sendToApp(socketId, mkFrame(h.clock, 'term.closed', { term_id: frame.term_id, why: 'unsupported' }))
      return
    }
    if (!this.room())
      return h.appError(socketId, 'rate_limited', 'too many terminal requests; try again in a moment', frame.id)
    if (this.subs.size >= TERM_MAX_OPEN)
      return h.appError(
        socketId,
        'rate_limited',
        `${TERM_MAX_OPEN} terminals are already open; close one first`,
        frame.id,
      )
    this.subs.set(frame.term_id, {
      socketId,
      deviceId,
      openFrameId: frame.id,
      opened: false,
      lagging: false,
      acked: 0,
      reach: 0,
      inflight: [],
    })
    this.remember(frame.id, socketId)
    h.sendBridge(raw)
  }

  /** The page's credit: only from the socket the view is bound to; passed on to the Mac as it came. */
  onAck(socketId: string, frame: { term_id: string; upto: number }, raw: Record<string, unknown>): void {
    const sub = this.subs.get(frame.term_id)
    if (!sub || sub.socketId !== socketId || sub.lagging || !this.h.bridgeOnline()) return
    if (frame.upto > sub.acked) sub.acked = frame.upto
    sub.inflight = sub.inflight.filter((end) => end > sub.acked)
    this.h.sendBridge(raw)
  }

  /** `term.opened`, `term.key`, `term.out` or `term.closed` from the Mac: only to the socket the id is bound to. */
  onBridge(
    frame: { type: string; term_id: string; at?: number; bytes_b64?: string },
    raw: Record<string, unknown>,
  ): void {
    const sub = this.subs.get(frame.term_id)
    if (!sub) return // an id nobody opened here, or one already ended: dropped
    const h = this.h
    if (frame.type === 'term.closed') {
      h.sendToApp(sub.socketId, raw)
      this.subs.delete(frame.term_id)
      return
    }
    if (frame.type === 'term.opened') {
      // A second one is the pane changing size on the Mac: a fresh picture follows, and the credit starts over with it, so a
      // resize while the window was full is never read as a lag.
      if (sub.opened) {
        sub.inflight = []
        sub.acked = sub.reach
        sub.lagging = false
      }
      sub.opened = true
      h.sendToApp(sub.socketId, raw)
      return
    }
    if (!sub.opened || sub.lagging) return
    const at = frame.at ?? 0
    const isKey = frame.type === 'term.key'
    const end = isKey ? at : at + rawLen(frame.bytes_b64?.length ?? 0)
    // a keyframe is a picture, not bytes of the stream: it counts as one frame, and the credit counts from its offset on
    const over =
      h.buffered(sub.socketId) > TERM_SOCKET_BUFFER_MAX ||
      sub.inflight.length >= TERM_WINDOW_FRAMES ||
      (!isKey && end - sub.acked > TERM_WINDOW_BYTES)
    if (over) {
      sub.lagging = true
      h.sendToApp(sub.socketId, mkFrame(h.clock, 'term.closed', { term_id: frame.term_id, why: 'lag' }))
      return
    }
    if (!h.sendToApp(sub.socketId, raw)) return
    if (isKey) {
      sub.acked = at
      sub.inflight = [at]
    } else sub.inflight.push(end)
    sub.reach = end
  }

  /** `error{ref}` from the Mac for an open it refused: to the asker, never stored. True when the ref was an open of ours. */
  onError(ref: string, raw: Record<string, unknown>): boolean {
    for (const [id, sub] of this.subs) {
      if (sub.openFrameId !== ref) continue
      this.h.sendToApp(sub.socketId, raw)
      this.subs.delete(id)
      return true
    }
    const f = this.forwarded.get(ref)
    if (!f) return false
    this.forwarded.delete(ref)
    if (this.h.clock.now() - f.at > TERM_OPEN_MAX_AGE_MS) return false // forgotten: an old ref is the ordinary path again
    this.h.sendToApp(f.socketId, raw) // false when the socket is gone: dropped
    return true
  }

  /** A socket closed: its views end, and the Mac is told the viewer is gone. */
  dropSocket(socketId: string): void {
    for (const [id, sub] of [...this.subs]) {
      if (sub.socketId !== socketId) continue
      this.subs.delete(id)
      if (this.h.bridgeOnline())
        this.h.sendBridge(mkFrame(this.h.clock, 'term.closed', { term_id: id, why: 'socket_closed' }))
    }
  }

  /** The Mac went away: every view ends, and each socket is told. Nothing is kept for the next hello. */
  bridgeGone(): void {
    for (const id of [...this.subs.keys()]) this.end(id, 'mac_offline', false)
  }

  private end(termId: string, why: string, tellMac: boolean): void {
    const sub = this.subs.get(termId)
    if (!sub) return
    this.subs.delete(termId)
    this.h.sendToApp(sub.socketId, mkFrame(this.h.clock, 'term.closed', { term_id: termId, why }))
    if (tellMac && this.h.bridgeOnline())
      this.h.sendBridge(mkFrame(this.h.clock, 'term.closed', { term_id: termId, why }))
  }
}
