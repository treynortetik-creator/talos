// @vitest-environment node
// Close code 1012 ("Service Restart") means the relay is stopping for a deploy and will be back in about a second: the
// client retries on a short fixed delay for 30 s instead of the 1-2-4-8 s backoff. Every other code keeps the backoff.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

type CloseEv = { code: number; reason: string }
const READY = readFileSync(new URL('../../../packages/protocol/fixtures/frames/ready.json', import.meta.url), 'utf8')

const sockets: FakeWs[] = []
class FakeWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: CloseEv) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    sockets.push(this)
  }
  send() {}
  close() {
    this.fail(1006)
  }
  /** The socket opens and the relay answers its hello with `ready`: the link is up. */
  up() {
    this.readyState = 1
    this.onopen?.()
    this.onmessage?.({ data: READY })
  }
  /** The socket ends with this code (after `up()`, a link that was up; else one that never reached `ready`). */
  fail(code: number, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

let client: SocketClient

beforeEach(async () => {
  sockets.length = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, maxMs: 30_000, random: () => 0.5 },
    isOnline: () => true,
    now: () => Date.now(),
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  expect(sockets).toHaveLength(1)
})
afterEach(() => {
  client.close()
  vi.useRealTimers()
})

describe('close 1012', () => {
  it('(a) reconnects within 750 ms and never shows unreachable', () => {
    sockets[0]?.up()
    expect(client.store.getState().connection).toBe('online')
    sockets[0]?.fail(1012, 'restarting')
    expect(client.store.getState().connection).toBe('connecting')
    vi.advanceTimersByTime(750)
    expect(sockets).toHaveLength(2)
    expect(client.store.getState().connection).not.toBe('unreachable')
  })

  it('(b) three failed retries inside 30 s all use at most 750 ms, and attempt does not grow', () => {
    sockets[0]?.up()
    expect(client.store.getState().connection).toBe('online')
    sockets[0]?.fail(1012, 'restarting')
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(750)
      expect(sockets).toHaveLength(i + 2)
      sockets.at(-1)?.fail(1006)
      expect(client.store.getState().connection).toBe('connecting')
    }
    vi.advanceTimersByTime(750)
    expect(sockets).toHaveLength(5)
  })

  it('(c) past 30 s without ready, the normal backoff applies again', () => {
    const t0 = Date.now()
    sockets[0]?.up()
    expect(client.store.getState().connection).toBe('online')
    sockets[0]?.fail(1012, 'restarting')
    // keep failing every retry until the window is over; the failure that lands after 30 s is the first normal one
    let guard = 0
    do {
      vi.advanceTimersByTime(750)
      sockets.at(-1)?.fail(1006)
    } while (Date.now() - t0 < 30_000 && guard++ < 200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30_000)
    expect(client.store.getState().connection).toBe('unreachable')
    // attempt never grew inside the window, so this wait is baseMs * 2^0 = 1000 ms: not short, not grown
    const n = sockets.length
    vi.advanceTimersByTime(750)
    expect(sockets).toHaveLength(n)
    vi.advanceTimersByTime(300)
    expect(sockets).toHaveLength(n + 1)
  })

  it('(e) a 1012 on a socket that never reached ready keeps the backoff: a proxy that says it at every dial cannot loop', () => {
    sockets[0]?.fail(1012, 'restarting')
    expect(client.store.getState().connection).toBe('unreachable')
    vi.advanceTimersByTime(900)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(sockets).toHaveLength(2)
  })

  it("(d) close 1006 keeps today's behaviour: unreachable, baseMs backoff", () => {
    sockets[0]?.fail(1006)
    expect(client.store.getState().connection).toBe('unreachable')
    vi.advanceTimersByTime(900)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(sockets).toHaveLength(2)
    // and the second wait doubles
    sockets[1]?.fail(1006)
    vi.advanceTimersByTime(1900)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(200)
    expect(sockets).toHaveLength(3)
  })
})
