// Deterministic clock for timers (expiry, quiet window, delegation timeouts, retention).
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type FakeClock = Clock & {
  /** Moves time forward and fires every timer that comes due, in order, including timers they schedule. */
  advance(ms: number): void
  set(ms: number): void
  readonly pending: number
  /** How many timers have fired so far (a test can bound it to prove a long jump did not replay days of timers). */
  readonly fired: number
  iso(): string
}

export function fakeClock(startIso = '2026-10-28T15:00:00.000Z'): FakeClock {
  let t = Date.parse(startIso)
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void; seq: number }>()
  let seq = 0
  let fired = 0
  const clock: FakeClock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: t + Math.max(0, ms), fn, seq: seq++ })
      return id
    },
    clearTimeout(h) {
      timers.delete(h as number)
    },
    advance(ms) {
      const target = t + ms
      for (;;) {
        let best: [number, { at: number; fn: () => void; seq: number }] | undefined
        for (const e of timers) {
          if (
            e[1].at <= target &&
            (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[1].seq < best[1].seq))
          )
            best = e
        }
        if (!best) break
        timers.delete(best[0])
        t = Math.max(t, best[1].at)
        fired++
        best[1].fn()
      }
      t = target
    },
    set(ms) {
      t = ms
    },
    get pending() {
      return timers.size
    },
    get fired() {
      return fired
    },
    iso: () => new Date(t).toISOString(),
  }
  return clock
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
