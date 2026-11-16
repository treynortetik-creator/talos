// The features cap: a bridge hello may list up to FEATURES_MAX features (an older relay took FEATURES_MAX_V1 and refused
// the hello over it), and what the relay passes on to an app stays at FEATURES_MAX_V1, the most an older app reads.
import {
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX,
  FEATURES_MAX_V1,
  FeatureList,
  frameSchemas,
  HealthStatus,
  HelloAppFrame,
  HelloBridgeFrame,
  NATIVE_ACT_FEATURE,
  PROBLEMS_FEATURE,
  Presence,
  ReadyFrame,
  signChallenge,
  WIDE_FEATURES_FEATURE,
  WS_CLOSE,
} from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeFeatures } from '../../src/core/features.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, '0')}/1`)

async function helloWith(features: string[]) {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const sent: Array<Record<string, unknown>> = []
  const closes: number[] = []
  const sock = relay.runtime.hub.attachBridge(
    {
      send: (t: string) => void sent.push(JSON.parse(t)),
      close: (c: number) => void closes.push(c),
      terminate: () => {},
    },
    { ip: '198.51.100.5', relayHost: 'relay.example.com' },
  )
  sock.onMessage(
    JSON.stringify({
      v: 1,
      type: 'hello',
      id: '01JBF3V7Q8K2M4N6P8R0S2T41M',
      ts: new Date(clock.now()).toISOString(),
      role: 'bridge',
      key_id: relay.bridgeKey.keyId,
      sig: await signChallenge(relay.bridgeKey.privateKey, sent[0] as never),
      client: { name: 'bridge', version: '1', features },
      agent_config_rev: 0,
    }),
  )
  await waitFor(() => sent.some((f) => f.type === 'ready') || closes.length > 0, 4000, 'an answer to the hello')
  return { sent, closes }
}

describe('the features cap', () => {
  it(`takes a bridge hello with ${FEATURES_MAX} features`, async () => {
    const { sent, closes } = await helloWith(names(FEATURES_MAX))
    expect(closes).toEqual([])
    const ready = sent.find((f) => f.type === 'ready')
    const features = (ready?.features ?? []) as string[]
    expect(features).toContain(WIDE_FEATURES_FEATURE) // the bridge learns it may send that many
    expect(features.length).toBeLessThanOrEqual(FEATURES_MAX_V1) // an older bridge reads this ready
  })

  it(`refuses a bridge hello with ${FEATURES_MAX + 1} features`, async () => {
    const { sent, closes } = await helloWith(names(FEATURES_MAX + 1))
    expect(closes).toEqual([WS_CLOSE.UNAUTHORIZED])
    expect(sent.some((f) => f.type === 'ready')).toBe(false)
  })

  it(`passes an app at most ${FEATURES_MAX_V1} of them, in the bridge's order, online and offline`, async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const all = names(30)
    const bridge = await k.bridge({ features: all }).connect()
    await bridge.expectFrame('ready', undefined, { direction: 'in' })
    const app = k.app()
    const ready = await app.connect()
    expect(ready.presence.features).toEqual(all.slice(0, FEATURES_MAX_V1))
    await bridge.close()
    const off = await app.expectFrame('presence', (p) => !p.bridge_online, { direction: 'in' })
    expect(off.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  })

  it('a stored list longer than the app cap, read back after a redeploy, is kept whole and passed on capped', () => {
    const all = names(30)
    const state = new Map([['bridge_features', JSON.stringify({ features: all, at: '2026-11-12T00:00:00.000Z' })]])
    const store = {
      getState: (k: string) => state.get(k) ?? null,
      setState: (k: string, v: string) => void state.set(k, v),
    }
    const f = new BridgeFeatures(store as never)
    expect(f.has(all[29] as string)).toBe(true)
    expect(f.presence().features).toEqual(all.slice(0, FEATURES_MAX_V1))
  })

  it('every features list in the protocol is the one list schema', () => {
    expect(HelloBridgeFrame.shape.client.shape.features.unwrap()).toBe(FeatureList)
    expect(HelloAppFrame.shape.client.shape.features.unwrap()).toBe(FeatureList)
    expect(ReadyFrame.shape.features.unwrap()).toBe(FeatureList)
    expect(Presence.shape.features.unwrap()).toBe(FeatureList)
  })

  it('the list schema takes 64 and refuses 65, in a whole presence frame', () => {
    const presence = (features: string[]) =>
      frameSchemas.presence.safeParse({
        v: 1,
        type: 'presence',
        id: '01JBF3V7Q8K2M4N6P8R0S2T41M',
        ts: '2026-11-12T00:00:00.000Z',
        bridge_online: true,
        last_seen: null,
        queue_depth: 0,
        features,
      }).success
    expect(presence(names(FEATURES_MAX))).toBe(true)
    expect(presence(names(FEATURES_MAX + 1))).toBe(false)
  })

  it('an app whose hello lists features-64/1 gets the whole list, online and offline; the others the first 20', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const all = names(30)
    const bridge = await k.bridge({ features: all }).connect()
    await bridge.expectFrame('ready', undefined, { direction: 'in' })
    const wide = k.app({ features: [WIDE_FEATURES_FEATURE] })
    const narrow = k.app()
    expect((await wide.connect()).presence.features).toEqual(all)
    expect((await narrow.connect()).presence.features).toEqual(all.slice(0, FEATURES_MAX_V1))
    await bridge.close()
    const offWide = await wide.expectFrame('presence', (p) => !p.bridge_online, { direction: 'in' })
    const offNarrow = await narrow.expectFrame('presence', (p) => !p.bridge_online, { direction: 'in' })
    expect(offWide.features).toEqual(all)
    expect(offNarrow.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  })

  it('every other frame reaches a wide app and a narrow one alike', () => {
    const state = new Map<string, string>()
    const store = {
      getState: (k: string) => state.get(k) ?? null,
      setState: (k: string, v: string) => void state.set(k, v),
    }
    const f = new BridgeFeatures(store as never)
    f.onHello(names(30), '2026-11-12T00:00:00.000Z')
    const other = { type: 'message.stored', presence: { features: ['x'] } }
    expect(f.widen(other)).toBe(other)
    expect(f.widenText(other, 'T')).toBe('T')
    f.onHello(names(5), '2026-11-12T00:00:01.000Z')
    const p = { type: 'presence', features: names(5) }
    expect(f.widenText(p, 'T')).toBe('T') // nothing more to give: the same text
  })

  it('lists features-implied/1, and reads a bridge that lists it as having the retired features', async () => {
    const { sent, closes } = await helloWith([FEATURES_IMPLIED_FEATURE, 'search/1'])
    expect(closes).toEqual([])
    expect((sent.find((f) => f.type === 'ready')?.features ?? []) as string[]).toContain(FEATURES_IMPLIED_FEATURE)
    const state = new Map<string, string>()
    const store = {
      getState: (k: string) => state.get(k) ?? null,
      setState: (k: string, v: string) => void state.set(k, v),
    }
    const f = new BridgeFeatures(store as never)
    f.onHello([FEATURES_IMPLIED_FEATURE, 'search/1'], '2026-11-12T00:00:00.000Z')
    expect(f.has(NATIVE_ACT_FEATURE)).toBe(true)
    expect(f.has(PROBLEMS_FEATURE)).toBe(true)
    expect(f.has('memory/1')).toBe(false)
    f.onHello(['search/1'], '2026-11-12T00:00:01.000Z') // an older bridge without the marker: by name only, as before
    expect(f.has(NATIVE_ACT_FEATURE)).toBe(false)
  })

  it('/api/status counts the connected pages that read the whole list and those that do not, nothing more', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    await (await k.bridge({ features: names(3) }).connect()).expectFrame('ready', undefined, { direction: 'in' })
    await k.connectedApp({ features: [WIDE_FEATURES_FEATURE] })
    await k.connectedApp()
    await k.connectedApp()
    const status = HealthStatus.parse(
      await (await fetch(`${relay.httpBase}/api/status`, { headers: relay.appHeaders })).json(),
    )
    expect(status.apps).toEqual({ wide: 1, narrow: 2 })
  })
})
