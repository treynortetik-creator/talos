// The owner's clock, added to the meta of every note that carries something the owner did: `local_time` (their own zone,
// with offset) on all of them, and `since_last` (the gap since their previous message in the same thread) only on a typed
// message, a voice note and a Run tap. `ts` stays the UTC time.
// Plain meta attributes only, so nothing new is added to the prompt and what was cached stays valid.
import type { BridgeContext } from './context.ts'

/** The Mac's own zone, used when the config has none that works. */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function formatter(zone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return undefined // not a zone this runtime knows
  }
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/** ISO 8601 with offset in `zone`; an unset or unknown zone uses the Mac's. Undefined when `iso` is not a time. */
export function localTime(iso: string, zone: string | undefined): string | undefined {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return undefined
  const f = (zone ? formatter(zone) : undefined) ?? formatter(systemZone()) ?? formatter('UTC')
  if (!f) return undefined
  const whole = Math.floor(ms / 1000) * 1000
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(whole))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour, p.minute, p.second)
  const offMin = Math.round((asUtc - whole) / 60_000)
  const sign = offMin < 0 ? '-' : '+'
  return (
    `${pad(p.year as number, 4)}-${pad(p.month as number)}-${pad(p.day as number)}` +
    `T${pad(p.hour as number)}:${pad(p.minute as number)}:${pad(p.second as number)}` +
    `${sign}${pad(Math.trunc(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
  )
}

/** "4m", "2h 10m", "2d 3h". Under a minute is words: a meta value loses `<`. Undefined for a negative gap or a bad time. */
export function humanGap(prevIso: string, nowIso: string): string | undefined {
  const a = Date.parse(prevIso)
  const b = Date.parse(nowIso)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined
  const mins = Math.floor((b - a) / 60_000)
  if (mins < 1) return 'under 1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** Just `local_time`: for a note that is not a message (a card decision, a spoken question, a config or schedule card). */
export function localClock(ctx: Pick<BridgeContext, 'config'>, ts: string): { local_time?: string } {
  const local = localTime(ts, ctx.config.config.timezone)
  return local ? { local_time: local } : {}
}

/**
 * The two meta fields for a typed message, a voice note or a Run tap in `threadId` stamped `ts`. `exceptId` is the note's own message, already in the
 * history by the time its notification is built. Spread the result into the notification's meta.
 */
export function clockMeta(
  ctx: Pick<BridgeContext, 'config' | 'store'>,
  threadId: string,
  ts: string,
  exceptId?: string,
): { local_time?: string; since_last?: string } {
  const out: { local_time?: string; since_last?: string } = localClock(ctx, ts)
  const prev = ctx.store.previousOwnerAt(threadId, ts, exceptId)
  const gap = prev ? humanGap(prev, ts) : undefined
  if (gap) out.since_last = gap
  return out
}
