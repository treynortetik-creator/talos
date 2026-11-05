// Loaded by bun (BUN_OPTIONS=--preload, see clock.ts) before the bridge or the CLI when a run sets E2E_NOW. The product has
// no test hook for its own clock, on purpose, so the shift stays out of it: `Date` here runs E2E_CLOCK_OFFSET_MS ahead.
const offset = Number(process.env.E2E_CLOCK_OFFSET_MS ?? 0)
if (offset) {
  const Real = Date
  const now = () => Real.now() + offset
  globalThis.Date = new Proxy(Real, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
    get: (target, key) => (key === 'now' ? now : Reflect.get(target, key)),
  })
}
