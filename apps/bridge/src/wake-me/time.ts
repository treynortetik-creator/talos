// Turning a wake's requested time into the scheduler's local wall time and back. The scheduler takes a one-shot job as a local
// date and time in its own zone (`once.at`); the agent may give an instant with an offset, a local time, or minutes from now.
// No calendar maths beyond that: which instant a local time means is asked of the zone itself (Intl), so DST is the zone's.

const MIN = 60_000

/** The wall time of `ms` in `zone`, to the minute: `YYYY-MM-DDTHH:MM`. */
export function wallOf(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00'
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`
}

/** The zone's offset from UTC at `ms`, in ms, to the minute. */
function offsetAt(ms: number, zone: string): number {
  const w = wallOf(ms, zone)
  const asUtc = Date.parse(`${w}:00Z`)
  return asUtc - Math.floor(ms / MIN) * MIN
}

/**
 * Every instant at which `zone` shows the wall time `local` (`YYYY-MM-DDTHH:MM`), earliest first: none in a spring-forward gap,
 * two in the repeated hour of a fall-back, one otherwise.
 */
export function instantsOf(local: string, zone: string): number[] {
  const guess = Date.parse(`${local}:00Z`)
  if (!Number.isFinite(guess)) return []
  const out = new Set<number>()
  for (const probe of [guess - 36 * 3600_000, guess, guess + 36 * 3600_000]) {
    const t = guess - offsetAt(probe, zone)
    if (wallOf(t, zone) === local) out.add(t)
  }
  return [...out].sort((a, b) => a - b)
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?$/
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

export type Asked = { ok: true; ms: number; note?: string } | { ok: false; error: string }

/**
 * The instant a wake was asked for, rounded UP to the minute (the scheduler fires on minutes; never early). `at` is an ISO time
 * with an offset or Z, or a local time in `zone`; `inMinutes` counts from `now`.
 */
export function askedInstant(a: { at?: unknown; inMinutes?: unknown }, now: number, zone: string): Asked {
  const ceilMin = (ms: number) => Math.ceil(ms / MIN) * MIN
  if ((a.at === undefined) === (a.inMinutes === undefined))
    return { ok: false, error: 'Give exactly one of `at` (a time) or `in_minutes` (a whole number of minutes).' }
  if (a.inMinutes !== undefined) {
    const n = a.inMinutes
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
      return { ok: false, error: '`in_minutes` must be a whole number of minutes, 1 or more.' }
    return { ok: true, ms: ceilMin(now + n * MIN) }
  }
  if (typeof a.at !== 'string')
    return { ok: false, error: '`at` must be a time like 2026-12-24T09:00 (local) or 2026-12-24T16:00Z.' }
  const s = a.at.trim()
  if (WITH_ZONE.test(s)) {
    const ms = Date.parse(s)
    if (!Number.isFinite(ms))
      return { ok: false, error: `\`at\` is not a real time: ${JSON.stringify(s.slice(0, 40))}.` }
    return { ok: true, ms: ceilMin(ms) }
  }
  const m = LOCAL.exec(s)
  if (!m) return { ok: false, error: '`at` must be a time like 2026-12-24T09:00 (local) or 2026-12-24T16:00Z.' }
  const seconds = m[4] !== undefined && m[4] !== '00'
  const found = instantsOf(`${m[1]}T${m[2]}:${m[3]}`, zone)
  if (found.length === 0)
    return {
      ok: false,
      error: `${m[1]} ${m[2]}:${m[3]} does not happen in ${zone} (the clocks skip it). Pick another time.`,
    }
  const first = found[0] as number
  return {
    ok: true,
    ms: first + (seconds ? MIN : 0),
    ...(found.length > 1
      ? { note: `${m[1]} ${m[2]}:${m[3]} happens twice in ${zone} (the clocks go back); this is the first one.` }
      : {}),
  }
}
