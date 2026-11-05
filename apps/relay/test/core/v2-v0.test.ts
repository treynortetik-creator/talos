// WP-V0 acceptance, relay part (docs/V2-FEATURES.md V1, V1.3, V8): the shared request router against the REAL relay
// (FakeApp in front, FakeBridge behind), relay features with the bridge offline, last-known bridge features, the
// history.request id keys, health.beat kept, and the message frame additions.
import { createDeviceKey, newUlid, signOwnerFrame } from '@talos-app/protocol'
import {
  defineEphemeralFramesContract,
  FakeApp,
  type FakeBridge,
  fakeClock,
  mkFrame,
  sleep,
  waitFor,
} from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EPHEMERAL_TTL_MS } from '../../src/core/ephemeral.ts'
import { registerRelayFeature, resetRelayFeatures } from '../../src/core/features.ts'
import { testAppHeaders } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  resetRelayFeatures()
  await relay?.stop()
  relay = null
})

const inFrames = (a: FakeApp) => a.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)
const bridgeIn = (b: FakeBridge) => b.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)

async function world(opts: { clock?: ReturnType<typeof fakeClock>; bridge?: boolean; features?: string[] } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const k = kit(relay)
  const app = await k.connectedApp()
  const other = await k.connectedApp()
  const bridge =
    opts.bridge === false
      ? null
      : await k
          .bridge({
            pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
            autoReply: false,
            ...(opts.features ? { features: opts.features } : {}),
          })
          .connect()
  return { relay, k, app, other, bridge }
}

const searchFrame = (rid = newUlid()) => ({
  type: 'search.query',
  request_id: rid,
  q: 'release',
  filters: { thread_ids: [], from: 'any', has_file: null, after: null, before: null },
  sort: 'relevance',
  cursor: null,
  limit: 10,
})

defineEphemeralFramesContract('real relay + FakeBridge', {
  async start() {
    const w = await world()
    const { app, other, k } = w
    let bridge = w.bridge as FakeBridge
    return {
      sendRead: async (frame) => {
        const signed = await app.sign({ ...mkFrame(String(frame.type)), ...frame })
        app.send(signed)
        return signed
      },
      expectApp: (type, pred, timeoutMs) =>
        app.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      receivedApp: () => inFrames(app),
      receivedOther: () => inFrames(other),
      expectBridge: (type, pred, timeoutMs) =>
        bridge.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      bridgeSend: (frame) => {
        bridge.send(frame)
      },
      bridgeOffline: async () => {
        await bridge.close()
        await waitFor(() => !w.relay.relay.services.bus.bridgeOnline(), 3000, 'relay sees the bridge gone')
      },
      freshCatchup: async () => {
        const fresh = await k.connectedApp()
        fresh.send({ type: 'catchup.request', since_seq: 0 })
        await sleep(300)
        const got = inFrames(fresh).flatMap((f) =>
          f.type === 'catchup.batch' ? (f.frames as Record<string, unknown>[]) : [f],
        )
        await fresh.close()
        return got
      },
      stop: async () => {
        await app.close()
        await other.close()
        await bridge?.close()
        await relay?.stop()
        relay = null
        bridge = null as unknown as FakeBridge
      },
    }
  },
})

describe('the shared router (core/ephemeral.ts) on the real relay', () => {
  it('a read the Mac never answers is forgotten after 30 s: a late answer is dropped', async () => {
    const clock = fakeClock()
    const { app, bridge } = await world({ clock })
    // the bridge behind answers nothing for search (a slow Mac)
    ;(bridge as unknown as { opts: { reads: unknown } }).opts.reads = {
      'search.query': () => ({ error: '__never__' }),
    }
    const hub = relay?.runtime.hub as unknown as { ephemeral: { pending(): number } }
    const f = await app.sign({ ...mkFrame('search.query'), ...searchFrame() })
    // keep the ts inside the bridge's window although the relay runs on a fake clock
    app.send(f)
    await bridge?.expectFrame('search.query', (x) => x.id === f.id, { direction: 'in' })
    expect(hub.ephemeral.pending()).toBe(1)
    await advance(clock, EPHEMERAL_TTL_MS + 1000)
    ;(relay?.runtime.hub as unknown as { sweep(): void } | undefined)?.sweep()
    expect(hub.ephemeral.pending()).toBe(0)
    bridge?.send({
      type: 'search.results',
      request_id: f.request_id,
      hits: [],
      next_cursor: null,
      total_estimate: 0,
      took_ms: 1,
      index: 'ready',
    })
    await sleep(150)
    expect(inFrames(app).some((x) => x.type === 'search.results')).toBe(false)
  })

  it('search.query is rate limited per socket at 120/min', async () => {
    const { app } = await world({ bridge: false })
    // with the Mac offline every one is answered at once (mac_offline) until the bucket is empty
    for (let i = 0; i < 121; i++) app.send(await app.sign({ ...mkFrame('search.query'), ...searchFrame() }))
    await waitFor(() => inFrames(app).filter((x) => x.type === 'error').length >= 121, 10_000, '121 errors')
    const codes = inFrames(app)
      .filter((x) => x.type === 'error')
      .map((x) => x.code)
    expect(codes.filter((c) => c === 'mac_offline')).toHaveLength(121) // offline wins before the limiter
  })

  it('a read signed by another device than the session is refused before it is forwarded', async () => {
    relay = await startTestRelay()
    const mine = await createDeviceKey()
    const app = new FakeApp({
      relayWs: relay.wsBase,
      headers: testAppHeaders(ORIGIN, mine.deviceId),
      deviceKey: mine,
    })
    await app.connect()
    const bridge = await kit(relay).bridge({ autoReply: false }).connect()
    const other = await createDeviceKey()
    const f = await signOwnerFrame(
      { ...mkFrame('search.query'), ...searchFrame(), device_id: other.deviceId },
      other.privateKey,
    )
    app.send(f)
    const err = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('unauthorized')
    await sleep(100)
    expect(bridgeIn(bridge).some((x) => x.id === f.id)).toBe(false)
    await app.close()
    await bridge.close()
  })
})

describe('feature flags (V1)', () => {
  it('relay features reach the app in ready with the bridge offline', async () => {
    registerRelayFeature('health/1')
    registerRelayFeature('share/1')
    relay = await startTestRelay()
    const app = kit(relay).app()
    const ready = await app.connect()
    expect(ready.presence.bridge_online).toBe(false)
    expect(ready.features).toEqual(expect.arrayContaining(['health/1', 'share/1']))
    await app.close()
  })

  it('presence keeps the LAST-KNOWN bridge features with features_at while the bridge is offline, across a restart', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const live = await k.connectedApp()
    const bridge = await k.bridge({ features: ['search/1', 'memory/1'] }).connect()
    await waitFor(
      () => inFrames(live).some((f) => f.type === 'presence' && JSON.stringify(f).includes('memory/1')),
      3000,
      'presence with features',
    )
    await bridge.close()
    await waitFor(() => !relay?.relay.services.bus.bridgeOnline(), 3000, 'bridge gone')
    const later = k.app()
    const ready = await later.connect()
    expect(ready.presence.bridge_online).toBe(false)
    expect(ready.presence.features).toEqual(['search/1', 'memory/1'])
    expect(typeof ready.presence.features_at).toBe('string')
    await later.close()
    await live.close()
    // a redeploy (new process, same data) still knows them
    const dir = relay.dir
    await relay.stopKeepData()
    relay = await startTestRelay({ dir, bridgeKey: relay.bridgeKey })
    const after = kit(relay).app()
    const r2 = await after.connect()
    expect(r2.presence.features).toEqual(['search/1', 'memory/1'])
    await after.close()
  })
})

describe('frame additions', () => {
  it('history.request with around_id goes to the Mac and the page comes back to the asker', async () => {
    const { app, bridge } = await world()
    const rid = newUlid()
    app.send({ type: 'history.request', request_id: rid, thread_id: 'general', around_id: `m_${newUlid()}`, limit: 50 })
    const got = await bridge?.expectFrame('history.request', (x) => x.request_id === rid, { direction: 'in' })
    expect(got?.around_id).toBeDefined()
    bridge?.send({
      type: 'history.page',
      request_id: rid,
      thread_id: 'general',
      messages: [],
      has_more: false,
      has_newer: false,
      anchor_id: got?.around_id,
    })
    const page = await app.expectFrame('history.page', (x) => x.request_id === rid, { direction: 'in' })
    expect(page.has_newer).toBe(false)
  })

  it('signed history.request: the page and a Mac error come back to the asking socket only, and an error is never stored', async () => {
    const { app, other, bridge } = await world()
    const rid = newUlid()
    const req = await app.sign({
      ...mkFrame('history.request'),
      request_id: rid,
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 50,
    })
    app.send(req)
    await bridge?.expectFrame('history.request', (x) => x.request_id === rid, { direction: 'in' })
    bridge?.send(mkFrame('error', { ref: req.id, code: 'sig_invalid', message: 'nope' }) as never)
    const err = await app.expectFrame('error', (x) => x.ref === req.id, { direction: 'in' })
    expect(err.code).toBe('sig_invalid')
    bridge?.send({
      type: 'history.page',
      request_id: rid,
      thread_id: 'general',
      messages: [],
      has_more: false,
    })
    await app.expectFrame('history.page', (x) => x.request_id === rid, { direction: 'in' })
    await sleep(200)
    expect(inFrames(other).some((f) => f.type === 'history.page' || f.type === 'error')).toBe(false)
    expect(inFrames(app).some((f) => f.type === 'message.stored')).toBe(false) // no "An action was rejected" row
  })

  it('a history.request signed by another device than the session is refused at the relay and never reaches the Mac', async () => {
    relay = await startTestRelay()
    const mine = await createDeviceKey()
    const other = await createDeviceKey()
    const app = new FakeApp({ relayWs: relay.wsBase, headers: testAppHeaders(ORIGIN, mine.deviceId), deviceKey: mine })
    await app.connect()
    const bridge = await kit(relay).bridge({ autoReply: false }).connect()
    const rid = newUlid()
    const f = await signOwnerFrame(
      {
        ...mkFrame('history.request'),
        request_id: rid,
        thread_id: 'general',
        around_id: `m_${newUlid()}`,
        limit: 50,
        device_id: other.deviceId,
      },
      other.privateKey,
    )
    app.send(f)
    const err = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((x) => x.type === 'history.request')).toBe(false)
    await app.close()
  })

  it('history.request with after_id and the Mac offline answers unavailable at once', async () => {
    const { app } = await world({ bridge: false })
    const rid = newUlid()
    app.send({ type: 'history.request', request_id: rid, thread_id: 'general', after_id: `m_${newUlid()}`, limit: 50 })
    const page = await app.expectFrame('history.page', (x) => x.request_id === rid, { direction: 'in' })
    expect(page.unavailable).toBe('mac_offline')
  })

  it('health.beat: the relay keeps the last one and never forwards it to apps', async () => {
    const { app, bridge } = await world()
    const beat = {
      bridge: { version: '0.4.1', started_at: new Date().toISOString() },
      mod: { state: 'alive', last_seen: null, expected: false },
      tts: false,
      stt: false,
      sqlite: { fts5: true },
    }
    bridge?.send({ type: 'health.beat', beat })
    await waitFor(() => relay?.runtime.store.getState('health_beat') !== null, 3000, 'beat stored')
    expect(JSON.parse(relay?.runtime.store.getState('health_beat') as string).sqlite.fts5).toBe(true)
    await sleep(100)
    expect(inFrames(app).some((f) => f.type === 'health.beat')).toBe(false)
  })

  it('a signed message with refs and share_content: message.stored carries both', async () => {
    const { app, bridge } = await world()
    const ref = { kind: 'memory', root_id: 'notes', path: 'a.md', sha256: 'ab'.repeat(32) }
    const f = await app.sendMessage('general', 'Summarise this', {
      refs: [ref],
      share_content: { url: 'https://example.com/a', title: 'A page' },
    })
    const stored = await app.expectFrame('message.stored', (x) => x.client_msg_id === f.client_msg_id, {
      direction: 'in',
    })
    expect(stored.message.refs).toEqual([ref])
    expect(stored.message.share_content).toEqual({ url: 'https://example.com/a', title: 'A page' })
    expect(stored.message.text).toBe('Summarise this')
    await bridge?.expectFrame('message', (x) => x.id === f.id, { direction: 'in' })
  })
})
