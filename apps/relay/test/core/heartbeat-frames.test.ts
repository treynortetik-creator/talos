// HB5: the real relay passes heartbeat.test / heartbeat.test_result the way it passes the schedule frames (docs/SCHEDULES.md S4):
// same owner check, nothing stored, answer routed to the asking socket only, mac_offline at once, rate limited. The results
// are the committed fixtures in packages/testkit/fixtures/heartbeat-frames.
import { readFileSync } from 'node:fs'
import { newUlid, parseHeartbeatTestResult } from '@talos-app/protocol'
import { fakeClock, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

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
const rid = (f: object) => (f as { request_id: string }).request_id
const inFrames = (a: { rec: { frames: Array<{ direction: string; raw: Record<string, unknown> }> } }, type: string) =>
  a.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === type).map((r) => r.raw)

describe('heartbeat.test through the real relay', () => {
  it('the bridge gets the signed bytes untouched, acks, and the result comes back to the asker, readable by the app parser', async () => {
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
  })

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

  it('an older bridge that does not list heartbeat/1 gets nothing and the app is told to update the Mac', async () => {
    const { app, bridge } = await world({ features: ['schedules/1'] })
    const f = await app.testHeartbeat(CONFIG)
    const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in', timeoutMs: 2000 })
    expect(e.code).toBe('scheduler_unavailable')
    expect(String(e.message)).toMatch(/Update Talos on your Mac/)
    await sleep(100)
    expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === f.id)).toBe(false)
  })

  it('a frame with a bad signature gets an error and no result; one naming another device never reaches the bridge', async () => {
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
    await sleep(100)
    expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === other.id)).toBe(false)
    expect(inFrames(app, 'heartbeat.test_result')).toHaveLength(0)
  })

  it("a second socket cannot take over the first one's request_id or receive its result", async () => {
    const { k, app, bridge } = await world({ delayMs: 400 })
    const other = await k.connectedApp()
    const first = await app.testHeartbeat(CONFIG)
    await app.expectFrame('ack', (x) => x.ref === first.id, { direction: 'in' })
    const thief = await other.testHeartbeat(CONFIG, { requestId: rid(first) })
    const e = await other.expectFrame('error', (x) => x.ref === thief.id, { direction: 'in', timeoutMs: 2000 })
    expect(e.code).toBe('bad_frame')
    expect(bridge?.rec.frames.some((r) => r.direction === 'in' && r.raw.id === thief.id)).toBe(false)
    await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(first), { direction: 'in' })
    await sleep(150)
    expect(inFrames(other, 'heartbeat.test_result')).toHaveLength(0)
  })

  it('the same frame sent twice is acked twice and runs once', async () => {
    const { app, bridge } = await world()
    const f = await app.testHeartbeat(CONFIG)
    await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
    app.send(f)
    await sleep(200)
    expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.id === f.id)).toHaveLength(1)
  })

  it('allows 6 tests an hour and then says to wait', async () => {
    const { app } = await world()
    for (let i = 0; i < 6; i++) {
      const f = await app.testHeartbeat(CONFIG)
      await app.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), { direction: 'in' })
    }
    const seventh = await app.testHeartbeat(CONFIG)
    const e = await app.expectFrame('error', (x) => x.ref === seventh.id, { direction: 'in', timeoutMs: 2000 })
    expect(e.code).toBe('rate_limited')
  })

  it('keeps a request for the 200 s a test can take (the 30 s of a read is not enough), then drops a late answer', async () => {
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
    await sleep(200)
    expect(inFrames(app, 'heartbeat.test_result').filter((x) => x.request_id === rid(g))).toHaveLength(0)
  })

  it('a bridge result with an unknown request_id, or for no request, reaches nobody', async () => {
    const { app, bridge } = await world()
    bridge?.send({ type: 'heartbeat.test_result', request_id: newUlid(), result: fx('01-test-pass.json').result })
    await sleep(200)
    expect(inFrames(app, 'heartbeat.test_result')).toHaveLength(0)
  })

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

  it('R1-4: the socket drops mid-test and the owner reconnects: the same request_id on the new socket gets the result, and the Mac is not asked twice', async () => {
    const { k, app, bridge } = await world({ delayMs: 600 })
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
  })

  it('R1-4: the result that arrived while nobody was connected is handed over when the owner asks again, once', async () => {
    const { k, app, bridge } = await world({ delayMs: 300 })
    const f = await app.testHeartbeat(CONFIG)
    await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
    await app.close()
    await sleep(700) // the Mac answered into the gap
    const again = await k.connectedApp({ deviceKey: app.device })
    await again.testHeartbeat(CONFIG, { requestId: rid(f) })
    await again.expectFrame('heartbeat.test_result', (x) => x.request_id === rid(f), {
      direction: 'in',
      timeoutMs: 3000,
    })
    const third = await again.testHeartbeat(CONFIG, { requestId: rid(f) })
    await again.expectFrame('ack', (x) => x.ref === third.id, { direction: 'in' }).catch(() => undefined)
    await sleep(200)
    expect(inFrames(again, 'heartbeat.test_result')).toHaveLength(1)
    expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'heartbeat.test')).toHaveLength(1)
  })

  it('R1-4: a LIVE other socket still cannot take a request over after a reconnect elsewhere', async () => {
    const { k, app } = await world({ delayMs: 500 })
    const other = await k.connectedApp()
    const f = await app.testHeartbeat(CONFIG)
    await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
    const thief = await other.testHeartbeat(CONFIG, { requestId: rid(f) })
    const e = await other.expectFrame('error', (x) => x.ref === thief.id, { direction: 'in', timeoutMs: 2000 })
    expect(e.code).toBe('bad_frame')
  })

  it('R1-10: a refused request_id collision does not spend a rate-limit token', async () => {
    const { k, app } = await world({ delayMs: 200 })
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
  })
})
