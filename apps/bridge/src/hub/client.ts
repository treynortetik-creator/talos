// The worker side of the hub socket (docs/OPTION-C.md "The hub socket"). A worker-mode bridge connects to main's live
// bridge over `$TALOS_APP_HOME/hub.sock`, says `hello` (thread, pid, the supervisor's nonce), and from then on hands it
// every frame it would have sent the relay. The hub validates, sends and acks. When the socket is down the
// worker falls back to the signed HTTP path (worker/transport.ts); it never opens the relay socket itself.
import { createConnection, type Socket } from 'node:net'
import { HUB_MAX_LINE_BYTES, HubHubLine, type HubHubLineT } from '@talos-app/protocol'
import type { Logger } from '../log.ts'

export type HubAckT = Extract<HubHubLineT, { t: 'ack' }>

const HELLO_TIMEOUT_MS = 5_000
export const OUT_TIMEOUT_MS = 15_000
const RECONNECT_MS = 3_000

export type HubClientOptions = {
  sockPath: string
  threadId: string
  nonce: string
  pid?: number
  log: Logger
  /** Test seam. */
  reconnectMs?: number
}

export class HubClient {
  private sock: Socket | undefined
  private welcomed = false
  private buf = ''
  private waiters = new Map<string, (a: HubAckT) => void>()
  private helloWait: ((ok: boolean) => void) | undefined
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The hub's last refusal of our hello (shown in the log; a refused worker keeps retrying slowly). */
  lastRefusal: { code: string; message: string } | undefined

  constructor(private readonly o: HubClientOptions) {}

  get connected(): boolean {
    return this.welcomed && this.sock !== undefined && !this.sock.destroyed
  }

  /** Connects and says hello. Resolves true once welcomed, false on refusal or no hub. Keeps reconnecting after. */
  connect(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.connected) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const sock = createConnection(this.o.sockPath)
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
          `${JSON.stringify({ t: 'hello', thread_id: this.o.threadId, pid: this.o.pid ?? process.pid, nonce: this.o.nonce })}\n`,
        )
      })
      sock.on('data', (chunk: string) => this.onData(chunk))
      sock.on('error', () => {})
      sock.on('close', () => {
        const wasUp = this.welcomed
        this.welcomed = false
        if (this.sock === sock) this.sock = undefined
        for (const w of this.waiters.values())
          w({ t: 'ack', frame_id: '', state: 'refused', code: 'hub_closed', message: 'the hub closed' })
        this.waiters.clear()
        finish(false)
        if (wasUp) this.o.log.warn('hub socket closed; replies fall back to HTTP until it is back')
        this.scheduleReconnect()
      })
    })
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
      this.lastRefusal = undefined
      this.o.log.info('hub: connected as a thread session', { thread: msg.thread_id })
      this.helloWait?.(true)
    } else if (msg.t === 'refused') {
      this.lastRefusal = { code: msg.code, message: msg.message }
      this.o.log.warn('hub refused this session', { code: msg.code })
      this.helloWait?.(false)
      this.sock?.destroy()
    } else if (msg.t === 'controls') {
      // P1 (WP-OC5): controls for this worker's mod; nothing here runs them yet
      this.o.log.info('hub: controls line ignored (no mod in this worker)')
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
