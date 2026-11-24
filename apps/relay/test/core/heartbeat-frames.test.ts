// HB5: the real relay passes heartbeat.test / heartbeat.test_result the way it passes the schedule frames (docs/SCHEDULES.md S4):
// same owner check, nothing stored, answer routed to the asking socket only, mac_offline at once, rate limited. The results
// are the committed fixtures in packages/testkit/fixtures/heartbeat-frames.
import { readFileSync } from 'node:fs'
import { newUlid, parseHeartbeatTestResult } from '@talos-app/protocol'
import { type FakeApp, type FakeBridge, fakeClock, mkFrame, sleep, t, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) }) // a test whose waits add up higher (the relay and sockets it starts, each testkit wait at x3) says so itself

const fx = (n: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../packages/testkit/fixtures/heartbeat-frames/${n}`, import.meta.url), 'utf8'),
  )
const CONFIG = fx('config.json').config as Record<string, unknown>

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function world(
  o: {
    clock?: ReturnType<typeof fakeClock>
    bridge?: boolean
    features?: string[]
    result?: string
    delayMs?: number
  } = {},
) {
  relay = await startTestRelay(o.clock ? { clock: o.clock } : {})
  const k = kit(relay)
  const app = await k.connectedApp()
  const bridge =
    o.bridge === false
      ? null
      : await k
          .bridge({
            pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
            autoReply: false,
            heartbeatTest: () => fx(o.result ?? '01-test-pass.json').result,
            ...(o.delayMs ? { heartbeatDelayMs: o.delayMs } : {}),
            ...(o.features ? { features: o.features } : {}),
          })
          .connect()
  return { relay, k, app, bridge }
}
/** Everything this socket sent before this has been handled (and what the relay sent to it before the answer has arrived): the relay answers one socket's frames in order. */
const handled = async (s: FakeApp | FakeBridge) => {
  const nonce = `after-${Math.random().toString(36).slice(2, 10)}`
  if ('device' in s) s.send(mkFrame('ping', { nonce }))
  else s.send({ type: 'ping', nonce })
  await s.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'in' })
}
const rid = (f: object) => (f as { request_id: string }).request_id
const inFrames = (a: { rec: { frames: Array<{ direction: string; raw: Record<string, unknown> }> } }, type: string) =>
  a.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === type).map((r) => r.raw)

describe('heartbeat.test through the real relay', () => {
  it(
    'the bridge gets the signed bytes untouched, acks, and the result comes back to the asker, readable by the app parser',
    async () => {
      const { app, bridge } = await world()
      const f = await app.testHeartbeat(CONFIG)
      const ack = await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      expect(ack.seq).toBeUndefined()
      const got = await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
        direction: 'in',
      })
      expect(bridge?.rec.frames.find((r) => r.direction === 'in' && r.raw.id === f.id)?.raw).toEqual(f)
      const parsed = parseHeartbeatTestResult(got.result)
      expect(parsed.ok && parsed.result.sources.map((s) => s.id)).toEqual(['github', 'inbox'])
    },
    t(40_000),
  )

  it('stores nothing: no event, no outbox row, only a seq-less seen id', async () => {
    const { app, relay: r } = await world()
    const f = await app.testHeartbeat(CONFIG)
    await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
    const types = (r.runtime.store.db.prepare('select type from core_events').all() as Array<{ type: string }>).map(
      (x) => x.type,
    )
    expect(types.filter((t) => t.startsWith('heartbeat'))).toEqual([])
    expect(r.runtime.store.outboxDepth()).toBe(0)
    const seen = r.runtime.store.db.prepare("select seq from core_dedup where key like 'sf:%'").all() as Array<{
      seq: number
    }>
    expect(seen.length).toBeGreaterThanOrEqual(1)
    for (const s of seen) expect(s.seq).toBe(0)
  })

  it('answers mac_offline at once with no bridge', async () => {
    const { app } = await world({ bridge: false })
    const f = await app.testHeartbeat(CONFIG)
    const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in', timeoutMs: 2000 })
    expect(e.code).toBe('mac_offline')
  })

  it(
    'an older bridge that does not list heartbeat/1 gets nothing and the app is told to update the Mac',
    async () => {
      const { app, bridge } = await world({ features: ['schedules/1'] })
      const f = await app.testHeartbeat(CONFIG)
      const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('scheduler_unavailable')
      expect(String(e.message)).toMatch(/Update Talos on your Mac/)
      await handled(bridge as FakeBridge) // the relay's earlier frames to the Mac have reached it
      await sleep(t(150)) // timing-ok: negative window, from the error answered and the Mac's socket flushed: nothing was passed on
      expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === f.id)).toBe(false)
    },
    t(35_000),
  )

  it(
    'a frame with a bad signature gets an error and no result; one naming another device never reaches the bridge',
    async () => {
      const { app, bridge } = await world()
      const mk = (device_id: string) => ({
        ...mkFrame('heartbeat.test'),
        request_id: newUlid(),
        config: CONFIG,
        window_h: 24,
        with_agent: false,
        device_id,
        osig: 'A'.repeat(86),
      })
      const bad = mk(app.device.deviceId)
      app.send(bad)
      const e = await app.expectFrame('error', (x) => x.ref === bad.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('sig_invalid')
      const other = mk('d_aaaaaaaaaaaaaaaaaaaaaa')
      app.send(other)
      await app.expectFrame('error', (x) => x.ref === other.id, { direction: 'in', timeoutMs: 2000 })
      await handled(bridge as FakeBridge)
      await sleep(t(150)) // timing-ok: negative window, from the error answered and the Mac's socket flushed: nothing was passed on
      expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === other.id)).toBe(false)
      expect(inFrames(app, 'heartbeat.test_result')).toHaveLength(0)
    },
    t(40_000),
  )

  it(
    "a second socket cannot take over the first one's request_id or receive its result",
    async () => {
      const { k, app, bridge } = await world({ delayMs: t(400) }) // a fake Mac's answer delay, on the real clock: scaled
      const other = await k.connectedApp()
      const first = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === first.id, { direction: 'in' })
      const thief = await other.testHeartbeat(CONFIG, { requestId: rid(first) })
      const e = await other.expectFrame('error', (x) => x.ref === thief.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('bad_frame')
      expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === thief.id)).toBe(false)
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(first), { direction: 'in' })
      await handled(other) // whatever the relay sent the second socket before this has arrived
      await sleep(t(150)) // timing-ok: negative window, from the first socket's result delivered: the second socket got none
      expect(inFrames(other, 'heartbeat.test_result')).toHaveLength(0)
    },
    t(65_000),
  )

  it(
    'the same frame sent twice is acked twice and runs once',
    async () => {
      const { app, bridge } = await world()
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
      app.send(f)
      await handled(app) // the relay has handled the second send
      await handled(bridge as FakeBridge)
      await sleep(t(200)) // timing-ok: negative window, from the second send handled and the Mac's socket flushed: it ran once
      expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.id === f.id)).toHaveLength(1)
    },
    t(50_000),
  )

  it(
    'allows 6 tests an hour and then says to wait',
    async () => {
      const { app } = await world()
      for (let i = 0; i < 6; i++) {
        const f = await app.testHeartbeat(CONFIG)
        await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
      }
      const seventh = await app.testHeartbeat(CONFIG)
      const e = await app.expectFrame('error', (x) => x.ref === seventh.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('rate_limited')
    },
    t(80_000),
  )

  it(
    'keeps a request for the 200 s a test can take (the 30 s of a read is not enough), then drops a late answer',
    async () => {
      const clock = fakeClock()
      const { app, bridge } = await world({ clock, delayMs: 3_600_000 }) // the fake bridge never answers on its own
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      await waitFor(() => relay?.runtime.hub.pendingScheduleRequests() === 1, 3000, 'pending')
      await advance(clock, 100_000)
      expect(relay?.runtime.hub.pendingScheduleRequests()).toBe(1)
      bridge?.send({ type: 'heartbeat.test_result', request_id: rid(f), result: fx('01-test-pass.json').result })
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })

      const g = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === g.id, { direction: 'in' })
      await advance(clock, 215_000)
      relay?.runtime.hub.sweep()
      expect(relay?.runtime.hub.pendingScheduleRequests()).toBe(0)
      bridge?.send({ type: 'heartbeat.test_result', request_id: rid(g), result: fx('01-test-pass.json').result })
      await handled(bridge as FakeBridge) // the relay has handled the late result
      await handled(app)
      await sleep(t(200)) // timing-ok: negative window, from the late result handled and the phone's socket flushed: it reached nobody
      expect(inFrames(app, 'heartbeat.test_result').filter((x) => x.request_id === rid(g))).toHaveLength(0)
    },
    t(75_000),
  )

  it(
    'a bridge result with an unknown request_id, or for no request, reaches nobody',
    async () => {
      const { app, bridge } = await world()
      bridge?.send({ type: 'heartbeat.test_result', request_id: newUlid(), result: fx('01-test-pass.json').result })
      await handled(bridge as FakeBridge) // the relay has handled the stray result
      await handled(app)
      await sleep(t(200)) // timing-ok: negative window, from the stray result handled and the phone's socket flushed: it reached nobody
      expect(inFrames(app, 'heartbeat.test_result')).toHaveLength(0)
    },
    t(40_000),
  )

  it("a newer app's frame (extra config keys, an odd window) is passed whole", async () => {
    const { app, bridge } = await world()
    const f = await app.testHeartbeat({ ...CONFIG, future_key: { a: 1 } }, { windowH: 6 })
    await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
    const seen = bridge?.rec.frames.find((r) => r.direction === 'in' && r.raw.id === f.id)
    expect((seen?.raw as { window_h: number } | undefined)?.window_h).toBe(6)
  })

  it.each([
    '01-test-pass.json',
    '03-test-failed-source.json',
    '05-test-old-minimal.json',
    '06-test-newer-unknown-values.json',
  ])('passes the committed result %s to the app unchanged', async (name) => {
    const { app } = await world({ result: name })
    const f = await app.testHeartbeat(CONFIG)
    const got = await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
      direction: 'in',
    })
    expect(got.result).toEqual(fx(name).result)
  })

  it(
    'R1-4: the socket drops mid-test and the owner reconnects: the same request_id on the new socket gets the result, and the Mac is not asked twice',
    async () => {
      const { k, app, bridge } = await world({ delayMs: t(600) }) // a fake Mac's answer delay, on the real clock: scaled
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      await app.close()
      const again = await k.connectedApp({ deviceKey: app.device })
      const g = await again.testHeartbeat(CONFIG, { requestId: rid(f) })
      await again.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
        direction: 'in',
        timeoutMs: 5000,
      })
      expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'heartbeat.test')).toHaveLength(1)
      expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === g.id)).toBe(false)
    },
    t(55_000),
  )

  it(
    'R1-4: the result that arrived while nobody was connected is handed over when the owner asks again, once',
    async () => {
      const { k, app, bridge } = await world({ delayMs: t(300) }) // a fake Mac's answer delay, on the real clock: scaled
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      await app.close()
      // the Mac answered into the gap: its result is sent, and the relay (answering the Mac's frames in order) has handled it
      await waitFor(
        () => bridge?.rec.frames.some((r) => r.direction === 'out' && r.raw.type === 'heartbeat.test_result') === true,
        3000,
        'the Mac to answer while nobody is connected',
      )
      await handled(bridge as FakeBridge)
      const again = await k.connectedApp({ deviceKey: app.device })
      await again.testHeartbeat(CONFIG, { requestId: rid(f) })
      await again.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
        direction: 'in',
        timeoutMs: 3000,
      })
      const third = await again.testHeartbeat(CONFIG, { requestId: rid(f) })
      await again.expectFrame('ack', (x) => x.ref === third.id, { direction: 'in' }).catch(() => undefined)
      await handled(again) // the relay has handled the third ask: one result seen before "exactly one"
      await sleep(t(200)) // timing-ok: negative window, from the third ask handled: still exactly one result
      expect(inFrames(again, 'heartbeat.test_result')).toHaveLength(1)
      expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'heartbeat.test')).toHaveLength(1)
    },
    t(85_000),
  )

  it(
    'R1-4: a LIVE other socket still cannot take a request over after a reconnect elsewhere',
    async () => {
      const { k, app } = await world({ delayMs: t(500) }) // a fake Mac's answer delay, on the real clock: scaled
      const other = await k.connectedApp()
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      const thief = await other.testHeartbeat(CONFIG, { requestId: rid(f) })
      const e = await other.expectFrame('error', (x) => x.ref === thief.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('bad_frame')
    },
    t(45_000),
  )

  it(
    'R2-1: the old socket is half-open (never closed), the SAME device reconnects and re-asks: the result goes to the new socket, the old one gets none, and the Mac is asked once',
    async () => {
      const { k, app, bridge } = await world({ delayMs: t(600) }) // a fake Mac's answer delay, on the real clock: scaled
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      // no app.close(): the phone changed networks and the relay still sees the old socket as live
      const again = await k.connectedApp({ deviceKey: app.device })
      const g = await again.testHeartbeat(CONFIG, { requestId: rid(f) })
      await again.expectFrame('ack', (x) => x.ref === g.id, { direction: 'in' })
      await again.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
        direction: 'in',
        timeoutMs: 5000,
      })
      await handled(app) // nothing more for the old socket, and the new one's frames are all in
      await handled(again)
      await sleep(t(150)) // timing-ok: negative window, from the result delivered to the new socket: the old one got none, no error
      expect(inFrames(again, 'error').filter((e) => e.ref === g.id)).toEqual([])
      expect(inFrames(app, 'heartbeat.test_result')).toHaveLength(0)
      expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'heartbeat.test')).toHaveLength(1)
    },
    t(80_000),
  )

  it(
    'R2-1: a different device cannot take a request over while the owner is connected',
    async () => {
      const { k, app, bridge } = await world({ delayMs: t(500) }) // a fake Mac's answer delay, on the real clock: scaled
      const other = await k.connectedApp() // a different device key
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
      const thief = await other.testHeartbeat(CONFIG, { requestId: rid(f) })
      const e = await other.expectFrame('error', (x) => x.ref === thief.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('bad_frame')
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
      await handled(other)
      await sleep(t(150)) // timing-ok: negative window, from the owner's result delivered: the other device got none
      expect(inFrames(other, 'heartbeat.test_result')).toHaveLength(0)
      expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'heartbeat.test')).toHaveLength(1)
    },
    t(60_000),
  )

  it(
    'R1-10: a refused request_id collision does not spend a rate-limit token',
    async () => {
      const { k, app } = await world({ delayMs: t(2000) }) // the fake Mac answers after all 8 thieves are refused, even under load
      const other = await k.connectedApp()
      const first = await app.testHeartbeat(CONFIG)
      await app.expectFrame('ack', (x) => x.ref === first.id, { direction: 'in' })
      for (let i = 0; i < 8; i++) {
        const t = await other.testHeartbeat(CONFIG, { requestId: rid(first) })
        await other.expectFrame('error', (x) => x.ref === t.id, { direction: 'in', timeoutMs: 2000 })
      }
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(first), { direction: 'in' })
      // 1 used so far: five more succeed, the seventh overall is the one refused
      for (let i = 0; i < 5; i++) {
        const f = await app.testHeartbeat(CONFIG)
        await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
      }
      const seventh = await app.testHeartbeat(CONFIG)
      const e = await app.expectFrame('error', (x) => x.ref === seventh.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('rate_limited')
    },
    t(160_000),
  )
})
