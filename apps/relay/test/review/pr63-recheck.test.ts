// Independent re-review of PR #63 (Option C WP-OC0) at b6d3ff8, on the REAL relay hub: a thread session's
// session.state is kept per thread and never replaces main's in `ready`; workers.status and thread.session.control
// pass through. These pass on b6d3ff8 and back the "what holds" list.
import { newUlid } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const at = () => new Date().toISOString()
const state = (session_id: string, extra: Record<string, unknown> = {}) => ({
  session_id,
  source: 'mod',
  capabilities: [],
  rate_limits: [],
  surfaces: [],
  at: at(),
  ...extra,
})

describe('recheck OC0: per-thread session.state at the real relay', () => {
  it('holds: a scoped state after main’s never replaces main’s in ready; it rides in thread_session_states', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const live = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.state', state: state('main-1') })
    b.send({ type: 'session.state', state: state('worker-1', { scope: { thread_id: 'trip' } }) })
    // the relay fans each state out to the live app once it has stored it
    await waitFor(() => live.rec.of('session.state', 'in').length >= 2, 4000, 'both states stored')
    const r = (await k.connectedApp()).rec.of('ready', 'in')[0] as Record<string, any>
    expect(r.session_state.session_id).toBe('main-1')
    expect(r.thread_session_states).toEqual([
      { thread_id: 'trip', state: expect.objectContaining({ session_id: 'worker-1' }) },
    ])
  })

  it('holds: a scoped state BEFORE any main state leaves session_state empty rather than the worker’s', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const live = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.state', state: state('worker-1', { scope: { thread_id: 'trip' } }) })
    await waitFor(() => live.rec.of('session.state', 'in').length >= 1, 4000, 'the scoped state stored')
    const r = (await k.connectedApp()).rec.of('ready', 'in')[0] as Record<string, any>
    expect(r.session_state).toBeUndefined()
  })

  it('holds: a thread.session.control signed by the owner is acked and reaches the bridge once', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const sent = await a.sendSchedule('thread.session.control', {
      control_id: newUlid(),
      thread_id: 'trip',
      action: 'resume',
    })
    await waitFor(() => a.rec.of('ack', 'in').some((f) => f.ref === sent.id), 4000, 'the ack')
    expect(a.rec.of('ack', 'in').some((f) => f.ref === sent.id)).toBe(true)
    // the ack reaches the app on its own socket and can beat the bridge socket's recording of the frame
    await waitFor(
      () => b.count('thread.session.control', sent.id as string) > 0,
      4000,
      'the frame on the bridge socket',
    )
    expect(b.count('thread.session.control', sent.id as string)).toBe(1)
  })
})
