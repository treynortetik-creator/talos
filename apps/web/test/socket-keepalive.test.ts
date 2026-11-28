// @vitest-environment node
// The keepalive (a ping every ping_ms, the link called dead after 2.5 of them without a pong), and what an answer to it is
// worth. A socket the client closes itself must be dropped for good at that moment: the browser leaves a dead socket in
// CLOSING for tens of seconds, and until it reports the close the page must not read "online" with nothing behind it.
// Every timer here is vitest's fake one, the keepalive's interval too: time moves only when a test advances it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STABLE_MS } from '../src/lib/socket-constants.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { FakeWs, resetFakeSockets } from './helpers/fake-ws.ts'

const win = new EventTarget()
const g = globalThis as Record<string, unknown>
beforeAll(() => {
  g.window = win
  g.document = new EventTarget()
})
afterAll(() => {
  g.window = undefined
  g.document = undefined
})

const PING_MS = 25_000 // the ready fixture's policy.ping_ms
let sockets: FakeWs[]
let client: SocketClient

beforeEach(async () => {
  sockets = resetFakeSockets()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, maxMs: 30_000, random: () => 0.5 },
    isOnline: () => true,
    now: () => Date.now(),
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
})
afterEach(() => {
  client.close()
  vi.useRealTimers()
})

const last = () => sockets.at(-1) as FakeWs
const wait = () => (client.meta.getState().retryAt ?? 0) - Date.now()
const advance = (ms: number) => vi.advanceTimersByTime(ms)
/** A link that comes up, stays `upMs`, drops, and the wait passes: the next dial. Returns the wait the client chose. */
function flap(upMs: number): number {
  last().up()
  advance(upMs)
  last().fail(1006)
  const w = wait()
  advance(w)
  return w
}

describe('a socket the client closes itself is dropped at that moment', () => {
  it('the keepalive gives up on a silent link: not "online" any more, and a new socket comes up promptly', () => {
    const dead = last()
    dead.up()
    advance(PING_MS * 3) // no pong for 75 s: the third tick sees more than 62.5 s of silence and gives up
    expect(dead.closeCalls).toBe(1)
    expect(client.store.getState().connection).not.toBe('online') // not stuck on online behind a CLOSING socket
    expect(client.meta.getState().retryAt).not.toBeNull()
    const n = sockets.length
    advance(wait()) // one backoff step (the link had been up past STABLE_MS, so the first)
    expect(sockets).toHaveLength(n + 1)
    expect(wait()).toBeLessThanOrEqual(0)
    last().up()
    expect(client.store.getState().connection).toBe('online')
  })

  it('after a sleep the first tick of the keepalive does it', () => {
    last().up()
    vi.setSystemTime(Date.now() + 8 * 3_600_000) // asleep
    advance(PING_MS) // on waking the interval fires: no pong for hours
    expect(last().closeCalls).toBe(1)
    expect(client.store.getState().connection).not.toBe('online')
  })

  it('the browser reporting that close later changes nothing: no second dial, no second drop', () => {
    const dead = last()
    dead.up()
    advance(PING_MS * 3)
    advance(wait())
    last().up() // the replacement is up
    const n = sockets.length
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    dead.fail(1006) // thirty seconds later the browser says it
    advance(1000)
    expect(sockets).toHaveLength(n)
    expect(client.store.getState().connection).toBe('online')
    expect(log.mock.calls.filter((c) => String(c[0]).includes('relay link closed'))).toHaveLength(0)
    log.mockRestore()
  })

  it('what is waiting on the dropped socket hears it at once', async () => {
    const dead = last()
    dead.up()
    advance(PING_MS * 3 - 5000) // the request goes out shortly before the keepalive gives up
    await vi.waitFor(() => expect(client.store.getState().config).toBeTruthy())
    const outcome = client.patchConfig({}).then(
      () => 'answered',
      (e: unknown) => e,
    )
    await vi.waitFor(() => expect(dead.of('config.patch')).toHaveLength(1))
    advance(5000)
    let settled = false
    void outcome.then(() => (settled = true))
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(String(await outcome)).toContain('Connection lost')
  })

  it.each([4401, 4403])('a %i from the server still stops the session, as before', (code) => {
    const s = last()
    s.up()
    s.fail(code, 'ended')
    expect(client.meta.getState().authFailed).toBe(true)
    advance(120_000)
    expect(sockets).toHaveLength(1)
  })

  it.each([4401, 4403])('a %i that arrives while the socket is closing still stops the session', (code) => {
    const s = last()
    s.up()
    s.readyState = 2 // closing
    advance(PING_MS * 3) // the keepalive does not touch a socket that is not open
    s.fail(code, 'ended')
    expect(client.meta.getState().authFailed).toBe(true)
    advance(120_000)
    expect(sockets).toHaveLength(1)
  })
})

describe('what an answer to the keepalive is worth for the stable reset', () => {
  /** Two short flaps (the backoff is at its third step), then a link that comes up. */
  function third() {
    flap(1000)
    flap(1000)
    last().up()
  }

  it('the latest keepalive ping answered after the window opened: a timer 70 s late (a hidden tab) resets', () => {
    third()
    advance(PING_MS) // the keepalive pings
    last().pong()
    vi.setSystemTime(Date.now() + 40_000) // the browser held the stable timer back
    advance(STABLE_MS - PING_MS) // it fires 70 s after ready
    last().fail(1006)
    expect(wait()).toBe(1000)
  })

  it('no answer to the keepalive: the same late timer does not reset', () => {
    third()
    advance(PING_MS)
    vi.setSystemTime(Date.now() + 40_000)
    advance(STABLE_MS - PING_MS)
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it("a pong that is not the latest keepalive ping's (a stranger nonce) does not count", () => {
    third()
    advance(PING_MS)
    last().deliver('pong', { nonce: 'not-a-ping-of-ours' })
    vi.setSystemTime(Date.now() + 40_000)
    advance(STABLE_MS - PING_MS)
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it('hours of sleep never count, even with an answer right on waking', () => {
    third()
    advance(PING_MS)
    last().pong()
    vi.setSystemTime(Date.now() + 8 * 3_600_000)
    advance(STABLE_MS - PING_MS)
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it('an answer to a ping sent before the window re-opened does not count in the new window', () => {
    third()
    advance(PING_MS) // ping 1, before the sleep
    vi.setSystemTime(Date.now() + 8 * 3_600_000)
    advance(STABLE_MS - PING_MS) // the late timer: hours, no reset; a new window opens now
    last().pong() // the answer to ping 1 arrives inside the new window
    advance(PING_MS - 5000) // ping 2 goes out inside the window and is never answered
    vi.setSystemTime(Date.now() + 35_000) // and the new window's timer is late too: 65 s
    advance(STABLE_MS - PING_MS + 5000)
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it('an answer to a ping sent inside the re-opened window does count', () => {
    third()
    advance(PING_MS)
    vi.setSystemTime(Date.now() + 8 * 3_600_000)
    advance(STABLE_MS - PING_MS) // a new window opens
    last().pong() // the link answers on waking (ping 1), so the keepalive leaves it be
    advance(PING_MS - 5000) // ping 2 goes out inside the window
    last().pong()
    vi.setSystemTime(Date.now() + 35_000)
    advance(STABLE_MS - PING_MS + 5000) // the window's timer is 65 s late
    last().fail(1006)
    expect(wait()).toBe(1000)
  })
})
