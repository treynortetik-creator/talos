// Review of PR #58 (subagents A0). FAILING tests for gaps the A1/A2 contracts would otherwise inherit.

import { describe, expect, it } from 'vitest'
import { mkFrame } from '../src/frame-utils.ts'
import { agentRowSample, agentsSnapshotSample, FakeAgentsLink, FakeAgentsView, fakeClock } from '../src/index.ts'
import { STATE_HEARTBEAT_MS_REVIEW } from './review-consts.ts'

const T0 = '2026-10-30T12:00:00.000Z'

describe('review A0: view must not pair one session state with another session rows', () => {
  it('ready with session_state for sess_B and a leftover session_agents for sess_A: no Stop, no old rows', () => {
    const view = new FakeAgentsView()
    view.receive({
      ...mkFrame('ready'),
      session_id: 'sess_ready',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: { bridge_online: true, last_seen: T0, queue_depth: 0 },
      session_state: {
        session_id: 'sess_B',
        source: 'mod',
        capabilities: ['agents', 'agent_stop'],
        rate_limits: [],
        surfaces: [],
        at: T0,
      },
      session_agents: agentsSnapshotSample([agentRowSample({ id: 'old' })], { session_id: 'sess_A' }),
    })
    // The relay hands out whatever snapshot it last saw (no session check), so the view has to do it.
    expect(view.showsStop('old')).toBe(false)
    expect(view.agents()?.rows ?? []).toHaveLength(0)
  })
})

describe('review A0: bridge reference link re-sends an unchanged snapshot on a beat (like session.state)', () => {
  it('a restarted relay gets ready.session_agents back without waiting for a row to change', () => {
    const clock = fakeClock(T0)
    const link = new FakeAgentsLink(clock)
    link.sync(agentsSnapshotSample([agentRowSample({ id: 'shell1', kind: 'shell', type: 'shell', status: 'running' })]))
    // live mod, nothing changes for 3 heartbeats of session.state
    for (let t = 0; t < 3 * STATE_HEARTBEAT_MS_REVIEW; t += 2000) {
      clock.advance(2000)
      link.sync()
    }
    expect(link.sent.length).toBeGreaterThan(1)
    link.close()
  })
})
