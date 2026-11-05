// Quiet window maths (spec 7.4). Uses Intl only, so any IANA zone works and DST is handled by the platform.
export type QuietWindow = { start: string; end: string } | null

const formatters = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    formatters.set(tz, f)
  }
  return f
}

/** Minutes since local midnight in `tz`. */
export function localMinutes(at: Date, tz: string): number {
  let h = 0
  let m = 0
  for (const p of fmt(tz).formatToParts(at)) {
    if (p.type === 'hour') h = Number(p.value) % 24
    if (p.type === 'minute') m = Number(p.value)
  }
  return h * 60 + m
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** True when `at` falls inside the window. `null` or start == end means no quiet window. May wrap midnight. */
export function isQuiet(at: Date, qw: QuietWindow, tz: string): boolean {
  if (!qw) return false
  const s = toMin(qw.start)
  const e = toMin(qw.end)
  if (s === e) return false
  const now = localMinutes(at, tz)
  return s < e ? now >= s && now < e : now >= s || now < e
}

/**
 * The first whole-minute instant at which the window is over. If `at` is not quiet, returns `at` unchanged.
 * Walks minute by minute (at most 48 h), so a window end that falls inside a DST gap still resolves correctly.
 */
export function nextQuietEnd(at: Date, qw: QuietWindow, tz: string): Date {
  if (!isQuiet(at, qw, tz)) return at
  const step = 60_000
  let t = Math.floor(at.getTime() / step) * step + step
  for (let i = 0; i < 48 * 60; i++, t += step) {
    if (!isQuiet(new Date(t), qw, tz)) return new Date(t)
  }
  return new Date(t)
}
