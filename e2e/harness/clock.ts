// The suite's clock. Every process in a scenario (Chronos, the bridge, the relay, the browser) agrees on the time, so a
// test can be repeated at any instant: E2E_NOW (an ISO instant) is where that shared clock starts, once per stack, and it
// runs at real speed from there. A spec can also place its scenario (the `worldAt` fixture). Neither: the wall clock, and
// nothing here does anything.
import { fileURLToPath } from 'node:url'

const PRELOAD = fileURLToPath(new URL('./clock-preload.ts', import.meta.url))

function pinned(): number | null {
  const pin = process.env.E2E_NOW
  if (!pin) return null
  const t = Date.parse(pin)
  if (Number.isNaN(t)) throw new Error(`E2E_NOW is not an ISO instant: ${pin}`)
  return t
}

/** The suite's "real" now: E2E_NOW, or the wall clock. */
export function realNow(): number {
  return pinned() ?? Date.now()
}

/** Under this, a scenario is on the wall clock already: a job's minute is floored, and nothing needs shifting for that. */
const SAME_TIME_MS = 120_000

/** What to add to the wall clock to be at `at` (default: E2E_NOW) from this moment on. */
export function worldOffsetMs(at?: string): number {
  const t = at ? Date.parse(at) : pinned()
  if (t === null) return 0
  const offset = t - Date.now()
  return Math.abs(offset) < SAME_TIME_MS ? 0 : offset
}

/** The env that puts a bun process (the bridge, the CLI) on that clock. Empty without E2E_NOW. */
export function clockEnv(offsetMs: number): Record<string, string> {
  if (offsetMs === 0) return {}
  return { E2E_CLOCK_OFFSET_MS: String(offsetMs), BUN_OPTIONS: `--preload=${PRELOAD}` }
}
