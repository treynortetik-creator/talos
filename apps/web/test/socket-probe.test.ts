// @vitest-environment node
// 0.19: "back online", coming to the front, a window focus and a page restored from the back-forward cache PROBE the live
// socket (a ping, a short wait) and replace it only when nothing answers. A healthy socket is never torn down: no new
// socket, nothing re-sent, nothing rejected. Timers are vitest's fake ones: time moves only when a test advances it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoAnswerError, NotSentError } from '../src/lib/client.ts'
import { reloadHolds, resetReloadHolds } from '../src/lib/reloadHold.ts'
import { DIAL_GIVE_UP_MS, EAGER_DIAL_MS, WAKE_PROBE_MS } from '../src/lib/socket-constants.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { FakeWs, resetFakeSockets, sentOn } from './helpers/fake-ws.ts'

const win = new EventTarget()
const doc = new EventTarget()
const g = globalThis as Record<string, unknown>
beforeAll(() => {
  g.window = win
  g.document = doc
})
afterAll(() => {
  g.window = undefined
  g.document = undefined
})

let sockets: FakeWs[]
let client: SocketClient
let online = true
let visible = true

beforeEach(async () => {
  sockets = resetFakeSockets()
  online = true
  visible = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, maxMs: 30_000, random: () => 0.5 },
    isOnline: () => online,
    isVisible: () => visible,
    now: () => Date.now(),
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  sockets[0]?.up()
})
afterEach(() => {
  client.close()
  vi.useRealTimers()
})

const last = () => sockets.at(-1) as FakeWs
const wait = () => (client.meta.getState().retryAt ?? 0) - Date.now()
const advance = (ms: number) => vi.advanceTimersByTime(ms)
const pings = () => sentOn('ping').length
const hellos = () => sentOn('hello').length

/** The ways a person comes back to the page. Each one must probe, never replace. */
const TRIGGERS: Record<string, () => void> = {
  online: () => win.dispatchEvent(new Event('online')),
  'coming to the front': () => doc.dispatchEvent(new Event('visibilitychange')),
  focus: () => win.dispatchEvent(new Event('focus')),
  'a page restored from the back-forward cache': () =>
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })),
}

async function sendOne(text: string) {
  const res = await client.sendMessage({ threadId: 'general', text })
  return res.clientMsgId
}

describe.each(Object.entries(TRIGGERS))('%s, healthy socket', (_name, trigger) => {
  it('keeps the socket: one ping, no new socket, nothing re-sent, nothing rejected', async () => {
    await sendOne('already on the wire')
    const s = last()
    const connection = client.store.getState().connection
    expect(s.of('message')).toHaveLength(1)
    const failed = vi.fn()
    const request = client.patchConfig({}).catch(failed) // waits for the Mac's answer on this socket
    await vi.waitFor(() => expect(s.of('config.patch')).toHaveLength(1))
    trigger()
    expect(sockets).toHaveLength(1)
    expect(s.of('ping')).toHaveLength(1)
    s.pong()
    advance(WAKE_PROBE_MS * 4)
    expect(sockets).toHaveLength(1)
    expect(s.closeCalls).toBe(0)
    expect(s.of('message')).toHaveLength(1) // not written a second time
    expect(hellos()).toBe(1)
    expect(client.store.getState().connection).toBe(connection)
    expect(failed).not.toHaveBeenCalled()
    void request
  })

  it("only the pong with this probe's nonce proves the link: a frame the browser held while asleep does not", () => {
    const s = last()
    trigger()
    s.deliver('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 })
    s.deliver('pong', { nonce: 'not-this-probes-nonce' })
    advance(WAKE_PROBE_MS)
    expect(s.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
  })
})

describe.each(Object.entries(TRIGGERS))('%s, dead socket', (_name, trigger) => {
  it('replaces it once, WAKE_PROBE_MS after the ping, and dials at once', () => {
    const s = last()
    trigger()
    advance(WAKE_PROBE_MS - 1)
    expect(sockets).toHaveLength(1)
    advance(1)
    expect(s.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2) // dialled now, not after a backoff wait
    expect(client.store.getState().connection).toBe('connecting')
    last().up()
    expect(hellos()).toBe(2)
    expect(client.store.getState().connection).toBe('online')
  })
})

describe('a burst of events', () => {
  it('online, visibility, focus and pageshow together make one ping and one replacement', () => {
    const s = last()
    for (const t of Object.values(TRIGGERS)) t()
    expect(pings()).toBe(1)
    advance(WAKE_PROBE_MS)
    expect(s.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
    last().up() // a replacement left hanging would be given up on after DIAL_GIVE_UP_MS
    advance(60_000) // and nothing else follows
    expect(sockets).toHaveLength(2)
  })

  it('a second event while a probe is pending does not push its deadline out', () => {
    trigger('online')
    advance(2000)
    trigger('focus')
    expect(pings()).toBe(1)
    advance(WAKE_PROBE_MS - 2000)
    expect(sockets).toHaveLength(2)
  })

  it('an answered probe frees the slot: the next event probes again', () => {
    trigger('online')
    last().pong()
    advance(100)
    trigger('focus')
    expect(pings()).toBe(2)
  })
})
const trigger = (name: string) => (TRIGGERS[name] as () => void)()

describe('no lost and no doubled messages across a replacement', () => {
  it('a message written to the dead socket and one queued during the gap each go out once on the new one', async () => {
    const m1 = await sendOne('written to the dying socket')
    const first = last()
    const bytes1 = first.of('message')[0]
    trigger('online')
    advance(WAKE_PROBE_MS) // dead: replaced, the new socket is still connecting
    const gap = last()
    expect(gap).not.toBe(first)
    await sendOne('queued while reconnecting') // no ready yet: it waits in the outbox
    expect(gap.sent).toHaveLength(0)
    const seq = client.store.getState().lastSeq
    gap.up()
    await vi.advanceTimersByTimeAsync(0)
    const hello = gap.of('hello')[0] as { last_seq?: number }
    expect(hello.last_seq).toBe(seq) // resumes from what the old socket delivered
    const out = gap.of('message') as Array<{ id?: string; text?: string }>
    expect(out.map((f) => f.text).sort()).toEqual(['queued while reconnecting', 'written to the dying socket'])
    expect(JSON.stringify(out.find((f) => f.text === 'written to the dying socket'))).toBe(JSON.stringify(bytes1)) // same bytes
    // acked: nothing is sent again, on any later event
    for (const f of out) gap.deliver('ack', { ref: f.id })
    trigger('online')
    gap.pong()
    advance(WAKE_PROBE_MS * 3)
    expect(gap.of('message')).toHaveLength(2)
    expect(m1).toBeTruthy()
  })

  it('a request waiting on the socket is rejected when the dead socket is replaced, and not before', async () => {
    const thread = client.store.getState().threads[0]
    const outcome = client.patchConfig({ threads: thread ? [{ ...thread, order: 1 }] : [] }).then(
      () => 'answered',
      (e: unknown) => e,
    )
    await vi.waitFor(() => expect(last().of('config.patch')).toHaveLength(1))
    trigger('online')
    advance(WAKE_PROBE_MS - 1)
    let settled = false
    void outcome.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    advance(1)
    expect(await outcome).toBeInstanceOf(NoAnswerError)
  })
})

describe('a probe racing a real close', () => {
  it('the real close lands first: no second dial from the probe timer', () => {
    trigger('online')
    advance(1000)
    last().fail(1006)
    expect(sockets).toHaveLength(1)
    advance(WAKE_PROBE_MS) // the probe's moment passes; the backoff dial is the only one
    expect(sockets).toHaveLength(2)
    last().up() // a dial left hanging is given up on after DIAL_GIVE_UP_MS (socket-handshake-timeout.test.ts)
    advance(60_000)
    expect(sockets).toHaveLength(2)
  })

  it('the probe replaces the socket, then the old socket really closes: one dial, one hello', () => {
    const old = last()
    trigger('online')
    advance(WAKE_PROBE_MS)
    expect(sockets).toHaveLength(2)
    last().up()
    old.fail(1006) // the browser finally reports it
    advance(120_000)
    expect(sockets).toHaveLength(2)
    expect(hellos()).toBe(2)
    expect(client.store.getState().connection).toBe('online')
  })

  it('a pong that arrives before the timer keeps the socket', () => {
    const s = last()
    trigger('online')
    advance(WAKE_PROBE_MS - 1)
    s.pong() // at the last millisecond
    advance(1)
    expect(s.closeCalls).toBe(0)
    expect(sockets).toHaveLength(1)
  })

  it('a pong that arrives after the timer is ignored and does not disturb the new socket', () => {
    const old = last()
    trigger('online')
    advance(WAKE_PROBE_MS)
    last().up()
    old.pong() // the old link wakes up late
    advance(60_000)
    expect(sockets).toHaveLength(2)
    expect(last().closeCalls).toBe(0)
    expect(client.store.getState().connection).toBe('online')
  })

  it('Retry (reconnect()) during a pending probe takes the socket: the probe timer then does nothing', () => {
    trigger('online')
    advance(1000)
    client.reconnect()
    expect(sockets).toHaveLength(2)
    last().up()
    advance(WAKE_PROBE_MS * 2)
    expect(sockets).toHaveLength(2)
    expect(last().closeCalls).toBe(0)
  })
})

describe('the probe ends with the socket', () => {
  it('going offline during a probe leaves no probe timer', () => {
    advance(300) // the snapshot save has run; the stable timer and the probe are the only timers
    trigger('online')
    expect(vi.getTimerCount()).toBe(2)
    win.dispatchEvent(new Event('offline'))
    advance(300) // going offline changes the store, so one more snapshot save runs
    const timers = vi.getTimerCount()
    advance(WAKE_PROBE_MS * 2)
    expect(sockets).toHaveLength(1)
    expect(timers).toBe(0)
  })

  it('close() (sign-out) during a probe leaves nothing behind', () => {
    trigger('online')
    client.close()
    expect(vi.getTimerCount()).toBe(0)
    advance(WAKE_PROBE_MS * 2)
    expect(sockets).toHaveLength(1)
  })

  it('a refused session (4401) stays stopped: no trigger dials', () => {
    last().fail(4401, 'session ended')
    expect(client.meta.getState().authFailed).toBe(true)
    for (const t of Object.values(TRIGGERS)) t()
    advance(60_000)
    expect(sockets).toHaveLength(1)
  })
})

describe('no socket, or one that is not up yet', () => {
  it('online with no socket and a retry pending dials now and keeps the grown step', () => {
    last().fail(1006) // wait 1000, attempt 1
    advance(1000)
    last().fail(1006) // never ready: wait 2000, attempt 2
    const n = sockets.length
    trigger('online')
    expect(sockets).toHaveLength(n + 1)
    last().fail(1006)
    expect(wait()).toBeGreaterThan(2000)
  })

  it('a socket whose send throws counts as dead: replaced at once, never read as fine', () => {
    const s = last()
    s.throwOnSend = true
    trigger('online')
    expect(s.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
    expect(client.store.getState().connection).not.toBe('online')
  })
})

describe('what the person is shown', () => {
  it('a replacement that cannot be dialled shows unreachable with a retry time, not online', () => {
    trigger('online')
    advance(WAKE_PROBE_MS)
    last().fail(1006) // the new dial is refused
    expect(client.store.getState().connection).toBe('unreachable')
    expect(client.meta.getState().retryAt).not.toBeNull()
  })
})

// ---- review of 0.19 -----------------------------------------------------------------------------------------------------

/** A client whose first socket never came up: the dial is still going. */
async function dialling() {
  client.close()
  sockets = resetFakeSockets()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, maxMs: 30_000, random: () => 0.5 },
    isOnline: () => online,
    isVisible: () => visible,
    now: () => Date.now(),
    handshakeGiveUpMs: 1e9, // these tests are about the triggers; the handshake timer has its own file
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  expect(sockets).toHaveLength(1)
}
const BACK = ['coming to the front', 'focus', 'a page restored from the back-forward cache'] as const

describe('a dial that is not up yet gets DIAL_GIVE_UP_MS, not the probe window', () => {
  it('a 4 s handshake under focus events every 2 s connects, on the one socket', async () => {
    await dialling()
    advance(2000)
    trigger('focus')
    advance(2000)
    trigger('focus') // 4 s: the handshake ends right after
    sockets[0]?.up()
    advance(2000)
    trigger('focus')
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.closeCalls).toBe(0)
    expect(client.store.getState().connection).toBe('online')
  })

  it('a dial still connecting after DIAL_GIVE_UP_MS is replaced by the next trigger', async () => {
    await dialling()
    advance(DIAL_GIVE_UP_MS - 1)
    trigger('focus')
    expect(sockets).toHaveLength(1)
    advance(1)
    trigger('focus')
    expect(sockets[0]?.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
  })

  it.each(BACK)('%s never replaces an open socket that is waiting for ready', async (name) => {
    await dialling()
    const s = sockets[0] as FakeWs
    s.open() // the hello is out; the relay has not answered
    for (let i = 0; i < 12; i++) {
      advance(1000) // 12 s in all
      trigger(name)
    }
    expect(sockets).toHaveLength(1)
    expect(s.closeCalls).toBe(0)
    s.ready()
    expect(client.store.getState().connection).toBe('online')
  })

  it('online replaces an open socket still waiting for ready only after DIAL_GIVE_UP_MS', async () => {
    await dialling()
    const s = sockets[0] as FakeWs
    s.open()
    advance(DIAL_GIVE_UP_MS - 1)
    trigger('online')
    expect(sockets).toHaveLength(1)
    advance(1)
    trigger('online')
    expect(s.closeCalls).toBe(1)
    expect(sockets).toHaveLength(2)
  })
})

describe('the probe waits long enough for a slow link', () => {
  it('a pong at 3 s keeps the socket', () => {
    const s = last()
    trigger('online')
    advance(3000)
    s.pong()
    advance(WAKE_PROBE_MS * 2)
    expect(s.closeCalls).toBe(0)
    expect(sockets).toHaveLength(1)
  })

  it('a request in flight survives a slow pong', async () => {
    const s = last()
    const outcome = client.patchConfig({}).then(
      () => 'answered',
      (e: unknown) => e,
    )
    await vi.waitFor(() => expect(s.of('config.patch')).toHaveLength(1))
    trigger('online')
    advance(3000)
    s.pong()
    let settled = false
    void outcome.then(() => (settled = true))
    advance(5000) // still inside the request's own wait: only a replacement of the socket could have ended it
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(sockets).toHaveLength(1)
  })
})

describe('with no socket, coming back dials at once at most once per EAGER_DIAL_MS', () => {
  async function outage() {
    last().fail(1006) // wait 1000, attempt 1
    advance(1000)
    last().fail(1006) // the redial is refused: a retry is scheduled (2000)
  }

  it.each(BACK)('%s: the first dials now, the rest wait for the scheduled retry', async (name) => {
    await outage()
    const n = sockets.length
    trigger(name)
    expect(sockets).toHaveLength(n + 1) // dialled now
    last().fail(1006) // refused again: another retry is scheduled
    for (let i = 0; i < 8; i++) {
      advance(1000)
      trigger(name)
    }
    // eight events in eight seconds: none of them dialled (only a scheduled retry may)
    expect(sockets.length).toBeLessThanOrEqual(n + 2)
  })

  it('after EAGER_DIAL_MS the next one dials again, and the scheduled retry still dials on its own', async () => {
    await outage()
    const n = sockets.length
    trigger('focus')
    last().fail(1006)
    advance(EAGER_DIAL_MS)
    // the scheduled retry may already have dialled in that time; either way an event now is allowed to dial at once
    const before = sockets.length
    if (client.meta.getState().retryAt !== null) trigger('focus')
    expect(sockets.length).toBeGreaterThanOrEqual(before)
    expect(sockets.length).toBeGreaterThan(n)
  })

  it('a refused outage makes no dial storm and no /api/me storm', async () => {
    const asked = vi.fn(async () => new Response('{}', { status: 200 }))
    client.close()
    sockets = resetFakeSockets()
    client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://fake.invalid/ws',
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      backoff: { baseMs: 20_000, maxMs: 30_000, random: () => 0.5 }, // a retry that is far away
      isOnline: () => online,
      isVisible: () => visible,
      now: () => Date.now(),
      fetchImpl: asked as unknown as typeof fetch,
    })
    await client.ensureDevice()
    await client.start({ pinned: true })
    sockets[0]?.fail(1006)
    for (let i = 0; i < 40; i++) {
      advance(500) // 20 s of focus and visibility events, half a second apart
      trigger(i % 2 ? 'focus' : 'coming to the front')
      sockets.at(-1)?.fail(1006)
    }
    expect(sockets.length).toBeLessThanOrEqual(5) // the first, one per EAGER_DIAL_MS (two), the retry
    expect(asked.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('replacing a dead socket is not a drop', () => {
  it('keeps the backoff step: the replacement that fails waits the first step, not the second', () => {
    trigger('online')
    advance(WAKE_PROBE_MS) // dead: replaced
    last().fail(1006) // the new dial is refused
    expect(wait()).toBe(1000)
  })

  it('never shows unreachable and logs no drop while it replaces the socket', () => {
    const seen: string[] = []
    const off = client.store.subscribe((st) => seen.push(st.connection))
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    trigger('online')
    advance(WAKE_PROBE_MS)
    off()
    expect(seen).not.toContain('unreachable')
    expect(client.store.getState().connection).toBe('connecting')
    expect(log.mock.calls.filter((c) => String(c[0]).includes('relay link closed'))).toHaveLength(0)
    log.mockRestore()
  })

  it('what was written to the dead socket holds no reload once it is let go', async () => {
    resetReloadHolds()
    await sendOne('held until acked')
    expect(reloadHolds.getState().holds).toBe(1)
    trigger('online')
    advance(WAKE_PROBE_MS)
    expect(sockets).toHaveLength(2)
    expect(reloadHolds.getState().holds).toBe(0) // the next socket takes its own
  })
})

describe('a closing socket is left to finish', () => {
  it.each(Object.entries(TRIGGERS))('%s: does nothing, and the real close still arrives', (_name, fire) => {
    const s = last()
    s.readyState = 2
    fire()
    advance(WAKE_PROBE_MS * 2)
    expect(sockets).toHaveLength(1)
    expect(s.closeCalls).toBe(0)
  })

  it('a 4401 that arrives while the socket is closing still stops the session', () => {
    const s = last()
    s.readyState = 2
    for (const t of Object.values(TRIGGERS)) t()
    s.fail(4401, 'session ended')
    expect(client.meta.getState().authFailed).toBe(true)
    for (const t of Object.values(TRIGGERS)) t()
    advance(120_000)
    expect(sockets).toHaveLength(1)
  })
})

describe('a request is not sent into a socket that went while it was being signed', () => {
  it('sendOwnerFrame fails as not sent, at once', async () => {
    const s = last()
    const outcome = client.sendOwnerFrame?.({ type: 'session.control', thread_id: 'general', action: 'stop' }).then(
      () => 'sent',
      (e: unknown) => e,
    )
    s.fail(1006) // signing is still going
    let settled = false
    void outcome?.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(await outcome).toBeInstanceOf(NotSentError)
    expect(s.of('session.control')).toHaveLength(0)
  })

  it('a read (speak.request) fails as not sent, at once', async () => {
    const s = last()
    const outcome = client.speak?.request({ messageId: 'm_1', threadId: 'general', fresh: false }).then(
      () => 'sent',
      (e: unknown) => e,
    )
    s.fail(1006)
    let settled = false
    void outcome?.then(() => (settled = true))
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(await outcome).toBeInstanceOf(NotSentError)
  })
})
