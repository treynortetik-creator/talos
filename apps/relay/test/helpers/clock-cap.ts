// The cap on how many timers one advance of a relay test's fake clock may fire. Counted, not timed, so it cannot flake. Used by
// startTestRelay (core/harness.ts: a live server, where a long replay once raced its keep-alive) and createFakeServices
// (helpers/fake-services.ts: the in-process harnesses, where an advance of days took up to 12.8 s).
import type { Clock } from '@talos-app/testkit'

/**
 * A 24 h advance of a peer test fired enough to take 5.4 s, and 8 advances in the suite fired 34,000 to 135,000 (a 5 s ping
 * replayed across days), 2 to 9 s each. A long jump is clock.set() when no timer has to run, or clock.jump() when each due
 * timer should fire once (a machine waking from sleep); advance(ms, { replay: true }) only where every firing in between matters.
 */
export const MAX_TIMERS_PER_ADVANCE = 20_000

type CappableClock = Clock & { advance(ms: number, opts?: { replay?: boolean }): void; readonly fired: number }
const isFake = (c: Clock): c is CappableClock => 'advance' in c && 'fired' in c

/** Wraps a fake clock's advance with the cap; a real clock, or one already capped (two relays on one clock), is left alone. */
export function capClockJumps(c: Clock): void {
  if (!isFake(c)) return
  const marked = c as CappableClock & { __capped?: true }
  if (marked.__capped) return
  marked.__capped = true
  const inner = c.advance.bind(c)
  c.advance = (ms, opts) => {
    const before = c.fired
    inner(ms, opts)
    const n = c.fired - before
    if (n > MAX_TIMERS_PER_ADVANCE && !opts?.replay)
      throw new Error(
        `clock.advance(${ms}) replayed ${n} timers (cap ${MAX_TIMERS_PER_ADVANCE}): a jump this long blocks the test for seconds ` +
          'and once raced the server keep-alive (ECONNRESET). Use clock.set() if no timer has to run, clock.jump() to fire each ' +
          'due timer once, or advance(ms, { replay: true }) if every firing in between matters.',
      )
  }
}
