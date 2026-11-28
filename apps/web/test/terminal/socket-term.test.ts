// @vitest-environment node
// The socket TermClient (src/lib/socketTerm.ts) against the testkit's relay and a (fake) Mac: the open is signed by the device key and
// waits for the Mac's answer; the credit is unsigned; resume and close are signed; a Mac that is away is refused at once, and an
// error from the relay or the Mac rejects the open instead of leaving it waiting.
import { newUlid, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay
let bridge: FakeBridge | null
let client: SocketClient

async function start(withBridge = true) {
  relay = await new FakeRelay().start()
  bridge = withBridge
    ? await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, features: ['term-view/1'] }).connect()
    : null
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  if (withBridge) await waitFor(() => client.store.getState().presence.bridge_online, 4000, 'bridge online')
}
afterEach(async () => {
  client.close()
  await bridge?.close()
  await relay.stop()
})
const tid = () => `tm_${newUlid()}`

describe('opening and the answer', () => {
  beforeEach(() => start())

  it('sends one signed open (verifies under the device key), and resolves when the Mac says term.opened', async () => {
    const key = await client.deviceKey()
    const id = tid()
    const p = client.term?.open({ termId: id, target: 'main', cols: 80, rows: 24 })
    const req = await bridge?.expectFrame('term.open', () => true, { direction: 'in' })
    expect(req).toMatchObject({ term_id: id, tier: 'view', target: 'main', device_id: key?.deviceId })
    expect(await verifyOwnerFrame(req as never, key?.publicJwk as never)).toBe(true)
    bridge?.send(
      mkFrame('term.opened', { term_id: id, tier: 'view', cols: 100, rows: 30, idle_s: 600, max_s: 3600 }) as never,
    )
    await p
  })

  it("the Mac's term.closed answers an open too (it could not show that pane)", async () => {
    const id = tid()
    const p = client.term?.open({ termId: id, target: 'gone', cols: 80, rows: 24 })
    await bridge?.expectFrame('term.open', () => true, { direction: 'in' })
    bridge?.send(mkFrame('term.closed', { term_id: id, why: 'no_pane' }) as never)
    await p
  })

  it("an error the Mac sends for the open rejects it at once with the Mac's words", async () => {
    const id = tid()
    const p = client.term?.open({ termId: id, target: 'main', cols: 80, rows: 24 }).catch((e: Error) => e)
    const req = await bridge?.expectFrame('term.open', () => true, { direction: 'in' })
    bridge?.send(mkFrame('error', { ref: req?.id, code: 'stale', message: 'This device clock is off.' }) as never)
    const r = await p
    expect(r).toBeInstanceOf(TalosClientError)
    expect((r as TalosClientError).code).toBe('stale')
  })

  it('the credit is unsigned (a strict frame with no device or signature), and resume and close are signed', async () => {
    const key = await client.deviceKey()
    const id = tid()
    const opened = client.term?.open({ termId: id, target: 'main', cols: 80, rows: 24 })
    await bridge?.expectFrame('term.open', () => true, { direction: 'in' })
    bridge?.send(
      mkFrame('term.opened', { term_id: id, tier: 'view', cols: 80, rows: 24, idle_s: 600, max_s: 3600 }) as never,
    )
    await opened
    client.term?.ack(id, 4096)
    const ack = await bridge?.expectFrame('term.ack', () => true, { direction: 'in' })
    expect(ack).toMatchObject({ term_id: id, upto: 4096 })
    expect(ack).not.toHaveProperty('osig')
    expect(ack).not.toHaveProperty('device_id')
    // one at a time: each is signed first, so two started together can reach the relay in either order, and a close that lands first
    // ends the view before the resume (which the relay then drops)
    void client.term?.resume(id, 123).catch(() => {})
    const resume = await bridge?.expectFrame('term.resume', () => true, { direction: 'in' })
    void client.term?.close(id).catch(() => {})
    const close = await bridge?.expectFrame('term.close', () => true, { direction: 'in' })
    expect(resume).toMatchObject({ term_id: id, from: 123 })
    for (const f of [resume, close]) expect(await verifyOwnerFrame(f as never, key?.publicJwk as never)).toBe(true)
  })

  it('output frames for the view reach onFrame listeners, and nothing is kept in the store', async () => {
    const id = tid()
    const got: string[] = []
    client.onFrame('term.out', (f) => void got.push(f.term_id))
    const p = client.term?.open({ termId: id, target: 'main', cols: 80, rows: 24 })
    await bridge?.expectFrame('term.open', () => true, { direction: 'in' })
    bridge?.send(
      mkFrame('term.opened', { term_id: id, tier: 'view', cols: 80, rows: 24, idle_s: 600, max_s: 3600 }) as never,
    )
    await p
    const before = client.store.getState().lastSeq
    bridge?.send(mkFrame('term.out', { term_id: id, at: 0, bytes_b64: 'aGk' }) as never)
    await waitFor(() => got.length === 1, 3000, 'the output')
    expect(client.store.getState().lastSeq).toBe(before)
  })
})

describe('with the Mac away', () => {
  beforeEach(() => start(false))

  it('an open is refused at once with mac_offline and waits for nothing', async () => {
    const r = await client.term?.open({ termId: tid(), target: 'main', cols: 80, rows: 24 }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(TalosClientError)
    expect((r as TalosClientError).code).toBe('mac_offline')
  })
})
