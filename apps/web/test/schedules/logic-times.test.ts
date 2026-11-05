// HB1: the Schedules tab's logic where a run key (`ds`) can be a slot, and where a job has several fire times a day.
import { describe, expect, it } from 'vitest'
import { formFromSchedule, groupSchedules, runKeyLabel, runNowAsk } from '../../src/features/schedules/logic.ts'
import { base, job, NOW_MS } from './variants.ts'

const h = base.health
const times = { type: 'times' as const, days: 'weekdays' as const, times: ['09:45', '12:15', '14:45', '17:15'] }
const TODAY = '2026-10-05' // NOW_MS is this day in the fixture zone

describe('a slot key is a date for "today"', () => {
  it('a times job whose last run was a slot today sits in Today even when nothing else puts it there', () => {
    const j = job({
      id: 'check-in',
      when: times,
      today: 'not_due',
      next_run: '2026-10-07T09:45:00-04:00',
      last_run: { ds: `${TODAY}T0945`, status: 'ok', has_report: false },
    })
    const g = groupSchedules({ ...base, schedules: [j] }, NOW_MS)
    expect(g.today.map((s) => s.id)).toEqual(['check-in'])
    expect(g.later).toEqual([])
  })
  it("yesterday's slot does not put it in Today", () => {
    const j = job({
      id: 'check-in',
      when: times,
      today: 'not_due',
      next_run: '2026-10-07T09:45:00-04:00',
      last_run: { ds: '2026-10-04T0945', status: 'ok', has_report: false },
    })
    expect(groupSchedules({ ...base, schedules: [j] }, NOW_MS).later.map((s) => s.id)).toEqual(['check-in'])
  })
})

describe('Run now on a job with several fire times', () => {
  const j = job({
    id: 'check-in',
    when: times,
    today: 'ran',
    next_run: '2026-10-05T14:45:00-04:00',
    last_run: { ds: `${TODAY}T0945`, started_at: '2026-10-05T09:46:00-04:00', status: 'ok', has_report: false },
  })
  it('says it is an extra run, and never "counts as today\'s run" or "run again"', () => {
    const a = runNowAsk(j, h, NOW_MS)
    expect(a.again).toBe(false)
    const text = a.lines.join(' ')
    expect(text).toContain("This is an extra run. It doesn't use up any of its scheduled times.")
    expect(text).not.toContain("counts as today's run")
    expect(text).not.toContain('Run again?')
  })
  it('a plain job with a slot-shaped last run (it was switched from times) still reads as ran today', () => {
    const plain = job({
      id: 'swapped',
      today: 'pending',
      last_run: { ds: `${TODAY}T0945`, started_at: '2026-10-05T09:46:00-04:00', status: 'ok', has_report: false },
    })
    expect(runNowAsk(plain, h, NOW_MS).again).toBe(true)
  })
})

describe('the owner form and a times job', () => {
  it('the form can only hold one time, so it reads a times job as daily: the job must arrive read-only (scheduleFromChronos, protocol test)', () => {
    expect(formFromSchedule(job({ id: 'check-in', when: times }), 'Check the inbox.').kind).toBe('daily')
  })
})

describe('run keys for people', () => {
  it('keeps a date, spells a slot', () => {
    expect(runKeyLabel('2026-10-05')).toBe('2026-10-05')
    expect(runKeyLabel('2026-10-05T0945')).toBe('2026-10-05 09:45')
    expect(runKeyLabel('weird')).toBe('weird')
  })
})
