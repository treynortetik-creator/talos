// A WebSocket the test drives by hand, for timing tests under vitest's fake timers: nothing opens, answers or closes
// unless the test says so, so a dead link (no pong, no close event) is a socket the test simply leaves alone. It refuses
// what a browser refuses: `send` on a socket that is still connecting throws, and a closing or closed socket carries nothing.
import { readFileSync } from 'node:fs'
import { mkFrame } from '@talos-app/testkit'

const READY = readFileSync(new URL('../../../../packages/protocol/fixtures/frames/ready.json', import.meta.url), 'utf8')

export type SentFrame = Record<string, unknown> & { type: string }

export class FakeWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeWs[] = []
  readyState = 0
  /** When set, `send` throws on an open socket (a socket that broke under the page). */
  throwOnSend = false
  /** How many times the client called `close()` on this socket. */
  closeCalls = 0
  sent: SentFrame[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeWs.all.push(this)
  }
  send(data: string) {
    if (this.readyState === 0) throw new DOMException('still connecting', 'InvalidStateError')
    if (this.readyState !== 1) return
    if (this.throwOnSend) throw new DOMException('broken', 'InvalidStateError')
    this.sent.push(JSON.parse(data) as SentFrame)
  }
  /** Like a browser, `close()` starts the closing handshake: the close event comes later, when the test sends it (`fail`). */
  close() {
    this.closeCalls++
    if (this.readyState < 2) this.readyState = 2
  }
  /** The socket opens (the hello goes out) but the relay has not answered yet. */
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  /** The relay's `ready`, on a socket that is open. */
  ready() {
    this.onmessage?.({ data: READY })
  }
  /** The socket opens and the relay answers its hello with `ready`: the link is up. */
  up() {
    this.open()
    this.ready()
  }
  /** The relay sends a frame (through the real parser). */
  deliver(type: string, fields: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify(mkFrame(type, fields)) })
  }
  /** The relay answers the newest ping on this socket with a pong carrying its nonce. */
  pong() {
    const ping = this.sent.filter((f) => f.type === 'ping').at(-1)
    this.deliver('pong', { nonce: ping?.nonce })
  }
  /** The socket ends with this code. */
  fail(code: number, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  of(type: string) {
    return this.sent.filter((f) => f.type === type)
  }
}

/** Every socket the client opened, oldest first (`FakeWs.all`), reset by this call. */
export function resetFakeSockets(): FakeWs[] {
  FakeWs.all.length = 0
  return FakeWs.all
}
/** One frame type sent over every socket, oldest first. */
export const sentOn = (type: string) => FakeWs.all.flatMap((s) => s.of(type))
