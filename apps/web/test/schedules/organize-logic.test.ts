// The Schedules page kept short: the one next job, a countdown, thread groups that open themselves when something needs the
// owner, a group for one-off jobs, and the filter chips and search that narrow them.
import { describe, expect, it } from 'vitest'
import { SEARCH_AFTER } from '../../src/features/schedules/constants.ts'
import {
  countdownText,
  groupByThread,
  isFailedJob,
  MAIN_GROUP,
  needsOwner,
  nextJob,
  ONEOFF_GROUP,
  organize,
} from '../../src/features/schedules/logic.ts'
import { health, job, NOW_MS, snap } from './variants.ts'

const threads = [
  { id: 'general', name: 'General' },
  { id: 'trip', name: 'Trip' },
  { id: 'garden', name: 'Garden' },
]
const hl = health()
const base = { today: 'not_due' as const, wait_reason: null, window_ends: null }
const failedRun = {
  run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
  ds: '2026-10-05',
  started_at: '2026-10-05T06:00:00-04:00',
  runner: 'headless' as const,
  trigger: 'clock' as const,
  status: 'failed' as const,
  has_report: true,
}
const rows = () => [
  job({ id: 'a-main', name: 'Daily summary', ...base, next_run: '2026-10-06T07:30:00-04:00' }),
  job({ id: 'b-trip', name: 'Packing check', thread_id: 'trip', ...base, next_run: '2026-10-05T09:00:00-04:00' }),
  job({ id: 'c-trip', name: 'Hotel watch', thread_id: 'trip', ...base, enabled: false, next_run: null }),
  job({
    id: 'd-garden',
    name: 'Water plants',
    thread_id: 'garden',
    ...base,
    today: 'failed',
    last_run: failedRun,
    next_run: '2026-10-06T08:00:00-04:00',
  }),
  job({
    id: 'e-once',
    name: 'Renew passport',
    thread_id: 'trip',
    ...base,
    when: { type: 'once', at: '2026-10-05T08:30' },
    next_run: '2026-10-05T08:30:00-04:00',
  }),
]
const grouped = (r = rows()) =>
  groupByThread(snap({ health: health(), schedules: r }), NOW_MS, {
    threads,
    defaultThread: 'general',
    runner: () => 'main',
  })
const org = (
  o: { filters?: Array<'failed' | 'paused' | 'oneoff'>; query?: string; health?: ReturnType<typeof health> } = {},
  r = rows(),
) =>
  organize(grouped(r), {
    nowMs: NOW_MS,
    health: o.health ?? hl,
    filters: new Set(o.filters ?? []),
    query: o.query ?? '',
  })

describe('nextJob: the one job that runs next', () => {
  const h = health()
  it('is the earliest upcoming run among jobs that are on', () => {
    expect(nextJob(rows(), h, NOW_MS)?.id).toBe('e-once') // 8:30 beats 9:00 and tomorrow
  })
  it('skips a job that is off, paused, on events, or whose time has passed', () => {
    const r = rows().map((s) =>
      s.id === 'e-once'
        ? { ...s, paused: true }
        : s.id === 'b-trip'
          ? { ...s, next_run: '2026-10-05T07:00:00-04:00' }
          : s,
    )
    expect(nextJob(r, h, NOW_MS)?.id).toBe('a-main')
  })
  it('skips a job on hold: it will not run until the owner reviews it', () => {
    const r = rows().map((s) => (s.id === 'e-once' ? { ...s, today: 'held' as const } : s))
    expect(nextJob(r, h, NOW_MS)?.id).toBe('b-trip')
  })
  it('is null when everything is paused or there is nothing upcoming', () => {
    expect(nextJob(rows(), health({ paused_all: true }), NOW_MS)).toBeNull()
    expect(nextJob([], h, NOW_MS)).toBeNull()
  })
})

describe('countdownText', () => {
  const at = (ms: number) => new Date(NOW_MS + ms).toISOString()
  it('counts seconds under an hour, then hours and minutes, then days', () => {
    expect(countdownText(at(42_000), NOW_MS)).toBe('in 42 s')
    expect(countdownText(at(12 * 60_000 + 5_000), NOW_MS)).toBe('in 12 min 05 s')
    expect(countdownText(at(2 * 3_600_000 + 5 * 60_000), NOW_MS)).toBe('in 2 h 05 min')
    expect(countdownText(at(50 * 3_600_000), NOW_MS)).toBe('in 2 d 2 h')
  })
  it('reads "now" at or past the time', () => {
    expect(countdownText(at(0), NOW_MS)).toBe('now')
    expect(countdownText(at(-5_000), NOW_MS)).toBe('now')
  })
})

describe('what needs the owner', () => {
  it('a failed or stuck job is failed; a job on hold waits on the owner', () => {
    const [main, , , garden] = rows()
    expect(isFailedJob(garden as never, { nowMs: NOW_MS, health: hl })).toBe(true)
    expect(isFailedJob(main as never, { nowMs: NOW_MS, health: hl })).toBe(false)
    expect(isFailedJob(job({ id: 'x', ...base, today: 'stalled' }), { nowMs: NOW_MS, health: hl })).toBe(true)
    expect(needsOwner(job({ id: 'x', ...base, today: 'held' }))).toBe(true)
    expect(needsOwner(main as never)).toBe(false)
  })
})

describe('organize: groups with a header, one-offs apart', () => {
  it('thread groups keep their order; one-off jobs leave their thread for a group of their own, last', () => {
    const g = org()
    expect(g.map((x) => x.key)).toEqual([MAIN_GROUP, 'trip', 'garden', ONEOFF_GROUP])
    expect(g.find((x) => x.key === 'trip')?.rows.map((r) => r.id)).toEqual(['b-trip', 'c-trip'])
    const one = g.at(-1)
    expect(one?.name).toBe('One-off')
    expect(one?.rows.map((r) => r.id)).toEqual(['e-once'])
    expect(one?.runner).toBeNull()
  })
  it('the header carries the job count, the next run, and whether one failed', () => {
    const trip = org().find((x) => x.key === 'trip')
    expect(trip).toMatchObject({ count: 2, next: '2026-10-05T09:00:00-04:00', failed: false })
    const garden = org().find((x) => x.key === 'garden')
    expect(garden).toMatchObject({ count: 1, failed: true })
  })
  it('a group with nothing on has no next run', () => {
    const g = org({}, [rows()[2] as never]) // the only job is off
    expect(g[0]).toMatchObject({ next: null })
  })
  it('opens by itself when a job failed or is on hold, and only then', () => {
    const g = org()
    expect(g.map((x) => [x.key, x.autoOpen])).toEqual([
      [MAIN_GROUP, false],
      ['trip', false],
      ['garden', true],
      [ONEOFF_GROUP, false],
    ])
    const held = org({}, [job({ id: 'h', name: 'Held', thread_id: 'trip', ...base, today: 'held' })])
    expect(held[0]?.autoOpen).toBe(true)
    expect(held[0]?.failed).toBe(false) // no red dot: it waits on the owner, it did not fail
  })
})

describe('headers follow what the rows say', () => {
  it('an off job whose last run failed has no red dot and does not open its group', () => {
    const r = [
      job({
        id: 'o',
        name: 'Off one',
        thread_id: 'trip',
        ...base,
        enabled: false,
        today: 'failed',
        last_run: failedRun,
      }),
    ]
    expect(org({}, r)[0]).toMatchObject({ failed: false, autoOpen: false })
  })
  it('with every job paused there are no red dots, no next time, and nothing opens', () => {
    const g = org({ health: health({ paused_all: true }) })
    expect(g.every((x) => !x.failed && !x.autoOpen && x.next === null)).toBe(true)
  })
  it('a job on hold is not a next time; a run time already past is not shown', () => {
    const r = [
      job({ id: 'h', name: 'Held', thread_id: 'trip', ...base, today: 'held', next_run: '2026-10-06T08:00:00-04:00' }),
      job({ id: 'p', name: 'Past', thread_id: 'trip', ...base, next_run: '2026-10-05T07:00:00-04:00' }),
    ]
    expect(org({}, r)[0]?.next).toBeNull()
  })
  it('a one-off keeps where it came from, so its row can say who runs it', () => {
    const one = org().find((x) => x.key === ONEOFF_GROUP)
    expect(one?.from?.['e-once']).toEqual({ runner: 'main', name: 'Trip' })
  })
})

describe('filters and search', () => {
  it('search also matches the thread name and the prompt', () => {
    expect(org({ query: 'garden' }).flatMap((x) => x.rows.map((r) => r.id))).toEqual(['d-garden'])
    const r = rows().map((s) => (s.id === 'a-main' ? { ...s, prompt_preview: 'Email the landlord' } : s))
    expect(org({ query: 'landlord' }, r).flatMap((x) => x.rows.map((y) => y.id))).toEqual(['a-main'])
  })
  it('Failed keeps failed jobs, Paused keeps paused or off jobs, One-off keeps one-offs', () => {
    expect(org({ filters: ['failed'] }).flatMap((x) => x.rows.map((r) => r.id))).toEqual(['d-garden'])
    expect(org({ filters: ['paused'] }).flatMap((x) => x.rows.map((r) => r.id))).toEqual(['c-trip'])
    expect(org({ filters: ['oneoff'] }).flatMap((x) => x.rows.map((r) => r.id))).toEqual(['e-once'])
    const paused = rows().map((s) => (s.id === 'a-main' ? { ...s, paused: true } : s))
    expect(
      org({ filters: ['paused'] }, paused)
        .flatMap((x) => x.rows.map((r) => r.id))
        .sort(),
    ).toEqual(['a-main', 'c-trip'])
  })
  it('two chips show both kinds', () => {
    expect(
      org({ filters: ['failed', 'oneoff'] })
        .flatMap((x) => x.rows.map((r) => r.id))
        .sort(),
    ).toEqual(['d-garden', 'e-once'])
  })
  it('a group with no match is left out, and the count is the matches', () => {
    const g = org({ filters: ['paused'] })
    expect(g.map((x) => x.key)).toEqual(['trip'])
    expect(g[0]?.count).toBe(1)
  })
  it('search matches the name, ignoring case', () => {
    expect(org({ query: 'PLANT' }).flatMap((x) => x.rows.map((r) => r.id))).toEqual(['d-garden'])
    expect(org({ query: 'nothing like it' })).toEqual([])
  })
  it('search shows from more than 15 jobs', () => {
    expect(SEARCH_AFTER).toBe(15)
  })
})
