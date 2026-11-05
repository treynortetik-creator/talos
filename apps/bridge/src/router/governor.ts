// The usage governor (docs/OPTION-C.md, OPTION-C spec 6.3). Every session draws on one account pool, so main's own
// reading (the mod's `$.session.usage().rateLimits`, or the status line) covers every worker. No reading = "unknown",
// which never blocks (minimal friction).
import type { DedicatedConfigT, SessionStateT } from '@talos-app/protocol'

export type GovernorReading = {
  state: 'ok' | 'paused' | 'park_all' | 'off' | 'unknown'
  resets_at?: string
}

const FIVE_HOUR = new Set(['five_hour', '5h', 'five_hour_limit'])
const WEEKLY = new Set(['seven_day', 'weekly', 'seven_day_opus', 'seven_day_sonnet'])

export function governor(settings: DedicatedConfigT, state: SessionStateT | undefined): GovernorReading {
  if (settings.governor.off) return { state: 'off' }
  const limits = state?.rate_limits ?? []
  const five = limits.filter((l) => FIVE_HOUR.has(l.kind) && l.percent !== undefined)
  const week = limits.filter((l) => WEEKLY.has(l.kind) && l.percent !== undefined)
  if (!five.length && !week.length) return { state: 'unknown' }
  const max = (ls: typeof limits) => Math.max(-1, ...ls.map((l) => l.percent as number))
  const f = max(five)
  const w = max(week)
  const g = settings.governor
  const resetOf = (ls: typeof limits) => ls.map((l) => l.resets_at).find((x) => x !== undefined)
  if (f >= g.park_all || w >= g.park_all) {
    const r = f >= g.park_all ? resetOf(five) : resetOf(week)
    return r ? { state: 'park_all', resets_at: r } : { state: 'park_all' }
  }
  if (f >= g.five_hour || w >= g.weekly) {
    const r = f >= g.five_hour ? resetOf(five) : resetOf(week)
    return r ? { state: 'paused', resets_at: r } : { state: 'paused' }
  }
  return { state: 'ok' }
}

/**
 * May a parked (or never started) worker be started now? With trust mode on, the "limits are close" band (`paused`, the
 * 80 and 85 percent marks) only warns; the park-all mark (95 percent by default) still stops starts.
 */
export const allowsStart = (g: GovernorReading, opts: { trust?: boolean } = {}) =>
  g.state === 'ok' || g.state === 'unknown' || g.state === 'off' || (opts.trust === true && g.state === 'paused')
