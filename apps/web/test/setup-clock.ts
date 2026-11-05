// Every web unit test runs "now" = 2026-10-28T16:00Z, the instant the fixtures were written against. The clock still
// ticks (a Date offset, not frozen fake timers), so setTimeout-based waits and userEvent keep working. Without this,
// fixtures with absolute times (card expiries, "done today") rot as real time passes.
const RealDate = Date
const offset = RealDate.parse('2026-10-28T16:00:00.000Z') - RealDate.now()

class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset)
    else super(...(args as [number]))
  }
  static override now(): number {
    return RealDate.now() + offset
  }
}
globalThis.Date = ShiftedDate as DateConstructor

// Every positive wait gets 5 s, not the library default of 1 s. These tests wait on real async work (WebCrypto
// signing, a freshly reset App mounting), which stretches on a loaded CI box; a wait only costs its full budget when
// the condition never comes true. `findBy*` and `waitFor` (Testing Library) read `asyncUtilTimeout`; `vi.waitFor` takes
// its own `timeout`, so it is wrapped to default to the same budget (an explicit timeout still wins).
import { configure } from '@testing-library/react'
import { vi } from 'vitest'

const WAIT_BUDGET_MS = 5000
configure({ asyncUtilTimeout: WAIT_BUDGET_MS })
const rawWaitFor = vi.waitFor.bind(vi) as (cb: () => unknown, opts?: number | { timeout?: number }) => unknown
vi.waitFor = ((cb: () => unknown, opts?: number | { timeout?: number; interval?: number }) =>
  rawWaitFor(cb, typeof opts === 'number' ? opts : { timeout: WAIT_BUDGET_MS, ...opts })) as typeof vi.waitFor
