// Pure Schedules logic (docs/SCHEDULES.md S5): grouping, status words, the banner, the offline rule, the touched-fields set.
import { describe, expect, it } from 'vitest'
import {
  blankForm,
  draftFromForm,
  emptyKind,
  fixSteps,
  formFromSchedule,
  groupSchedules,
  navDot,
  needsRefetch,
  pickBanner,
  rowStatus,
  runNowAsk,
  slug,
  touchedSet,
  waitingOffline,
  whenLabel,
  zoneSuffix,
} from '../../src/features/schedules/logic.ts'
import { base, baseJob, disabledJob, heldJob, job, NOW_MS, VARIANTS } from './variants.ts'

const TZ = 'America/New_York'
const st = (s = baseJob, o: { macOnline?: boolean; nowMs?: number } = {}) =>
  rowStatus(s, { nowMs: o.nowMs ?? NOW_MS, tz: TZ, macOnline: o.macOnline ?? true })

describe('status words (S5.2 table)', () => {
  it('ran / failed / running / waiting / stuck / missed / held / pending / paused', () => {
    const v = VARIANTS.healthy().schedules
    const byId = Object.fromEntries(v.map((s) => [s.id, s]))
    expect(st(byId['daily-summary'])).toMatchObject({ word: 'Ran', tone: 'ok', time: '7:31 AM' })
    expect(st(byId['weekly-review'])).toMatchObject({ word: 'Waiting for the agent', tone: 'warn' })
    expect(st(byId['nightly-sync'])).toMatchObject({ word: 'Background run stuck', tone: 'danger' })
    expect(st(byId['remind-me'])).toMatchObject({ word: 'Pending', tone: 'muted' })
    expect(
      st(job({ id: 'a-b', today: 'failed', last_run: { ds: '2026-10-05', status: 'failed', has_report: false } })),
    ).toMatchObject({ word: 'Failed', tone: 'danger' })
    expect(st(job({ id: 'a-b', today: 'running' }))).toMatchObject({ word: 'Running…', tone: 'accent', running: true })
    expect(st(job({ id: 'a-b', today: 'missed' }))).toMatchObject({ word: 'Missed', tone: 'warn' })
    expect(st(heldJob).word).toBe('On hold: changed outside the app')
    expect(st(job({ id: 'a-b', paused: true })).word).toBe('Paused')
  })
  it('no_session waiting reads "agent session isn\'t running"', () => {
    expect(st(job({ id: 'a-b', today: 'waiting', wait_reason: 'no_session' })).word).toBe(
      "Waiting: agent session isn't running",
    )
  })
  it('a 0.2-era last_run with only {ds,status} still reads', () => {
    const s = job({ id: 'a-b', today: 'not_due', last_run: { ds: '2026-10-04', status: 'ok', has_report: false } })
    expect(st(s)).toMatchObject({ word: 'Ran', time: null })
  })
})

describe('offline waiting rows (S5.2): a timestamp comparison, not schedule maths', () => {
  const s = job({ id: 'a-b', today: 'not_due', next_run: '2026-10-05T07:30:00-04:00', catchup_min: 180 })
  it('past next_run and inside fire + catchup -> waiting', () => {
    expect(waitingOffline(s, NOW_MS, false)).toBe(true)
    expect(st(s, { macOnline: false }).word).toBe("Waiting: agent session isn't running")
  })
  it('online, or past the window, or paused: not waiting', () => {
    expect(waitingOffline(s, NOW_MS, true)).toBe(false)
    expect(waitingOffline(s, Date.parse('2026-10-05T10:31:00-04:00'), false)).toBe(false)
    expect(waitingOffline({ ...s, paused: true }, NOW_MS, false)).toBe(false)
  })
})

describe('groups (S5.2)', () => {
  it('Today / Later / Off', () => {
    const g = groupSchedules(VARIANTS.healthy(), NOW_MS)

    expect(g.today.map((s) => s.id).sort()).toEqual(['daily-summary', 'nightly-sync', 'weekly-review'])
    expect(g.later.map((s) => s.id)).toEqual(['weekly-cleanup', 'remind-me'])
    expect(g.off.map((s) => s.id)).toEqual(['pdf-digest'])
  })
  it('disabled, paused-all and command jobs are Off', () => {
    expect(groupSchedules({ ...base, schedules: [disabledJob] }, NOW_MS).off).toHaveLength(1)
    const all = groupSchedules(VARIANTS.pausedAll(), NOW_MS)
    expect(all.today).toHaveLength(0)
    expect(all.off).toHaveLength(2)
    expect(groupSchedules({ ...base, schedules: [job({ id: 'cmd-job', kind: 'command' })] }, NOW_MS).off).toHaveLength(
      1,
    )
  })
})

describe('labels', () => {
  it('whenLabel: today, tomorrow, weekday, date', () => {
    expect(whenLabel('2026-10-05T09:00:00-04:00', NOW_MS, TZ)).toBe('today 9:00 AM')
    expect(whenLabel('2026-10-06T07:30:00-04:00', NOW_MS, TZ)).toBe('tomorrow 7:30 AM')
    expect(whenLabel('2026-10-09T17:00:00-04:00', NOW_MS, TZ)).toBe('Fri 5:00 PM')
    expect(whenLabel('2026-11-12T15:00:00-05:00', NOW_MS, TZ)).toBe('Nov 12, 3:00 PM')
  })
  it('zoneSuffix only when the zones differ', () => {
    expect(zoneSuffix('2026-10-05T09:00:00-04:00', TZ, TZ)).toBe('')
    expect(zoneSuffix('2026-10-05T09:00:00-04:00', TZ, undefined)).toBe('')
    expect(zoneSuffix('2026-10-05T09:00:00-04:00', TZ, 'Etc/GMT+7')).toMatch(/^ \S+$/)
  })
})

describe('banner (S5.5): worst first', () => {
  it('session_runner_conflict beats waiting-with-no-session', () => {
    const b = pickBanner(base)
    expect(b?.code).toBe('session_runner_conflict')
    expect(b?.text).toContain('session timers')
    expect(b?.fix?.[0]).toContain('talos-app schedules adopt')
  })
  it('counts the jobs waiting with no session', () => {
    expect(pickBanner(VARIANTS.nosession())?.text).toBe("Your agent session isn't running. 1 job is waiting.")
  })
  it('paused_all offers Resume; headless_blocked offers Retry; held offers Review', () => {
    expect(pickBanner(VARIANTS.pausedAll())?.button).toBe('resume')
    expect(pickBanner(VARIANTS.headlessBlocked())).toMatchObject({ button: 'fix', retry: true })
    expect(pickBanner(VARIANTS.held())).toMatchObject({ button: 'review', scheduleId: 'held-job' })
  })
  it('no banner when healthy', () => {
    expect(pickBanner(VARIANTS.healthy())).toBeNull()
  })
  it('fixSteps numbers plain steps', () => {
    expect(fixSteps('1. Do a.\n2. Do b.')).toEqual(['Do a.', 'Do b.'])
    expect(fixSteps('Just one.')).toEqual(['Just one.'])
    expect(fixSteps(null)).toEqual([])
  })
})

describe('empty and error states (S5.6)', () => {
  it('maps health and errors to a screen', () => {
    expect(emptyKind(VARIANTS.notInstalled(), null)).toBe('not_installed')
    expect(emptyKind(VARIANTS.oldChronos(), null)).toBe('old_chronos')
    expect(emptyKind(VARIANTS.off(), null)).toBe('off')
    expect(emptyKind(VARIANTS.empty(), null)).toBe('no_jobs')
    expect(emptyKind(VARIANTS.unreadable(), null)).toBe('unreadable')
    expect(emptyKind(VARIANTS.healthy(), null)).toBeNull()
    expect(emptyKind(null, 'no_answer')).toBe('no_answer')
    expect(emptyKind(VARIANTS.healthy(), 'update_app')).toBe('update_app')
    expect(emptyKind(VARIANTS.healthy(), 'update_mac')).toBe('update_mac')
  })
})

describe('the tab dot (S5.1)', () => {
  it('stuck health, a failure within 24 h, or waiting with no session', () => {
    expect(navDot(base, NOW_MS)).toBe(true)
    expect(navDot(VARIANTS.healthy(), NOW_MS)).toBe(true) // a stalled background run
    expect(navDot(VARIANTS.nosession(), NOW_MS)).toBe(true)
    expect(navDot({ ...VARIANTS.healthy(), schedules: [VARIANTS.healthy().schedules[0] as never] }, NOW_MS)).toBe(false)
    const failed = job({
      id: 'a-b',
      today: 'ran',
      last_run: { ds: '2026-10-05', started_at: '2026-10-05T01:00:00-04:00', status: 'failed', has_report: false },
    })
    expect(navDot({ ...VARIANTS.healthy(), schedules: [failed] }, NOW_MS)).toBe(true)
    expect(navDot({ ...VARIANTS.healthy(), schedules: [failed] }, NOW_MS + 30 * 3600_000)).toBe(false)
    expect(navDot(null, NOW_MS)).toBe(false)
  })
})

describe('schedule.status re-fetch rule (S5.2)', () => {
  const revs = { 'a-b': 'sha256:e|sha256:r' }
  it('refetches only when etag|state_rev differs or a known row was removed', () => {
    expect(needsRefetch({ changed: [{ id: 'a-b', etag: 'sha256:e', state_rev: 'sha256:r' }], removed: [] }, revs)).toBe(
      false,
    )
    expect(
      needsRefetch({ changed: [{ id: 'a-b', etag: 'sha256:e', state_rev: 'sha256:r2' }], removed: [] }, revs),
    ).toBe(true)
    expect(
      needsRefetch({ changed: [{ id: 'new-one', etag: 'sha256:e', state_rev: 'sha256:r' }], removed: [] }, revs),
    ).toBe(true)
    expect(needsRefetch({ changed: [], removed: ['a-b'] }, revs)).toBe(true)
    expect(needsRefetch({ changed: [], removed: ['zzz'] }, revs)).toBe(false)
  })
})

describe('run now confirm (S5.3)', () => {
  const h = base.health
  it('full permissions warns; ran today asks again; before the fire time says it counts', () => {
    expect(runNowAsk(baseJob, h, NOW_MS).lines[0]).toBe('Run Daily Digest now? It runs with full permissions.')
    const ran = job({
      id: 'a-b',
      today: 'ran',
      last_run: { ds: '2026-10-05', started_at: '2026-10-05T07:31:00-04:00', status: 'ok', has_report: false },
    })
    const a = runNowAsk(ran, h, NOW_MS)
    expect(a.again).toBe(true)
    expect(a.lines.join(' ')).toContain('It already ran today at 7:31 AM. Run again?')
    const before = job({ id: 'a-b', today: 'pending', next_run: '2026-10-05T09:00:00-04:00' })
    expect(runNowAsk(before, h, NOW_MS).lines.join(' ')).toContain(
      "This counts as today's run; the 9:00 AM run won't happen.",
    )
  })
  it('a headless job with background runs blocked offers the session instead', () => {
    const blocked = VARIANTS.headlessBlocked()
    const hj = job({ id: 'a-b', runner: 'headless', permissions: 'full' })
    expect(runNowAsk(hj, blocked.health, NOW_MS).offerSession).toBe(true)
    expect(runNowAsk({ ...hj, permissions: 'restricted' }, blocked.health, NOW_MS).offerSession).toBe(false)
    expect(runNowAsk(hj, h, NOW_MS).offerSession).toBe(false)
  })
})

describe('the form (S5.4)', () => {
  const j = job({ id: 'daily-digest', name: 'Daily Digest', description: 'x' })
  const before = formFromSchedule(j, 'Do the thing.\n')
  it('edit sends only the touched fields', () => {
    expect(touchedSet(before, before)).toEqual({})
    expect(touchedSet(before, { ...before, name: 'Morning Digest' })).toEqual({ name: 'Morning Digest' })
    expect(touchedSet(before, { ...before, time: '08:15' })).toEqual({ when: { type: 'weekdays', time: '08:15' } })
    expect(touchedSet(before, { ...before, kind: 'days', days: ['mon', 'fri'] })).toEqual({
      when: { type: 'days', days: ['mon', 'fri'], time: '07:30' },
    })
    expect(
      touchedSet(before, { ...before, runner: 'headless', permissions: 'restricted', allowedTools: 'Read\nGrep ' }),
    ).toEqual({
      runner: 'headless',
      permissions: 'restricted',
      allowed_tools: ['Read', 'Grep'],
    })
    expect(touchedSet(before, { ...before, model: '' })).toEqual({})
    expect(touchedSet(before, { ...before, threadId: 'research' })).toEqual({ thread_id: 'research' })
  })
  it('create builds a strict draft with a safe unique id', () => {
    expect(slug('Daily Digest!', new Set(['daily-digest']))).toBe('daily-digest-2')
    expect(slug('!!', new Set())).toMatch(/^[a-z0-9-]{2,40}$/)
    const f = {
      ...blankForm(null),
      name: ' Remind me ',
      prompt: 'Ping me.',
      kind: 'once' as const,
      onceDate: '2026-11-12',
      time: '15:00',
    }
    expect(draftFromForm(f, 'remind-me')).toMatchObject({
      id: 'remind-me',
      name: 'Remind me',
      when: { type: 'once', at: '2026-11-12T15:00' },
      runner: 'session',
      permissions: 'full',
      enabled: true,
      thread_id: null,
    })
    expect(draftFromForm({ ...f, kind: 'days', days: [] }, 'x-y')).toBeNull()
  })
})
