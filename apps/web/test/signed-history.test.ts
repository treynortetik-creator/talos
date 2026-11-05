// @vitest-environment node
// Signed history and context paging, app side (docs/PROTOCOL.md "Signed history reads"): scroll-back, "Show more" and the
// search context view all send `history.request` signed by the device key, each with a fresh id, and an `error` from the
// Mac ends the wait at once instead of hanging for the timeout.
import { newId, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

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

const asked = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'history.request')

describe('the app signs every history request', () => {
  it('scroll-back (before_seq) and context paging (around/before/after) verify against the device key', async () => {
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    void client.loadHistory('general', 5).catch(() => {})
    const anchor = newId('m')
    for (const k of [{ aroundId: anchor }, { beforeId: anchor }, { afterId: anchor }])
      void client.search?.context('general', k).catch(() => {})
    await waitFor(() => asked().length === 4, 3000, 'four requests')
    const ids = new Set<string>()
    for (const f of asked()) {
      expect(typeof f.raw.osig).toBe('string')
      expect(f.raw.device_id).toBe(key.deviceId)
      expect(await verifyOwnerFrame(f.raw, key.publicJwk)).toBe(true)
      ids.add(String(f.raw.id))
    }
    expect(ids.size).toBe(4)
  })

  it('an error from the Mac rejects the context request at once, with the Mac text', async () => {
    const p = client.search?.context('general', { aroundId: newId('m') }).catch((e: Error) => e)
    const req = await bridge.expectFrame('history.request', () => true, { direction: 'in' })
    bridge.send(
      mkFrame('error', { ref: req.id, code: 'sig_invalid', message: 'Update the Talos app to page history.' }) as never,
    )
    // No stopwatch: the message is the Mac's own text, which a request that waited out its timeout could not carry.
    const r = await p
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('Update the Talos app')
  })
})
