// @vitest-environment node
// Regression tests: the agents half of the session store over the REAL socket client and the testkit
// FakeRelay (A0 fakes), not the in-memory fake client. These are guards.
import { type AgentsSnapshotT, SessionState, type SessionStateT } from '@talos-app/protocol'
import { agentRowSample, assertWebSentOnlyValidFrames, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_ANSWER_TEXT } from '../../src/features/session/logic.ts'
import { createSessionController, showsAgentStop, visibleAgents } from '../../src/features/session/store.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

const iso = (ms = Date.now()) => new Date(ms).toISOString()
const state = (session_id: string): SessionStateT =>
  SessionState.parse({
    session_id,
    source: 'mod',
    capabilities: ['stop', 'compact', 'command', 'clear', 'model', 'effort', 'inventory'],
    version: '2.1.312',
    busy: false,
    rate_limits: [],
    surfaces: ['cli'],
    at: iso(),
  })
const snap = (session_id: string, over: Partial<AgentsSnapshotT> = {}): AgentsSnapshotT => ({
  session_id,
  source: 'mod',
  can_stop: true,
  rows: [agentRowSample({ id: `a_${session_id}`, started_at: iso(Date.now() - 5000) })],
  at: iso(),
  ...over,
})

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
}

describe('agents over the real socket client', () => {
  it('guard: session.agents reaches the store; another session hides it; Stop goes out signed and valid', async () => {
    const ctl = createSessionController(client, { timeoutMs: 300 })
    ctl.start()
    await online()
    relay.sendToApps(mkFrame('session.state', { state: state('sess_A') }))
    relay.sendToApps(mkFrame('session.agents', { agents: snap('sess_A') }))
    await waitFor(() => visibleAgents(ctl.store.getState())?.rows.length === 1, 2000, 'rows')
    expect(showsAgentStop(ctl.store.getState(), 'a_sess_A')).toBe(true)

    const o = ctl.stopAgent('general', 'a_sess_A')
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'session.control'),
      2000,
      'control',
    )
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    await assertWebSentOnlyValidFrames(relay, { [key.deviceId]: key.publicJwk })
    const f = relay.frames.find((x) => x.direction === 'from_app' && x.raw.type === 'session.control')?.raw
    expect(f).toMatchObject({ action: 'agent_stop', agent_id: 'a_sess_A', thread_id: 'general' })
    expect(await o).toMatchObject({ kind: 'error' }) // no bridge answers: the phone's timeout, not a hang

    relay.sendToApps(mkFrame('session.state', { state: state('sess_B') }))
    await waitFor(() => visibleAgents(ctl.store.getState()) === undefined, 2000, 'hidden')
    expect(showsAgentStop(ctl.store.getState(), 'a_sess_A')).toBe(false)
    expect(await ctl.stopAgent('general', 'a_sess_A')).toMatchObject({ kind: 'error', local: true })
  })

  it('guard: offline, Stop settles with the send failing, not by waiting out its 60 s no-answer timeout', async () => {
    // The no-answer timeout is an hour here, so it can not be what settles Stop: if offline Stop waited for it, the await
    // below would not return and the test would end at the runner's limit. No stopwatch.
    const ctl = createSessionController(client, { timeoutMs: 3_600_000 })
    ctl.start()
    await online()
    relay.sendToApps(mkFrame('session.state', { state: state('sess_A') }))
    relay.sendToApps(mkFrame('session.agents', { agents: snap('sess_A') }))
    await waitFor(() => visibleAgents(ctl.store.getState())?.rows.length === 1, 2000, 'rows')
    await relay.stop()
    await waitFor(() => client.store.getState().connection !== 'online', 4000, 'offline')
    const o = await ctl.stopAgent('general', 'a_sess_A')
    expect(o.kind).toBe('error')
    expect(o.kind === 'error' && o.text).not.toBe(NO_ANSWER_TEXT) // it settled on the send failing, not on the no-answer timeout
    expect(Object.keys(ctl.store.getState().pending)).toHaveLength(0)
    relay = await new FakeRelay().start() // afterEach stops it
  })
})
