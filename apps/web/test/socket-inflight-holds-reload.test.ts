// @vitest-environment jsdom
// A reload for a new build must never take the page while a send, a Run or a card answer is in flight: the page would lose
// what it knows about it (a Run's "Sent" line, a retry button), though the Mac may already have the message (old-client.spec.ts
// "Run hands the agent the script once", flaking about one run in six: the new worker's hand-over reloaded the page 70 ms after
// the click). The socket client marks each such send with holdReload (src/lib/reloadHold.ts) until it is saved and queued, or
// the answer has come.
import type { CardT } from '@talos-app/protocol'
import { buildCard, FakeRelay, mkFrame, NodeWebSocket, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOLD_CAP_MS, reloadHolds, resetReloadHolds } from '../src/lib/reloadHold.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient | undefined
const holds = () => reloadHolds.getState().holds

beforeEach(async () => {
  resetReloadHolds()
  relay = await new FakeRelay().start()
})
afterEach(async () => {
  client?.close()
  client = undefined
  await relay.stop()
})

/** Device storage whose outbox writes hang until released: a slow IndexedDB under load. */
function slowPuts(): { storage: Storage; release: () => void; waiting: () => number } {
  const real = createMemoryStorage()
  const held: Array<() => void> = []
  let open = false
  const storage = {
    ...real,
    get: real.get.bind(real),
    del: real.del.bind(real),
    all: real.all.bind(real),
    clear: real.clear.bind(real),
    put: (store: string, key: string, v: unknown) =>
      store === 'outbox' && !open
        ? new Promise<void>((r) => held.push(() => void real.put(store as never, key, v as never).then(r)))
        : real.put(store as never, key, v as never),
  } as unknown as Storage
  return {
    storage,
    release: () => {
      open = true // later writes (the sent mark) go straight through
      for (const f of held.splice(0)) f()
    },
    waiting: () => held.length,
  }
}

async function online(storage: Storage): Promise<SocketClient> {
  const c = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  client = c
  await c.ensureDevice()
  await c.start({ pinned: true })
  await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
  return c
}

it('a message being signed and saved holds reloads; saved and queued, the queue holds them; the hold is gone after', async () => {
  const { storage, release, waiting } = slowPuts()
  const c = await online(storage)
  expect(holds()).toBe(0)
  const sent = c.sendMessage({ threadId: 'general', text: 'run this', intent: 'run' })
  await waitFor(() => waiting() === 1, 4000, 'the outbox write is pending')
  expect(holds(), 'held while the write is pending').toBe(1)
  release()
  await sent
  await waitFor(() => holds() === 0, 4000, 'released when the relay acked it')
})

it('a message written to the socket holds until its ack; a lost socket lets go (it is written again on the next one)', async () => {
  const c = await online(createMemoryStorage())
  relay.swallowAcks = true
  await c.sendMessage({ threadId: 'general', text: 'run this', intent: 'run' })
  expect(holds(), 'written, not acked').toBe(1)
  relay.dropApps()
  await waitFor(() => holds() === 0, 4000, 'the socket went, so it no longer waits on it')
})

it('a hold never outlives the cap, so a stuck ack cannot block the update for ever', async () => {
  const c = await online(createMemoryStorage())
  relay.swallowAcks = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await c.sendMessage({ threadId: 'general', text: 'x' })
    expect(holds()).toBe(1)
    vi.advanceTimersByTime(HOLD_CAP_MS + 1)
    expect(holds()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('a send that fails releases its hold', async () => {
  const c = await online(createMemoryStorage())
  const big = 'x'.repeat(40_000)
  await expect(c.sendMessage({ threadId: 'general', text: big })).rejects.toBeTruthy()
  expect(holds()).toBe(0)
})

it('a card answer holds reloads until its ack, and not after', async () => {
  const c = await online(createMemoryStorage())
  const card: CardT = buildCard({ thread_id: 'general' })
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => c.store.getState().cards.length === 1, 2000, 'card')
  relay.swallowAcks = true
  const answered = c.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }).catch((e) => e)
  await waitFor(() => holds() === 1, 2000, 'the hold while the answer waits for its ack')
  window.dispatchEvent(new Event('offline')) // ends the wait
  await answered
  expect(holds()).toBe(0)
})
