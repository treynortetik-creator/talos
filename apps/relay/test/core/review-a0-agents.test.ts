// Review of PR #58 (subagents A0) on the REAL relay hub. FAILING tests.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit, silentBridge } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})
const at = new Date().toISOString()
const state = (session_id: string) => ({
  session_id,
  source: 'mod',
  capabilities: ['stop', 'agents', 'agent_stop'],
  rate_limits: [],
  surfaces: [],
  at,
})
const agents = (session_id: string) => ({
  session_id,
  source: 'mod',
  rows: [
    {
      id: 'a1',
      kind: 'subagent',
      type: 'Explore',
      title: 'old',
      status: 'running',
      background: true,
      stoppable: true,
      recent: [],
    },
  ],
  at,
})

describe('review A0: relay session.agents', () => {
  it('a new session id in session.state retires the previous session snapshot from ready', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.state', state: state('sess_A') })
    b.send({ type: 'session.agents', agents: agents('sess_A') })
    // new Claude session: the mod has no tasks yet, so per FakeMod it sends no `agents` member at all
    b.send({ type: 'session.state', state: state('sess_B') })
    await b.sync() // the relay handled all three frames, in order, before the app asks for ready
    const late = await k.connectedApp()
    const ready = late.rec.of('ready', 'in')[0] as Record<string, any>
    expect(ready.session_state?.session_id).toBe('sess_B')
    // today: session_agents is sess_A with a running, stoppable row
    expect(ready.session_agents?.session_id ?? 'sess_B').toBe('sess_B')
  })

  it('the relay forwards the validated frame, not raw extra envelope fields (the 64 KB cap is per frame)', async () => {
    relay = await startTestRelay()
    const a = await kit(relay).connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.agents', agents: agents('sess_A'), padding: 'p'.repeat(150_000) })
    await a.expectFrame('session.agents', undefined, { timeoutMs: 10_000 })
    const got = a.rec.of('session.agents', 'in')[0] as Record<string, unknown> | undefined
    expect(got).toBeDefined()
    expect(JSON.stringify(got).length).toBeLessThan(70_000)
  })
})
