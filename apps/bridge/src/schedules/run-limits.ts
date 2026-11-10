// How long a session run may take before the bridge times it out, from Chronos's own limits (S3.3).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chronos's own default `timeout_min` (40): the time-out when its config cannot be read. A session run with no
 * schedule_run_done by `timeout_min` is finished as timed_out. Chronos reports `run_hung` at `timeout_min + 5`, so the
 * bridge must give up first; it also stays under `stale_claim_min`, so a live run is never taken over before it is
 * timed out. The snapshot does not carry either number, so they are read from Chronos's config file. A key that is
 * missing means Chronos's default for that key (timeout_min 40, stale_claim_min 45; chronoslib.py DEFAULTS), never the
 * other key's value.
 */
export const RUN_TIMEOUT_MS = 40 * 60_000
const CHRONOS_STALE_CLAIM_MIN = 45
/** The shortest limit handed out: a tiny stale_claim_min must not give zero or a negative time-out. */
const MIN_RUN_TIMEOUT_MS = 60_000
export function runTimeoutMs(c: { timeout_min?: unknown; stale_claim_min?: unknown } | null): number {
  // Chronos reads both through float()/int(), so "60" counts; anything else that is not a number is its default
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
    return Number.isFinite(n) ? n : undefined
  }
  const t = num(c?.timeout_min)
  const timeout = t !== undefined && t > 0 ? t : RUN_TIMEOUT_MS / 60_000
  const stale = Math.trunc(num(c?.stale_claim_min) ?? CHRONOS_STALE_CLAIM_MIN)
  return Math.max(MIN_RUN_TIMEOUT_MS, Math.round(Math.min(timeout, stale - 1) * 60_000))
}
/**
 * Chronos's config as the bridge needs it: the file named by TALOS_APP_CHRONOS_CONFIG (a leading ~ means the home
 * folder, as in Chronos) or ~/.config/chronos/config.json. null when it cannot be used, with `problem` told why. A
 * missing file at the standard place is not a problem: Chronos runs on its defaults there too.
 */
export function readChronosLimits(
  named: string | undefined,
  userHome: string,
  problem: (msg: string) => void,
): { timeout_min?: unknown; stale_claim_min?: unknown; memory_dir?: unknown } | null {
  const standard = join(userHome, '.config', 'chronos', 'config.json')
  const path = named ? (named === '~' || named.startsWith('~/') ? join(userHome, named.slice(1)) : named) : standard
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
    problem(
      `Chronos config ${path} is not a JSON object; using Chronos's defaults (timeout 40 min, stale claim 45 min)`,
    )
  } catch (e) {
    if (!(named === undefined && (e as NodeJS.ErrnoException).code === 'ENOENT'))
      problem(
        `could not read Chronos config ${path} (${(e as Error).message}); using Chronos's defaults (timeout 40 min, stale claim 45 min)`,
      )
  }
  return null
}
