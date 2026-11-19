// The hostile nightly (docs/CI-MACHINES.md, "The hostile nightly") shifts `Date` in every Node and bun process through
// scripts/ci-local/hostile-clock.cjs. A browser is not one of those processes, so the harness gives each browser context the
// same shift, Date only (timers, performance.now and the rest stay native); without it the page and the bridge are 30 days
// apart and the bridge refuses the page's signed frames as stale. The init script runs in every new document, once per realm.
// apps/web/test/helpers/hostile.ts is a copy of this file (apps/web cannot import from e2e/; testkit has no Playwright).
import type { BrowserContext } from '@playwright/test'

/** The shift in ms the hostile nightly put on this process's clock (TALOS_HOSTILE_CLOCK_MS, the shim's whole-number rule), else 0. */
export function hostileClockMs(): number {
  const raw = process.env.TALOS_HOSTILE_CLOCK_MS
  return /^-?\d{1,15}$/.test(raw ?? '') ? Number(raw) : 0
}

/**
 * Shift the context's `Date` by the hostile nightly's offset, as hostile-clock.cjs does for Node: `new Date()` and `Date.now()`
 * move, `Date()` as a function gives the shifted string, a given time and the prototype, UTC and parse are the real ones.
 * Nothing else moves, so a test's own `page.clock.install({ time })` or `setSystemTime` takes over cleanly.
 */
export async function shiftBrowserClock(context: BrowserContext): Promise<void> {
  const off = hostileClockMs()
  if (off === 0) return
  await context.addInitScript((ms: number) => {
    const g = globalThis as unknown as { __talosHostileClockMs?: number; Date: DateConstructor }
    if (g.__talosHostileClockMs) return
    const RealDate = Date
    const now = () => RealDate.now() + ms
    const Shifted = function (this: unknown, ...args: unknown[]) {
      if (!new.target) return new RealDate(now()).toString()
      return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target)
    } as unknown as DateConstructor
    ;(Shifted as { prototype: unknown }).prototype = RealDate.prototype
    RealDate.prototype.constructor = Shifted
    Object.setPrototypeOf(Shifted, RealDate)
    Object.defineProperty(Shifted, 'name', { value: 'Date' })
    Object.defineProperty(Shifted, 'length', { value: 7 })
    // not enumerable, as the real one: Playwright's fake clock copies a Date's enumerable own properties over its own `now`
    Object.defineProperty(Shifted, 'now', { value: now, writable: true, configurable: true })
    g.Date = Shifted
    g.__talosHostileClockMs = ms
  }, off)
}
