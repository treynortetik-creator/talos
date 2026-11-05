// WP-V1 acceptance, relay part (docs/V2-FEATURES.md V2.6, minus the dropped hourly external check): the REAL relay over
// HTTP and WebSocket, a FakeApp in front, a FakeBridge behind, a recording push transport, a local ntfy sink, an injected
// clock. Every row of "Bridge down", "Mod", "Health status" and "ntfy".
import { createServer, type Server } from 'node:http'
import { type HealthBeatT, HealthStatus } from '@talos-app/protocol'
import { type FakeBridge, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const SUB = { endpoint: 'https://push.example.com/send/health', keys: { p256dh: 'a', auth: 'b' } }
const START = '2026-10-29T12:00:00.000Z'

let relay: TestRelay | null = null
let sink: Sink | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
  await sink?.close()
  sink = null
})

type Sink = {
  url: string
  hits: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>
  close(): Promise<void>
}
async function ntfySink(): Promise<Sink> {
  const hits: Sink['hits'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      hits.push({ headers: req.headers, body })
      res.statusCode = 200
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/topic`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const beatOf = (over: Partial<HealthBeatT> = {}): HealthBeatT => ({
  bridge: { version: '0.4.1', started_at: START },
  mod: { state: 'alive', last_seen: START, expected: true },
  tts: true,
  stt: true,
  sqlite: { fts5: true },
  ...over,
})

type WorldOpts = {
  clock?: ReturnType<typeof fakeClock>
  visible?: boolean
  app?: boolean
  subs?: boolean
  env?: Record<string, string>
  ntfy?: boolean
}
async function world(opts: WorldOpts = {}) {
  if (opts.ntfy) sink = await ntfySink()
  relay = await startTestRelay({
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(sink
      ? { ntfyFetch: (_u: string | URL | Request, init?: RequestInit) => fetch(sink?.url as string, init) }
      : {}),
  })
  const r = relay
  if (opts.subs !== false) r.runtime.store.putSub(SUB)
  const k = kit(r)
  const app = opts.app === false ? null : await k.connectedApp({ visible: opts.visible ?? true })
  const connectBridge = async () =>
    k
      .bridge({ ...(app ? { pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } } : {}), autoReply: false })
      .connect()
  const bridge = await connectBridge()
  return { r, k, app, bridge, connectBridge }
}
const gone = async (b: FakeBridge) => {
  await b.close()
  await waitFor(() => !relay?.relay.services.bus.bridgeOnline(), 3000, 'relay sees the bridge gone')
}
const bodies = (r: TestRelay) => r.transport.sent.map((s) => s.payload.notification.body)
const status = async (r: TestRelay) => {
  const res = await fetch(`${r.httpBase}/api/status`, { headers: r.appHeaders })
  return { code: res.status, json: (await res.json()) as unknown }
}
const sendBeat = (b: FakeBridge, beat: HealthBeatT) => b.send({ type: 'health.beat', beat })
const quietConfig = (b: FakeBridge) =>
  b.send({
    type: 'config.sync',
    config: { ...DEFAULT_AGENT_CONFIG, rev: 1, quiet_window: { start: '22:00', end: '07:00' } },
    rev: 1,
  })

describe('V2.3 bridge rule', () => {
  it('gone 5 min -> one session_stopped even with a visible socket; back -> one mac_back; gone again 30 min later -> nothing', async () => {
    const clock = fakeClock(START)
    const { r, connectBridge, bridge } = await world({ clock, visible: true })
    await gone(bridge)
    await advance(clock, 4 * 60_000)
    expect(r.transport.sent).toHaveLength(0)
    await advance(clock, 2 * 60_000)
    await waitFor(() => bodies(r).length >= 1, 3000, 'session_stopped')
    await sleep(150)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(1), { timeout: 10_000 })
    expect(bodies(r)[0]).toContain('Mac session stopped')
    expect(r.transport.sent[0]?.payload.notification.navigate).toBe('/settings/health')
    // back: one mac_back
    const b2 = await connectBridge()
    await advance(clock, 30_000)
    await waitFor(() => bodies(r).length === 2, 3000, 'mac_back')
    expect(bodies(r)[1]).toContain('Mac is back')
    // 30 min later gone again: the min gap (120 min) holds it
    await advance(clock, 30 * 60_000)
    await gone(b2)
    await advance(clock, 7 * 60_000)
    await sleep(200)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(2), { timeout: 10_000 })
  })

  it('gone inside the quiet window: nothing in the window, one push when it ends if still gone', async () => {
    const clock = fakeClock('2026-10-29T06:50:00.000Z')
    const { r, app, bridge } = await world({ clock, visible: false })
    quietConfig(bridge)
    await waitFor(() => app?.rec.frames.some((x) => x.raw.type === 'config.sync') ?? false, 3000, 'config')
    await gone(bridge)
    await advance(clock, 6 * 60_000) // 06:56, inside the window
    await sleep(200)
    expect(r.transport.sent).toHaveLength(0)
    await advance(clock, 6 * 60_000) // 07:02, window over
    await waitFor(() => bodies(r).length === 1, 3000, 'held push')
    await sleep(200)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(1), { timeout: 10_000 })
    expect(bodies(r)[0]).toContain('Mac session stopped')
  })

  it('gone in the quiet window and back before it ends: nothing at all (no stopped, no back)', async () => {
    const clock = fakeClock('2026-10-29T06:50:00.000Z')
    const { r, app, bridge, connectBridge } = await world({ clock, visible: false })
    quietConfig(bridge)
    await waitFor(() => app?.rec.frames.some((x) => x.raw.type === 'config.sync') ?? false, 3000, 'config')
    await gone(bridge)
    await advance(clock, 6 * 60_000)
    await connectBridge()
    await advance(clock, 10 * 60_000)
    await sleep(200)
    expect(r.transport.sent).toHaveLength(0)
  })

  it('a mac_back that lands inside the quiet window is not sent', async () => {
    const clock = fakeClock('2026-10-29T21:50:00.000Z')
    const { r, app, bridge, connectBridge } = await world({ clock, visible: false })
    quietConfig(bridge)
    await waitFor(() => app?.rec.frames.some((x) => x.raw.type === 'config.sync') ?? false, 3000, 'config')
    await gone(bridge)
    await advance(clock, 6 * 60_000) // 21:56, outside the window: the down push goes out
    await waitFor(() => bodies(r).length === 1, 3000, 'down push')
    await advance(clock, 10 * 60_000) // 22:06, inside the window
    await connectBridge()
    await advance(clock, 2 * 60_000)
    await sleep(200)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(1), { timeout: 10_000 })
  })

  it('the rule survives a redeploy: same store, new hub, one push per outage', async () => {
    const clock = fakeClock(START)
    const w = await world({ clock, visible: false })
    await gone(w.bridge)
    await advance(clock, 6 * 60_000)
    await waitFor(() => bodies(w.r).length === 1, 3000, 'down push')
    const dir = w.r.dir
    await w.r.stopKeepData()
    const later = fakeClock(new Date(clock.now()).toISOString())
    relay = await startTestRelay({ clock: later, dir })
    relay.runtime.store.putSub(SUB)
    await advance(later, 10 * 60_000)
    await sleep(200)
    expect(relay.transport.sent).toHaveLength(0) // the flags were persisted: no second down push
  })
})

describe('L1 master switch', () => {
  it('notifications.master=false silences chat, not health alarms', async () => {
    const clock = fakeClock(START)
    const { r, app, bridge } = await world({ clock, visible: false })
    bridge.send({
      type: 'config.sync',
      config: {
        ...DEFAULT_AGENT_CONFIG,
        rev: 1,
        notifications: { ...DEFAULT_AGENT_CONFIG.notifications, master: false },
      },
      rev: 1,
    })
    await waitFor(() => app?.rec.frames.some((x) => x.raw.type === 'config.sync') ?? false, 3000, 'config')
    await gone(bridge)
    await advance(clock, 6 * 60_000)
    await waitFor(() => bodies(r).length === 1, 3000, 'alarm despite master off')
  })
})

describe('V2.3 mod rule', () => {
  it('quiet 11 min -> one mod_quiet (visible or not), not repeated', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world({ clock, visible: true })
    sendBeat(
      bridge,
      beatOf({ mod: { state: 'quiet', last_seen: new Date(clock.now() - 11 * 60_000).toISOString(), expected: true } }),
    )
    // the quiet spell counts from the first beat of this connection (a sleeping Mac must not trip it): 11 min of silence
    await advance(clock, 30_000)
    expect(r.transport.sent).toHaveLength(0)
    await advance(clock, 11 * 60_000)
    await waitFor(() => bodies(r).length === 1, 5000, 'mod_quiet')
    expect(bodies(r)[0]).toContain('mod stopped reporting')
    await advance(clock, 20 * 60_000)
    await sleep(200)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(1), { timeout: 10_000 })
  })

  it('quiet 5 min, or a mod that is not expected, sends nothing', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world({ clock, visible: false })
    sendBeat(
      bridge,
      beatOf({ mod: { state: 'quiet', last_seen: new Date(clock.now() - 5 * 60_000).toISOString(), expected: true } }),
    )
    await sleep(200)
    expect(r.transport.sent).toHaveLength(0)
    sendBeat(bridge, beatOf({ mod: { state: 'absent', last_seen: null, expected: false } }))
    await advance(clock, 30 * 60_000)
    expect(r.transport.sent).toHaveLength(0)
  })
})

describe('V2.3 status', () => {
  it('is session-guarded and schema-valid, and carries the last beat without the bridge block', async () => {
    const { r, bridge } = await world()
    const noSession = await fetch(`${r.httpBase}/api/status`)
    expect(noSession.status).toBe(401)
    sendBeat(bridge, beatOf())
    await waitFor(() => r.runtime.store.getState('health_beat') !== null, 3000, 'beat stored')
    const s = await status(r)
    expect(s.code).toBe(200)
    const parsed = HealthStatus.parse(s.json)
    expect(parsed.relay_ok).toBe(true)
    expect(parsed.bridge.online).toBe(true)
    expect(parsed.mod.state).toBe('alive')
    expect(parsed.push.subscriptions).toBe(1)
    expect(parsed.beat?.tts).toBe(true)
    expect(JSON.stringify(s.json)).not.toContain('"bridge":{"version"')
  })

  it('limits: the relay reports its own numbers (buffer days, upload cap, voice minutes) and nothing else', async () => {
    const { r } = await world({
      env: { BUFFER_DAYS: '3', MEDIA_MAX_MB: '20', VOICE_DAILY_MAX_MIN: '45', VOICE_SESSION_MAX_MIN: '15' },
    })
    const s = await status(r)
    const parsed = HealthStatus.parse(s.json)
    expect(parsed.limits).toEqual({
      buffer_days: 3,
      upload_max_mb: 20,
      voice_daily_max_min: 45,
      voice_session_max_min: 15,
    })
    expect(Object.keys((s.json as { limits: object }).limits).sort()).toEqual(
      ['buffer_days', 'upload_max_mb', 'voice_daily_max_min', 'voice_session_max_min'].sort(),
    )
  })

  it('limits: an app that does not know the field, or a status without it, still parses (old relay, old app)', () => {
    const { limits: _l, ...older } = HealthStatus.parse({
      at: START,
      relay_ok: true,
      relay_problems: [],
      relay: { version: '1', up_since: START },
      mac_problems: [],
      bridge: { online: true, last_seen: START, down_since: null },
      mod: { state: 'alive', last_seen: START, expected: true },
      push: { subscriptions: 1, last_ok_at: null, last_error_at: null },
      ntfy: false,
      limits: { buffer_days: 7 },
    })
    expect(HealthStatus.parse(older).limits).toBeUndefined()
  })

  it('permission_relay_declared rides the beat through to the status; an older bridge leaves it out; junk degrades that field only', async () => {
    const { r, bridge } = await world()
    sendBeat(bridge, beatOf())
    await waitFor(() => r.runtime.store.getState('health_beat') !== null, 3000, 'beat stored')
    expect(HealthStatus.parse((await status(r)).json).beat).not.toHaveProperty('permission_relay_declared')
    sendBeat(bridge, beatOf({ permission_relay_declared: false }))
    await vi.waitFor(
      async () => expect(HealthStatus.parse((await status(r)).json).beat?.permission_relay_declared).toBe(false),
      { timeout: 5000 },
    )
    sendBeat(bridge, beatOf({ permission_relay_declared: true }))
    await vi.waitFor(
      async () => expect(HealthStatus.parse((await status(r)).json).beat?.permission_relay_declared).toBe(true),
      { timeout: 5000 },
    )
    bridge.send({
      type: 'health.beat',
      beat: { ...beatOf({ tts: false }), permission_relay_declared: 'maybe' } as never,
    })
    await vi.waitFor(async () => expect(HealthStatus.parse((await status(r)).json).beat?.tts).toBe(false), {
      timeout: 5000,
    })
    expect(HealthStatus.parse((await status(r)).json).beat).not.toHaveProperty('permission_relay_declared')
  })

  it('permission_relay_declared is never read from a previous process: gone, or reconnected before its first beat, it is left out', async () => {
    const { r, bridge, connectBridge } = await world()
    sendBeat(bridge, beatOf({ permission_relay_declared: true }))
    await vi.waitFor(
      async () => expect(HealthStatus.parse((await status(r)).json).beat?.permission_relay_declared).toBe(true),
      { timeout: 5000 },
    )
    await gone(bridge)
    expect(HealthStatus.parse((await status(r)).json).beat).not.toHaveProperty('permission_relay_declared')
    const b2 = await connectBridge() // a new process, no beat yet
    await waitFor(() => relay?.relay.services.bus.bridgeOnline() === true, 3000, 'bridge back')
    expect(HealthStatus.parse((await status(r)).json).beat).not.toHaveProperty('permission_relay_declared')
    sendBeat(b2, beatOf({ permission_relay_declared: false }))
    await vi.waitFor(
      async () => expect(HealthStatus.parse((await status(r)).json).beat?.permission_relay_declared).toBe(false),
      { timeout: 5000 },
    )
  })

  it('bridge offline 6 h -> relay_ok:true, mac_problems lists bridge_offline, mod is unknown', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world({ clock, app: false })
    sendBeat(bridge, beatOf())
    await sleep(100)
    await gone(bridge)
    clock.advance(6 * 3600_000)
    const parsed = HealthStatus.parse((await status(r)).json)
    expect(parsed.relay_ok).toBe(true)
    expect(parsed.relay_problems).toEqual([])
    expect(parsed.mac_problems).toContain('bridge_offline')
    expect(parsed.mod.state).toBe('unknown')
    expect(parsed.bridge.online).toBe(false)
    expect(parsed.bridge.down_since).not.toBeNull()
  })

  it('0 subscriptions with ntfy on -> relay_ok:true; ntfy off -> no_alert_path', async () => {
    const off = await world({ subs: false })
    const a = HealthStatus.parse((await status(off.r)).json)
    expect(a.relay_ok).toBe(false)
    expect(a.relay_problems).toEqual(['no_alert_path'])
    expect(a.ntfy).toBe(false)
    await relay?.stop()
    relay = null
    const on = await world({ subs: false, ntfy: true, env: { ALERT_NTFY_URL: 'https://ntfy.example.com/topic' } })
    const b = HealthStatus.parse((await status(on.r)).json)
    expect(b.relay_ok).toBe(true)
    expect(b.ntfy).toBe(true)
    expect(JSON.stringify(b)).not.toContain('ntfy.example.com')
  })

  it('a push subscription that cannot be read does not break the status, and does not count as a way to alert', async () => {
    const { r } = await world({ subs: false })
    const spoil = (endpoint: string) =>
      r.runtime.store.db
        .prepare('insert into core_push_subs (endpoint, sub, created_at) values (?, ?, ?)')
        .run(endpoint, Buffer.from('not sealed by this relay'), Date.now())
    spoil('https://push.example.com/send/spoiled')
    const alone = await status(r)
    expect(alone.code).toBe(200)
    expect(HealthStatus.parse(alone.json).relay_problems).toEqual(['no_alert_path'])
    r.runtime.store.putSub(SUB)
    const beside = await status(r)
    expect(beside.code).toBe(200)
    expect(HealthStatus.parse(beside.json).relay_problems).toEqual([])
  })

  it('mod_quiet shows up in mac_problems', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world({ clock })
    sendBeat(
      bridge,
      beatOf({ mod: { state: 'quiet', last_seen: new Date(clock.now() - 11 * 60_000).toISOString(), expected: true } }),
    )
    await sleep(100)
    await advance(clock, 11 * 60_000) // the spell counts from this connection's first beat
    const parsed = HealthStatus.parse((await status(r)).json)
    expect(parsed.mac_problems).toContain('mod_quiet')
    expect(parsed.mod.state).toBe('quiet')
  })
})

describe('V2.3 ntfy and the test button', () => {
  it('the sink gets only fixed strings: Title is the agent, Tags warning, the body is the template text', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world({
      clock,
      visible: false,
      ntfy: true,
      env: { ALERT_NTFY_URL: 'https://ntfy.example.com/topic', ALERT_NTFY_TOKEN: 'tok_secret' },
    })
    await gone(bridge)
    await advance(clock, 6 * 60_000)
    await waitFor(() => (sink?.hits.length ?? 0) === 1, 5000, 'ntfy hit')
    const hit = sink?.hits[0]
    expect(hit?.body).toContain('Mac session stopped')
    expect(hit?.headers.title).toBe(DEFAULT_AGENT_CONFIG.agent.name)
    expect(hit?.headers.tags).toBe('warning')
    expect(hit?.headers.authorization).toBe('Bearer tok_secret')
    expect(hit?.body).not.toMatch(/general|thread|\//)
    expect(r.transport.sent).toHaveLength(1)
  })

  it('a push that has no subscription still reaches ntfy', async () => {
    const clock = fakeClock(START)
    const { bridge } = await world({
      clock,
      subs: false,
      ntfy: true,
      env: { ALERT_NTFY_URL: 'https://ntfy.example.com/topic' },
    })
    await gone(bridge)
    await advance(clock, 6 * 60_000)
    await waitFor(() => (sink?.hits.length ?? 0) === 1, 5000, 'ntfy hit')
  })

  it('POST /api/health/test: 200 with what happened; needs a session (the csrf rule is swept in auth/csrf-routes.test.ts); it sends one test alert down every path, ignoring the rules', async () => {
    const { r } = await world({
      visible: true,
      ntfy: true,
      env: { ALERT_NTFY_URL: 'https://ntfy.example.com/topic' },
    })
    const no = await fetch(`${r.httpBase}/api/health/test`, { method: 'POST' })
    expect(no.status).toBe(401)
    const res = await fetch(`${r.httpBase}/api/health/test`, { method: 'POST', headers: r.appHeaders })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ push: { sent: 1, ok: 1 }, ntfy: 'sent' })
    expect(r.transport.sent).toHaveLength(1) // visible socket or not
    expect(r.transport.sent[0]?.payload.notification.navigate).toBe('/settings/health')
    await waitFor(() => (sink?.hits.length ?? 0) === 1, 3000, 'ntfy test hit')
    expect(sink?.hits[0]?.body).toBe('Test alert from Talos')
  })

  it('the relay advertises health/1 with the bridge offline', async () => {
    const { r, app, bridge } = await world({ app: true })
    await gone(bridge)
    const fresh = await kit(r).connectedApp()
    const ready = fresh.rec.frames.find((f) => f.raw.type === 'ready')
    expect((ready?.raw.features as string[] | undefined) ?? []).toContain('health/1')
    expect(app).toBeTruthy()
  })
})
