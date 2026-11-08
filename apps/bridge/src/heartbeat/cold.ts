// "Cold": a heartbeat that has been off so long that its cursors mean nothing, so every source starts over and what it reports
// on that first look is recorded as shown, not woken. How long is "so long" comes from the job's own weekly times: twice the
// largest gap between two of them (counting the wrap from the last time of the week to the first), and never under 48 hours.
// A Monday/Thursday job is then not cold every week, and a daily one is cold after two days.
//
// TODO: this reads the weekly time list itself and does no calendar maths beyond it. If Chronos ever gets a verb that lists a
// job's slots over a range (chronoslib's `slots(job, d)` is the function it would wrap), ask that instead of reading the list here.
import type { ScheduleWhenT } from '@talos-app/protocol'
import type { HeartbeatStore } from './store.ts'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
const WEEK_MIN = 7 * 24 * 60
export const COLD_FLOOR_MS = 48 * HOUR_MS
/** A job whose days or times cannot be read: the longest limit any weekly list can have (a single weekly slot, 7 days, twice). */
export const COLD_UNKNOWN_MS = 14 * DAY_MS

const NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** Day indexes (Monday 0) a `times` job runs on, or null when they cannot be read. Chronos may print them as numbers. */
function daysOf(days: unknown): number[] | null {
  if (days === 'daily') return [0, 1, 2, 3, 4, 5, 6]
  if (days === 'weekdays') return [0, 1, 2, 3, 4]
  if (!Array.isArray(days) || days.length === 0) return null
  const out: number[] = []
  for (const d of days) {
    const i = typeof d === 'number' ? d : NAMES.indexOf(String(d).toLowerCase())
    if (!Number.isInteger(i) || i < 0 || i > 6) return null
    out.push(i)
  }
  return out
}

export function coldAfterMs(when: ScheduleWhenT | undefined): number {
  if (when?.type !== 'times') return COLD_UNKNOWN_MS
  const days = daysOf(when.days)
  const mins = when.times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)))
  if (!days || !mins.length || mins.some((m) => !Number.isFinite(m))) return COLD_UNKNOWN_MS
  const at = [...new Set(days.flatMap((d) => mins.map((m) => d * 1440 + m)))].sort((a, b) => a - b)
  const gap =
    at.length > 1
      ? Math.max(...at.map((m, i) => (at[(i + 1) % at.length] as number) - m + (i + 1 === at.length ? WEEK_MIN : 0)))
      : WEEK_MIN // one slot a week: the next one is a week away
  return Math.max(2 * gap * 60_000, COLD_FLOOR_MS)
}

/**
 * How long the heartbeat has been off, if over `limitMs` (`ms`; 0 otherwise), and whether that makes it cold. Cold is the heartbeat's
 * own gap (`last_run`, not a source's silence: a source that was down while the heartbeat kept running delivers normally), or an off
 * period no source has answered in yet (`cold_since`, set by a cold run that every source failed, cleared by the first answer): that
 * run skipped nothing, so the next one still has the backlog to skip. The length runs from where the off period began, `cold_since`
 * when it is set (it holds the old `last_run`), so a second failed run still says the true length.
 */
export function coldness(store: HeartbeatStore, nowMs: number, limitMs: number): { ms: number; cold: boolean } {
  const from = store.cold_since ?? store.last_run
  const gap = from ? nowMs - Date.parse(from) : 0
  const ms = gap > limitMs ? gap : 0
  // A store an earlier version wrote knows its sources but has no `last_run`: how long it was off is unknown, so it starts over once.
  return {
    ms,
    cold: ms > 0 || store.cold_since !== null || (store.last_run === null && Object.keys(store.sources).length > 0),
  }
}

/** `answered`: some source gave an answer this run, so a backlog was actually looked at and skipped. */
export function coldNote(ms: number, backlog: number, answered = true): string {
  const days = Math.floor(ms / DAY_MS)
  const gone = ms > 0 ? `Heartbeat was off for ${days} ${days === 1 ? 'day' : 'days'}.` : 'Heartbeat started over.'
  if (!answered) return ms > 0 ? `${gone} The backlog will be skipped once a source answers.` : gone
  return `${gone} Skipped the backlog${backlog ? ` (${backlog} ${backlog === 1 ? 'item' : 'items'})` : ''}.`
}
