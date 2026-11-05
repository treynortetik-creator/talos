// Adversarial review of PR #47 (WP-V1 health alarms). The REAL relay (hub + HealthWatch + CorePush) over WebSocket, a
// FakeBridge behind, a recording push transport, a local ntfy sink, an injected clock. The goal under test: the owner hears
// that his Mac / bridge / session died exactly once per outage, never spammed, never a silent gap.
//
// Tests in "FAILS on PR #47" are expected to fail on feat/v2-v1 and pass once the finding is fixed. Tests in "holds" are
// probes that pass today and pin behaviour a fix must not break.
import { createServer, type Server } from 'node:http'
import type { HealthBeatT } from '@talos-app/protocol'
import { type FakeBridge, type FakeClock, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 120_000 })

/** Advance while a bridge is connected: steps well under the hub's DEAD_MS (75 s) so pongs land between steps. */
const advanceLive = async (clock: FakeClock, ms: number) => {
  for (let left = ms; left > 0; left -= 20_000) {
    clock.advance(Math.min(20_000, left))
    await sleep(25)
  }
}

const SUB = { endpoint: 'https://push.example.com/send/review', keys: { p256dh: 'a', auth: 'b' } }
// A fixed UTC-7 zone (no DST), as a user in a no-DST zone would have it, with a quiet window of 20:30-04:00 local.
const QUIET = { start: '20:30', end: '04:00' }
/** UTC-7 wall time on 2026-10-30 (or the next day when `nextDay`) as an ISO instant. */
const utc7 = (hhmm: string, nextDay = false) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  const base = Date.UTC(2026, 9, nextDay ? 31 : 30, h + 7, m) // local + 7 h = UTC
  return new Date(base).toISOString()
}

const relays: TestRelay[] = []
let sink: Sink | null = null
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
  await sink?.close()
  sink = null
})

type Sink = { url: string; hits: string[]; close(): Promise<void> }
async function ntfySink(): Promise<Sink> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      hits.push(body)
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

async function relayOn(clock: FakeClock, extra: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay({ clock, ...extra })
  relays.push(r)
  r.runtime.store.putSub(SUB)
  return r
}
const bridgeFor = (r: TestRelay) => kit(r).bridge({ autoReply: false }).connect()
const gone = async (r: TestRelay, b: FakeBridge) => {
  await b.close()
  await waitFor(() => !r.relay.services.bus.bridgeOnline(), 3000, 'relay sees the bridge gone')
}
const bodies = (r: TestRelay) => r.transport.sent.map((s) => s.payload.notification.body)
const count = (r: TestRelay, re: RegExp) => bodies(r).filter((b) => re.test(b)).length
const STOPPED = /Mac session stopped/
const BACK = /Mac is back/
const MOD = /mod stopped reporting/
const fixedUtcMinus7Config = (b: FakeBridge, quiet: typeof QUIET | null = QUIET) =>
  b.send({
    type: 'config.sync',
    config: { ...DEFAULT_AGENT_CONFIG, rev: 1, timezone: 'Etc/GMT+7', quiet_window: quiet },
    rev: 1,
  })
const configStored = (r: TestRelay) =>
  waitFor(() => r.runtime.hub.agentConfig()?.timezone === 'Etc/GMT+7', 3000, 'config stored')
const beat = (mod: HealthBeatT['mod']): HealthBeatT => ({
  bridge: { version: '0.4.1', started_at: '2026-10-30T00:00:00.000Z' },
  mod,
  tts: true,
  stt: true,
  sqlite: { fts5: true },
})

describe('FAILS on PR #47', () => {
  it('F1 relay redeploy with a long-connected bridge: no "session stopped" while the bridge reconnects', async () => {
    // A routine Railway redeploy. The bridge has been connected since morning; the relay restarts; the bridge's backoff
    // (1, 2, 5, 10, 30 s) brings it back ~20-50 s later. `bridge_last_seen` was last written at the morning hello (a
    // stopping hub skips the close write), so the new HealthWatch thinks the bridge has been gone for hours and fires at
    // its first 15 s poll, followed by a "Mac is back". Two false pushes per redeploy.
    const c = fakeClock(utc7('08:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await advanceLive(c, 3 * 3600_000) // connected all morning
    expect(a.relay.services.bus.bridgeOnline()).toBe(true)
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    await b.close().catch(() => undefined)
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    await advance(c2, 30_000, 5_000) // the bridge is still in its reconnect backoff
    await bridgeFor(r2)
    await advance(c2, 60_000, 5_000)
    await sleep(150)
    expect(bodies(r2)).toEqual([])
  })

  it('F2 an outage suppressed by the min gap is never alerted, however long it lasts (silent gap)', async () => {
    // 10:00 dies -> 10:05 "stopped"; 10:10 back -> "back"; 10:40 dies for good. The gap (120 min) marks the outage
    // handled and nothing ever re-looks at it: 24 h later the last thing on his phone is "Mac is back".
    const c = fakeClock(utc7('10:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    await gone(r, b)
    await advance(c, 6 * 60_000)
    await waitFor(() => count(r, STOPPED) === 1, 3000, 'first stopped')
    b = await bridgeFor(r)
    await advance(c, 30_000, 15_000)
    await waitFor(() => count(r, BACK) === 1, 3000, 'back')
    await advance(c, 30 * 60_000)
    await gone(r, b)
    await advance(c, 24 * 3600_000, 5 * 60_000) // dead all day (no quiet window configured here)
    await sleep(150)
    await vi.waitFor(() => expect(count(r, STOPPED)).toBe(2), { timeout: 10_000 }) // once the gap has run out, the still-ongoing outage gets its one push
  })

  it('F3 "stopped" at 19:00, back at 23:00 inside the quiet window: the "back" is dropped, not held to 04:00', async () => {
    // V2.3 rule 5: a Mac-side alert inside the window is held and re-evaluated at its end, sent if the condition holds.
    // The Mac is back at 04:00, so "Mac is back" is owed. Today `tick` clears down_pushed in the window and never sends:
    // the last push he saw says the Mac is dead.
    const c = fakeClock(utc7('18:50'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    fixedUtcMinus7Config(b)
    await configStored(r)
    await gone(r, b)
    await advance(c, 10 * 60_000)
    await waitFor(() => count(r, STOPPED) === 1, 3000, 'stopped at 18:56')
    await advance(c, 4 * 3600_000, 5 * 60_000) // 23:00 UTC-7
    b = await bridgeFor(r)
    await advanceLive(c, 5 * 3600_000 + 10 * 60_000) // past 04:00
    expect(r.relay.services.bus.bridgeOnline()).toBe(true)
    await sleep(150)
    await vi.waitFor(() => expect(count(r, BACK)).toBe(1), { timeout: 10_000 })
  })

  it('F4 mod_quiet false positive: the mod quiet spell is counted across the time the Mac was asleep', async () => {
    // Mac asleep 8 h (bridge offline). On wake the bridge reconnects first and its onReady beat says mod `quiet`,
    // last_seen = before sleep, because the mod has not re-synced yet (its hello backs off 1-16 s while the MCP server
    // comes up). The next 15 s relay poll sees "quiet for 8 h" and pushes "mod stopped reporting"; the alive beat lands
    // seconds later. Same after any Claude Code restart that took > MOD_QUIET_MIN.
    const c = fakeClock(utc7('06:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    b.send({ type: 'health.beat', beat: beat({ state: 'alive', last_seen: utc7('06:00'), expected: true }) })
    await sleep(100)
    await gone(r, b)
    await advance(c, 8 * 3600_000, 10 * 60_000)
    const before = c.now() - 8 * 3600_000
    b = await bridgeFor(r)
    b.send({
      type: 'health.beat',
      beat: beat({ state: 'quiet', last_seen: new Date(before).toISOString(), expected: true }),
    })
    await advance(c, 16_000, 2_000) // one relay poll
    b.send({
      type: 'health.beat',
      beat: beat({ state: 'alive', last_seen: new Date(c.now()).toISOString(), expected: true }),
    })
    await advance(c, 60_000, 5_000)
    await sleep(150)
    expect(count(r, MOD)).toBe(0)
  })

  it('F5 POST /api/health/test with nobody to alert answers 204, and the screen says "sent"', async () => {
    // 0 subscriptions and ntfy off (`no_alert_path`): the test button is the owner's one way to prove the path works,
    // and it reports success while nothing can arrive. It should say so (non-2xx, or a body naming the paths used).
    const c = fakeClock(utc7('12:00'))
    const r = await startTestRelay({ clock: c })
    relays.push(r)
    const res = await fetch(`${r.httpBase}/api/health/test`, { method: 'POST', headers: r.appHeaders })
    expect(r.transport.sent).toHaveLength(0)
    expect(res.status).not.toBe(204)
  })

  it('F6 two relay instances on one store each fire the same outage (flags are cached in memory)', async () => {
    // LOW: Railway does not overlap deploys of a service with a volume, so this needs two replicas or a manual run
    // against prod data. `tick` reads `this.st`, loaded once at construction, never the store.
    const c = fakeClock(utc7('10:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    const second = await relayOn(c, { dir: a.dir, bridgeKey: a.bridgeKey })
    await gone(a, b)
    await advance(c, 7 * 60_000, 10_000)
    await sleep(200)
    await vi.waitFor(() => expect(count(a, STOPPED) + count(second, STOPPED)).toBe(1), { timeout: 10_000 })
  })
})

describe('holds on PR #47 (probes that pass; a fix must keep them)', () => {
  it('H1 UTC-7 20:30-04:00 (UTC math): outage from 20:27 is held, one push at 04:00, nothing before', async () => {
    const c = fakeClock(utc7('20:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    fixedUtcMinus7Config(b)
    await configStored(r)
    await advanceLive(c, 27 * 60_000) // 20:27
    await gone(r, b)
    await advance(c, 7 * 3600_000 + 32 * 60_000, 5 * 60_000) // 03:59
    await sleep(100)
    expect(bodies(r)).toEqual([])
    await advance(c, 60_000, 15_000) // 04:00:xx
    await waitFor(() => count(r, STOPPED) === 1, 3000, 'held push at 04:00')
    await advance(c, 3600_000, 5 * 60_000)
    expect(bodies(r)).toHaveLength(1)
  })

  it('H2 held alarm whose outage ended at 03:50 sends nothing at 04:00, even after a 2-min blip at 03:58', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    fixedUtcMinus7Config(b)
    await configStored(r)
    await gone(r, b)
    await advance(c, 6 * 3600_000 + 50 * 60_000, 5 * 60_000) // 03:50
    b = await bridgeFor(r)
    await advance(c, 8 * 60_000, 15_000) // 03:58
    await gone(r, b)
    await advance(c, 3 * 60_000, 15_000) // 04:01: the blip is 3 min old
    b = await bridgeFor(r)
    await advanceLive(c, 30 * 60_000)
    await sleep(100)
    expect(bodies(r)).toEqual([])
  })

  it('H3 flapping bridge (up 10 s, down 60 s, x20) inside 5 min windows raises nothing', async () => {
    const c = fakeClock(utc7('12:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    for (let i = 0; i < 20; i++) {
      await gone(r, b)
      await advance(c, 60_000, 15_000)
      b = await bridgeFor(r)
      await advance(c, 10_000, 5_000)
    }
    await sleep(100)
    expect(bodies(r)).toEqual([])
  })

  it('H4 an outage after the min gap has run out is alerted (the guarantee the outbox.test edit dropped)', async () => {
    const c = fakeClock(utc7('09:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    await gone(r, b)
    await advance(c, 6 * 60_000)
    b = await bridgeFor(r)
    await advanceLive(c, 3 * 3600_000)
    expect(r.relay.services.bus.bridgeOnline()).toBe(true)
    await gone(r, b)
    await advance(c, 6 * 60_000)
    await waitFor(() => count(r, STOPPED) === 2, 3000, 'second outage, gap expired')
  })

  it('H5 ntfy plus web push: one ntfy hit and one web push per alarm, no hub duplicate', async () => {
    sink = await ntfySink()
    const s = sink
    const c = fakeClock(utc7('12:00'))
    const r = await relayOn(c, {
      env: { ALERT_NTFY_URL: 'https://ntfy.example.com/topic' },
      ntfyFetch: (_u, init) => fetch(s.url, init),
    })
    const b = await bridgeFor(r)
    await gone(r, b)
    await advance(c, 20 * 60_000, 15_000) // the hub's own 5-min timer also fires in here
    await sleep(200)
    await vi.waitFor(() => expect(s.hits).toHaveLength(1), { timeout: 10_000 })
    expect(count(r, STOPPED)).toBe(1)
  })

  it('H6 a beat with extra keys (a path) never reaches the store or /api/status', async () => {
    const c = fakeClock(utc7('12:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    b.send({
      type: 'health.beat',
      beat: { ...beat({ state: 'alive', last_seen: utc7('12:00'), expected: true }), path: '/home/example/secret.md' },
    })
    await sleep(200)
    const res = await fetch(`${r.httpBase}/api/status`, { headers: r.appHeaders })
    const text = await res.text()
    expect(text).not.toContain('/home/example')
    expect(r.runtime.store.getState('health_beat') ?? '').not.toContain('/home/example')
  })
})
