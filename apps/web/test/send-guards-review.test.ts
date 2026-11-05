// @vitest-environment node
// Package C review round (socket side): the frame cap counts bytes like the relay does, a reply shows its quote at once,
// and coming back to the front does not restart a connection the relay refused.
import { newId } from '@talos-app/protocol'
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSocketClient, type OutboxEntry } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | null = null
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

/** Keeps every socket it opens, so a test can end one the way the relay would. */
class TrackedWS extends WebSocket {
  static all: TrackedWS[] = []
  constructor(url: string | URL) {
    super(url)
    TrackedWS.all.push(this)
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

describe('frame cap is bytes, not UTF-16 units', () => {
  it('a stored frame of 100,000 CJK characters (300 KB on the wire) is failed, not sent', async () => {
    const storage = createMemoryStorage()
    const id = newId('m').replace('m_', '').padEnd(26, '0').slice(0, 26)
    const text = '漢'.repeat(100_000)
    const bytes = JSON.stringify({ v: 1, type: 'message', id, text })
    expect(bytes.length).toBeLessThan(256 * 1024) // under the cap by units...
    expect(new TextEncoder().encode(bytes).length).toBeGreaterThan(256 * 1024) // ...over it by bytes
    const entry: OutboxEntry = {
      id,
      order: 1,
      kind: 'message',
      clientMsgId: newId('m'),
      threadId: 'general',
      bytes,
    }
    await storage.put('outbox', entry.id, entry)
    const { client, relay } = await setup({}, storage)
    try {
      await waitFor(() => client.meta.getState().failed[entry.clientMsgId] === 'final', 2000, 'marked failed')
      expect(relay.frames.some((f) => f.direction === 'from_app' && f.raw.id === entry.id)).toBe(false)
      client.retryMessage(entry.clientMsgId) // and Retry cannot put it back on the wire
      expect(client.meta.getState().failed[entry.clientMsgId]).toBe('final')
      expect(relay.frames.some((f) => f.direction === 'from_app' && f.raw.id === entry.id)).toBe(false)
    } finally {
      client.close()
    }
  })

  it('control: 30,000 CJK characters (90 KB on the wire) still go', async () => {
    const { client, relay } = await setup()
    try {
      await client.sendMessage({ threadId: 'general', text: '漢'.repeat(30_000) })
      await waitFor(
        () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'message'),
        3000,
        'delivered',
      )
    } finally {
      client.close()
    }
  })
})

describe('a reply shows its quote at once', () => {
  it('the row shown while the message is queued already has reply_to, and the frame carries it', async () => {
    const { client, relay } = await setup({}, createMemoryStorage())
    try {
      client.store.setState((s) => ({ ...s, devicePinned: false }))
      const parent = newId('m')
      const res = await client.sendMessage({ threadId: 'general', text: 'thanks', replyTo: parent })
      const row = client.store.getState().messages.general?.find((m) => m.id === res.clientMsgId)
      expect(row?.reply_to).toBe(parent)
      client.setPinned(true)
      await waitFor(
        () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.reply_to === parent),
        3000,
        'reply_to on the wire',
      )
    } finally {
      client.close()
    }
  })
})

describe('coming back to the front after a refused session', () => {
  const show = () => doc.dispatchEvent(new Event('visibilitychange'))

  it('does not start new connection attempts once the relay has refused the session (4401)', async () => {
    TrackedWS.all = []
    const { client } = await setup({ WebSocketImpl: TrackedWS as never, isVisible: () => true })
    try {
      expect(hellos()).toBe(1)
      const sock = TrackedWS.all.at(-1)
      sock?.onclose?.({ code: 4401 } as CloseEvent)
      expect(client.meta.getState().authFailed).toBe(true)
      show()
      await new Promise((r) => setTimeout(r, 400))
      expect(TrackedWS.all).toHaveLength(1) // no new socket
      expect(hellos()).toBe(1)
    } finally {
      client.close()
    }
  })

  it('control: with no socket and no refusal, coming back reconnects at once', async () => {
    TrackedWS.all = []
    const { client } = await setup({
      WebSocketImpl: TrackedWS as never,
      isVisible: () => true,
      backoff: { baseMs: 60_000, maxMs: 60_000 },
    })
    try {
      TrackedWS.all.at(-1)?.onclose?.({ code: 1006 } as CloseEvent) // dropped; the retry is a minute away
      show()
      await waitFor(() => hellos() === 2, 3000, 'reconnected at once')
    } finally {
      client.close()
    }
  })
})
