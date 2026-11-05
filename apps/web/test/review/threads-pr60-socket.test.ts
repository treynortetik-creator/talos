// @vitest-environment node
// PR #60 review: the real socket client against the testkit FakeRelay. The relay acks a config.patch when it STORES it
// (apps/relay/src/core/hub.ts acceptOwner); the bridge applies it later and may refuse it (config_conflict when two
// devices or two quick taps race on base_rev). REVIEW-FAIL on 677cf2b: patchConfig has already resolved on the relay
// ack, so the bridge's refusal is dropped and ThreadEditor / ReorderList report success for an edit that never landed.
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
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

describe('PR60 review: config.patch outcome', () => {
  it('REVIEW-FAIL: a patch the bridge refuses after the relay ack is reported as refused, not saved', async () => {
    const threads = client.store.getState().threads.map((t, i, a) => ({ ...t, order: a.length - i }))
    const outcome = client.patchConfig({ threads }).then(
      () => 'saved',
      (e: { code?: string }) => e.code ?? 'error',
    )
    // the bridge got the frame (via the relay) and refused it: base_rev was stale
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'config.patch'),
      2000,
      'patch sent',
    )
    const sent = relay.frames.find((f) => f.direction === 'from_app' && f.raw.type === 'config.patch')
    relay.sendToApps(
      mkFrame('error', { ref: sent?.raw.id as string, code: 'config_conflict', message: 'config is at rev 9' }),
    )
    expect(await outcome).toBe('config_conflict')
  })
})
