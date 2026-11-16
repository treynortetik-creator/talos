// The words a thread session's status is shown in (sessionWords), state by state: the table the mock and the UI read.
import type { WorkerStatusItemT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  durationWords,
  LONG_TURN_MS,
  type SessionWordsInput,
  sessionWords,
} from '../../src/features/thread-sessions/words.ts'

const NOW = Date.parse('2026-11-13T01:00:00.000Z') // 10:00 AM in Tokyo
const ZONE = 'Asia/Tokyo' // no DST, so the times below read the same all year
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const item = (o: Partial<WorkerStatusItemT>): WorkerStatusItemT => ({ thread_id: 'trip', state: 'live', ...o })
const words = (o: Partial<WorkerStatusItemT> | undefined, more: Partial<SessionWordsInput> = {}) =>
  sessionWords({ item: o ? item(o) : undefined, now: NOW, supervisorOnline: true, timeZone: ZONE, ...more })

describe('sessionWords', () => {
  const rows: Array<[string, Partial<WorkerStatusItemT> | undefined, Partial<SessionWordsInput>, string, string]> = [
    ['no session yet', undefined, {}, 'none', 'No session yet'],
    [
      'needs you: a permission request',
      { state: 'live', turn_started_at: ago(5) },
      { pendingCard: true },
      'needs',
      'Needs you · a permission request',
    ],
    [
      'needs you: usage limit, the screen said when',
      { needs_you: { kind: 'usage limit', since: ago(40), resets_at: '2026-11-13T07:00:00.000Z', step: 'press Esc' } },
      {},
      'needs',
      'Usage limit · resets 4:00 PM',
    ],
    [
      'needs you: usage limit, only the plan window',
      { needs_you: { kind: 'usage limit', since: ago(40) } },
      { aboutResetsAt: '2026-11-13T07:00:00.000Z' },
      'needs',
      'Usage limit · resets about 4:00 PM',
    ],
    [
      'needs you: usage limit, no time known',
      { needs_you: { kind: 'usage limit', since: ago(40) } },
      {},
      'needs',
      'Usage limit reached',
    ],
    [
      'needs you: a question at the Mac',
      { needs_you: { kind: 'trust this folder', since: ago(12) } },
      {},
      'needs',
      'Needs you at the Mac · trust this folder',
    ],
    ['working', { state: 'busy', turn_started_at: ago(25) }, {}, 'working', 'Working · since 9:35 AM (25 min)'],
    [
      'working 3 h: amber',
      { state: 'busy', turn_started_at: ago(190) },
      {},
      'long',
      'Working for 3 h 10 min in one turn',
    ],
    ['idle between turns', { state: 'live', last_turn_at: ago(5) }, {}, 'idle', 'Idle · last reply 9:55 AM'],
    ['ready, no turn yet', { state: 'live' }, {}, 'idle', 'Ready'],
    ['starting', { state: 'starting' }, {}, 'working', 'Starting…'],
    [
      'parked idle',
      { state: 'parked', parked_at: ago(30), stopped_why: 'idle' },
      {},
      'parked',
      'Parked · idle since 9:30 AM',
    ],
    ['stopped by you', { state: 'parked', parked_at: ago(30), stopped_why: 'owner' }, {}, 'parked', 'Stopped by you'],
    [
      'paused on the usage cap',
      { state: 'parked', stopped_why: 'governor' },
      { governorResetsAt: '2026-11-13T09:00:00.000Z' },
      'parked',
      'Paused · usage cap, resumes 6:00 PM',
    ],
    ['made room', { state: 'parked', stopped_why: 'cap' }, {}, 'parked', 'Parked · made room for another thread'],
    [
      'crashed and restarted',
      { state: 'parked', stopped_why: 'crash', restarts_1h: 3 },
      {},
      'failed',
      'Crashed · restarted 3× in the last hour',
    ],
    ['interrupted', { state: 'parked', stopped_why: 'interrupted' }, {}, 'parked', 'Stopped mid-turn'],
    ['restarting', { state: 'parked', stopped_why: 'restart' }, {}, 'working', 'Restarting…'],
    ['failed', { state: 'failed', error: 'needs_mac', error_at: ago(3) }, {}, 'failed', 'Failed · needs the Mac'],
    [
      'parked, no reason recorded (an older or Linux supervisor)',
      { state: 'parked', parked_at: ago(30) },
      {},
      'parked',
      'Parked · 9:30 AM',
    ],
    ['not started', { state: 'off' }, {}, 'none', 'Not started'],
  ]
  for (const [name, o, more, tone, short] of rows)
    it(name, () => {
      const w = words(o, more)
      expect(w.tone).toBe(tone)
      expect(w.short).toBe(short)
      expect(w.long.length).toBeGreaterThan(0)
    })

  it('waiting on the owner beats a pending card, and both beat the turn that is running', () => {
    expect(words({ state: 'busy', turn_started_at: ago(5) }, { pendingCard: true }).openCard).toBe(true)
    const w = words({ needs_you: { kind: 'sign in', since: ago(2) }, turn_started_at: ago(5) }, { pendingCard: true })
    expect(w.short).toBe('Needs you at the Mac · sign in')
    expect(w.openCard).toBeUndefined()
  })

  it('the step for the Mac goes with the words; the long line says since when', () => {
    const w = words({ needs_you: { kind: 'computer-use permissions', since: ago(12), step: 'press Esc in its pane' } })
    expect(w.step).toBe('press Esc in its pane')
    expect(w.long).toBe('Waiting since 9:48 AM on “computer-use permissions” in its window at the Mac.')
  })

  it('crash restarts are told while it runs too', () => {
    expect(words({ state: 'live', last_turn_at: ago(5), restarts_1h: 2 }).long).toContain('2 times in the last hour')
  })

  it('a time from another day says the day', () => {
    expect(words({ state: 'parked', parked_at: ago(24 * 60), stopped_why: 'idle' }).short).toBe(
      'Parked · idle since Nov 12, 10:00 AM',
    )
  })

  it('Mac offline: the last known picture, said as such, never live', () => {
    const w = words({ state: 'busy', turn_started_at: ago(25) }, { supervisorOnline: false, statusAt: ago(20) })
    expect(w.tone).toBe('offline')
    expect(w.short).toBe('Mac offline · last heard 9:40 AM')
    expect(w.long).toContain('Last known: Working on your message since 9:35 AM.')
    expect(w.long).toContain("The Mac isn't reporting (last heard 9:40 AM)")
  })

  it('a time that does not parse never shows as "Invalid Date"', () => {
    const w = words({ state: 'busy', turn_started_at: 'later' })
    expect(w.short).not.toContain('Invalid')
    expect(w.short).not.toContain('NaN')
    expect(w.short).toBe('Working…')
  })

  it('durations', () => {
    expect(durationWords(0)).toBe('1 min')
    expect(durationWords(59 * 60_000)).toBe('59 min')
    expect(durationWords(LONG_TURN_MS)).toBe('2 h')
    expect(durationWords(LONG_TURN_MS + 5 * 60_000)).toBe('2 h 5 min')
  })

  it('a time that is missing or does not parse leaves no hole in the words', () => {
    for (const w of [
      words({ state: 'parked', stopped_why: 'idle' }),
      words({ needs_you: { kind: 'sign in', since: 'later' } }),
      words({ needs_you: { kind: 'usage limit', since: 'later' } }),
      words({ state: 'live', last_turn_at: 'soon' }),
    ]) {
      expect(w.short).not.toMatch(/since\s*$|reply\s*$| {2}/)
      expect(w.long).not.toMatch(/since :|at {2}|since \./)
    }
    expect(words({ state: 'parked', stopped_why: 'idle' }).short).toBe('Parked · idle')
    expect(words({ state: 'live', last_turn_at: 'soon' }).short).toBe('Ready')
  })

  it('a failure is not hidden behind a pending card', () => {
    expect(words({ state: 'failed', error: 'crash_loop' }, { pendingCard: true }).short).toBe('Failed · kept crashing')
  })

  it('a usage-cap resume time already past is not said', () => {
    expect(words({ state: 'parked', stopped_why: 'governor' }, { governorResetsAt: ago(5) }).short).toBe(
      'Paused · usage cap',
    )
  })

  it('Mac offline keeps the way to a pending request', () => {
    expect(words({ state: 'busy' }, { supervisorOnline: false, pendingCard: true }).openCard).toBe(true)
  })

  it('a time from another year says the year', () => {
    expect(words({ state: 'parked', parked_at: '2025-12-31T01:00:00.000Z', stopped_why: 'owner' }).long).toContain(
      'Dec 31 2025',
    )
  })
})
