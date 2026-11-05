// D40: right after a relay redeploy the hub has not written the bridge's close time, so the stored "last seen" can be days
// old for a bridge that is only waiting out its reconnect backoff. Presence must not report it as gone for longer than this
// process has been up, or the app says "probably asleep, last seen 3 d ago" on a healthy Mac. The REAL hub, an injected clock.
import { fakeClock, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

const relays: TestRelay[] = []
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
})

describe('presence after a relay redeploy', () => {
  it('does not report a bridge gone since before this process started', async () => {
    const day = 24 * 3600_000
    const c = fakeClock('2026-10-27T08:00:00.000Z')
    const a = await startTestRelay({ clock: c })
    relays.push(a)
    const b = await kit(a).bridge({ autoReply: false }).connect()
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData() // a stopping hub writes no close time: bridge_last_seen is still the 2026-10-27 hello
    await b.close().catch(() => undefined)
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now() + 3 * day).toISOString())
    const r2 = await startTestRelay({ clock: c2, dir, bridgeKey: key })
    relays.push(r2)
    await sleep(50)
    const p = r2.runtime.hub.presence()
    expect(p.bridge_online).toBe(false)
    // not "3 days ago": no earlier than this process' start
    expect(Date.parse(p.last_seen as string)).toBeGreaterThanOrEqual(c2.now())
    // and it keeps counting from then, so a Mac that stays away is still honestly "asleep" later
    c2.advance(10 * 60_000)
    expect(Date.parse(r2.runtime.hub.presence().last_seen as string)).toBeLessThan(c2.now() - 5 * 60_000)
  })
})
