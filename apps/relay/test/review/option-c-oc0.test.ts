// Independent review of PR #63 (Option C WP-OC0): the REAL relay hub with every module. The PR's docs say
// `thread.session.control` is "app → relay → bridge, signed ... The relay only passes it through" and that the relay
// "keeps the last [workers.status] for ready.workers_status". No relay file changed, so both claims are tested here.
// REVIEW-FAIL tests fail on 9b0aa80.
import { sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const status = () => ({
  supported: true,
  supervisor_online: true,
  threads: [{ thread_id: 'general', state: 'parked' }],
  governor: { state: 'ok' },
  at: new Date().toISOString(),
})

describe('review OC0: relay pass-through for the Option C frames', () => {
  it('REVIEW-FAIL: a signed thread.session.control reaches the bridge and the app gets an ack (or an error), never silence', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const sent = await a.sendSchedule('thread.session.control', {
      control_id: (await import('@talos-app/protocol')).newUlid(),
      thread_id: 'general',
      action: 'park',
    })
    const answered = () => [...a.rec.of('ack', 'in'), ...a.rec.of('error', 'in')].some((f) => f.ref === sent.id)
    await waitFor(answered, 4000, 'an ack or error for the control')
    expect(answered()).toBe(true)
    // the ack reaches the app on its own socket and can beat the bridge socket's recording of the frame
    await waitFor(
      () => b.count('thread.session.control', sent.id as string) > 0,
      4000,
      'the frame on the bridge socket',
    )
    expect(b.count('thread.session.control', sent.id as string)).toBe(1)
  })

  it('REVIEW-FAIL: workers.status from the bridge reaches apps, and a reconnecting app gets it in ready', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'workers.status', status: status() })
    await waitFor(() => a.rec.of('workers.status', 'in').length > 0, 4000, 'workers.status at the app')
    await sleep(200) // the first frame has landed: give a duplicate time to arrive before asserting exactly one
    expect(a.rec.of('workers.status', 'in')).toHaveLength(1)
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.workers_status).toMatchObject({ supported: true })
  })

  it('control: an ordinary session.state still reaches apps (the harness works)', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({
      type: 'session.state',
      state: { session_id: 's1', source: 'mod', capabilities: [], rate_limits: [], surfaces: [], at: status().at },
    })
    await waitFor(() => a.rec.of('session.state', 'in').length > 0, 4000, 'session.state at the app')
    expect(a.rec.of('session.state', 'in')).toHaveLength(1)
  })
})
