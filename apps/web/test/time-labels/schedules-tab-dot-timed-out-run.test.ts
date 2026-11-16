// The Schedules tab dot (docs/SCHEDULES.md S5.1: "a job failed in the last 24 h") must light for every run the row calls
// "Failed". Chronos ends a run as `timed_out`, `launch_stalled` or `session_ended` too (S7.5: running -> `failed`
// (`session_ended`/`timed_out`)); the row shows a red "Failed" for those, but `navDot` only looks for the literal status 'failed'.
// No timezone needed: explicit zones and instants only.
import { describe, expect, it } from 'vitest'
import { isFailedJob, navDot, rowStatus } from '../../src/features/schedules/logic.ts'
import { health, job, NOW_MS, snap } from '../schedules/variants.ts'

const ONE_HOUR_AGO = new Date(NOW_MS - 3600_000).toISOString()

describe('the tab dot for a job whose run failed today', () => {
  for (const status of ['timed_out', 'launch_stalled', 'session_ended'] as const) {
    it(`lights when the last run ended ${status} an hour ago (the row itself reads "Failed")`, () => {
      const failedToday = job({
        id: 'daily-summary',
        today: 'failed',
        wait_reason: null,
        last_run: { ds: '2026-10-05', started_at: ONE_HOUR_AGO, status, has_report: false },
      })
      const s = snap({ health: health(), schedules: [failedToday] })
      // the list agrees this job failed: a red "Failed" row, and the Failed filter keeps it
      expect(rowStatus(failedToday, { nowMs: NOW_MS, tz: s.health.tz, macOnline: true })).toMatchObject({
        word: 'Failed',
        tone: 'danger',
      })
      expect(isFailedJob(failedToday, { nowMs: NOW_MS, health: s.health })).toBe(true)
      // expected: the dot is on, as it is for status 'failed'
      expect(navDot(s, NOW_MS)).toBe(true)
    })
  }

  it('control: the same job with status "failed" does light the dot', () => {
    const failed = job({
      id: 'daily-summary',
      today: 'failed',
      wait_reason: null,
      last_run: { ds: '2026-10-05', started_at: ONE_HOUR_AGO, status: 'failed', has_report: false },
    })
    expect(navDot(snap({ health: health(), schedules: [failed] }), NOW_MS)).toBe(true)
  })
})
