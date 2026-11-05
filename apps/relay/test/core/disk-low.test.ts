// D11, relay part: the bridge's beat carries free disk bytes; the watchdog pushes `disk_low` once per episode, holds it
// through the quiet window, and /api/status still parses for an older web client (no new enum value).
import {
  DISK_LOW_BYTES,
  DISK_RECOVERED_BYTES,
  type HealthBeatT,
  HealthStatus,
  MacProblem,
  RelayProblem,
} from '@talos-app/protocol'
import { type FakeBridge, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
const SUB = { endpoint: 'https://push.example.com/send/disk', keys: { p256dh: 'a', auth: 'b' } }
const START = '2026-10-31T15:00:00.000Z' // 08:00 in the UTC-7 zone; UTC is the default timezone, no quiet window
const GB = 1024 ** 3

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const beatOf = (free: number | undefined): HealthBeatT => ({
  bridge: { version: '0.4.1', started_at: START },
  mod: { state: 'alive', last_seen: START, expected: true },
  tts: true,
  stt: true,
  sqlite: { fts5: true },
  ...(free !== undefined ? { disk_free_bytes: free } : {}),
})

async function world(clock: ReturnType<typeof fakeClock>) {
  relay = await startTestRelay({ clock })
  const r = relay
  r.runtime.store.putSub(SUB)
  const k = kit(r)
  const app = await k.connectedApp({ visible: false })
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
    .connect()
  return { r, app, bridge }
}
const bodies = (r: TestRelay) => r.transport.sent.map((s) => s.payload.notification.body)
// the relay takes the beat on a real socket; give it a moment before the fake clock moves on to the next poll
const beat = async (b: FakeBridge, free: number | undefined) => {
  b.send({ type: 'health.beat', beat: beatOf(free) })
  await sleep(100)
}
const status = async (r: TestRelay) =>
  (await (await fetch(`${r.httpBase}/api/status`, { headers: r.appHeaders })).json()) as unknown

describe('D11 disk_low', () => {
  it('under the line: one push with fixed text to /settings/health; not repeated while low', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world(clock)
    await beat(bridge, 500 * 1024 ** 2)
    await advance(clock, 20_000)
    await waitFor(() => bodies(r).length === 1, 5000, 'disk_low')
    expect(bodies(r)[0]).toBe(`${DEFAULT_AGENT_CONFIG.agent.name}'s Mac disk is nearly full`)
    expect(r.transport.sent[0]?.payload.notification.navigate).toBe('/settings/health')
    expect(JSON.stringify(r.transport.sent[0]?.payload)).not.toContain(String(500 * 1024 ** 2)) // no byte count
    for (let i = 0; i < 4; i++) {
      await beat(bridge, (400 - i) * 1024 ** 2)
      await advance(clock, 60_000)
    }
    await sleep(200)
    await vi.waitFor(() => expect(bodies(r)).toHaveLength(1), { timeout: 10_000 })
  })

  it('hovering between the low and recovered lines does not push twice; recovering and filling again does', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world(clock)
    await beat(bridge, 1 * GB)
    await advance(clock, 20_000)
    await waitFor(() => bodies(r).length === 1, 5000, 'first disk_low')
    await beat(bridge, DISK_LOW_BYTES + GB) // above the low line, below the recovered line: still the same episode
    await advance(clock, 60_000)
    await beat(bridge, 1 * GB)
    await advance(clock, 60_000)
    await sleep(200)
    expect(bodies(r)).toHaveLength(1)
    await beat(bridge, DISK_RECOVERED_BYTES + GB) // cleaned up: the episode ends
    await advance(clock, 60_000)
    await beat(bridge, 1 * GB) // fills again: a new episode
    await advance(clock, 60_000)
    await waitFor(() => bodies(r).length === 2, 5000, 'second disk_low')
  })

  it('plenty of space, or a bridge too old to report it, sends nothing', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world(clock)
    await beat(bridge, 50 * GB)
    await advance(clock, 60_000)
    await beat(bridge, undefined)
    await advance(clock, 60_000)
    await sleep(200)
    expect(r.transport.sent).toHaveLength(0)
  })

  it('held by the quiet window; sent when it ends if the disk is still low', async () => {
    const clock = fakeClock('2026-10-31T06:50:00.000Z')
    const { r, app, bridge } = await world(clock)
    bridge.send({
      type: 'config.sync',
      config: { ...DEFAULT_AGENT_CONFIG, rev: 1, quiet_window: { start: '22:00', end: '07:00' } },
      rev: 1,
    })
    await waitFor(() => app.rec.frames.some((x) => x.raw.type === 'config.sync'), 3000, 'config')
    await beat(bridge, 1 * GB)
    await advance(clock, 5 * 60_000) // 06:55, inside the window
    await sleep(200)
    expect(r.transport.sent).toHaveLength(0)
    await beat(bridge, 1 * GB)
    await advance(clock, 6 * 60_000) // 07:01, window over
    await waitFor(() => bodies(r).length === 1, 5000, 'held disk_low')
  })

  it('/api/status passes the number through and adds no enum value an older web client would reject', async () => {
    const clock = fakeClock(START)
    const { r, bridge } = await world(clock)
    await beat(bridge, 1 * GB)
    await sleep(150)
    await advance(clock, 20_000)
    const raw = (await status(r)) as {
      beat?: { disk_free_bytes?: number }
      relay_problems: string[]
      mac_problems: string[]
    }
    expect(raw.beat?.disk_free_bytes).toBe(1 * GB)
    // every enum value in the reply is one the shipped enums (and so an older client) already know
    for (const p of raw.relay_problems) expect(RelayProblem.options).toContain(p)
    for (const p of raw.mac_problems) expect(MacProblem.options).toContain(p)
    expect(RelayProblem.options).toEqual(['storage_full', 'no_alert_path'])
    expect(MacProblem.options).toEqual(['bridge_offline', 'mod_quiet'])
    expect(HealthStatus.parse(raw).beat?.disk_free_bytes).toBe(1 * GB)
  })
})
