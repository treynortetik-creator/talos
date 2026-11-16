// A schedule row shows the last run's clock time beside "Ran" / "Failed" (`rowStatus` -> `StatusText`). When that run was on an
// EARLIER day (today is `pending` or `not_due`, so the row falls through to the last result), the time is still the bare clock
// time, so at 6:00 AM a daily 7:30 job reads "Ran 7:31 AM": a time that has not happened yet today. The row has to say which
// day, or not show a time. (`groupSchedules` already knows a last run can be from another day: it compares `last_run.ds` to today.)
// No timezone needed: the scheduler's zone is passed in.
import { describe, expect, it } from 'vitest'
import { rowStatus } from '../../src/features/schedules/logic.ts'
import { job } from '../schedules/variants.ts'

const TZ = 'Asia/Kolkata'
// Kolkata has no DST: +05:30 all year. The times below are its wall clock.
const NOW_MS = Date.parse('2026-10-28T06:00:00+05:30')
const say = (s: ReturnType<typeof rowStatus>) => [s.word, s.time].filter(Boolean).join(' ')

describe('a row whose last run was on an earlier day', () => {
  it('does not read as a run at a time that is still ahead today', () => {
    const daily = job({
      id: 'daily-summary',
      when: { type: 'daily', time: '07:30' },
      today: 'pending', // now < today's fire (S7.5)
      wait_reason: null,
      next_run: '2026-10-28T07:30:00+05:30',
      last_run: { ds: '2026-10-27', started_at: '2026-10-27T07:31:00+05:30', status: 'ok', has_report: false },
    })
    const st = rowStatus(daily, { nowMs: NOW_MS, tz: TZ, macOnline: true })
    // expected: "Pending", or "Ran yesterday 7:31 AM" / "Ran Oct 27, 7:31 AM": anything but a bare time from another day
    expect(say(st)).not.toBe('Ran 7:31 AM')
  })

  it('a failure from last week is not shown with only a clock time', () => {
    const weekly = job({
      id: 'weekly-review',
      when: { type: 'days', days: ['wed'], time: '09:00' },
      today: 'not_due',
      wait_reason: null,
      next_run: '2026-11-04T09:00:00+05:30',
      last_run: { ds: '2026-10-21', started_at: '2026-10-21T09:00:30+05:30', status: 'failed', has_report: false },
    })
    const todayFailure = job({
      id: 'weekly-review',
      today: 'failed',
      wait_reason: null,
      last_run: { ds: '2026-10-28', started_at: '2026-10-28T09:00:30+05:30', status: 'failed', has_report: false },
    })
    const now = Date.parse('2026-10-28T12:00:00+05:30')
    const old = say(rowStatus(weekly, { nowMs: now, tz: TZ, macOnline: true }))
    const fresh = say(rowStatus(todayFailure, { nowMs: now, tz: TZ, macOnline: true }))
    expect(fresh).toBe('Failed 9:00 AM')
    // expected: a failure seven days old reads differently from one this morning
    expect(old).not.toBe(fresh)
  })
})
