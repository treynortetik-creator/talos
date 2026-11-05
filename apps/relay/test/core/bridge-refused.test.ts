// D40: a Mac whose key the relay refuses used to look the same as a Mac that is asleep. The REAL relay (real auth, real hub,
// real sockets): a refused hello closes 4401 and /api/status says so while the bridge is offline; a good hello clears it;
// the field never shows while the bridge is online; and an older web client's strict status parser still accepts it.
import { generateBridgeKey, HealthStatus } from '@talos-app/protocol'
import { FakeBridge } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

async function status(rr: RealRelay) {
  const o = await rr.owner()
  const res = await fetch(`${rr.httpBase}/api/status`, {
    headers: { Cookie: o.cookie, Origin: 'https://relay.example.com' },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { bridge: { online: boolean; auth_refused_at?: string | null } }
}

describe('D40 a refused bridge key shows in status', () => {
  it('closes 4401, reports auth_refused_at while offline, and a good hello clears it', async () => {
    r = await startRealRelay()
    expect((await status(r)).bridge.auth_refused_at).toBeUndefined()

    const bad = new FakeBridge({ relayWs: r.wsBase, key: await generateBridgeKey() })
    expect(await bad.connectExpectingRefusal()).toBe(4401)
    const refused = await status(r)
    expect(refused.bridge.online).toBe(false)
    expect(typeof refused.bridge.auth_refused_at).toBe('string')
    expect(Number.isNaN(Date.parse(refused.bridge.auth_refused_at as string))).toBe(false)
    // the strict parser an older client uses still takes it (no new enum value, one optional field)
    expect(HealthStatus.safeParse(refused).success).toBe(true)

    const good = await r.bridge().connect()
    expect((await status(r)).bridge.auth_refused_at).toBeUndefined()
    await good.close()
    // offline again, no refusal since: no stale refusal
    await new Promise((res) => setTimeout(res, 100))
    const after = await status(r)
    expect(after.bridge.online).toBe(false)
    expect(after.bridge.auth_refused_at).toBeUndefined()
  })

  it('a bad hello while the real bridge is online does not show', async () => {
    r = await startRealRelay()
    await r.bridge().connect()
    const bad = new FakeBridge({ relayWs: r.wsBase, key: await generateBridgeKey() })
    expect(await bad.connectExpectingRefusal()).toBe(4401)
    const s = await status(r)
    expect(s.bridge.online).toBe(true)
    expect(s.bridge.auth_refused_at).toBeUndefined()
  })

  it('a bad hello during an online stretch does not show after the real bridge drops', async () => {
    r = await startRealRelay()
    const good = await r.bridge().connect()
    const bad = new FakeBridge({ relayWs: r.wsBase, key: await generateBridgeKey() })
    expect(await bad.connectExpectingRefusal()).toBe(4401)
    await new Promise((res) => setTimeout(res, 20))
    await good.close()
    await new Promise((res) => setTimeout(res, 100))
    const s = await status(r)
    expect(s.bridge.online).toBe(false)
    // the refusal predates the drop, so the owner is not sent to swap a working key
    expect(s.bridge.auth_refused_at).toBeUndefined()
    // a refusal AFTER the drop does show
    const bad2 = new FakeBridge({ relayWs: r.wsBase, key: await generateBridgeKey() })
    expect(await bad2.connectExpectingRefusal()).toBe(4401)
    expect(typeof (await status(r)).bridge.auth_refused_at).toBe('string')
  })
})
