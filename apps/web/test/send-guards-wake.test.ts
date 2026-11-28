// @vitest-environment node
// Package C (D5, D16, D31): the socket client never sends a message the relay would kill the connection over, can drop a
// failed message, notices a dead socket quickly when the app comes back to the front, and retries a send it could not
// save on a timer.
import { newId } from '@talos-app/protocol'
import { FakeRelay, t, waitFor } from '@talos-app/testkit'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSocketClient, MAX_MESSAGE_CHARS, type OutboxEntry } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | null = null
// Node has no DOM: the client only needs somewhere to hang its window/document listeners.
const doc = new EventTarget()
const g = globalThis as Record<string, unknown>
beforeAll(() => {
  g.window = new EventTarget()
  g.document = doc
})
afterAll(() => {
  g.window = undefined
  g.document = undefined
})
afterEach(async () => {
  await relay?.stop()
  relay = null
})

/** A real WebSocket that can be made to ignore the relay's `pong`, i.e. a socket that died while the phone slept. */
class DeafWS extends WebSocket {
  static deaf = false
  /** The pongs that reached the client (a deaf socket swallows them, so they are not counted). */
  static pongs = 0
  constructor(url: string | URL) {
    super(url)
    this.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || JSON.parse(ev.data).type !== 'pong') return
      if (DeafWS.deaf) ev.stopImmediatePropagation()
      else DeafWS.pongs++
    })
  }
}

type Opts = Partial<Parameters<typeof createSocketClient>[0]>
async function setup(over: Opts = {}, storage = createMemoryStorage()) {
  relay = await new FakeRelay().start()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
    ...over,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return { client, storage, relay }
}
const hellos = () => (relay?.frames ?? []).filter((f) => f.direction === 'from_app' && f.raw.type === 'hello').length

describe('D5 sending guards', () => {
  it('a message over 32,000 characters is refused up front: nothing stored, shown or sent', async () => {
    const { client, storage, relay } = await setup()
    try {
      await expect(
        client.sendMessage({ threadId: 'general', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }),
      ).rejects.toMatchObject({
        code: 'too_large',
      })
      expect(client.outboxSize()).toBe(0)
      expect(await storage.all('outbox')).toHaveLength(0)
      expect(client.store.getState().messages.general ?? []).toHaveLength(0)
      expect(relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'message')).toHaveLength(0)
    } finally {
      client.close()
    }
  })

  it('a signed frame already stored past 256 KB (from an old build) is never sent: no 1009 loop, later messages go', async () => {
    const storage = createMemoryStorage()
    const id = newId('m').replace('m_', '').padEnd(26, '0').slice(0, 26)
    const entry: OutboxEntry = {
      id,
      order: 1,
      kind: 'message',
      clientMsgId: newId('m'),
      threadId: 'general',
      bytes: JSON.stringify({ v: 1, type: 'message', id, text: 'x'.repeat(300_000) }),
    }
    await storage.put('outbox', entry.id, entry)
    const { client, relay } = await setup({}, storage)
    try {
      await waitFor(() => client.meta.getState().failed[entry.clientMsgId] === 'final', 2000, 'marked failed')
      const res = await client.sendMessage({ threadId: 'general', text: 'short one behind it' })
      await waitFor(
        () =>
          relay.frames.some(
            (f) => f.direction === 'from_app' && f.raw.type === 'message' && f.raw.text === 'short one behind it',
          ),
        3000,
        'short message delivered',
      )
      expect(relay.frames.some((f) => f.direction === 'from_app' && f.raw.id === entry.id)).toBe(false)
      expect(hellos()).toBe(1) // never reconnected
      expect(res.state).toBe('sent')
    } finally {
      client.close()
    }
  })

  it('discardMessage drops a failed message from the outbox, storage, timeline and failed list', async () => {
    const { client, storage } = await setup()
    try {
      client.store.setState((s) => ({ ...s, devicePinned: false }))
      const res = await client.sendMessage({ threadId: 'general', text: 'will not go' })
      const [entry] = await storage.all<OutboxEntry>('outbox')
      if (!entry) throw new Error('no entry')
      expect(client.store.getState().messages.general).toHaveLength(1)
      await client.discardMessage(res.clientMsgId)
      expect(client.outboxSize()).toBe(0)
      expect(await storage.all('outbox')).toHaveLength(0)
      expect(client.store.getState().messages.general ?? []).toHaveLength(0)
      expect(client.meta.getState().queuedIds).not.toContain(res.clientMsgId)
    } finally {
      client.close()
    }
  })
})

describe('D16 coming back to the app', () => {
  const show = () => doc.dispatchEvent(new Event('visibilitychange'))

  // The probe waits wakeProbeMs for the pong; the real default (10 s) is covered by test/socket-probe.test.ts on fake timers.
  const PROBE = { WebSocketImpl: DeafWS as never, isVisible: () => true, wakeProbeMs: 200 }

  it('a socket that no longer answers is dropped when the probe finds it dead, and reconnects', async () => {
    DeafWS.deaf = false
    const { client } = await setup(PROBE)
    try {
      expect(hellos()).toBe(1)
      DeafWS.deaf = true
      show()
      await waitFor(() => hellos() === 2, t(6000), 'reconnected')
      DeafWS.deaf = false
      await waitFor(() => client.store.getState().connection === 'online', 4000, 'online again')
    } finally {
      DeafWS.deaf = false
      client.close()
    }
  })

  it('control: a socket that answers is left alone', async () => {
    DeafWS.deaf = false
    const { client } = await setup(PROBE)
    try {
      DeafWS.pongs = 0
      show()
      // the probe's pong has been counted: only a socket that answers gets here (a deaf one times out in this wait)
      await waitFor(() => DeafWS.pongs >= 1, t(6000), "the probe's pong")
      expect(hellos()).toBe(1)
      expect(client.store.getState().connection).toBe('online')
    } finally {
      client.close()
    }
  })
})

describe('D31 a send that could not be saved', () => {
  it('is retried on a timer, with no reconnect needed', async () => {
    const storage = createMemoryStorage()
    const put = storage.put.bind(storage)
    let outboxPuts = 0
    storage.put = async (store, key, value) => {
      // the first put is the signed frame; the second, the written mark, fails once (the frame stays queued)
      if (store === 'outbox' && ++outboxPuts === 2) throw new DOMException('quota', 'QuotaExceededError')
      return put(store, key, value)
    }
    const { client, relay } = await setup({ flushRetryMs: 50 }, storage)
    try {
      await client.sendMessage({ threadId: 'general', text: 'hello' })
      await waitFor(
        () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'message'),
        4000,
        'message sent after the retry',
      )
      expect(hellos()).toBe(1)
    } finally {
      client.close()
    }
  })
})
