// "Cold": the heartbeat has been off so long that its cursors mean nothing. The limit is twice the job's own largest gap
// between two of its weekly times (and never under 48 hours), so a Monday/Thursday job is not cold every week.
import { describe, expect, test } from 'bun:test'
import type { ScheduleWhenT } from '@talos-app/protocol'
import { COLD_FLOOR_MS, COLD_UNKNOWN_MS, coldAfterMs, coldness } from '../../src/heartbeat/cold.ts'
import { emptyStore } from '../../src/heartbeat/store.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR
const times = (days: unknown, t: string[]) => ({ type: 'times', days, times: t }) as unknown as ScheduleWhenT

describe('how long a heartbeat may be off', () => {
  test('Monday and Thursday: the longest gap is Thursday to Monday, 4 days, so 8', () => {
    expect(coldAfterMs(times(['mon', 'thu'], ['09:00']))).toBe(8 * DAY)
    expect(coldAfterMs(times([0, 3], ['09:00']))).toBe(8 * DAY) // Chronos may print the days as numbers, Monday 0
  })

  test('a daily job: a 24 hour gap is 48 hours, which is also the floor', () => {
    expect(coldAfterMs(times('daily', ['09:00']))).toBe(48 * HOUR)
    expect(coldAfterMs(times('daily', ['09:00', '21:00']))).toBe(COLD_FLOOR_MS) // 12 hour gaps would be 24: the floor wins
  })

  test('a single weekly slot: a 7 day gap, so 14 days', () => {
    expect(coldAfterMs(times(['wed'], ['09:00']))).toBe(14 * DAY)
  })

  test('weekdays with four times: the gap over the weekend counts, and times given out of order do not matter', () => {
    // Friday 17:15 to Monday 09:45 is 64.5 hours
    expect(coldAfterMs(times('weekdays', ['17:15', '09:45', '12:15', '14:45']))).toBe(129 * HOUR)
  })

  test('days or times it cannot read, or a job that is not a times job: the longest any weekly list can have, 14 days', () => {
    expect(coldAfterMs(times(['someday'], ['09:00']))).toBe(COLD_UNKNOWN_MS)
    expect(coldAfterMs({ type: 'daily', time: '09:00' } as ScheduleWhenT)).toBe(COLD_UNKNOWN_MS)
    expect(coldAfterMs(undefined)).toBe(COLD_UNKNOWN_MS)
    expect(COLD_UNKNOWN_MS).toBe(14 * DAY)
  })
})

describe('cold, judged against that limit', () => {
  const NOW = Date.parse('2026-10-12T10:00:00.000Z')
  const stored = (lastRunMs: number | null) => {
    const s = emptyStore()
    s.sources.ss = { cursor: null, last_ok: null, fail_streak: 0 }
    s.last_run = lastRunMs === null ? null : new Date(lastRunMs).toISOString()
    return s
  }
  for (const [name, limit] of [
    ['Monday and Thursday (8 days)', 8 * DAY],
    ['daily (48 hours)', 48 * HOUR],
    ['one weekly slot (14 days)', 14 * DAY],
  ] as const) {
    test(`${name}: exactly at the limit is not cold, a second over is`, () => {
      expect(coldness(stored(NOW - limit), NOW, limit).cold).toBe(false)
      expect(coldness(stored(NOW - limit - 1000), NOW, limit)).toEqual({ ms: limit + 1000, cold: true })
    })
    test(`${name}: a little under is not cold`, () => {
      expect(coldness(stored(NOW - limit + 1000), NOW, limit).cold).toBe(false)
    })
  }

  test('a store with sources and no last_run is cold; a store that has never run is not', () => {
    expect(coldness(stored(null), NOW, 8 * DAY)).toEqual({ ms: 0, cold: true })
    expect(coldness(emptyStore(), NOW, 8 * DAY).cold).toBe(false)
  })
})

describe('cold_since: an off period that no source has answered in yet', () => {
  const NOW = Date.parse('2026-10-12T10:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const marked = (lastRunMs: number | null, coldSinceMs: number | null) => {
    const s = emptyStore()
    s.sources.ss = { cursor: null, last_ok: null, fail_streak: 0 }
    s.last_run = lastRunMs === null ? null : ago(lastRunMs)
    s.cold_since = coldSinceMs === null ? null : ago(coldSinceMs)
    return s
  }

  test('cold_since makes it cold whatever last_run says, and the length runs from cold_since', () => {
    expect(coldness(marked(HOUR, 4 * DAY), NOW, 3 * DAY)).toEqual({ ms: 4 * DAY, cold: true })
    expect(coldness(marked(HOUR, 4 * DAY), NOW, 8 * DAY)).toEqual({ ms: 0, cold: true }) // under the limit: no days claimed
  })

  test('without cold_since it is last_run and nothing else: a failing source does not make it cold', () => {
    expect(coldness(marked(HOUR, null), NOW, 3 * DAY)).toEqual({ ms: 0, cold: false })
    expect(coldness(marked(4 * DAY, null), NOW, 3 * DAY)).toEqual({ ms: 4 * DAY, cold: true })
  })

  test('the old-store rule is unchanged: sources and no last_run is cold once', () => {
    expect(coldness(marked(null, null), NOW, 3 * DAY)).toEqual({ ms: 0, cold: true })
  })
})
