// The reader-side checks on a thread's wake file (wake-decision.ts). Same-uid code can write `workers/<id>/wake`, so the reader
// (the Mac's WorkerWakes.takeWakes, the Linux supervisor's takeWake) is the place of record: freshness by `at`, the reader's own
// gap and hourly cap on restart and fresh, fresh only when idle, and a notice for every control it carries out. The vectors in
// fixtures/wake-decision/ are hand-written expectations; the Swift reader runs the same files.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGENT_REQUEST_MIN_GAP_MS,
  AGENT_RESTARTS_PER_HOUR,
  dedicatedSettings,
  updateRestartLine,
  WAKE_AUDIT_EVENTS,
  WAKE_AUDIT_FIELDS,
  WAKE_CAP_WINDOW_MS,
  WAKE_CAPPED_ACTIONS,
  WAKE_CAPPED_PER_HOUR,
  WAKE_IDLE_ONLY_ACTIONS,
  WAKE_MAX_AGE_MS,
  WAKE_MAX_FUTURE_MS,
  WAKE_MIN_GAP_MS,
  WAKE_NOTICE,
  WAKE_REFUSAL_WHYS,
  type WakeDecisionInputT,
  WakeFile,
  WakeState,
  WORKER_FILES,
  wakeAudit,
  wakeCapCheck,
  wakeDecision,
  wakeDoneNotice,
  wakeLimitText,
} from '../src/index.ts'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'wake-decision')
type Vector = {
  name: string
  input: Omit<WakeDecisionInputT, 'wake'> & { wake: unknown }
  output: Record<string, unknown>
}
const vectors: Vector[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ name: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }))

/** Every vector goes through the real wake-file parser first, exactly as a reader gets it off disk. */
const run = (v: Vector) => wakeDecision({ ...v.input, wake: WakeFile.parse(v.input.wake) })

describe('wake decision vectors (shared with the Swift reader)', () => {
  it('there are vectors to run', () => expect(vectors.length).toBeGreaterThanOrEqual(30))
  for (const v of vectors) it(v.name, () => expect(run(v)).toEqual(v.output))

  it('the vectors cover every refusal reason, audit kind, action and notice template', () => {
    const outs = vectors.map((v) => v.output)
    for (const why of WAKE_REFUSAL_WHYS)
      expect(
        outs.some((o) => o.why === why),
        why,
      ).toBe(true)
    for (const a of WAKE_AUDIT_EVENTS)
      expect(
        outs.some((o) => o.audit === a),
        a,
      ).toBe(true)
    for (const action of ['pointer', 'park', 'resume', 'restart', 'fresh'])
      expect(
        vectors.some((v) => (v.input.wake as { action: string }).action === action),
        action,
      ).toBe(true)
    const notices = outs.map((o) => o.notice).filter((n): n is string => typeof n === 'string')
    const opening = (t: string) => t.slice(0, t.search(/[{(]/) > 0 ? t.search(/[{(]/) : 20)
    for (const [k, t] of Object.entries(WAKE_NOTICE))
      expect(
        notices.some((n) => n.startsWith(opening(t))),
        k,
      ).toBe(true)
  })

  it('every `at` spelling the wake parser accepts is in a vector: no fraction, an offset, six fraction digits', () => {
    const ats = vectors.map((v) => (v.input.wake as { at: string }).at)
    expect(ats.some((a) => /:\d\dZ$/.test(a))).toBe(true)
    expect(ats.some((a) => /[+-]\d\d:\d\d$/.test(a))).toBe(true)
    expect(ats.some((a) => /\.\d{6}Z$/.test(a))).toBe(true)
  })

  it('every notice is one line', () => {
    for (const v of vectors) {
      const n = v.output.notice
      if (typeof n === 'string') expect(n, v.name).not.toMatch(/[\r\n]/)
    }
  })
})

describe('the reader’s own limits', () => {
  it('20 s apart and 12 an hour per thread: out of a person’s reach, a stop for a loop; Main’s own restart rules are apart', () => {
    expect(WAKE_MIN_GAP_MS).toBe(20_000)
    expect(WAKE_CAPPED_PER_HOUR).toBe(12)
    expect(WAKE_CAP_WINDOW_MS).toBe(3_600_000)
    expect(AGENT_REQUEST_MIN_GAP_MS).toBe(120_000) // Main's, unchanged
    expect(AGENT_RESTARTS_PER_HOUR).toBe(3)
  })
  it('a wake is fresh for five minutes, with a few seconds of clock skew ahead', () => {
    expect(WAKE_MAX_AGE_MS).toBe(300_000)
    expect(WAKE_MAX_FUTURE_MS).toBe(5_000)
  })
  it('only restart and fresh are capped; only fresh waits for an idle session', () => {
    expect([...WAKE_CAPPED_ACTIONS]).toEqual(['restart', 'fresh'])
    expect([...WAKE_IDLE_ONLY_ACTIONS]).toEqual(['fresh'])
  })
  it('the reader state and the bridge record have their own file names under workers/<id>/', () => {
    expect(WORKER_FILES.wakeState).toBe('wake-state.json')
    expect(WORKER_FILES.wakeWritten).toBe('wake-written.json')
  })
})

describe('the cap check the bridge also runs before it writes', () => {
  const NOW = 10 * 3_600_000
  it('says which rule and when the next is allowed', () => {
    expect(wakeCapCheck([], NOW)).toEqual({ ok: true })
    expect(wakeCapCheck([NOW - 5_000], NOW)).toEqual({ ok: false, why: 'gap', next_at: NOW + 15_000 })
    const eleven = Array.from({ length: 11 }, (_, k) => NOW - (k + 1) * 5 * 60_000) // 5..55 minutes ago
    expect(wakeCapCheck([NOW - 59 * 60_000, ...eleven], NOW)).toEqual({ ok: false, why: 'hour', next_at: NOW + 60_000 })
    expect(wakeCapCheck([NOW - 60 * 60_000, ...eleven], NOW)).toEqual({ ok: true })
    expect(wakeCapCheck([NOW + 3_600_000], NOW)).toMatchObject({ ok: false, why: 'gap' })
    expect(wakeCapCheck([NOW + 3_600_001], NOW)).toEqual({ ok: true })
  })
  it('the words are the reader notice for that action', () => {
    expect(wakeLimitText('restart')).toBe(
      "Talos did not restart this thread's session: at most 12 restarts or fresh starts an hour, at least 20 seconds apart. Nothing was changed.",
    )
    expect(wakeLimitText('fresh')).toContain('Talos did not start a fresh conversation for this thread:')
  })
  it('the reader state file: a good one parses, anything else does not', () => {
    const good = {
      v: 1,
      taken: [
        { at: 1, action: 'restart' },
        { at: 2, action: 'fresh' },
      ],
    }
    expect(WakeState.parse(good)).toEqual(good)
    for (const bad of [
      { v: 2, taken: [] },
      { v: 1, taken: [1, 2] },
      { v: 1, taken: [{ at: 1, action: 'park' }] },
      { v: 1, taken: Array(17).fill({ at: 1, action: 'restart' }) },
      {},
    ])
      expect(WakeState.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false)
  })
})

describe('the wake file counter key (no longer used)', () => {
  const base = { v: 1, thread_id: 'trip', at: '2026-11-13T12:00:00.000Z', reason: 'control', action: 'restart' }
  it('a file written with one still parses, whatever the value; nothing decides on it', () => {
    for (const c of [1, 0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 2]) {
      const r = WakeFile.safeParse({ ...base, counter: c })
      expect(r.success, String(c)).toBe(true)
    }
    const now = Date.parse(base.at)
    const a = wakeDecision({ wake: WakeFile.parse({ ...base, counter: 1 }), now, recentTaken: [], threadIdle: true })
    const b = wakeDecision({
      wake: WakeFile.parse({ ...base, counter: Number.MAX_SAFE_INTEGER }),
      now,
      recentTaken: [],
      threadIdle: true,
    })
    expect(a).toEqual(b)
  })
})

describe('notices and audit records', () => {
  const w = WakeFile.parse({ v: 1, thread_id: 'trip', at: '2026-11-13T12:00:00.000Z', action: 'restart' })
  it('a restart of a busy session says it waits for the turn; an idle one says it restarted', () => {
    expect(wakeDoneNotice(w, { busy: true })).toBe(
      "Talos will restart this thread's session after its current turn (a new message).",
    )
    expect(wakeDoneNotice(w)).toBe("Talos restarted this thread's session (a new message).")
  })
  it('carry exactly the agreed fields', () => {
    expect([...WAKE_AUDIT_FIELDS]).toEqual(['thread', 'action', 'reason', 'at', 'why'])
    expect([...WAKE_AUDIT_EVENTS]).toEqual(['wake_refused', 'wake_stale'])
    const a = wakeAudit(w, 'gap')
    expect(Object.keys(a)).toEqual([...WAKE_AUDIT_FIELDS])
    expect(a).toEqual({
      thread: 'trip',
      action: 'restart',
      reason: 'message',
      at: '2026-11-13T12:00:00.000Z',
      why: 'gap',
    })
  })
})

describe('updateRestartLine (restart-on-update, the owner’s one line)', () => {
  // The shared cases (with the Mac's twin) are apps/desktop/Tests/Fixtures/update-restart-line.json, run by swift-parity.test.ts;
  // these are the protocol's own, notRestarted among them (into the shared file once the Swift has the group too).
  it('says what was restarted, what waits for its turn, what failed and what was not restarted; nothing when nothing is', () => {
    expect(updateRestartLine({ restarted: ['A', 'B'], waiting: ['C'], failed: ['D'], notRestarted: ['E'] })).toBe(
      'Updated or instructions changed: restarted A, B; C restarts when its turn ends; D failed; E was not restarted (it did not start again).',
    )
    expect(updateRestartLine({ restarted: ['A', 'B'], waiting: ['C'], failed: ['D'] })).toBe(
      'Updated or instructions changed: restarted A, B; C restarts when its turn ends; D failed.',
    )
    expect(updateRestartLine({ restarted: [], waiting: [], failed: [], notRestarted: ['A', 'B'] })).toBe(
      'Updated or instructions changed: A, B were not restarted (they did not start again).',
    )
    expect(updateRestartLine({ restarted: [], waiting: [], failed: [], notRestarted: [] })).toBeNull()
    expect(updateRestartLine({ restarted: [], waiting: [], failed: [], notRestarted: ['a\nb'] })).toBe(
      'Updated or instructions changed: a b was not restarted (it did not start again).',
    )
  })
  it('restart_on_update is on by default, and a junk value is on, never a silent off', () => {
    expect(dedicatedSettings({}).restart_on_update).toBe(true)
    expect(dedicatedSettings({ dedicated: { restart_on_update: false } }).restart_on_update).toBe(false)
    expect(dedicatedSettings({ dedicated: { restart_on_update: 'no' } }).restart_on_update).toBe(true)
  })
})
