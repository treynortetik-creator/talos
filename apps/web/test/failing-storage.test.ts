// @vitest-environment node
// The failing-storage helper itself: it refuses what it is told to, for as long as it is told to, then heals. Tests of what
// the app does when storage refuses (send-storage-failure.test.ts) rely on it.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createFailingStorage } from './helpers/failing-storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function online() {
  relay = await new FakeRelay().start()
  const storage = createFailingStorage()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return { client, storage, relay }
}

describe('the failing storage helper', () => {
  it('refuses the armed operation on the armed store, a set number of times, and then heals', async () => {
    const { client, storage } = await online()
    try {
      const fault = storage.fail({ op: 'put', store: 'outbox', times: 1 })
      await expect(client.sendMessage({ threadId: 'general', text: 'first' })).rejects.toBeDefined()
      expect(fault.refused).toBe(1)
      await expect(client.sendMessage({ threadId: 'general', text: 'second' })).resolves.toMatchObject({
        state: 'sent',
      })
    } finally {
      client.close()
    }
  })
})
