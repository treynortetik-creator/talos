// BUGHUNT (presence): right after a redeploy `GET /api/status` (the Health screen) reports the Mac as offline since the
// LAST HELLO BEFORE THE DEPLOY, which can be days ago, although the bridge is only waiting out its reconnect backoff.
// A stopping hub writes no close time (src/core/hub-bridge-conn.ts:89 returns early when stopped), so the stored
// `bridge_last_seen` is the old hello. `Hub.presence()` clamps it to this process' start (src/core/hub.ts:641-645), and so
// does the watchdog's own `downSince()` (src/core/health.ts:223-226), but `HealthWatch.status()` reads the raw value three
// times (src/core/health.ts:285, 287, 308): `mac_problems: ['bridge_offline']`, `down_since` and `last_seen` days old.
// Suggested fix: use `downSince()` in status(), or write `bridge_last_seen` in `Hub.stop()` when a bridge is connected.
import { fakeClock, sleep } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
const relays: TestRelay[] = []
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
})

it('the health status does not call a Mac that was online at the deploy "offline for 3 days"', async () => {
  const day = 24 * 3600_000
  const c = fakeClock('2026-10-27T08:00:00.000Z')
  const a = await startTestRelay({ clock: c })
  relays.push(a)
  const b = await kit(a).bridge({ autoReply: false }).connect() // hello at 08:00 on the 27th...
  c.advance(3 * day) // ...and the same socket is still up three days later
  expect(a.runtime.hub.bridgeOnline()).toBe(true)
  const { dir, bridgeKey } = a
  await a.stopKeepData() // the deploy
  await b.close().catch(() => undefined)
  relays.splice(relays.indexOf(a), 1)

  const r2 = await startTestRelay({ clock: c, dir, bridgeKey })
  relays.push(r2)
  await sleep(30)
  c.advance(20_000) // the bridge is still in its reconnect backoff, 20 s after boot
  const s = r2.runtime.health.status()
  expect(s.bridge.online).toBe(false)
  expect(r2.runtime.hub.presence().last_seen).not.toBeNull()
  // presence (the banner) is honest: not before this process started
  expect(Date.parse(r2.runtime.hub.presence().last_seen as string)).toBeGreaterThanOrEqual(c.now() - 60_000)
  // the Health screen is not: a Mac that was connected 20 s ago is "offline" with a 3-day-old time
  expect(s.mac_problems).not.toContain('bridge_offline')
  expect(Date.parse(s.bridge.down_since as string)).toBeGreaterThanOrEqual(c.now() - 60_000)
})
