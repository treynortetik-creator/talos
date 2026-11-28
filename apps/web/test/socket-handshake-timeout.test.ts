// @vitest-environment node
// A dial that hangs (TCP or TLS stalls, or the socket opens and `ready` never comes) is given up on by the client itself, after
// handshakeGiveUpMs (HANDSHAKE_GIVE_UP_MS, 20 s, the bridge's own limit): the same drop path the keepalive give-up runs, then a normal backoff redial. Timers are
// vitest's fake ones: time moves only when a test advances it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadHolds, resetReloadHolds } from '../src/lib/reloadHold.ts'
import { DIAL_GIVE_UP_MS, HANDSHAKE_GIVE_UP_MS } from '../src/lib/socket-constants.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { FakeWs, resetFakeSockets } from './helpers/fake-ws.ts'

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

const LIMIT = 4321 // a value no other timer uses, so the pending handshake timers can be told apart; injected: tests do not wait the real 20 s
let sockets: FakeWs[]
let client: SocketClient
let online = true

beforeEach(async () => {
  sockets = resetFakeSockets()
  online = true
  resetReloadHolds()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  trackDialTimers()
  client = mk(LIMIT)
  await client.ensureDevice()
  await client.start({ pinned: true }) // dials: sockets[0] is connecting
})
afterEach(() => {
  client.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The handshake timers still pending (set with LIMIT as the delay, not yet fired or cleared). */
const pendingDial = new Set<unknown>()
function trackDialTimers() {
  pendingDial.clear()
  const set = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    const id = set(() => {
      pendingDial.delete(id)
      fn(...(a as []))
    }, ms)
    if (ms === LIMIT) pendingDial.add(id)
    return id
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: never) => {
    pendingDial.delete(id)
    clear(id)
  }) as typeof clearTimeout
}

function mk(handshakeGiveUpMs?: number, dialGiveUpMs?: number): SocketClient {
  return createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://fake.invalid/ws',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    backoff: { baseMs: 1000, maxMs: 30_000, random: () => 0.5 },
    isOnline: () => online,
    isVisible: () => true,
    now: () => Date.now(),
    handshakeGiveUpMs,
    dialGiveUpMs,
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
}
const last = () => sockets.at(-1) as FakeWs
const wait = () => (client.meta.getState().retryAt ?? 0) - Date.now()
const advance = (ms: number) => vi.advanceTimersByTime(ms)
const status = () => client.store.getState().connection

describe('a dial that never opens', () => {
  it('is dropped at the limit, shows unreachable, and redials after the normal backoff', () => {
    const s = sockets[0] as FakeWs
    expect(status()).toBe('connecting')
    advance(LIMIT - 1)
    expect(s.closeCalls).toBe(0)
    expect(status()).toBe('connecting')
    advance(1)
    expect(s.closeCalls).toBe(1)
    expect(status()).toBe('unreachable') // never stuck on connecting
    expect(sockets).toHaveLength(1) // not an instant redial: the backoff runs
    expect(wait()).toBe(1000)
    advance(wait())
    expect(sockets).toHaveLength(2)
    expect(status()).toBe('connecting')
  })

  it('logs the drop under its own code, before it was ready', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    advance(LIMIT)
    expect(client.meta.getState().lastCloseCode).toBe(4001)
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('code 4001')
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('before it was ready')
  })

  it("the browser's later close of that socket changes nothing", () => {
    const s = sockets[0] as FakeWs
    advance(LIMIT)
    const retryAt = client.meta.getState().retryAt
    s.fail(1006)
    expect(sockets).toHaveLength(1)
    expect(client.meta.getState().retryAt).toBe(retryAt)
    expect(client.meta.getState().lastCloseCode).toBe(4001)
  })

  it('a hanging redial is given up on too, and the backoff keeps growing', () => {
    advance(LIMIT)
    advance(wait())
    expect(wait()).toBeLessThanOrEqual(0)
    advance(LIMIT)
    expect(sockets).toHaveLength(2)
    expect(wait()).toBe(2000)
  })

  it('the real default is HANDSHAKE_GIVE_UP_MS (20 s), above the 15 s the triggers wait', async () => {
    expect(HANDSHAKE_GIVE_UP_MS).toBe(20_000)
    expect(HANDSHAKE_GIVE_UP_MS).toBeGreaterThan(DIAL_GIVE_UP_MS)
    client.close()
    sockets = resetFakeSockets()
    client = mk(undefined)
    await client.ensureDevice()
    await client.start({ pinned: true })
    advance(HANDSHAKE_GIVE_UP_MS - 1)
    expect(sockets[0]?.closeCalls).toBe(0)
    advance(1)
    expect(sockets[0]?.closeCalls).toBe(1)
  })

  it('a 16 s cold-radio link still connects: dial and ready both after 15 s, no trigger, no drop', async () => {
    client.close()
    sockets = resetFakeSockets()
    client = mk(undefined)
    await client.ensureDevice()
    await client.start({ pinned: true })
    advance(DIAL_GIVE_UP_MS + 1000) // 16 s of nothing
    const s = sockets[0] as FakeWs
    expect(s.closeCalls).toBe(0)
    s.up()
    expect(status()).toBe('online')
    advance(HANDSHAKE_GIVE_UP_MS * 2)
    expect(s.closeCalls).toBe(0)
    expect(sockets).toHaveLength(1)
  })

  it('an open socket whose ready comes at 16 s connects too', async () => {
    client.close()
    sockets = resetFakeSockets()
    client = mk(undefined)
    await client.ensureDevice()
    await client.start({ pinned: true })
    const s = sockets[0] as FakeWs
    advance(1000)
    s.open()
    advance(DIAL_GIVE_UP_MS)
    s.ready()
    expect(status()).toBe('online')
    expect(s.closeCalls).toBe(0)
  })
})

describe('an open socket that never gets ready', () => {
  it('is dropped at the limit counted from the dial, not from the open', () => {
    const s = sockets[0] as FakeWs
    advance(1000)
    s.open() // the hello is out
    advance(LIMIT - 1000 - 1)
    expect(s.closeCalls).toBe(0)
    advance(1)
    expect(s.closeCalls).toBe(1)
    expect(status()).toBe('unreachable')
    advance(wait())
    expect(sockets).toHaveLength(2)
    last().up()
    expect(status()).toBe('online')
  })

  it('a late ready from the dropped socket is not ours', () => {
    const s = sockets[0] as FakeWs
    s.open()
    advance(LIMIT)
    s.ready()
    expect(status()).toBe('unreachable')
  })
})

describe('ready just before the limit', () => {
  it('keeps the socket: the timer never fires after ready', () => {
    const s = sockets[0] as FakeWs
    advance(LIMIT - 1)
    s.up()
    expect(status()).toBe('online')
    advance(LIMIT * 5)
    expect(s.closeCalls).toBe(0)
    expect(sockets).toHaveLength(1)
    expect(status()).toBe('online')
  })
})

describe('the timer is cleared on every other way out', () => {
  const quiet = (n = 1) => {
    advance(LIMIT * 5)
    expect(sockets).toHaveLength(n)
  }

  it('a close during the handshake: the normal drop path owns the redial, the timer adds none', () => {
    ;(sockets[0] as FakeWs).fail(1006)
    advance(wait()) // the one backoff redial
    expect(sockets).toHaveLength(2)
    advance(LIMIT - 1000) // the old socket's timer would have fired about here
    expect(client.meta.getState().lastCloseCode).toBe(1006)
    expect(sockets[1]?.closeCalls).toBe(0) // the new dial still has its own window
  })

  it('offline', () => {
    online = false
    win.dispatchEvent(new Event('offline'))
    const s = sockets[0] as FakeWs
    quiet()
    expect(status()).toBe('offline')
    expect(client.meta.getState().lastCloseCode).not.toBe(4001)
    expect(s.closeCalls).toBe(1) // by the offline path, once
  })

  it('reconnect() replaces the dial and the new dial has its own full window', () => {
    advance(LIMIT - 1)
    client.reconnect()
    expect(sockets).toHaveLength(2)
    advance(1) // the old timer would fire here
    expect(last().closeCalls).toBe(0)
    advance(LIMIT - 2)
    expect(last().closeCalls).toBe(0)
    advance(1)
    expect(last().closeCalls).toBe(1)
  })

  it('close() (a sign-out): nothing fires afterwards', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    client.close()
    quiet()
    expect(log).not.toHaveBeenCalled()
  })

  it('a drop after ready leaves no dial timer behind', () => {
    const s = sockets[0] as FakeWs
    s.up()
    s.fail(1006)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    advance(wait()) // the redial; its own timer is armed
    const n = sockets.length
    last().up()
    advance(LIMIT * 5)
    expect(sockets).toHaveLength(n)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('no handshake timer is left pending (the stale-socket guard alone would hide a leak)', () => {
  it('one while dialling', () => {
    expect(pendingDial.size).toBe(1)
  })
  it('ready: none', () => {
    ;(sockets[0] as FakeWs).up()
    expect(pendingDial.size).toBe(0)
  })
  it('a close: none', () => {
    ;(sockets[0] as FakeWs).fail(1006)
    expect(pendingDial.size).toBe(0)
  })
  it('the give-up itself: none left', () => {
    advance(LIMIT)
    expect(pendingDial.size).toBe(0)
  })
  it("reconnect(): exactly one, the new dial's", () => {
    client.reconnect()
    expect(pendingDial.size).toBe(1)
  })
  it('offline: none', () => {
    online = false
    win.dispatchEvent(new Event('offline'))
    expect(pendingDial.size).toBe(0)
  })
  it('close(): none', () => {
    client.close()
    expect(pendingDial.size).toBe(0)
  })
  it('a 4401: none', () => {
    ;(sockets[0] as FakeWs).fail(4401)
    expect(pendingDial.size).toBe(0)
  })
})

describe('a server refusal during the handshake still stops', () => {
  it.each([4401, 4403])('%i stops: offline, authFailed, no redial, and the timer does not revive it', (code) => {
    const s = sockets[0] as FakeWs
    advance(1000)
    s.open()
    s.fail(code, 'no')
    expect(status()).toBe('offline')
    expect(client.meta.getState().authFailed).toBe(true)
    advance(LIMIT * 10)
    expect(sockets).toHaveLength(1)
    expect(status()).toBe('offline')
    expect(client.meta.getState().authFailed).toBe(true)
  })
})

describe('status and triggers', () => {
  it('a focus during the handshake that is under the limit does not replace it', () => {
    advance(LIMIT - 1)
    win.dispatchEvent(new Event('focus'))
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.closeCalls).toBe(0)
  })

  it('the timer first (both limits equal): one drop, then the trigger dials at once; exactly two sockets, the dead one closed once', async () => {
    client.close()
    sockets = resetFakeSockets()
    client = mk(DIAL_GIVE_UP_MS, DIAL_GIVE_UP_MS)
    await client.ensureDevice()
    await client.start({ pinned: true })
    advance(DIAL_GIVE_UP_MS) // the timer fires: dropped, backoff scheduled
    expect(sockets).toHaveLength(1)
    win.dispatchEvent(new Event('focus')) // no socket and a retry waiting: dials at once
    expect(sockets).toHaveLength(2)
    expect(sockets[0]?.closeCalls).toBe(1)
    advance(DIAL_GIVE_UP_MS - 1) // the backoff wait that was cut short must not dial a third
    expect(sockets).toHaveLength(2)
  })

  it('the trigger first (handshake limit above the trigger limit): one replacement, and the old timer is cleared, not fired', async () => {
    client.close()
    sockets = resetFakeSockets()
    client = mk(DIAL_GIVE_UP_MS + 5000, DIAL_GIVE_UP_MS)
    await client.ensureDevice()
    await client.start({ pinned: true })
    advance(DIAL_GIVE_UP_MS)
    win.dispatchEvent(new Event('focus')) // replaces the dial
    expect(sockets).toHaveLength(2)
    expect(sockets[0]?.closeCalls).toBe(1)
    advance(5000) // the old dial's timer would fire here
    expect(sockets).toHaveLength(2)
    expect(sockets[0]?.closeCalls).toBe(1)
    expect(sockets[1]?.closeCalls).toBe(0)
    expect(client.meta.getState().lastCloseCode).not.toBe(4001) // a replacement is not a logged drop
  })
})

describe('a server refusal still in flight when the limit passes', () => {
  it.each([4401, 4403])(
    'a socket already CLOSING at the limit is left to its %i, which still stops the session',
    (code) => {
      const s = sockets[0] as FakeWs
      advance(1000)
      s.open()
      s.readyState = 2 // the relay closed it with a refusal; its close event is still on the way
      advance(LIMIT)
      expect(s.closeCalls).toBe(0) // not ours to cut short
      expect(client.meta.getState().lastCloseCode).not.toBe(4001)
      expect(sockets).toHaveLength(1)
      expect(client.meta.getState().retryAt).toBeNull()
      s.fail(code, 'refused')
      expect(status()).toBe('offline')
      expect(client.meta.getState().authFailed).toBe(true)
      advance(LIMIT * 10)
      expect(sockets).toHaveLength(1)
    },
  )
})

describe('no lost and no doubled messages after a timeout replacement', () => {
  it('a message queued during the hung dial goes out once, on the replacement', async () => {
    const res = await client.sendMessage({ threadId: 'general', text: 'while the dial hangs' })
    expect(res.clientMsgId).toBeTruthy()
    expect(sockets[0]?.sent).toHaveLength(0)
    advance(LIMIT) // given up on
    advance(wait())
    const next = last()
    expect(next).not.toBe(sockets[0])
    next.up()
    await vi.advanceTimersByTimeAsync(0)
    const out = next.of('message') as Array<{ id?: string; text?: string }>
    expect(out.map((f) => f.text)).toEqual(['while the dial hangs'])
    for (const f of out) next.deliver('ack', { ref: f.id })
    await vi.advanceTimersByTimeAsync(0)
    advance(LIMIT * 5)
    expect(sockets[0]?.of('message')).toHaveLength(0)
    expect(next.of('message')).toHaveLength(1)
    expect(reloadHolds.getState().holds).toBe(0) // the holds were released with the dropped socket
  })

  it('a message written to an open socket that never got ready is not lost when the dial is dropped', async () => {
    const s = sockets[0] as FakeWs
    s.open()
    await client.sendMessage({ threadId: 'general', text: 'before ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.of('message')).toHaveLength(0) // not written before ready
    advance(LIMIT)
    advance(wait())
    last().up()
    await vi.advanceTimersByTimeAsync(0)
    expect(last().of('message')).toHaveLength(1)
  })
})
