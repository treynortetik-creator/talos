// Zone arithmetic for FakeScheduler ONLY. Product code never does schedule maths (docs/SCHEDULES.md S1.3, S3.1): the
// real scheduler computes every fire time. The fake has to emulate it, including the S7.5 DST rules: a local time that
// doesn't exist fires at the next valid minute, an ambiguous one at its first occurrence.

const fmts = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string) {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    fmts.set(tz, f)
  }
  return f
}

export type LocalParts = { y: number; mo: number; d: number; h: number; mi: number; s: number }

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, number> = {}
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return {
    y: p.year as number,
    mo: p.month as number,
    d: p.day as number,
    h: p.hour as number,
    mi: p.minute as number,
    s: p.second as number,
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Minutes east of UTC at that instant. */
export function offsetMinutes(ms: number, tz: string): number {
  const p = localParts(ms, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** RFC 3339 with the zone's offset, seconds precision (`2026-10-05T07:30:00-04:00`), as Chronos prints. */
export function isoInZone(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  const off = offsetMinutes(ms, tz)
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
}

export function addDays(ds: string, n: number): string {
  const [y, m, d] = ds.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export function weekdayOf(ds: string): (typeof WD)[number] {
  const [y, m, d] = ds.split('-').map(Number) as [number, number, number]
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as (typeof WD)[number]
}
export function dayOfMonth(ds: string): number {
  return Number(ds.slice(8, 10))
}
/** Whether `ds` is a real calendar date (monthdays: the 31st of a 30-day month is skipped). */
export function isRealDate(ds: string): boolean {
  return addDays(ds, 0) === ds
}

/** The first instant whose local wall time in `tz` is `ds` `hh:mm`; a skipped time fires at the next valid minute. */
export function localToInstant(ds: string, hhmm: string, tz: string): number {
  const [y, m, d] = ds.split('-').map(Number) as [number, number, number]
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number]
  for (let extra = 0; extra <= 24 * 60; extra++) {
    const wall = Date.UTC(y, m - 1, d, hh, mm + extra)
    const hits = new Set<number>()
    for (const probe of [wall - 14 * 3600_000, wall, wall + 14 * 3600_000]) {
      const t = wall - offsetMinutes(probe, tz) * 60_000
      if (Date.UTC(...wallOf(t, tz)) === wall) hits.add(t)
    }
    if (hits.size) return Math.min(...hits)
  }
  throw new Error(`no valid local time for ${ds} ${hhmm} in ${tz}`)
}

function wallOf(ms: number, tz: string): [number, number, number, number, number] {
  const p = localParts(ms, tz)
  return [p.y, p.mo - 1, p.d, p.h, p.mi]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYNAME: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}
const SHORT: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

/** "7:30 AM" */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}
const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** Plain words in the style of Chronos english() (checked against the goldens for the forms they contain). */
export function whenWords(
  w:
    | { type: 'daily' | 'weekdays'; time: string }
    | { type: 'days'; days: string[]; time: string }
    | { type: 'monthdays'; days: number[]; time: string }
    | { type: 'once'; at: string }
    | { type: 'events' },
): string {
  switch (w.type) {
    case 'daily':
      return `Every day at ${clock12(w.time)}`
    case 'weekdays':
      return `Weekdays at ${clock12(w.time)}`
    case 'days':
      return `${list(w.days.map((d) => `${DAYNAME[d]}s`))} at ${clock12(w.time)}`
    case 'monthdays':
      return `On the ${list(w.days.map(ordinal))} at ${clock12(w.time)}`
    case 'once': {
      const ds = w.at.slice(0, 10)
      const [, m, d] = ds.split('-').map(Number) as [number, number, number]
      return `Once on ${SHORT[weekdayOf(ds)]} ${MONTHS[m - 1]} ${d} at ${clock12(w.at.slice(11, 16))}`
    }
    case 'events':
      return 'On events'
  }
}
