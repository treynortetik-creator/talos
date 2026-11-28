// @vitest-environment node
// 0.19: the reconnect backoff starts over only after a connection has stayed up for STABLE_MS (the bridge's own rule,
// apps/bridge/src/relay-client.ts), not at the relay's `ready`. A relay that says `ready` and then hangs up must not be
// redialled every second for ever. Timers are vitest's fake ones: time only moves when a test advances it.
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

const BASE = 1000
const MAX = 30_000
let sockets: FakeWs[]
let client: SocketClient

beforeEach(async () => {
  sockets = resetFakeSockets()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: BASE, maxMs: MAX, random: () => 0.5 }, // 0.5 is the middle of the jitter: the delay is exactly 2^attempt
    isOnline: () => true,
    now: () => Date.now(),
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
})
afterEach(() => {
  client.close()
  vi.useRealTimers()
})

const last = () => sockets.at(-1) as FakeWs
/** The wait the client scheduled after the last drop. */
const wait = () => (client.meta.getState().retryAt ?? 0) - Date.now()
/** A link that comes up, stays `upMs`, then drops; returns the wait the client chose. Then lets that wait pass (the next dial). */
function flap(upMs: number): number {
  last().up()
  vi.advanceTimersByTime(upMs)
  last().fail(1006)
  const w = wait()
  vi.advanceTimersByTime(w)
  return w
}

describe('backoff reset', () => {
  it('a server that drops 10 s after ready keeps growing the wait, up to the cap', () => {
    const waits = [0, 1, 2, 3, 4, 5, 6].map(() => flap(10_000))
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
  })

  it('a server that says ready and hangs up at once is not redialled every second', () => {
    const waits = Array.from({ length: 8 }, () => flap(0))
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] as number)
    expect(waits.at(-1)).toBe(MAX)
  })

  it('a link that stays up STABLE_MS starts the backoff over', () => {
    expect([flap(5000), flap(5000), flap(5000)]).toEqual([1000, 2000, 4000])
    last().up()
    vi.advanceTimersByTime(STABLE_MS)
    last().fail(1006)
    expect(wait()).toBe(1000)
  })

  it('one millisecond short of STABLE_MS is not enough', () => {
    flap(5000)
    flap(5000)
    last().up()
    vi.advanceTimersByTime(STABLE_MS - 1)
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it('the timer belongs to its socket: a drop and a quick new link do not inherit the old 30 s', () => {
    flap(STABLE_MS - 5000) // 25 s up, then a drop
    last().up() // the new link has been up 0 s
    vi.advanceTimersByTime(10_000) // 35 s since the first ready, 10 s on this one
    last().fail(1006)
    expect(wait()).toBe(2000) // grown: the first drop was not stable, and this link was not either
  })

  it('after a stable link the steps start from the bottom again', () => {
    expect([flap(5000), flap(5000), flap(5000)]).toEqual([1000, 2000, 4000])
    expect([flap(STABLE_MS), flap(1000), flap(1000)]).toEqual([1000, 2000, 4000])
  })
})

describe('sleep and clock jumps', () => {
  it('a timer that fires 8 h late (the machine slept) does not count as 30 s of uptime', () => {
    flap(1000)
    flap(1000)
    last().up()
    vi.setSystemTime(Date.now() + 8 * 3_600_000) // asleep: the clock moved, no timer ran
    vi.advanceTimersByTime(STABLE_MS) // on waking, the late timer fires
    last().fail(1006)
    expect(wait()).toBe(4000)
  })

  it('a clock that steps backwards does not reset either', () => {
    flap(1000)
    last().up()
    vi.setSystemTime(Date.now() - 3_600_000)
    vi.advanceTimersByTime(STABLE_MS)
    last().fail(1006)
    expect(wait()).toBe(2000)
  })

  it('uptime is elapsed time: a link up across local midnight for 30 s resets', () => {
    vi.setSystemTime(new Date(2026, 10, 25, 23, 59, 50)) // local time, as the code reads it
    flap(1000)
    flap(1000)
    last().up() // 23:59:52 or so
    vi.advanceTimersByTime(STABLE_MS) // now past 00:00 the next local day
    expect(new Date().getDate()).toBe(26)
    last().fail(1006)
    expect(wait()).toBe(1000)
  })
})

describe('the timer ends with the socket', () => {
  it('close() (sign-out) leaves no timer behind', () => {
    last().up()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    client.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('going offline leaves no timer behind', () => {
    last().up()
    vi.advanceTimersByTime(300) // the snapshot save (250 ms debounce) has run: only the stable timer is left
    expect(vi.getTimerCount()).toBe(1)
    win.dispatchEvent(new Event('offline'))
    vi.advanceTimersByTime(300) // going offline changes the store, so one more snapshot save runs
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a link replaced by reconnect() 29 s in does not count: its old timer cannot reset a later drop', () => {
    flap(1000)
    flap(1000)
    last().up()
    vi.advanceTimersByTime(STABLE_MS - 1000)
    client.reconnect() // replaced by hand, 29 s in: this link did not last
    last().up()
    vi.advanceTimersByTime(2000) // the old timer's moment passes
    last().fail(1006)
    expect(wait()).toBe(4000)
  })
})

describe('explicit dials do not reset the backoff', () => {
  it('reconnect() dials at once and keeps the grown step', () => {
    flap(1000)
    flap(1000)
    last().fail(1006) // never ready
    const before = sockets.length
    client.reconnect()
    expect(sockets).toHaveLength(before + 1)
    last().fail(1006)
    expect(wait()).toBeGreaterThan(2000)
  })

  it('coming to the front with no socket dials at once and keeps the grown step', () => {
    flap(1000)
    flap(1000)
    last().fail(1006)
    const before = sockets.length
    ;(g.document as EventTarget).dispatchEvent(new Event('visibilitychange'))
    expect(sockets).toHaveLength(before + 1)
    last().fail(1006)
    expect(wait()).toBeGreaterThan(2000)
  })
})
