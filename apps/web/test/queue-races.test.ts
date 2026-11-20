// @vitest-environment node
// Races in the offline message queue. Each case injects the failure for real, in the storage object or the upload the
// client uses, at the one await where the old code lost a message, resurrected a deleted one, or let order change.
import { FakeBridge, FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteDeviceKey } from '../src/lib/deviceKey.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'
import { keepsUnsent } from '../src/lib/unsent.ts'

const DAY = 24 * 3600_000
let relay: FakeRelay
let bridge: FakeBridge
let storage: Storage
let skew = 0
let online = false
let client: SocketClient

type Row = { id: string; clientMsgId: string; bytes: string; writtenAt?: number | null; order: number; kind?: string }
type Hooks = {
  beforePut?: (store: string, key: string, value: unknown) => Promise<void> | void
  afterDel?: (store: string, key: string) => Promise<void> | void
}
let hooks: Hooks = {}

function hookedStorage(): Storage {
  const inner = createMemoryStorage()
  return {
    ...inner,
    async put(store, key, value) {
      await hooks.beforePut?.(store, key, value)
      return inner.put(store, key, value)
    },
    async del(store, key) {
      await inner.del(store, key)
      await hooks.afterDel?.(store, key)
    },
  }
}

/** A socket that swallows the frames `lose` picks: the client believes they went out, the relay never sees them. */
let lose: ((frame: string) => boolean) | undefined
class LossyWS extends WebSocket {
  override send(data: string | BufferSource | Blob) {
    if (typeof data === 'string' && lose?.(data)) return
    super.send(data)
  }
}

const make = (flushRetryMs = 60) =>
  createSocketClient({
    storage,
    WebSocketImpl: LossyWS as unknown as typeof WebSocket,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => online,
    now: () => Date.now() + skew,
    flushRetryMs,
  })

beforeEach(async () => {
  hooks = {}
  lose = undefined
  relay = await new FakeRelay().start()
  storage = hookedStorage()
  skew = 0
  online = false
  client = make()
  const key = await client.ensureDevice()
  bridge = await new FakeBridge({
    relayWs: relay.wsBase,
    key: relay.bridgeKey,
    now: () => Date.now() + skew,
    pinnedDevices: { [key.deviceId]: key.publicJwk },
  }).connect()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const rows = () => storage.all<Row>('outbox')
const fromApp = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gate = () => {
  let open!: () => void
  const wait = new Promise<void>((r) => {
    open = r
  })
  let hit!: () => void
  const hitP = new Promise<void>((r) => {
    hit = r
  })
  return { wait, open, hit, hitP }
}

async function reopen(flushRetryMs?: number) {
  client.close()
  online = true
  client = make(flushRetryMs)
  await client.start({ pinned: true })
}
describe('a close that lands while a message is being marked as written', () => {
  it('keeps the only copy when the session only expired', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') client.close({ keepQueue: true })
    }
    const res = await client.sendMessage({ threadId: 'general', text: 'do not lose me' })
    expect(res.state).toBe('queued')
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left[0]?.clientMsgId).toBe(res.clientMsgId)
  })

  it('still takes it back out when the owner signed out', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') client.close()
    }
    await client.sendMessage({ threadId: 'general', text: 'gone with the sign-out' })
    expect(await rows()).toHaveLength(0)
  })
})

describe('a close that lands while a message is first being saved', () => {
  /** The close arrives during the one write that saves the signed message (the one with no write time yet). */
  const closeDuringFirstSave = (keepQueue: boolean) => {
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && (v as Row).writtenAt === null) client.close(keepQueue ? { keepQueue: true } : undefined)
    }
  }

  it.each([['expired'], ['signed_in_again']])(
    'reason %s: the row stays, the caller is told it is queued, and it goes out once after sign-in with the same key',
    async (reason) => {
      closeDuringFirstSave(keepsUnsent(reason))
      const res = await client.sendMessage({ threadId: 'general', text: 'pressed as it expired' })
      expect(res.state).toBe('queued') // not a failure: the words are not handed back as well
      const left = await rows()
      expect(left).toHaveLength(1)
      expect(left[0]?.clientMsgId).toBe(res.clientMsgId)
      hooks = {}
      await reopen() // signed back in on the same device key
      await waitFor(() => fromApp('message').length === 1, 6000, 'sent after sign-in')
      await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
      expect(fromApp('message')).toHaveLength(1)
    },
  )

  it('with the device key replaced meanwhile, the row is removed with a notice and nothing is sent', async () => {
    closeDuringFirstSave(true)
    await client.sendMessage({ threadId: 'general', text: 'under the old key' })
    expect(await rows()).toHaveLength(1)
    hooks = {}
    await deleteDeviceKey(storage)
    await make().ensureDevice() // a new key
    await reopen()
    await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
    const notice = Object.values(client.store.getState().messages)
      .flat()
      .find((m) => m.author === 'system')
    expect(notice?.text).toMatch(/1 message that was waiting was removed/)
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(fromApp('message')).toHaveLength(0)
  })

  it('a sign-out takes the row back out and the caller gets a failure', async () => {
    closeDuringFirstSave(false)
    await expect(client.sendMessage({ threadId: 'general', text: 'gone with the sign-out' })).rejects.toThrow()
    expect(await rows()).toHaveLength(0)
  })
})

/**
 * Holds the next signing until the gate opens. The signing input is a hash, so a signing is told apart by who asked for it:
 * `from` is a function name that must be on the call stack.
 */
function holdSigning(from?: string) {
  const g = gate()
  const real = crypto.subtle.sign.bind(crypto.subtle)
  let held = false
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (alg, key, data) => {
    if (!held && (from === undefined || new Error().stack?.includes(from))) {
      held = true
      g.hit()
      await g.wait
    }
    return real(alg as never, key, data as BufferSource)
  })
  return g
}

describe('a close that lands while a message is being signed', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([['expired'], ['signed_in_again']])(
    'reason %s: the row is saved, the caller is told it is queued, and it goes out once after sign-in',
    async (reason) => {
      const g = holdSigning()
      const sent = client.sendMessage({ threadId: 'general', text: 'pressed as the session ended' })
      await g.hitP
      client.close({ keepQueue: keepsUnsent(reason) })
      g.open()
      const res = await sent // not a throw: the words are not handed back as well
      expect(res.state).toBe('queued')
      expect(await rows()).toHaveLength(1)
      vi.restoreAllMocks()
      await reopen()
      await waitFor(() => fromApp('message').length === 1, 6000, 'sent after sign-in')
      await vi.waitFor(async () => expect(await rows()).toHaveLength(0), { timeout: 6000 })
      expect(fromApp('message')).toHaveLength(1)
    },
  )
})

describe('a sign-out during the last await of a re-sign', () => {
  it('writes nothing back to the queue afterwards', async () => {
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'old news' })
    skew = 0
    let fired = false
    hooks.afterDel = async (s) => {
      if (s !== 'outbox' || fired) return
      fired = true
      client.close() // the sign-out, then its wipe
      await storage.clear('outbox')
    }
    await reopen()
    await waitFor(() => fired, 6000, 'the re-sign finished its swap')
    await sleep(150)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
  })
})

describe('a close that lands while a message is being signed again', () => {
  it('keeps the message, in its new signature, when the session only expired', async () => {
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'old but wanted' })
    skew = 0
    const [orig] = await rows()
    let fired = false
    hooks.beforePut = (s, k) => {
      if (s !== 'outbox' || k === orig?.id || fired) return
      fired = true
      client.close({ keepQueue: true })
    }
    await reopen()
    await waitFor(() => fired, 6000, 'the re-sign began')
    await sleep(150)
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left[0]?.id).not.toBe(orig?.id) // the old signature is past what the Mac accepts; the new one stays
    expect(fromApp('message')).toHaveLength(0)
  })
})

describe('a discard while the queue is flushing', () => {
  it('is not undone in storage by a write that was already in flight, and the message is not sent', async () => {
    await client.sendMessage({ threadId: 'general', text: 'changed my mind' })
    const g = gate()
    hooks.beforePut = async (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number') {
        g.hit()
        await g.wait
      }
    }
    const id = (await rows())[0]?.clientMsgId as string
    await reopen()
    await g.hitP
    const discarded = client.discardMessage(id)
    g.open()
    await discarded
    await sleep(150)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
  })

  it('does not let a message go out that was discarded while it was being signed again', async () => {
    skew = -10 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'old, then dropped' })
    skew = 0
    const [orig] = await rows()
    const g = gate()
    hooks.beforePut = async (s, k) => {
      if (s === 'outbox' && k !== orig?.id) {
        g.hit()
        await g.wait
      }
    }
    await reopen()
    await g.hitP
    const discarded = client.discardMessage(sent.clientMsgId)
    g.open()
    await discarded
    await sleep(200)
    expect(await rows()).toHaveLength(0)
    expect(fromApp('message')).toHaveLength(0)
    expect(bridge.notified).toHaveLength(0)
  })
})

describe('a retry that races the flush', () => {
  it('leaves one row for the message, not an orphan from the second re-sign', async () => {
    skew = -10 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'once only' })
    skew = 0
    relay.swallowAcks = true // rows stay, so an orphan can be seen
    const [orig] = await rows()
    const g = gate()
    let held = false
    hooks.beforePut = async (s, k) => {
      if (s === 'outbox' && k !== orig?.id && !held) {
        held = true
        g.hit()
        await g.wait
      }
    }
    await reopen()
    await g.hitP
    client.retryMessage(sent.clientMsgId) // taps while the flush is half way through its re-sign
    await sleep(80)
    g.open()
    await waitFor(() => fromApp('message').length >= 1, 6000, 'sent')
    await sleep(200)
    expect(await rows()).toHaveLength(1)
  })
})

describe('a message from an older build, which did not record when it was written', () => {
  it('keeps counting from when it was signed, not from the first resend', async () => {
    skew = -6.5 * DAY
    const sent = await client.sendMessage({ threadId: 'general', text: 'from the old build' })
    const signedAt = Date.now() + skew
    const [row] = await rows()
    if (!row) throw new Error('no row')
    const { writtenAt: _w, ...legacy } = row
    await storage.put('outbox', row.id, legacy)
    skew = 0
    relay.swallowAcks = true // the row stays: it is never acked
    await reopen()
    await waitFor(() => fromApp('message').length === 1, 6000, 'sent once')
    await sleep(100)
    const [after] = await rows()
    expect(typeof after?.writtenAt).toBe('number')
    expect(Math.abs((after?.writtenAt as number) - signedAt)).toBeLessThan(DAY) // not "now"

    client.close()
    skew = 1.5 * DAY // eight days since it was signed: the Mac and the relay have forgotten its id
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'retry', 6000, 'held for the owner')
    expect(fromApp('message')).toHaveLength(1)
  })
})

describe('a failed save of the written mark', () => {
  it('still sends the message soon, without waiting for a reconnect', async () => {
    online = true
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    let failed = false
    hooks.beforePut = (s, _k, v) => {
      if (s === 'outbox' && typeof (v as Row).writtenAt === 'number' && !failed) {
        failed = true
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
    }
    const res = await client.sendMessage({ threadId: 'general', text: 'try me again' })
    expect(res.state).toBe('queued')
    await waitFor(() => fromApp('message').length === 1, 4000, 'sent by itself')
  })
})

describe('queue wipe listeners', () => {
  it('are told when a close keeps nothing, and not when the queue is kept', async () => {
    const wiped = vi.fn()
    client.onQueueWiped(wiped)
    client.close({ keepQueue: true })
    expect(wiped).not.toHaveBeenCalled()
    client.close()
    expect(wiped).toHaveBeenCalledTimes(1)
  })
})
