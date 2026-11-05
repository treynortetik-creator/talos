// @vitest-environment node
// WP-V0: ready.features (what the relay supports) lands in ClientState.relayFeatures.
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

describe('ready.features -> relayFeatures (socketClient)', () => {
  it('stores the relay feature list from ready', async () => {
    const relay = await new FakeRelay().start()
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    try {
      expect(client.store.getState().relayFeatures).toEqual([])
      await client.ensureDevice()
      await client.start({ pinned: true })
      await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
      // The testkit's app-side ready carries no features, so push one that does (as the real relay's ready would).
      relay.sendToApps(
        mkFrame('ready', {
          session_id: 'sess_test0001',
          policy: { max_frame_bytes: 262144, ping_ms: 25000 },
          server_seq: 0,
          presence: { bridge_online: false, last_seen: null, queue_depth: 0 },
          features: ['schedules/1', 'health/1', 'share/1'],
        }),
      )
      await waitFor(() => client.store.getState().relayFeatures.length === 3, 2000, 'relayFeatures')
      expect(client.store.getState().relayFeatures).toEqual(['schedules/1', 'health/1', 'share/1'])
    } finally {
      client.close()
      await relay.stop()
    }
  })
})
