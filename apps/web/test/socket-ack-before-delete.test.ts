// @vitest-environment node
// The relay's ack is the page's proof a message went out. Handling it must not wait on the device's storage: under load an
// IndexedDB delete took over 10 s, and until it finished the message still counted as queued, so a Run line read "Queued ·
// sends when you're back online" with the agent already holding the Run (old-client.spec.ts:74, 2026-11-20). The queue
// and the row's receipt follow the ack at once; the stored copy is deleted after.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

let relay: FakeRelay | null = null
// Node has no DOM: the client only needs somewhere to hang its window/document listeners.
const g = globalThis as Record<string, unknown>
beforeAll(() => {
  g.window = new EventTarget()
  g.document = new EventTarget()
})
afterAll(() => {
  g.window = undefined
  g.document = undefined
})
afterEach(async () => {
  await relay?.stop()
  relay = null
})

/** Device storage whose outbox deletes hang until released: a slow IndexedDB under load. */
function slowDeletes(): { storage: Storage; release: () => void; pending: () => number } {
  const real = createMemoryStorage()
  const held: Array<() => void> = []
  const storage: Storage = {
    ...real,
    get: real.get.bind(real),
    put: real.put.bind(real),
    all: real.all.bind(real),
    clear: real.clear.bind(real),
    del: (store, key) =>
      store === 'outbox'
        ? new Promise<void>((r) => held.push(() => void real.del(store, key).then(r)))
        : real.del(store, key),
  } as Storage
  return {
    storage,
    release: () => {
      for (const f of held.splice(0)) f()
    },
    pending: () => held.length,
  }
}

it('an ack takes the message out of the queue and marks it sent before the stored copy is deleted', async () => {
  relay = await new FakeRelay().start()
  const { storage, release, pending } = slowDeletes()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')

  const r = await client.sendMessage({ threadId: 'general', text: 'run this' })
  expect(r.state).toBe('sent')
  await waitFor(() => pending() > 0, 4000, 'the ack reached the client and its delete started')
  // the delete is still hanging: the queue and the row already say it went out
  expect(client.meta.getState().queuedIds).not.toContain(r.clientMsgId)
  const row = client.store.getState().messages.general?.find((m) => m.id === r.clientMsgId)
  expect(row?.receipt).toBe('sent')
  release()
  let left = -1
  for (let i = 0; i < 80 && left !== 0; i++) {
    left = (await storage.all('outbox')).length
    if (left) await new Promise((r) => setTimeout(r, 50))
  }
  expect(left, 'the stored copy is gone once the delete runs').toBe(0)
  client.close()
})
