// A relay that stops and starts again in place (the same Hub object, as the restart journey and the replay harness do) still
// sends a scheduler alert that arrived during quiet hours once the window ends.
import { FakeScheduler, fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

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

describe('a schedule alert after a same-hub stop and start', () => {
  it('held through quiet hours, it is sent once when the window ends', async () => {
    const clock = fakeClock('2026-10-28T23:00:00.000Z')
    relay = await startTestRelay({ clock })
    const r = relay
    const k = kit(r)
    const app = await k.connectedApp({ visible: false })
    r.runtime.store.putSub({ endpoint: 'https://push.example.com/send/9', keys: { p256dh: 'a', auth: 'b' } })
    const connect = () =>
      k
        .bridge({
          pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
          scheduler: new FakeScheduler({ tz: 'UTC', now: new Date().toISOString() }),
          autoReply: false,
        })
        .connect()
    const first = await connect()
    first.send({
      type: 'config.sync',
      config: { ...DEFAULT_AGENT_CONFIG, rev: 1, quiet_window: { start: '22:00', end: '07:00' } },
      rev: 1,
    })
    await waitFor(() => r.runtime.hub.agentConfig()?.quiet_window != null, 3000, 'quiet window set')

    r.runtime.hub.stop()
    r.runtime.hub.start()

    const bridge = await connect()
    bridge.send({
      type: 'schedule.status',
      health: health(),
      changed: [],
      removed: [],
      alert: { kind: 'job_failed', key: 'job-1:2026-10-28' },
    })
    const failed = () => r.transport.sent.filter((x) => x.payload.notification.body === 'A scheduled job failed')
    await advance(clock, 60_000)
    expect(failed()).toHaveLength(0) // held: it is 23:01

    await advance(clock, 8 * 3_600_000, 120_000) // past 07:00
    await waitFor(() => failed().length === 1, 3000, 'one push after the window')
    await advance(clock, 5 * 60_000)
    expect(failed()).toHaveLength(1)
  })
})
