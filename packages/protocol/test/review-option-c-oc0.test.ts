// Independent review of PR #63 (Option C WP-OC0): protocol seams. REVIEW-FAIL tests fail on 9b0aa80 and pin a
// finding (fields OC1-OC5 will need that would otherwise force a protocol change later); the rest are controls.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  HubHubLine,
  HubWorkerLine,
  ReadyFrame,
  SessionState,
  Thread,
  threadSessionMode,
} from '../src/index.ts'

const at = '2026-10-30T12:00:00.000Z'
const thread = {
  id: 'trip',
  name: 'Trip',
  kind: 'agent',
  order: 3,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: at,
}

describe('review OC0: frames the later packages need', () => {
  it('REVIEW-FAIL: ready has a place for per-thread session states (spec 3.1 "session.state per scope", 9.3 panel)', () => {
    // ready.session_state holds ONE state. Once workers send scoped states, the relay either overwrites main's with a
    // worker's, or needs a new ready field. An older app also rejects the whole `ready` if a scoped state lands in
    // ready.session_state, because SessionState is strict (see the control below).
    const keys = Object.keys(ReadyFrame.shape)
    expect(keys.some((k) => /thread_session|session_states|scoped/.test(k))).toBe(true)
  })

  it('REVIEW-FAIL (P1, OC5): the hub socket carries spec 5.1 `mod` lines and hub → worker `controls`', () => {
    expect(HubWorkerLine.safeParse({ t: 'mod', state: {} }).success).toBe(true)
    expect(HubHubLine.safeParse({ t: 'controls' }).success).toBe(true)
  })
})

describe('review OC0: compat controls (pass)', () => {
  it('control: a pre-OC0 SessionState (strict, no scope) rejects a scoped state, so scope must never reach an old app', () => {
    const OldSessionState = SessionState.omit({ scope: true })
    const scoped = { session_id: 's1', scope: { thread_id: 'trip' }, source: 'mod', at }
    expect(SessionState.safeParse(scoped).success).toBe(true)
    expect(OldSessionState.safeParse(scoped).success).toBe(false)
    // an unscoped (main) state still parses on both sides
    const { scope: _s, ...main } = scoped
    expect(OldSessionState.safeParse(main).success).toBe(true)
  })

  it('control: an older app/bridge (Thread without the new keys) parses a dedicated thread without crashing', () => {
    const OldThread = Thread.omit({ session: true, session_opts: true })
    const r = OldThread.safeParse({ ...thread, session: 'dedicated', session_opts: { cwd: '/Users/example/p' } })
    expect(r.success).toBe(true)
    expect(r.success && 'session' in r.data).toBe(false) // stripped, which is why the bridge must keep it (#60)
  })

  it('control: a future dedicated.* key does not break this bridge; a stray `enabled: "yes"` never reads as on', () => {
    const ex = JSON.parse(readFileSync(new URL('../../../examples/config.default.json', import.meta.url), 'utf8'))
    const base = { ...ex, threads: [...ex.threads, { ...thread, session: 'dedicated' }] }
    expect(AgentConfig.safeParse(base).success).toBe(true)
    const future = AgentConfig.safeParse({ ...base, dedicated: { enabled: false, future_knob: 1 } })
    expect(future.success).toBe(true)
    expect(threadSessionMode({ ...base, dedicated: { enabled: 'yes' } }, 'trip')).toBe('shared')
    expect(threadSessionMode(base, 'trip')).toBe('shared')
  })
})
