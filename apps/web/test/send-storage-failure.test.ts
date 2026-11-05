// @vitest-environment node
// A message whose local save fails must visibly not send, and must never go out later on its own. The owner's retry is
// then the only copy the agent can get. Storage failure is injected in the storage object the real client uses.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createFailingStorage, type FailingStorage } from './helpers/failing-storage.ts'

let relay: FakeRelay
let client: SocketClient
let storage: FailingStorage

beforeEach(async () => {
  storage = createFailingStorage()
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

const messagesAtRelay = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'message')
const helloCount = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'hello').length

describe('a send whose local save fails', () => {
  it('throws, shows no row, queues nothing, and is not sent by the next reconnect; the retry sends exactly once', async () => {
    storage.fail({ op: 'put', store: 'outbox', message: 'The quota has been exceeded.' })
    await expect(client.sendMessage({ threadId: 'general', text: 'move the money' })).rejects.toThrow()
    expect(client.outboxSize()).toBe(0)
    expect(client.store.getState().messages.general ?? []).toHaveLength(0)

    // A reconnect flushes the queue. If the failed message had joined it, it would go out here.
    const hellos = helloCount()
    relay.dropApps()
    await waitFor(() => helloCount() > hellos, 4000, 'reconnect')
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
    expect(messagesAtRelay()).toHaveLength(0)

    storage.heal()
    await client.sendMessage({ threadId: 'general', text: 'move the money' })
    await waitFor(() => messagesAtRelay().length === 1, 4000, 'retry arrives')
    await waitFor(() => client.outboxSize() === 0, 4000, 'acked')
    expect(messagesAtRelay()).toHaveLength(1)
  })
})
