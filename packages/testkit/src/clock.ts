// Deterministic clock for timers (expiry, quiet window, delegation timeouts, retention).
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type FakeClock = Clock & {
  /**
   * Moves time forward and fires every timer that comes due, in order, including timers they schedule. `replay`: the caller
   * means every firing in between to run (a test relay refuses an advance that fires over its cap without it).
   */
  advance(ms: number, opts?: { replay?: boolean }): void
  /**
   * A long jump as a machine waking from sleep sees it: time moves at once, then every timer already due fires once, late, in
   * order (a repeating timer re-arms from the new time and does not fire again). advance() instead replays every firing in
   * between: a 5 s ping across 8 days is 135,000 callbacks and seconds of real time, which raced a live server's keep-alive
   * (red main at 50b976cb). Use set() when no timer has to run at all. One limit: a wait the code splits into hops (the relay's
   * longTimeout, 2^31-1 ms each, for waits past 24.8 days) fires its first hop late and re-arms the rest from the jump's end, so
   * its end does not come inside a longer jump; reach such a deadline with advance() in steps, or set() then advance().
   */
  jump(ms: number): void
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
    jump(ms) {
      t += ms
      clock.advance(0) // each timer due by now fires once; one it re-arms is due later, so it does not fire again
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
