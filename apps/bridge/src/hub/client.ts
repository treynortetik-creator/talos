// The worker side of the hub socket (docs/OPTION-C.md "The hub socket"). A worker-mode bridge connects to main's live
// bridge over `$TALOS_APP_HOME/run/hub.sock`, says `hello` (thread, pid, the supervisor's nonce), and from then on hands it
// every frame it would have sent the relay. The hub validates, sends and acks. When the socket is down the
// worker falls back to the signed HTTP path (worker/transport.ts); it never opens the relay socket itself.
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { HUB_FEATURE_SCHEDULES, HUB_MAX_LINE_BYTES, HubHubLine, type HubHubLineT, newUlid } from '@talos-app/protocol'
import type { Logger } from '../log.ts'

export type HubAckT = Extract<HubHubLineT, { t: 'ack' }>

const HELLO_TIMEOUT_MS = 5_000
export const OUT_TIMEOUT_MS = 15_000
/** A Schedules tool waits in main's schedule queue behind Chronos; give it longer than a frame ack. */
export const RPC_TIMEOUT_MS = 60_000
/** Longer for the tools that wait in main's schedule queue behind a Chronos call or a slow card write. */
const RPC_TIMEOUT_BY_TOOL: Record<string, number> = {
  schedule_run_start: 150_000,
  schedule_run_done: 150_000,
  schedule_propose: 120_000,
}

/** What to do after an answer that never came: the action may or may not have run, and the next step differs per tool. */
function unansweredText(tool: string, why: string): string {
  const next: Record<string, string> = {
    schedule_run_start:
      "Check schedules_list for the run's state before doing anything else. Calling schedule_run_start again for a run you already claimed is safe: it answers GO.",
    schedule_run_done:
      "Check schedules_list for the run's state. Calling schedule_run_done again is safe: a run that is already closed answers that it is.",
    schedule_propose:
      "A card may be waiting in this thread: look at it, and don't propose the same thing again until you have. Use schedules_list to see the job's current state.",
    config_propose:
      "A card may be waiting in this thread: look at it, and don't propose the same thing again until you have.",
  }
  return `${why} It may or may not have run. ${next[tool] ?? 'Check with schedules_list before trying again.'}`
}
const RECONNECT_MS = 3_000
/** Down this long, the link is not coming back on its own: the session likely predates the main bridge it should reach. */
export const HUB_DOWN_STALE_MS = 120_000
/** A session that has never reached the hub is only "older than the main bridge" once its first tries have had time. */
const FIRST_TRIES_MS = 15_000

/** When the link went down, on this clock, as the owner's words should say it. */
const timeText = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * What a thread session says when it has no hub link. A short drop (the main bridge restarting) is worth a retry; a link down
 * since this bridge started, or for minutes, will not come back by waiting: the session is older than the main bridge, or the
 * main bridge is gone, and the session needs a restart.
 */
export function hubDownText(o: { since: number; now: number; everUp: boolean; startedAt: number }): string {
  const long = o.now - o.since > HUB_DOWN_STALE_MS || (!o.everUp && o.now - o.startedAt > FIRST_TRIES_MS)
  if (!long)
    return "The main bridge isn't reachable from this thread session (no hub socket). Nothing was done; try again shortly."
  const since = o.everUp ? `since ${timeText(o.since)}` : `since this session's bridge started (${timeText(o.since)})`
  return `The main bridge hasn't been reachable from this thread session ${since}, so waiting will not fix it. This session may be older than the main bridge (it was restarted or updated after this session started), and needs a restart: ask Main to restart this thread's session, or tell the owner. Nothing was done.`
}

export type HubClientOptions = {
  sockPath: string
  /**
   * Where the hub socket was before it moved to its own folder: used while `sockPath` is not there, so a worker updated
   * before the live bridge restarts still reaches it. For one release.
   */
  legacySockPath?: string
  threadId: string
  nonce: string
  pid?: number
  log: Logger
  /** Test seam. */
  reconnectMs?: number
  /** Test seam: what the hello advertises (default: everything this build does). `[]` plays an older worker. */
  features?: string[]
  /** Test seam: the clock the down time is measured on (default Date.now). */
  now?: () => number
}

export class HubClient {
  private sock: Socket | undefined
  private welcomed = false
  private buf = ''
  private waiters = new Map<string, (a: HubAckT) => void>()
  private rpcWaiters = new Map<string, { tool: string; done: (r: { ok: boolean; text: string }) => void }>()
  private helloWait: ((ok: boolean) => void) | undefined
  private closed = false
  /** The hub refused a hello that carried `features` (an older hub's strict schema): say hello the old way from now on. */
  private plainHello = false
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The hub's last refusal of our hello (shown in the log; a refused worker keeps retrying slowly). */
  lastRefusal: { code: string; message: string } | undefined

  private readonly startedAt: number
  /** Since when the link has been down (this bridge's start, until the first welcome); undefined while it is up. */
  private downAt: number | undefined
  private everUp = false

  constructor(private readonly o: HubClientOptions) {
    this.startedAt = this.now()
    this.downAt = this.startedAt
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  /** Since when the link to the main bridge has been down; undefined while it is up. For the session's own status. */
  get downSince(): number | undefined {
    return this.connected ? undefined : (this.downAt ?? this.startedAt)
  }

  /** The words for "no hub link", as long as it has been down. */
  downText(): string {
    return hubDownText({
      since: this.downSince ?? this.now(),
      now: this.now(),
      everUp: this.everUp,
      startedAt: this.startedAt,
    })
  }

  get connected(): boolean {
    return this.welcomed && this.sock !== undefined && !this.sock.destroyed
  }

  /** Connects and says hello. Resolves true once welcomed, false on refusal or no hub. Keeps reconnecting after. */
  connect(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.connected) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const legacy = this.o.legacySockPath
      const sock = createConnection(
        !existsSync(this.o.sockPath) && legacy && existsSync(legacy) ? legacy : this.o.sockPath,
      )
      const t = setTimeout(() => {
        finish(false)
        sock.destroy()
      }, HELLO_TIMEOUT_MS)
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(t)
        this.helloWait = undefined
        resolve(ok)
      }
      this.helloWait = finish
      this.sock = sock
      this.buf = ''
      this.welcomed = false
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        sock.write(
          `${JSON.stringify({
            t: 'hello',
            thread_id: this.o.threadId,
            pid: this.o.pid ?? process.pid,
            nonce: this.o.nonce,
            ...(this.features().length && !this.plainHello ? { features: this.features() } : {}),
          })}\n`,
        )
      })
      sock.on('data', (chunk: string) => this.onData(chunk))
      sock.on('error', () => {})
      sock.on('close', () => {
        const wasUp = this.welcomed
        this.welcomed = false
        if (wasUp) this.downAt = this.now()
        if (this.sock === sock) this.sock = undefined
        for (const w of this.waiters.values())
          w({ t: 'ack', frame_id: '', state: 'refused', code: 'hub_closed', message: 'the hub closed' })
        this.waiters.clear()
        for (const w of this.rpcWaiters.values())
          w.done({ ok: false, text: unansweredText(w.tool, 'The hub closed before the main bridge answered.') })
        this.rpcWaiters.clear()
        finish(false)
        if (wasUp) this.o.log.warn('hub socket closed; replies fall back to HTTP until it is back')
        this.scheduleReconnect()
      })
    })
  }

  private features(): string[] {
    return this.o.features ?? [HUB_FEATURE_SCHEDULES]
  }

  private scheduleReconnect() {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connect()
    }, this.o.reconnectMs ?? RECONNECT_MS)
    this.timer.unref?.()
  }

  private onData(chunk: string) {
    this.buf += chunk
    if (this.buf.length > HUB_MAX_LINE_BYTES) {
      this.o.log.warn('hub sent an oversized line; reconnecting')
      this.sock?.destroy()
      return
    }
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      this.onLine(line)
      nl = this.buf.indexOf('\n')
    }
  }

  private onLine(line: string) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const m = HubHubLine.safeParse(raw)
    if (!m.success) return
    const msg = m.data
    if (msg.t === 'welcome') {
      this.welcomed = true
      this.everUp = true
      this.downAt = undefined
      this.lastRefusal = undefined
      this.o.log.info('hub: connected as a thread session', { thread: msg.thread_id })
      this.helloWait?.(true)
    } else if (msg.t === 'refused') {
      this.lastRefusal = { code: msg.code, message: msg.message }
      if (msg.code === 'bad_frame' && this.features().length) this.plainHello = true
      this.o.log.warn('hub refused this session', { code: msg.code })
      this.helloWait?.(false)
      this.sock?.destroy()
    } else if (msg.t === 'controls') {
      // P1 (WP-OC5): controls for this worker's mod; nothing here runs them yet
      this.o.log.info('hub: controls line ignored (no mod in this worker)')
    } else if (msg.t === 'perm_result') {
      // answers a hook's request, never a worker's: nothing here asked for it
    } else if (msg.t === 'rpc_result') {
      const w = this.rpcWaiters.get(msg.id)
      if (w) {
        this.rpcWaiters.delete(msg.id)
        w.done({ ok: msg.ok, text: msg.text })
      }
    } else {
      const w = this.waiters.get(msg.frame_id)
      if (w) {
        this.waiters.delete(msg.frame_id)
        w(msg)
      }
    }
  }

  /** Hands one frame to the hub and waits for its ack (or a timeout, reported as `refused` with code `timeout`). */
  out(frame: { type: string; id: string }): Promise<HubAckT> {
    const sock = this.sock
    if (!this.connected || !sock)
      return Promise.resolve({ t: 'ack', frame_id: frame.id, state: 'refused', code: 'hub_down', message: 'no hub' })
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(frame.id)
        resolve({ t: 'ack', frame_id: frame.id, state: 'refused', code: 'timeout', message: 'the hub did not answer' })
      }, OUT_TIMEOUT_MS)
      this.waiters.set(frame.id, (a) => {
        clearTimeout(t)
        resolve(a)
      })
      sock.write(`${JSON.stringify({ t: 'out', frame })}\n`)
    })
  }

  /**
   * Asks main's bridge to run a Schedules tool for this thread (the hub decides the thread, not the request). Never rejects:
   * no hub, a hub too old to know `rpc`, or a slow one reads as `ok:false` in words the agent can act on, never as an empty answer.
   */
  rpc(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; text: string }> {
    const sock = this.sock
    if (!this.connected || !sock) return Promise.resolve({ ok: false, text: this.downText() })
    const id = `rpc_${newUlid()}`
    const wait = timeoutMs ?? RPC_TIMEOUT_BY_TOOL[tool] ?? RPC_TIMEOUT_MS
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.rpcWaiters.delete(id)
        resolve({
          ok: false,
          text: unansweredText(
            tool,
            'The main bridge did not answer in time (an older main bridge ignores this request).',
          ),
        })
      }, wait)
      this.rpcWaiters.set(id, {
        tool,
        done: (r) => {
          clearTimeout(t)
          resolve(r)
        },
      })
      sock.write(`${JSON.stringify({ t: 'rpc', id, tool, args })}\n`)
    })
  }

  /** Fire and forget (ephemeral frames). False when there is no hub. */
  fire(frame: { type: string; id: string }): boolean {
    if (!this.connected || !this.sock) return false
    this.sock.write(`${JSON.stringify({ t: 'out', frame })}\n`)
    return true
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.sock?.destroy()
    this.sock = undefined
    this.welcomed = false
  }
}
