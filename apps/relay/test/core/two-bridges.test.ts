// Two bridges with one key. The real relay (real auth, real hub, real sockets): the second hello replaces the first and the
// relay says so in its log; a bridge that asks to stand by never replaces the one that is connected; presence tells the app
// "superseded" while the older bridge has not come back, and clears it once a hello finds the slot empty.
import { BRIDGE_STANDBY_FEATURE, generateBridgeKey, HealthStatus } from '@talos-app/protocol'
import { FakeBridge, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const WAIT_MS = 10_000
type WarnLog = { warn(obj: object, msg: string): void }
const hubLog = (rr: RealRelay) => (rr.runtime.hub as unknown as { d: { log: WarnLog } }).d.log
const standbyBridge = (rr: RealRelay) => new FakeBridge({ relayWs: rr.wsBase, key: rr.bridgeKey, standby: true })

async function status(rr: RealRelay) {
  const o = await rr.owner()
  const res = await fetch(`${rr.httpBase}/api/status`, {
    headers: { Cookie: o.cookie, Origin: 'https://relay.example.com' },
  })
  expect(res.status).toBe(200)
  return HealthStatus.parse(await res.json())
}

const twoBridgesWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((c) => /two bridges are connected/i.test(String(c[1])))

/** Two live bridges: the first is replaced, then asks back in as a standby and is turned away. */
async function twoLiveBridges(rr: RealRelay) {
  const first = await rr.bridge().connect()
  const second = await rr.bridge().connect()
  await waitFor(() => first.closeCode === 4409, WAIT_MS, 'the first bridge to be closed 4409')
  expect(await standbyBridge(rr).connectExpectingRefusal()).toBe(4409)
  return { first, second }
}

describe('two bridges with one key', () => {
  it('the relay warns once and tells the app when a replaced bridge is still alive', async () => {
    r = await startRealRelay()
    const warn = vi.spyOn(hubLog(r), 'warn')
    const app = r.app(await r.owner())
    await app.connect()
    const { second } = await twoLiveBridges(r)
    await app.expectFrame('presence', (f) => f.bridge_online === true && f.superseded === true)
    expect(r.runtime.hub.presence()).toMatchObject({ bridge_online: true, superseded: true })
    expect(await standbyBridge(r).connectExpectingRefusal()).toBe(4409) // it keeps asking: no second warning
    expect(twoBridgesWarnings(warn)).toHaveLength(1)
    expect(second.connected).toBe(true)
    await app.close()
  })

  it('a bridge that redials over its own dead socket is not reported as a second bridge', async () => {
    r = await startRealRelay()
    const warn = vi.spyOn(hubLog(r), 'warn')
    const first = await r.bridge().connect()
    await r.bridge().connect() // the relay still holds the old socket: the new hello replaces it
    await waitFor(() => first.closeCode === 4409, WAIT_MS, 'the old socket to be closed 4409')
    expect(r.runtime.hub.presence().superseded).toBeUndefined()
    expect(twoBridgesWarnings(warn)).toHaveLength(0)
  })

  it('tells a bridge it may stand by, and a standby hello never replaces the bridge that is connected', async () => {
    r = await startRealRelay()
    const holder = await r.bridge().connect()
    expect(
      holder.rec.frames.some((f) => f.frame.type === 'ready' && f.frame.features?.includes(BRIDGE_STANDBY_FEATURE)),
    ).toBe(true)
    for (let i = 0; i < 3; i++) expect(await standbyBridge(r).connectExpectingRefusal()).toBe(4409)
    expect(holder.connected).toBe(true)
    expect(holder.closeCode).toBeNull()
    expect(r.runtime.hub.bridgeOnline()).toBe(true)
  })

  it('a standby hello that is not signed with the key is refused as any other hello is', async () => {
    r = await startRealRelay()
    await r.bridge().connect()
    const stranger = new FakeBridge({ relayWs: r.wsBase, key: await generateBridgeKey(), standby: true })
    expect(await stranger.connectExpectingRefusal()).toBe(4401)
    expect(r.runtime.hub.presence().superseded).toBeUndefined()
  })

  it('shows "superseded" while the older bridge is away, and a standby hello takes the empty slot', async () => {
    r = await startRealRelay()
    const { second } = await twoLiveBridges(r)
    await second.close()
    await waitFor(() => !r?.runtime.hub.bridgeOnline(), WAIT_MS, 'the relay to see the second bridge go')
    expect(r.runtime.hub.presence()).toMatchObject({ bridge_online: false, superseded: true })
    expect((await status(r)).bridge).toMatchObject({ online: false, superseded: true })

    const back = await standbyBridge(r).connect() // the slot is empty: an ordinary hello
    expect(back.connected).toBe(true)
    expect(r.runtime.hub.presence().superseded).toBeUndefined()
    expect((await status(r)).bridge.superseded).toBeUndefined()
  })

  it('an ordinary hello into an empty slot clears it too', async () => {
    r = await startRealRelay()
    const { second } = await twoLiveBridges(r)
    await second.close()
    await waitFor(() => !r?.runtime.hub.bridgeOnline(), WAIT_MS, 'the relay to see the second bridge go')
    expect(r.runtime.hub.presence().superseded).toBe(true)
    await r.bridge().connect()
    expect(r.runtime.hub.presence().superseded).toBeUndefined()
  })
})
