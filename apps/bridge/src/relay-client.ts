// The live bridge's WebSocket to the relay (spec 4.1): challenge/hello/ready, ping/pong, reconnect with backoff, and the
// terminal states. On close 4409 ("superseded") it never reconnects: a second bridge with the same key took over.
import { type Frame, newUlid, parseFrameText, WS_CLOSE } from '@talos-app/protocol'
import type { Clock } from './clock.ts'
import { relayWsUrl } from './config.ts'
import { buildHello, challengeHostOk } from './handshake.ts'
import type { KeyMaterial } from './keys.ts'
import type { Logger } from './log.ts'

/** 1, 2, 5, 10, 30 s, then every 60 s, each with +/-20% jitter (spec 4.1). `random` returns [0, 1). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = [1000, 2000, 5000, 10_000, 30_000][attempt] ?? 60_000
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** A connection must stay up this long before the reconnect backoff starts over from 1 s. */
export const STABLE_MS = 30_000

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
}

export class RelayClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: unknown = null
  private pingTimer: unknown = null
  private stableTimer: unknown = null
  private stopped = true
  private authed = false
  private keyIndex = 0
  private lastKeyCount = 1
  private lastRx = 0
  private closeWaiters: Array<() => void> = []
  private restarting = false
  /** Bumped by every connect(); a connect that finds it changed while loading keys is stale and gives up. */
  private connectGen = 0
  superseded = false
  /** The close code of the last socket that ended (null before the first). Written to status.json for the menu bar. */
  lastCloseCode: number | null = null

  constructor(private readonly o: RelayClientOptions) {}

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
  async restartNow(): Promise<void> {
    if (this.stopped || this.superseded) return
    this.clearTimers()
    this.keyIndex = 0
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
    this.stableTimer = null
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
    if (this.stopped || this.superseded) return
    const gen = ++this.connectGen
    this.authed = false
    let keys: KeyMaterial[]
    try {
      keys = await this.o.loadKeys()
    } catch (e) {
      this.o.log.error('bridge key unreadable', { error: (e as Error).message })
      this.scheduleReconnect()
      return
    }
    if (gen !== this.connectGen || this.stopped || this.superseded) return // a newer connect() took over
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
    let sentHello = false
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

  private onClose(code: number, wasAuthed: boolean) {
    this.o.events.onDisconnect({ code, authed: wasAuthed })
    if (this.stopped) return
    if (code === WS_CLOSE.SUPERSEDED) {
      this.superseded = true
      this.stopped = true
      this.o.log.warn('superseded', { code })
      this.o.events.onSuperseded()
      return
    }
    if (code === WS_CLOSE.UNAUTHORIZED && !wasAuthed) {
      this.keyIndex++ // the next candidate key (prev, next), then back to the first
      this.o.log.warn('bridge auth rejected (4401)', { key_index: this.keyIndex })
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.stopped || this.superseded) return
    const ms = backoffMs(this.attempt++, this.o.random)
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
          ...(this.o.features
            ? { features: typeof this.o.features === 'function' ? this.o.features() : this.o.features }
            : {}),
          agentConfigRev: this.o.agentConfigRev(),
          now: () => this.o.clock.now(),
        })
        ws.send(JSON.stringify(h))
        return
      }
      if (frame.type === 'ready') {
        this.authed = true
        if (this.keyIndex % Math.max(1, this.lastKeyCount) > 0)
          this.o.onKeyFallback?.(this.keyIndex % this.lastKeyCount)
        // The backoff restarts only once this connection has lasted: a relay that accepts the hello and then hangs up
        // (an oversized frame, a rate limit) would otherwise be redialled every second forever.
        this.stableTimer = this.o.clock.setTimeout(() => {
          this.attempt = 0
        }, STABLE_MS)
        this.startPing(frame.policy.ping_ms)
        this.o.events.onReady(frame)
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
    this.o.events.onFrame(raw, frame)
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
