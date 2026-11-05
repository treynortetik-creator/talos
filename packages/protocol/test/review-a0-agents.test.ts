// Review of PR #58 (subagents A0). FAILING tests.
import { describe, expect, it } from 'vitest'
import { AgentRow, newUlid, parseFrame } from '../src/index.ts'

const at = '2026-10-30T12:00:00.000Z'
const env = (type: string) => ({ v: 1, id: newUlid(), ts: at, type })

describe('review A0: forward compat of capabilities', () => {
  // A0 adds 'agents' and 'agent_stop'. SessionState.capabilities is a strict enum, so a peer one version behind (an old
  // relay, an old cached PWA) refuses the WHOLE session.state, and the whole `ready` that carries it (checked against
  // origin/main 774acf1: "invalid ready frame at session_state.capabilities.7"). The same will happen with the next cap.
  it('a capability this build does not know is dropped, not fatal to session.state', () => {
    const r = parseFrame(
      {
        ...env('session.state'),
        state: {
          session_id: 's1',
          source: 'mod',
          capabilities: ['stop', 'future_cap'],
          rate_limits: [],
          surfaces: [],
          at,
        },
      },
      { direction: 'relay_to_app' },
    )
    expect(r.ok).toBe(true)
  })
  it('a capability this build does not know does not stop the app going online (ready)', () => {
    const r = parseFrame(
      {
        ...env('ready'),
        session_id: 'sess_x',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 0,
        presence: { bridge_online: true, last_seen: at, queue_depth: 0 },
        session_state: {
          session_id: 's1',
          source: 'mod',
          capabilities: ['future_cap'],
          rate_limits: [],
          surfaces: [],
          at,
        },
      },
      { direction: 'relay_to_app' },
    )
    expect(r.ok).toBe(true)
  })
})

describe('review A0: ids get the same control-character rule as every other string', () => {
  const row = { id: 'a1', kind: 'subagent', type: 'Explore', title: 't', status: 'running' }
  it('id with a bidi override is refused', () => {
    expect(AgentRow.safeParse({ ...row, id: 'a1‮gpj.exe' }).success).toBe(false)
  })
  it('parent_id with a newline is refused', () => {
    expect(AgentRow.safeParse({ ...row, parent_id: 'p\n1' }).success).toBe(false)
  })
})
