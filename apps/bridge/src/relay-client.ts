// The live bridge's WebSocket to the relay (spec 4.1): challenge/hello/ready, ping/pong, reconnect with backoff, and the
// terminal states. On close 4409 ("superseded") a second bridge with the same key took over. This one then asks back in on
// the same backoff, as a standby: the relay turns that hello away while the other bridge is connected, so the two never trade
// the slot, and accepts it once the other has gone. A relay that does not list the standby feature gets no such asks (it
// would replace the live bridge), so against it a superseded bridge stays down, as before.
import {
  BRIDGE_STANDBY_FEATURE,
  FEATURES_MAX_V1,
  type Frame,
  helloFeatures,
  helloNeedsResend,
  newUlid,
  parseFrameText,
  WIDE_FEATURES_FEATURE,
  WS_CLOSE,
} from '@talos-app/protocol'
import type { Clock } from './clock.ts'
import { relayWsUrl } from './config.ts'
import { buildHello, challengeHostOk } from './handshake.ts'
import type { KeyMaterial } from './keys.ts'
import type { Logger } from './log.ts'
import type { RelayFeaturesMemo } from './relay-features-memo.ts'

/** 1, 2, 5, 10, 30 s, then every 60 s, each with +/-20% jitter (spec 4.1). `random` returns [0, 1). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = [1000, 2000, 5000, 10_000, 30_000][attempt] ?? 60_000
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** A connection must stay up this long before the reconnect backoff starts over from 1 s. */
export const STABLE_MS = 30_000

/**
 * How long one dial may take from opening the socket to the relay's `ready`. The heartbeat watchdog only starts at
 * `ready`, so a relay or proxy that takes the connection and then stalls would otherwise hold the bridge on that one
 * attempt for ever. Twice the relay's own handshake limit, and far above a healthy handshake (well under a second).
 */
export const HANDSHAKE_TIMEOUT_MS = 20_000

/** After a 1012 close the bridge redials on the short delay for this long before the normal backoff resumes. */
const RESTART_WINDOW_MS = 30_000

/** The relay list assumed before any relay said one: it takes the wide list (features-cap.ts). */
const ASSUME_WIDE: readonly string[] = [WIDE_FEATURES_FEATURE]

export type ReadyFrame = Extract<Frame, { type: 'ready' }>

export type RelayClientEvents = {
  onReady(ready: ReadyFrame): void
  /** Every authenticated frame that parsed as relay->bridge. `raw` is the JSON.parse of the text, untouched. */
  onFrame(raw: Record<string, unknown>, frame: Frame): void
  /** An authenticated frame that did not parse. `raw` is whatever JSON came in (undefined when it was not JSON). */
  onBadFrame(raw: Record<string, unknown> | undefined, message: string): void
  onDisconnect(info: { code: number; authed: boolean }): void
  onSuperseded(): void
}

export type RelayClientOptions = {
  relayUrl: string
  /** Candidate keys in the order to try: current first; later ones are tried after a 4401 (rotation recovery). */
  loadKeys: () => Promise<KeyMaterial[]>
  client: { name: string; version: string }
  /** `hello.client.features` (docs/SCHEDULES.md S1.5); a function is read at each hello (docs/V2-FEATURES.md V1). */
  features?: readonly string[] | (() => readonly string[])
  agentConfigRev: () => number
  clock: Clock
  log: Logger
  events: RelayClientEvents
  random?: () => number
  /** Called when a later key candidate worked after a 4401 (so the owner learns the rotation did not finish). */
  onKeyFallback?: (index: number) => void
  /**
   * The relay's last `ready.features`, kept across restarts (relay-features-memo.ts): the first hello is then already the
   * one this relay takes, and a start does not dial twice. Absent: the first hello is the one any relay takes.
   */
  featuresMemo?: RelayFeaturesMemo
}

export class RelayClient {
  /**
   * A phone's `attest.request` (BYOR phase 4), asked of the relay while the phone's HTTP call waits. The answer, if any, goes
   * out as a plain frame on the socket the request ARRIVED on, and only while that is still the live one: it is never
   * queued or retried, so a request that outlived its socket is simply not answered. Set once, before the first dial.
   */
  onAttest?: (req: { id: string; nonce: string }) => Promise<Record<string, unknown> | null>
  private ws: WebSocket | null = null
  private attempt = 0
  /** When the current socket opened (the clock's ms): the `relay authed` line says how long the hello took. */
  private openedAt: number | null = null
  /** Until this time (clock ms) a relay restart (close 1012) is being waited out: redials use a short fixed delay. 0 = none. */
  private restartUntil = 0
  private timer: unknown = null
  private pingTimer: unknown = null
  private stableTimer: unknown = null
  private handshakeTimer: unknown = null
  private stopped = true
  private authed = false
  private keyIndex = 0
  private lastKeyCount = 1
  private lastRx = 0
  private closeWaiters: Array<() => void> = []
  private restarting = false
  /** Bumped by every connect(); a connect that finds it changed while loading keys is stale and gives up. */
  private connectGen = 0
  /** Replaced by another bridge (4409) and not connected since: asks back in as a standby, or stays down on an older relay. */
  superseded = false
  /** The relay's last `ready` listed `BRIDGE_STANDBY_FEATURE`. */
  private relayStandby = false
  /**
   * This relay's last `ready.features`: which features list it takes (helloFeatures). Before the first `ready` it is the
   * memo's list from this relay's last `ready` before the restart, or, with none, ASSUME_WIDE: every relay since 5367f571
   * takes 64, so a first start sends the whole list and dials once. An empty list is the one any relay takes (20).
   */
  private relayFeatures: readonly string[]
  /** A `ready` arrived since start(): from then on only the relay's word changes the list. */
  private everReady = false
  /** This start already dropped a wide hello to the safe one after a failure before `ready` (at most once per start). */
  private fellBack = false
  /** The current dial's hello went out wider than any relay takes. */
  private helloWide = false
  /** The features the last hello listed. */
  private sentFeatures: readonly string[] = []
  /** The `ready.features` that last made this client redial for a better hello: the same list never makes a second one. */
  private resentFor: string | null = null
  /** The close code of the last socket that ended (null before the first). Written to status.json for the menu bar. */
  lastCloseCode: number | null = null

  constructor(private readonly o: RelayClientOptions) {
    this.relayFeatures = o.featuresMemo?.load() ?? ASSUME_WIDE
  }

  /** Sets the relay's list and keeps it for the next start when it changed. */
  private setRelayFeatures(list: readonly string[]) {
    const changed = JSON.stringify(list) !== JSON.stringify(this.relayFeatures)
    this.relayFeatures = list
    if (changed) this.o.featuresMemo?.save(list)
  }

  /** Clock ms since the last frame arrived. The heartbeat watchdog trips past 2.5 pings; tests wait on this between clock steps. */
  get silentForMs(): number {
    return this.o.clock.now() - this.lastRx
  }

  get connected(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect().catch((e) => this.o.log.error('connect failed', { error: (e as Error).message }))
  }

  /** Closes with 1000 and does not reconnect. */
  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    await this.closeSocket(1000)
  }

  /** Drops the current socket (closing it first, so the relay never sees two) and reconnects now, e.g. after a key rotation. */
  async restartNow(opts?: { keepKey?: boolean }): Promise<void> {
    if (this.stopped || this.superseded) return
    this.clearTimers()
    if (!opts?.keepKey) this.keyIndex = 0 // a redial for the features list stays on the key the relay just took
    // the close of the socket we are replacing must not schedule a reconnect of its own: restartNow connects once
    this.restarting = true
    try {
      await this.closeSocket(1000)
    } finally {
      this.restarting = false
    }
    if (this.stopped || this.superseded) return
    this.clearTimers()
    this.attempt = 0
    this.connect().catch((e) => this.o.log.error('connect failed', { error: (e as Error).message }))
  }

  private allFeatures(): readonly string[] {
    const f = this.o.features
    return f === undefined ? [] : typeof f === 'function' ? f() : f
  }
  /** What this hello lists: what this relay takes (packages/protocol/src/features-cap.ts). */
  private helloList(): string[] {
    this.sentFeatures = helloFeatures(this.allFeatures(), this.relayFeatures)
    this.helloWide = this.sentFeatures.length > FEATURES_MAX_V1
    return [...this.sentFeatures]
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.connected) return false
    try {
      this.ws?.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private clearTimers() {
    if (this.timer) this.o.clock.clearTimeout(this.timer)
    if (this.pingTimer) this.o.clock.clearTimeout(this.pingTimer)
    if (this.stableTimer) this.o.clock.clearTimeout(this.stableTimer)
    if (this.handshakeTimer) this.o.clock.clearTimeout(this.handshakeTimer)
    this.stableTimer = null
    this.handshakeTimer = null
    this.timer = null
    this.pingTimer = null
  }

  private closeSocket(code: number): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => resolve()
      this.closeWaiters.push(done)
      try {
        ws.close(code)
      } catch {
        resolve()
      }
      setTimeout(resolve, 1500) // do not hang shutdown on a peer that never answers the close handshake
    })
  }

  private async connect() {
    if (this.stopped) return
    const gen = ++this.connectGen
    this.authed = false
    this.helloWide = false
    let keys: KeyMaterial[]
    try {
      keys = await this.o.loadKeys()
    } catch (e) {
      this.o.log.error('bridge key unreadable', { error: (e as Error).message })
      this.scheduleReconnect()
      return
    }
    if (gen !== this.connectGen || this.stopped) return // a newer connect() took over
    this.lastKeyCount = keys.length
    const key = keys.length ? keys[this.keyIndex % keys.length] : undefined
    if (!key) return this.scheduleReconnect()
    let ws: WebSocket
    try {
      ws = new WebSocket(relayWsUrl(this.o.relayUrl))
    } catch (e) {
      this.o.log.error('websocket construction failed', { error: (e as Error).message })
      return this.scheduleReconnect()
    }
    this.ws = ws
    this.handshakeTimer = this.o.clock.setTimeout(() => this.onHandshakeTimeout(ws), HANDSHAKE_TIMEOUT_MS)
    let sentHello = false
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.openedAt = this.o.clock.now()
      this.o.log.info('relay socket open', { attempt: this.attempt }) // the dial's backoff step; no address
    }
    ws.onmessage = (ev) => {
      this.lastRx = this.o.clock.now()
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
      this.onText(
        ws,
        text,
        key,
        () => sentHello,
        (v) => {
          sentHello = v
        },
      ).catch((e) => {
        this.o.log.error('relay frame handler failed', { error: (e as Error).message })
      })
    }
    ws.onclose = (ev) => {
      for (const w of this.closeWaiters.splice(0)) w()
      // a socket that is no longer ours (replaced by restartNow) says nothing about the current connection
      if (this.ws !== ws) return
      this.lastCloseCode = ev.code
      this.ws = null
      this.clearTimers()
      const wasAuthed = this.authed
      this.authed = false
      if (this.restarting) {
        this.o.events.onDisconnect({ code: ev.code, authed: wasAuthed })
        return
      }
      this.onClose(ev.code, wasAuthed)
    }
    ws.onerror = () => {
      // 'close' follows; nothing to do here
    }
  }

  /**
   * No `ready` in time: this dial is abandoned and the next one is scheduled on the backoff, exactly as if the socket had
   * closed (1006, "no close frame"). The socket is let go of first, so whatever it does later (a late `ready`, its own
   * close) is ignored and cannot disturb the connection that replaces it.
   */
  private onHandshakeTimeout(ws: WebSocket) {
    if (this.ws !== ws || this.authed || this.stopped) return
    this.handshakeTimer = null
    this.o.log.warn('relay handshake timed out; reconnecting', {
      after_ms: HANDSHAKE_TIMEOUT_MS,
      attempt: this.attempt,
    })
    this.ws = null
    this.clearTimers()
    try {
      ws.close()
    } catch {
      // already gone
    }
    this.lastCloseCode = 1006
    this.onClose(1006, false)
  }

  private onClose(code: number, wasAuthed: boolean) {
    this.o.events.onDisconnect({ code, authed: wasAuthed })
    if (this.stopped) return
    if (code === WS_CLOSE.SUPERSEDED) {
      const first = !this.superseded
      this.superseded = true
      if (first) {
        this.o.log.warn('superseded', { code, will_retry: this.relayStandby })
        this.o.events.onSuperseded()
      }
      if (!this.relayStandby)
        this.stopped = true // an older relay would let a standby hello replace the live bridge
      else this.scheduleReconnect() // still held by the other bridge: ask again after the next backoff step
      return
    }
    if (code === WS_CLOSE.UNAUTHORIZED && !wasAuthed) {
      // An older relay refuses a features list longer than it reads with 4401 too: the next hello is the one any relay takes,
      // and so is the next start's first one (kept for this relay URL) until a `ready` says it takes more.
      this.fellBack = true
      this.setRelayFeatures([])
      this.keyIndex++ // the next candidate key (prev, next), then back to the first
      this.o.log.warn('bridge auth rejected (4401)', { key_index: this.keyIndex })
    } else if (
      !wasAuthed &&
      this.helloWide &&
      !this.everReady &&
      !this.fellBack &&
      code !== WS_CLOSE.RESTARTING // only a relay that already accepted the socket says it: not a size or list refusal
    ) {
      // Any other end before the first `ready` of a dial whose hello was wide (a proxy's 1006, a handshake timeout, a size
      // refusal): the next dial sends the safe list, once per start, so a rolled-back relay behind a proxy cannot strand it.
      // Not kept on disk: it may have been a network blip, and a `ready` that says the relay takes more redials for it.
      this.fellBack = true
      this.relayFeatures = []
      this.o.log.warn('relay closed before ready on a wide hello: the next one is the safe list', { code })
    }
    // 1012 "Service Restart": the relay is stopping for a deploy and is back in about a second. For 30 s redial on a short
    // fixed delay that does not grow the backoff; after that the normal backoff resumes where it was.
    // only a socket that was up opens the window: a 1012 at every dial (a proxy, a broken relay) must not redial for ever
    if (code === WS_CLOSE.RESTARTING && wasAuthed) this.restartUntil = this.o.clock.now() + RESTART_WINDOW_MS
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.stopped) return
    const restarting = this.o.clock.now() < this.restartUntil
    const ms = restarting
      ? Math.round(250 + (this.o.random ?? Math.random)() * 500)
      : backoffMs(this.attempt++, this.o.random)
    this.o.log.info('reconnect scheduled', { in_ms: ms, attempt: this.attempt })
    this.timer = this.o.clock.setTimeout(() => {
      this.connect().catch((e) => this.o.log.error('connect failed', { error: (e as Error).message }))
    }, ms)
  }

  private async onText(
    ws: WebSocket,
    text: string,
    key: KeyMaterial,
    hello: () => boolean,
    setHello: (v: boolean) => void,
  ) {
    if (ws !== this.ws) return
    const parsed = parseFrameText(text, { authenticated: this.authed, direction: 'relay_to_bridge' })
    if (!parsed.ok) {
      if (!this.authed) {
        ws.close(WS_CLOSE.BAD_FRAME)
        return
      }
      const raw = parsed.raw
      this.o.events.onBadFrame(
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined,
        parsed.message,
      )
      return
    }
    const frame = parsed.frame
    const raw = parsed.raw as Record<string, unknown>
    if (!this.authed) {
      if (frame.type === 'challenge' && !hello()) {
        if (!challengeHostOk(this.o.relayUrl, frame)) {
          this.o.log.security('challenge names a different relay host; refusing to sign', {})
          ws.close(1008)
          return
        }
        setHello(true)
        const h = await buildHello({
          challenge: frame,
          key,
          client: this.o.client,
          ...(this.o.features ? { features: this.helloList() } : {}),
          agentConfigRev: this.o.agentConfigRev(),
          ...(this.superseded ? { standby: true } : {}),
          now: () => this.o.clock.now(),
        })
        ws.send(JSON.stringify(h))
        return
      }
      if (frame.type === 'ready') {
        this.authed = true
        this.o.log.info('relay authed', {
          after_ms: Math.max(0, this.o.clock.now() - (this.openedAt ?? this.o.clock.now())),
        })
        this.everReady = true
        if (this.handshakeTimer) this.o.clock.clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        this.superseded = false // in: this hello took the empty slot
        this.relayStandby = frame.features?.includes(BRIDGE_STANDBY_FEATURE) ?? false
        const took = frame.features ?? []
        this.setRelayFeatures(took)
        if (this.keyIndex % Math.max(1, this.lastKeyCount) > 0)
          this.o.onKeyFallback?.(this.keyIndex % this.lastKeyCount)
        this.restartUntil = 0 // a `ready` ends the restart window
        // The backoff restarts only once this connection has lasted: a relay that accepts the hello and then hangs up
        // (an oversized frame, a rate limit) would otherwise be redialled every second forever.
        this.stableTimer = this.o.clock.setTimeout(() => {
          this.attempt = 0
        }, STABLE_MS)
        this.startPing(frame.policy.ping_ms)
        this.o.events.onReady(frame)
        // The hello was chosen from this relay's previous `ready` (none: what any relay takes). When this one says the relay
        // takes more, or no longer reads the retired-features marker, it goes again, once: only the relay's word, no timer.
        const relayList = JSON.stringify(took)
        if (this.o.features && helloNeedsResend(this.allFeatures(), this.sentFeatures, took)) {
          if (this.resentFor !== relayList) {
            this.resentFor = relayList
            this.o.log.info('relay takes other features than this hello listed: reconnecting to send them', {})
            void this.restartNow({ keepKey: true })
          }
        } else this.resentFor = null
        return
      }
      return
    }
    if (frame.type === 'ping') {
      this.send({
        v: 1,
        type: 'pong',
        id: newUlid(),
        ts: new Date(this.o.clock.now()).toISOString(),
        nonce: frame.nonce,
      })
      return
    }
    if (frame.type === 'pong' || frame.type === 'ready' || frame.type === 'challenge') return
    if (frame.type === 'attest.request') {
      void this.answerAttest(ws, frame)
      return
    }
    this.o.events.onFrame(raw, frame)
  }

  private async answerAttest(ws: WebSocket, req: { id: string; nonce: string }) {
    if (!this.onAttest) return
    try {
      const out = await this.onAttest({ id: req.id, nonce: req.nonce })
      if (!out || ws !== this.ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(out))
    } catch (e) {
      this.o.log.warn('attest request failed', { error: (e as Error).message })
    }
  }

  private startPing(pingMs: number) {
    this.lastRx = this.o.clock.now()
    const tick = () => {
      if (!this.connected) return
      if (this.o.clock.now() - this.lastRx > pingMs * 2.5) {
        this.o.log.warn('relay silent; reconnecting', {})
        try {
          this.ws?.close(1001)
        } catch {
          // the close handler schedules the reconnect
        }
        return
      }
      this.send({
        v: 1,
        type: 'ping',
        id: newUlid(),
        ts: new Date(this.o.clock.now()).toISOString(),
        nonce: newUlid().slice(-12),
      })
      this.pingTimer = this.o.clock.setTimeout(tick, pingMs)
    }
    this.pingTimer = this.o.clock.setTimeout(tick, pingMs)
  }
}
