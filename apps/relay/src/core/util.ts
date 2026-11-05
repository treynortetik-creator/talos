import { newUlid } from '@talos-app/protocol'
import { pickClientIp } from '../client-ip.ts'
import type { Clock } from '../services.ts'

export const DAY_MS = 86_400_000

export function mkFrame<T extends string>(clock: Clock, type: T, fields: Record<string, unknown> = {}) {
  return { v: 1 as const, type, id: newUlid(), ts: new Date(clock.now()).toISOString(), ...fields }
}

/** Client IP for a socket upgrade or a share call: see `pickClientIp`. */
export function clientIp(
  headers: { realIp?: string | null | undefined; xff?: string | null | undefined },
  remote: string | undefined,
  hops: number,
): string {
  return pickClientIp({ ...headers, remote, hops })
}

/** setTimeout that cannot exceed the 32-bit limit: re-arms itself for longer waits. */
export function longTimeout(clock: Clock, fn: () => void, ms: number, track: (h: unknown) => void): void {
  const MAX = 2 ** 31 - 1
  if (ms <= MAX) {
    track(clock.setTimeout(fn, Math.max(0, ms)))
    return
  }
  track(clock.setTimeout(() => longTimeout(clock, fn, ms - MAX, track), MAX))
}
