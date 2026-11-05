// @vitest-environment node
// Adversarial review of WP-V2 (PR #45): the REAL socket client (createSocketClient -> socketSearch) against FakeRelay with a
// FakeBridge connected that is slow to answer. The PR's own "live timeline unchanged" tests replace requestPage with the
// replay client, so socketClient's skip-the-upsert path is never exercised by them.
import { type MessageT, newId } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay
let bridge: FakeBridge
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, features: ['search/1'] }).connect()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  await waitFor(() => client.store.getState().presence.bridge_online, 4000, 'bridge online')
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const past = (text: string): MessageT => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
})

describe('context pages never reach the live timeline', () => {
  it('(holds) an on-time context page is not merged', async () => {
    const anchor = past('a needle from long ago')
    const p = client.search?.context('general', { aroundId: anchor.id })
    const req = await bridge.expectFrame('history.request', (f) => f.around_id === anchor.id, { direction: 'in' })
    bridge.send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'general',
        messages: [anchor],
        has_more: false,
        has_newer: false,
        anchor_id: anchor.id,
      }) as never,
    )
    const r = await p
    expect(r?.messages.map((m) => m.id)).toEqual([anchor.id])
    await new Promise((r2) => setTimeout(r2, 200))
    expect(JSON.stringify(client.store.getState().messages.general ?? [])).not.toContain('needle')
  })

  it('FAILS: a context page that arrives after the 15 s timeout (+1 s) is merged into the live timeline', async () => {
    const anchor = past('a needle from long ago')
    const p = client.search?.context('general', { aroundId: anchor.id }).catch((e: Error) => e)
    const req = await bridge.expectFrame('history.request', (f) => f.around_id === anchor.id, { direction: 'in' })
    const r = await p // the app gives up after SEARCH_LIMITS.appTimeoutMs (15 s): "Your Mac didn't answer."
    expect(r).toBeInstanceOf(Error)
    await new Promise((r2) => setTimeout(r2, 1200)) // the request id is forgotten 1 s after the timeout
    // a slow Mac (a long reconcile, a sleeping lid) finally answers
    bridge.send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'general',
        messages: [anchor],
        has_more: false,
        has_newer: false,
        anchor_id: anchor.id,
      }) as never,
    )
    await new Promise((r2) => setTimeout(r2, 300))
    expect(JSON.stringify(client.store.getState().messages.general ?? [])).not.toContain('needle')
  }, 30_000)
})
