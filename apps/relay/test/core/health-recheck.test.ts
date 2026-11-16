// Re-check of PR #47 after the review fixes (head 45063bd). Adversarial review of PR #47 (WP-V1 health alarms). The REAL relay (hub + HealthWatch + CorePush) over WebSocket, a
// FakeBridge behind, a recording push transport, a local ntfy sink, an injected clock. The goal under test: the owner hears
// that his Mac / bridge / session died exactly once per outage, never spammed, never a silent gap.
//
// Tests in "FAILS on PR #47" are expected to fail on feat/v2-v1 and pass once the finding is fixed. Tests in "holds" are
// probes that pass today and pin behaviour a fix must not break.
import { type FakeBridge, type FakeClock, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, advanceHeard, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 120_000 })

/** The relays started on each fake clock, so stepping one clock waits only on the bridges of that clock's relays. */
const onClock = new Map<TestRelay, FakeClock>()
/** Advance while a bridge is connected: each step waits for the bridge's pong (advanceHeard), never a fixed sleep. */
const advanceLive = (clock: FakeClock, ms: number) =>
  advanceHeard(
    clock,
    ms,
    relays.filter((r) => onClock.get(r) === clock),
  )

const SUB = { endpoint: 'https://push.example.com/send/review', keys: { p256dh: 'a', auth: 'b' } }
// A fixed UTC-5 zone (no DST), as a user in a no-DST zone would have it, with a quiet window of 22:00-06:00 local.
const QUIET = { start: '22:00', end: '06:00' }
/** UTC-5 wall time on 2026-10-30 (or the next day when `nextDay`) as an ISO instant. */
const utc5 = (hhmm: string, nextDay = false) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  const base = Date.UTC(2026, 9, nextDay ? 31 : 30, h + 5, m) // local + 5 h = UTC
  return new Date(base).toISOString()
}

const relays: TestRelay[] = []
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
})

async function relayOn(clock: FakeClock, extra: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay({ clock, ...extra })
  relays.push(r)
  onClock.set(r, clock)
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
const fixedUtcMinus5Config = (b: FakeBridge, quiet: typeof QUIET | null = QUIET) =>
  b.send({
    type: 'config.sync',
    config: { ...DEFAULT_AGENT_CONFIG, rev: 1, timezone: 'Etc/GMT+5', quiet_window: quiet },
    rev: 1,
  })
const configStored = (r: TestRelay) =>
  waitFor(() => r.runtime.hub.agentConfig()?.timezone === 'Etc/GMT+5', 3000, 'config stored')

describe('re-check: FAILS on 45063bd', () => {
  it('N1 "back" held overnight is lost if the Mac blips offline for a minute before 06:00', async () => {
    // stopped 18:56; back 23:00 (held: back_owed). 23:30 a one-minute network blip: the poll sees the bridge offline and
    // clears back_owed ("down again: the old back is stale"). The blip is far shorter than 5 min, so no new "stopped" will
    // ever be sent either. At 06:00 nothing goes out: the last push on his phone says the Mac is dead, and it is up.
    const c = fakeClock(utc5('18:50'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    fixedUtcMinus5Config(b)
    await configStored(r)
    await gone(r, b)
    await advance(c, 10 * 60_000)
    await waitFor(() => count(r, STOPPED) === 1, 3000, 'stopped at 18:56')
    await advance(c, 4 * 3600_000, 5 * 60_000) // 23:00
    b = await bridgeFor(r)
    await advanceLive(c, 30 * 60_000) // 23:30
    await gone(r, b)
    await advance(c, 60_000, 15_000) // a 1-min blip
    b = await bridgeFor(r)
    await advanceLive(c, 6 * 3600_000 + 39 * 60_000) // 06:10
    expect(r.relay.services.bus.bridgeOnline()).toBe(true)
    await sleep(150)
    await vi.waitFor(() => expect(bodies(r)).toEqual(["Talos's Mac session stopped", "Talos's Mac is back"]), {
      timeout: 10_000,
    })
  })

  it('N2 a relay redeploy at 01:00 while a "back" is held loses it (the new relay polls before the bridge reconnects)', async () => {
    const c = fakeClock(utc5('18:50'))
    const a = await relayOn(c)
    let b = await bridgeFor(a)
    fixedUtcMinus5Config(b)
    await configStored(a)
    await gone(a, b)
    await advance(c, 10 * 60_000)
    await waitFor(() => count(a, STOPPED) === 1, 3000, 'stopped')
    await advance(c, 4 * 3600_000, 5 * 60_000) // 23:00
    b = await bridgeFor(a)
    await advanceLive(c, 2 * 3600_000) // 01:00
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    await b.close().catch(() => undefined)
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    await advance(c2, 30_000, 5_000) // bridge in its reconnect backoff across the first poll
    await bridgeFor(r2)
    await advanceLive(c2, 5 * 3600_000 + 9 * 60_000 + 30_000) // 06:10
    await sleep(150)
    await vi.waitFor(() => expect(count(r2, BACK)).toBe(1), { timeout: 10_000 })
  })
})

describe('re-check: holds on 45063bd', () => {
  it('K1 an outage that starts 3 min before a redeploy is still alerted (grace delays, never drops)', async () => {
    const c = fakeClock(utc5('10:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await gone(a, b)
    await advance(c, 3 * 60_000, 15_000)
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    await advance(c2, 4 * 60_000, 15_000)
    expect(count(r2, STOPPED)).toBe(0) // grace: 5 min from relay start, not from the close
    await advance(c2, 2 * 60_000, 15_000)
    await waitFor(() => count(r2, STOPPED) === 1, 3000, 'alert after grace')
  })

  it('K2 bridge reconnects in the grace then dies 1 min later: alerted 5 min after that death', async () => {
    const c = fakeClock(utc5('10:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await advanceLive(c, 30 * 60_000)
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    await b.close().catch(() => undefined)
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    await advance(c2, 20_000, 5_000)
    const b2 = await bridgeFor(r2)
    await advanceLive(c2, 60_000)
    await gone(r2, b2)
    await advance(c2, 6 * 60_000, 15_000)
    await waitFor(() => count(r2, STOPPED) === 1, 3000, 'alert')
  })

  it('K3 deferred gap alert lands in the quiet window: held to 06:00, then one push', async () => {
    const c = fakeClock(utc5('20:00'))
    const r = await relayOn(c)
    let b = await bridgeFor(r)
    fixedUtcMinus5Config(b)
    await configStored(r)
    await gone(r, b)
    await advance(c, 6 * 60_000) // stopped 20:05
    b = await bridgeFor(r)
    await advanceLive(c, 10 * 60_000) // back 20:16
    await gone(r, b) // dies for the night at ~20:16: the gap runs out 22:05, inside the window
    await advance(c, 9 * 3600_000 + 30 * 60_000, 5 * 60_000) // 05:46
    expect(count(r, STOPPED)).toBe(1)
    await advance(c, 20 * 60_000, 15_000) // 06:06
    await waitFor(() => count(r, STOPPED) === 2, 3000, 'held deferred alert')
    expect(bodies(r)).toHaveLength(3) // stopped, back, stopped
  })
})
