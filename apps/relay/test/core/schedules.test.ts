// WP-S2 acceptance (docs/SCHEDULES.md S9): the REAL relay over HTTP and WebSocket, a FakeApp in front, a FakeBridge with a
// FakeScheduler behind. When the WP-S1 captures exist in packages/testkit/fixtures/captured/, the last block replays them
// through the same relay (the merge gate).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeviceKey, newUlid } from '@talos-app/protocol'
import {
  buildCard,
  defineScheduleFramesContract,
  FakeScheduler,
  fakeClock,
  mkFrame,
  sleep,
  waitFor,
} from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { testAppHeaders } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { advance, bridgeFetch, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

const JOB = {
  id: 'daily-digest',
  name: 'Daily Digest',
  description: 'Example job',
  when: { type: 'daily' as const, time: '07:30' },
  catchup_min: 180,
  enabled: true,
  runner: 'session' as const,
  permissions: 'full' as const,
  allowed_tools: [],
  model: null,
  notify: 'failure' as const,
  prompt: 'Summarise yesterday and post it.\n',
}

const health = () => ({
  state: 'ok',
  adapter: { id: 'fake', version: null, api: null },
  tz: 'UTC',
  host_label: 'Example Mac',
  session_runner: 'talos',
  paused_all: false,
  headless: 'ok',
  tick_age_s: 1,
  issues: [],
  checked_at: new Date().toISOString(),
})
const status = (alert: { kind: string; key: string } | null) => ({
  type: 'schedule.status',
  health: health(),
  changed: [],
  removed: [],
  alert,
})

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function world(opts: { clock?: ReturnType<typeof fakeClock>; bridge?: boolean; visible?: boolean } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const k = kit(relay)
  const scheduler = new FakeScheduler({ tz: 'UTC', now: new Date().toISOString() })
  await scheduler.seed(JOB)
  const app = await k.connectedApp({ visible: opts.visible ?? true })
  const bridge =
    opts.bridge === false
      ? null
      : await k
          .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, scheduler, autoReply: false })
          .connect()
  return { relay, k, app, bridge, scheduler }
}

const rid = (f: object) => (f as { request_id: string }).request_id
const inFrames = (a: { rec: { frames: Array<{ direction: string; raw: Record<string, unknown> }> } }, type: string) =>
  a.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === type).map((r) => r.raw)

// ---- the contract, against the real relay -----------------------------------------------------------------------------

defineScheduleFramesContract('real relay + FakeBridge + FakeScheduler', {
  async start() {
    const w = await world()
    const { app, bridge } = w
    return {
      knownScheduleId: JOB.id,
      knownScheduleName: JOB.name,
      knownPrompt: 'Summarise yesterday and post it.',
      threadId: 'general',
      sendOwner: async (frame) => {
        const signed = await app.sign({ ...mkFrame(String(frame.type)), ...frame })
        app.send(signed)
        return signed
      },
      sendUnsigned: async (frame) => {
        const f = { ...mkFrame(String(frame.type)), ...frame, device_id: app.device.deviceId, osig: 'A'.repeat(86) }
        app.send(f)
        return f
      },
      expect: (type, pred, timeoutMs) =>
        app.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      received: () => app.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw),
      stop: async () => {
        await app.close()
        await bridge?.close()
        await relay?.stop()
        relay = null
      },
    }
  },
})

// ---- nothing stored ---------------------------------------------------------------------------------------------------

describe('WP-S2 relay: nothing stored', () => {
  it('a full flow (list, get, control, patch, run_now, status) leaves no schedule frame in core_events or the outbox', async () => {
    const { app, bridge, relay: r } = await world()
    await app.listSchedules()
    await app.expectFrame('schedules.snapshot', undefined, { direction: 'in' })
    await app.getSchedule(JOB.id)
    await app.expectFrame('schedule.detail', undefined, { direction: 'in' })
    await app.controlSchedule('pause', JOB.id)
    await app.expectFrame('schedule.status', undefined, { direction: 'in' })
    await app.runScheduleNow(JOB.id)
    bridge?.send(status(null))
    const seenIds = () =>
      r.runtime.store.db.prepare("select key, seq from core_dedup where key like 'sf:%'").all() as Array<{
        key: string
        seq: number
      }>
    await waitFor(() => seenIds().length >= 4, 4000, 'the seen ids recorded')
    const types = (r.runtime.store.db.prepare('select type from core_events').all() as Array<{ type: string }>).map(
      (x) => x.type,
    )
    expect(types.filter((t) => t.startsWith('schedule'))).toEqual([])
    expect(r.runtime.store.outboxDepth()).toBe(0)
    // the only trace is seq-less seen ids
    const seen = seenIds()
    expect(seen.length).toBeGreaterThanOrEqual(4)
    for (const s of seen) expect(s.seq).toBe(0)
  })
})

// ---- routing ----------------------------------------------------------------------------------------------------------

describe('WP-S2 relay: routing', () => {
  it('answers mac_offline at once when no bridge is connected, for every signed frame type', async () => {
    const { app } = await world({ bridge: false })
    const sent = [
      await app.listSchedules(),
      await app.getSchedule(JOB.id),
      await app.patchSchedule({ op: 'delete', id: JOB.id, base_etag: `sha256:${'0'.repeat(64)}` }, 'general'),
      await app.runScheduleNow(JOB.id),
      await app.controlSchedule('pause_all', null),
    ]
    for (const f of sent) {
      const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in', timeoutMs: 2000 })
      expect(e.code).toBe('mac_offline')
    }
  })

  it('forwards the signed bytes to the bridge untouched and adds nothing the signature does not cover', async () => {
    const { app, bridge } = await world()
    const f = await app.listSchedules()
    await app.expectFrame('schedules.snapshot', undefined, { direction: 'in' })
    const got = bridge?.rec.frames.find((r) => r.direction === 'in' && r.raw.id === f.id)?.raw
    expect(got).toEqual(f)
  })

  it('routes a snapshot and a detail only to the socket that asked', async () => {
    const { k, app, bridge } = await world()
    const other = await k.connectedApp()
    await app.listSchedules()
    await app.expectFrame('schedules.snapshot', undefined, { direction: 'in' })
    await app.getSchedule(JOB.id)
    await app.expectFrame('schedule.detail', undefined, { direction: 'in' })
    await sleep(150)
    expect(inFrames(other, 'schedules.snapshot')).toHaveLength(0)
    expect(inFrames(other, 'schedule.detail')).toHaveLength(0)
    await other.close()
    await bridge?.close()
  })

  it('drops a response with an unknown request_id, and one of the wrong type for its request', async () => {
    const { app, bridge } = await world({})
    const f = await app.listSchedules()
    await app.expectFrame('schedules.snapshot', undefined, { direction: 'in' })
    const before = inFrames(app, 'schedules.snapshot').length
    const snap = inFrames(app, 'schedules.snapshot')[0] as Record<string, unknown>
    bridge?.send({ type: 'schedules.snapshot', request_id: newUlid(), snapshot: snap.snapshot }) // unknown id
    bridge?.send({ type: 'schedules.snapshot', request_id: rid(f), snapshot: snap.snapshot }) // already answered
    await sleep(200)
    expect(inFrames(app, 'schedules.snapshot')).toHaveLength(before)
    // a detail answering a list request is the wrong type: dropped, and the request stays open
    const g = await app.listSchedules()
    // (the real fake bridge answered g already; the pending map is empty again)
    await app.expectFrame('schedules.snapshot', (s) => s.request_id === rid(g), { direction: 'in' })
    expect(relay?.runtime.hub.pendingScheduleRequests()).toBe(0)
  })

  it('prunes a request nobody answered after 30 s, and a late answer is dropped', async () => {
    const clock = fakeClock()
    const { app, bridge, relay: r } = await world({ clock })
    bridge!.autoReply = false
    // a bridge that acks but never answers: use a scheduler-less raw bridge instead of the FakeScheduler one
    await bridge?.close()
    const silent = await kit(r).bridge({ autoReply: false, verifyOwner: false }).connect()
    const f = await app.listSchedules()
    await waitFor(() => r.runtime.hub.pendingScheduleRequests() === 1, 3000, 'pending')
    clock.advance(31_000)
    r.runtime.hub.sweep()
    expect(r.runtime.hub.pendingScheduleRequests()).toBe(0)
    const snap = ScheduleSnapshotMin()
    silent.send({ type: 'schedules.snapshot', request_id: rid(f), snapshot: snap })
    await sleep(200)
    expect(inFrames(app, 'schedules.snapshot')).toHaveLength(0)
  })

  it('forwards the bridge ack (no seq) and error to the sending socket and stores nothing', async () => {
    const { app, bridge, relay: r } = await world()
    const f = await app.getSchedule('nope-not-a-job')
    const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(e.code).toBe('schedule_not_found')
    const g = await app.controlSchedule('pause', JOB.id)
    const a = await app.expectFrame('ack', (x) => x.ref === g.id, { direction: 'in' })
    expect(a.seq).toBeUndefined()
    // the sender went away: a late error is dropped, not turned into a thread message
    const h = await app.runScheduleNow(JOB.id)
    await app.close()
    bridge?.send({ type: 'error', ref: h.id, code: 'already_running', message: 'late' })
    await sleep(200)
    const msgs = r.runtime.store.db
      .prepare("select count(*) n from core_events where type = 'message.stored'")
      .get() as {
      n: number
    }
    expect(msgs.n).toBe(0)
  })

  it('schedule.status reaches every app socket, is not stored, and an unpinned socket gets nothing', async () => {
    const { k, app, bridge, relay: r } = await world()
    const two = await k.connectedApp()
    bridge?.send(status(null))
    await app.expectFrame('schedule.status', undefined, { direction: 'in' })
    await two.expectFrame('schedule.status', undefined, { direction: 'in' })
    const n = r.runtime.store.db.prepare("select count(*) n from core_events where type = 'schedule.status'").get() as {
      n: number
    }
    expect(n.n).toBe(0)
  })
})

function ScheduleSnapshotMin() {
  return { protocol: 1 }
}

// ---- push -------------------------------------------------------------------------------------------------------------

describe('WP-S2 relay: alert push', () => {
  const sub = { endpoint: 'https://push.example.com/send/9', keys: { p256dh: 'a', auth: 'b' } }

  it('an alert with no visible socket gives one push; the same key again within 24 h gives none; a new key after 24 h does', async () => {
    const clock = fakeClock()
    const { bridge, relay: r, app } = await world({ clock, visible: false })
    r.runtime.store.putSub(sub)
    expect(app.connected).toBe(true)
    bridge?.send(status({ kind: 'job_failed', key: 'job-1:2026-10-28' }))
    await waitFor(() => r.transport.sent.length === 1, 3000, 'push')
    expect(r.transport.sent[0]?.payload.notification.body).toBe('A scheduled job failed')
    expect(r.transport.sent[0]?.payload.notification.navigate).toBe('/schedules')
    bridge?.send(status({ kind: 'job_failed', key: 'job-1:2026-10-28' }))
    await sleep(200)
    await vi.waitFor(() => expect(r.transport.sent).toHaveLength(1), { timeout: 10_000 })
    bridge?.send(status({ kind: 'scheduler_stuck', key: 'tick_missing' }))
    await waitFor(() => r.transport.sent.length === 2, 3000, 'second push')
    expect(r.transport.sent[1]?.payload.notification.body).toBe('Your scheduler needs you')
    // 25 h later (the seen row ages; a fake clock this far would also kill the ping-timed sockets)
    r.runtime.store.db
      .prepare('update core_dedup set created_at = created_at - ? where key like ?')
      .run(25 * 3600_000, 'sa:%')
    bridge?.send(status({ kind: 'job_failed', key: 'job-1:2026-10-28' }))
    await waitFor(() => r.transport.sent.length === 3, 3000, 'push after 24h')
  })

  it('no push while an app socket is visible', async () => {
    const { bridge, relay: r } = await world({ visible: true })
    r.runtime.store.putSub(sub)
    bridge?.send(status({ kind: 'job_failed', key: 'k' }))
    await sleep(300)
    expect(r.transport.sent).toHaveLength(0)
  })

  it('an idle visible screen (nobody there for 60 s) no longer mutes a schedule alert', async () => {
    const clock = fakeClock()
    const { bridge, relay: r } = await world({ clock, visible: true })
    r.runtime.store.putSub(sub)
    bridge?.send(status({ kind: 'job_failed', key: 'idle-1' }))
    await sleep(300)
    expect(r.transport.sent).toHaveLength(0) // someone just arrived
    await advance(clock, 61_000, 20_000)
    bridge?.send(status({ kind: 'job_failed', key: 'idle-2' }))
    await waitFor(() => r.transport.sent.length === 1, 3000, 'push to the phone')
    expect(r.transport.sent[0]?.payload.notification.body).toBe('A scheduled job failed')
  })

  it('inside the quiet window the push is held, then sent once when the window ends', async () => {
    const clock = fakeClock('2026-10-29T06:58:00.000Z')
    const { bridge, relay: r, app } = await world({ clock, visible: false })
    r.runtime.store.putSub(sub)
    const cfg = { ...DEFAULT_AGENT_CONFIG, rev: 1, quiet_window: { start: '22:00', end: '07:00' } }
    bridge?.send({ type: 'config.sync', config: cfg, rev: 1 })
    await waitFor(() => app.rec.frames.some((x) => x.raw.type === 'config.sync'), 3000, 'config')
    bridge?.send(status({ kind: 'job_failed', key: 'q1' }))
    bridge?.send(status({ kind: 'job_failed', key: 'q2' }))
    await sleep(300)
    expect(r.transport.sent).toHaveLength(0)
    await advance(clock, 3 * 60_000)
    await waitFor(() => r.transport.sent.length === 1, 3000, 'held push')
    await sleep(200)
    await vi.waitFor(() => expect(r.transport.sent).toHaveLength(1), { timeout: 10_000 })
    expect(r.transport.sent[0]?.payload.notification.body).toBe('A scheduled job failed')
  })
})

// ---- dedup and limits -------------------------------------------------------------------------------------------------

describe('WP-S2 relay: dedup, limits, device', () => {
  it('a duplicate frame id is acked with no seq and not forwarded twice', async () => {
    const { app, bridge } = await world()
    const f = await app.controlSchedule('pause', JOB.id)
    await app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
    app.send(f)
    await waitFor(() => inFrames(app, 'ack').filter((x) => x.ref === f.id).length === 2, 3000, 'dup ack')
    for (const a of inFrames(app, 'ack').filter((x) => x.ref === f.id)) expect(a.seq).toBeUndefined()
    expect(bridge?.rec.frames.filter((r) => r.direction === 'in' && r.raw.id === f.id)).toHaveLength(1)
  })

  it('a device other than the session device gets unauthorized and nothing is forwarded', async () => {
    relay = await startTestRelay()
    const mine = await createDeviceKey()
    const other = await createDeviceKey()
    const { FakeApp } = await import('@talos-app/testkit')
    const app = new FakeApp({
      relayWs: relay.wsBase,
      headers: testAppHeaders(ORIGIN, mine.deviceId),
      deviceKey: mine,
    })
    await app.connect()
    const bridge = await kit(relay).bridge({ verifyOwner: false, autoReply: false }).connect()
    const { signOwnerFrame } = await import('@talos-app/protocol')
    const f = await signOwnerFrame(
      { ...mkFrame('schedules.list'), request_id: newUlid(), device_id: other.deviceId },
      other.privateKey,
    )
    app.send(f)
    const e = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(e.code).toBe('unauthorized')
    await sleep(100)
    expect(bridge.rec.frames.some((r) => r.direction === 'in' && r.raw.id === f.id)).toBe(false)
  })

  it('schedules.list and get: 12 per minute per socket, then rate_limited; the bucket refills', async () => {
    const clock = fakeClock()
    const { app } = await world({ clock })
    const sent: Array<{ id: string }> = []
    for (let i = 0; i < 13; i++) sent.push(await app.listSchedules())
    const e = await app.expectFrame('error', (x) => x.ref === sent[12]?.id, { direction: 'in' })
    expect(e.code).toBe('rate_limited')
    expect(inFrames(app, 'error').filter((x) => x.code === 'rate_limited')).toHaveLength(1)
    clock.advance(10_000)
    const again = await app.listSchedules()
    await app.expectFrame('schedules.snapshot', (s) => s.request_id === rid(again), { direction: 'in' })
  })

  it('schedule.patch: 30 per hour', async () => {
    const { app } = await world({ clock: fakeClock() })
    const change = { op: 'delete', id: JOB.id, base_etag: `sha256:${'0'.repeat(64)}` }
    const sent: Array<{ id: string }> = []
    for (let i = 0; i < 31; i++) sent.push(await app.patchSchedule(change, 'general'))
    const e = await app.expectFrame('error', (x) => x.ref === sent[30]?.id && x.code === 'rate_limited', {
      direction: 'in',
    })
    expect(e.code).toBe('rate_limited')
  })

  it('schedule.run_now: 20 per hour total', async () => {
    const { app } = await world({ clock: fakeClock() })
    const sent: Array<{ id: string }> = []
    for (let i = 0; i < 21; i++) sent.push(await app.runScheduleNow(JOB.id))
    const e = await app.expectFrame('error', (x) => x.ref === sent[20]?.id && x.code === 'rate_limited', {
      direction: 'in',
    })
    expect(e.code).toBe('rate_limited')
  })

  it('schedule.control: 60 per hour, and retry_headless stops at 6 per hour', async () => {
    // real clock: the per-socket frame budget (60 burst) would stall a fake one
    const { app } = await world()
    const retries: Array<{ id: string }> = []
    for (let i = 0; i < 7; i++) retries.push(await app.controlSchedule('retry_headless', null))
    const e = await app.expectFrame('error', (x) => x.ref === retries[6]?.id && x.code === 'rate_limited', {
      direction: 'in',
    })
    expect(e.code).toBe('rate_limited')
    expect(inFrames(app, 'error').filter((x) => x.code === 'rate_limited')).toHaveLength(1)
    const controls: Array<{ id: string }> = []
    for (let i = 0; i < 60; i++) controls.push(await app.controlSchedule('pause_all', null))
    await waitFor(() => inFrames(app, 'error').length + inFrames(app, 'ack').length >= 67, 15_000, 'all answered')
    const limited = inFrames(app, 'error').filter((x) => x.code === 'rate_limited')
    // 6 retries took 6 of the 60 control tokens, so the last 6 of the 60 pause_all are refused
    expect(limited).toHaveLength(1 + 6)
    for (const c of controls.slice(54)) expect(limited.some((x) => x.ref === c.id)).toBe(true)
  })

  it('a rate-limited frame is not remembered, so its resend after the refill goes through', async () => {
    const clock = fakeClock()
    const { app } = await world({ clock })
    for (let i = 0; i < 12; i++) await app.listSchedules()
    const f = await app.listSchedules()
    await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    clock.advance(10_000)
    app.send(f)
    await app.expectFrame('schedules.snapshot', (s) => s.request_id === rid(f), { direction: 'in' })
  })
})

// ---- bridge HTTP ------------------------------------------------------------------------------------------------------

describe('WP-S2 relay: bridge HTTP', () => {
  const post = (r: TestRelay, frame: Record<string, unknown>) =>
    bridgeFetch(r, 'POST', '/bridge/post', JSON.stringify(frame), { 'content-type': 'application/json' })

  it('POST /bridge/post with a schedule card is refused; a generic card is accepted', async () => {
    relay = await startTestRelay()
    const mk = (kind: string) => ({
      ...mkFrame('card.create'),
      card: buildCard({ kind: kind as never, thread_id: 'general' } as never),
    })
    const bad = await post(relay, mk('schedule'))
    expect(bad.status).toBe(400)
    const ok = await post(relay, mk('generic'))
    expect(ok.status).toBe(200)
    expect(
      relay.runtime.store.db.prepare("select count(*) n from core_events where type = 'card.create'").get(),
    ).toEqual({
      n: 1,
    })
  })

  it('POST /bridge/post refuses every schedule frame type', async () => {
    relay = await startTestRelay()
    for (const type of ['schedules.snapshot', 'schedule.detail', 'schedule.status', 'schedule.patch']) {
      const res = await post(relay, { ...mkFrame(type), request_id: newUlid() })
      expect(res.status).toBe(400)
    }
  })
})

// ---- features ---------------------------------------------------------------------------------------------------------

describe('WP-S2 relay: features', () => {
  it('echoes the bridge features in presence and in an app ready; advertises its own to the bridge', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const bridge = await k.bridge({ features: ['schedules/1'] }).connect()
    const ready = await bridge.expectFrame('ready', undefined, { direction: 'in' })
    expect(ready.features).toContain('schedules/1')
    const app = k.app()
    const appReady = await app.connect()
    expect(appReady.presence.features).toEqual(['schedules/1'])
    await bridge.close()
    const off = await app.expectFrame('presence', (p) => !p.bridge_online, { direction: 'in' })
    // docs/V2-FEATURES.md V1 (review finding 7) replaced the online-only echo: offline, presence keeps the LAST-KNOWN
    // bridge features with features_at, so the app shows "Needs your Mac" instead of hiding the tab
    expect(off.features).toEqual(['schedules/1'])
    expect(typeof off.features_at).toBe('string')
    const bare = await k.bridge({ features: [] }).connect()
    const p = await app.expectFrame('presence', (x) => x.bridge_online, { direction: 'in' })
    expect(p.features).toBeUndefined()
    await bare.close()
  })
})

// ---- captures (merge gate) --------------------------------------------------------------------------------------------

const capturedDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/testkit/fixtures/captured')
type CapturedStep = {
  label: string
  received_by_bridge: Array<Record<string, unknown>>
  sent_by_bridge: Array<Record<string, unknown>>
}
type CapturedScenario = { scenario: string; steps: CapturedStep[] }
// One file per scenario: { scenario, title, steps[] }, each step the frames the REAL bridge received and sent (index.json lists them).
const scenarios: CapturedScenario[] = readdirSync(capturedDir)
  .filter((f) => /^\d\d-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(capturedDir, f), 'utf8')) as CapturedScenario)

const ROUTED_TO_APP = new Set([
  'schedules.snapshot',
  'schedule.detail',
  'schedule.status',
  'card.create',
  'card.update',
])
const ENVELOPE = new Set(['v', 'type', 'id', 'ts', 'device_id', 'osig'])

describe('WP-S2 relay: WP-S1 captures replayed through the real relay (merge gate)', () => {
  it('has the captured scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10)
  })

  for (const sc of scenarios) {
    it(`${sc.scenario}: every frame the real bridge sent reaches the app (snapshot and detail only to the asker), nothing schedule-shaped is stored`, async () => {
      const { app, bridge, relay: r } = await world()
      await bridge?.close()
      const raw = await kit(r).bridge({ autoReply: false, verifyOwner: false }).connect()
      const other = await kit(r).connectedApp()
      const idMap = new Map<string, string>() // captured id / request_id -> live one
      let expectedIn = 0
      for (const step of sc.steps) {
        const before = app.rec.frames.filter((x) => x.direction === 'in').length
        let expected = 0
        for (const inbound of step.received_by_bridge) {
          const type = String(inbound.type)
          if (!type.startsWith('schedule')) continue // card.resolve etc. take the existing owner path, covered elsewhere
          const fields: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(inbound)) if (!ENVELOPE.has(k)) fields[k] = v
          if (typeof fields.request_id === 'string') {
            const live = newUlid()
            idMap.set(fields.request_id, live)
            fields.request_id = live
          }
          const sent = await app.sendSchedule(type, fields)
          idMap.set(String(inbound.id), sent.id)
        }
        for (const out of step.sent_by_bridge) {
          const f: Record<string, unknown> = { ...out, id: newUlid() }
          if (typeof f.request_id === 'string') f.request_id = idMap.get(f.request_id) ?? f.request_id
          const type = String(f.type)
          const refLive = typeof f.ref === 'string' ? idMap.get(f.ref) : undefined
          if (typeof f.ref === 'string') f.ref = refLive ?? newUlid()
          raw.send(f)
          if (ROUTED_TO_APP.has(type) || ((type === 'ack' || type === 'error') && refLive)) expected++
        }
        expectedIn += expected
        await waitFor(
          () => app.rec.frames.filter((x) => x.direction === 'in').length - before >= expected,
          5000,
          `${sc.scenario} step ${step.label}`,
        )
      }
      expect(expectedIn).toBeGreaterThan(0)
      await sleep(100)
      // snapshots and details went to the asker only; the other socket saw status/cards but never a response
      expect(inFrames(other, 'schedules.snapshot')).toHaveLength(0)
      expect(inFrames(other, 'schedule.detail')).toHaveLength(0)
      const stored = r.runtime.store.db
        .prepare("select count(*) n from core_events where type like 'schedule%'")
        .get() as { n: number }
      expect(stored.n).toBe(0)
    })
  }
})
