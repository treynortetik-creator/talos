// Small formatting helpers (no locale or timezone assumptions: the browser's own).
export function relativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '' // an unreadable time is no time, never "NaN d"
  const diff = Math.max(0, nowMs - at)
  const s = Math.round(diff / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  return `${d} d`
}

/** Row-trailing age with no space or "ago": "now", "4m", "3h", "3d". Empty for a missing or unreadable time. */
export function shortAge(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor(Math.max(0, nowMs - t) / 1000)
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "YYYY-MM-DD" of an instant in `tz`, or in the device's own zone when there is none (or it cannot be read). */
function dayKeyIn(ms: number, tz?: string): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  try {
    return new Intl.DateTimeFormat('en-CA', tz ? { ...opts, timeZone: tz } : opts).format(ms)
  } catch {
    return new Intl.DateTimeFormat('en-CA', opts).format(ms)
  }
}

/** Whole calendar days from `nowMs` to `ms` in `tz` (the device's zone when absent): 0 today, -1 yesterday, 1 tomorrow. */
export function calendarDays(ms: number, nowMs: number, tz?: string): number {
  const n = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000)
  return n(dayKeyIn(ms, tz)) - n(dayKeyIn(nowMs, tz))
}

/**
 * Which form a time on screen takes: the one rule every time label follows. Counted in calendar days in `tz` (the
 * device's own zone when absent), never in 24-hour windows: so a time an hour short of a week away is not named by
 * today's weekday, and a run last night is not a bare clock time that reads as later today. Within six days either way
 * the weekday names the day; past that the date, with the year when it is not this year.
 */
export type DayForm = 'today' | 'yesterday' | 'weekday' | 'date' | 'year'
export function dayForm(ms: number, nowMs: number, tz?: string): DayForm {
  const d = calendarDays(ms, nowMs, tz)
  if (d === 0) return 'today'
  if (d === -1) return 'yesterday'
  if (d > -7 && d < 7) return 'weekday'
  return dayKeyIn(ms, tz).slice(0, 4) === dayKeyIn(nowMs, tz).slice(0, 4) ? 'date' : 'year'
}

/**
 * A time on screen in the device's zone and language, by dayForm: "7:45 AM", "Yesterday 7:45 AM", "Mon 7:45 AM",
 * "Oct 5, 7:45 AM", "Oct 5, 2025, 7:45 AM". Empty for a missing or unreadable time.
 */
export function timeLabel(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const t = clockTime(iso)
  const d = new Date(ms)
  switch (dayForm(ms, nowMs)) {
    case 'today':
      return t
    case 'yesterday':
      return `Yesterday ${t}`
    case 'weekday':
      return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`
    case 'date':
      return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`
    case 'year':
      return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}, ${t}`
  }
}

/** A day heading by the same rule: "Today", "Yesterday", "Tue, Oct 28", and "Tue, Oct 28, 2025" in another year. */
export function dayLabel(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso)
  const form = dayForm(ms, nowMs)
  if (form === 'today') return 'Today'
  if (form === 'yesterday') return 'Yesterday'
  return new Date(ms).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(form === 'year' ? { year: 'numeric' } : {}),
  })
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "just now", "3 min ago", "2 h ago". */
export function ago(iso: string | null | undefined, nowMs: number = Date.now()): string {
  const r = relativeTime(iso, nowMs)
  return r === 'now' || r === '' ? 'just now' : `${r} ago`
}
