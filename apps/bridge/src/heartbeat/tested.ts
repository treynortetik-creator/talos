// The Heartbeat test ledger (docs/HEARTBEAT.md "In the app", "A test before turning on"): the bridge remembers the last passing
// test of each config hash, in `$TALOS_APP_HOME/heartbeat/tests.json`, and refuses to turn a heartbeat on without one that is
// under 24 hours old. A hash covers every setting (mode, sources, mutes, caps, time limits), so a pass for other settings is no pass.
//
// Only the bridge writes this, and only from a result it computed itself (`HeartbeatTester`). Deleting the file means "no test
// has passed": every enable is then refused until the owner tests again. Never read as "allowed".
//
// What this is: a guard against mistakes (turning on settings nobody has looked at). It is not a lock against code running as
// the owner on this Mac: the file is plain JSON with no signature, so a command source or the agent's shell could write a pass.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  configHash,
  HEARTBEAT_META_KEY,
  HEARTBEAT_TEST_VALID_MS,
  HeartbeatConfig,
  heartbeatConfigFromMeta,
  heartbeatConfigHashOf,
  type ScheduleCardBase,
  type ScheduleChangeT,
} from '@talos-app/protocol'
import { ensureDir, writeJsonAtomic } from '../fsutil.ts'

export const TESTS_SCHEMA = 'talos.heartbeat-tests/1'
const KEEP = 50
const SKEW_MS = 5 * 60_000
const HASH = /^sha256:[0-9a-f]{64}$/
/** The words the owner and the agent get. The field name is the spec's. */
export const TEST_REQUIRED = 'Run a heartbeat test for these settings first'
export const TEST_REQUIRED_FIELD = 'test_required'
/** Said when a change to an existing job cannot be judged because the job cannot be read. */
export const READ_FAIL = "Couldn't read the current schedule; try again (nothing was saved)."

export const testsFile = (home: string) => join(home, 'heartbeat', 'tests.json')

type Passes = Record<string, string>

/** Never throws; anything unreadable is "no passes". */
function load(home: string): Passes {
  const path = testsFile(home)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; passes?: unknown }
    if (raw?.schema !== TESTS_SCHEMA || raw.passes === null || typeof raw.passes !== 'object') return {}
    const out: Passes = {}
    for (const [h, at] of Object.entries(raw.passes))
      if (HASH.test(h) && typeof at === 'string' && Number.isFinite(Date.parse(at))) out[h] = at
    return out
  } catch {
    return {}
  }
}

const fresh = (at: string, nowMs: number) => {
  const age = nowMs - Date.parse(at)
  // a pass "from the future" (the clock was set back) is no pass, like the app's own check
  return age <= HEARTBEAT_TEST_VALID_MS && age >= -SKEW_MS
}

/** True when `hash` passed a test under 24 hours ago (by `nowMs`). */
export function hasFreshPass(home: string, hash: string, nowMs: number): boolean {
  const at = load(home)[hash]
  return at !== undefined && fresh(at, nowMs)
}

/** Remembers a pass. Throws when it cannot be written: the caller must not call the test a pass then. Synchronous, so two at once cannot interleave. */
export function recordPass(home: string, hash: string, nowMs: number): void {
  if (!HASH.test(hash)) throw new Error('not a config hash')
  const passes = load(home)
  passes[hash] = new Date(nowMs).toISOString()
  const live = Object.entries(passes)
    .filter(([, at]) => fresh(at, nowMs))
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, KEEP)
  const dir = join(home, 'heartbeat')
  ensureDir(dir)
  writeJsonAtomic(testsFile(home), { schema: TESTS_SCHEMA, passes: Object.fromEntries(live) }, 0o600)
}

/** The hash with the mute list taken out: adding or removing a mute only ever hides items, so it is not a new thing to test. */
function hashWithoutMutes(raw: unknown): string {
  return configHash({ ...HeartbeatConfig.parse(raw), mutes: [] })
}
const rawOf = (meta: unknown) =>
  heartbeatConfigFromMeta(meta) === null ? undefined : (meta as Record<string, unknown>)[HEARTBEAT_META_KEY]

/**
 * `test_required`: the words to refuse with, or null. Fires when `change` leaves a HEARTBEAT job ENABLED and nothing has proved
 * these exact settings. It sits where the agent's schedule_propose, the owner's schedule.patch and an adopt all pass (prepareCard),
 * and is asked again when the card is approved.
 *
 * Not asked: a delete; a change that leaves the job off (turning off, or saving a job off, is how setup works); an update to a
 * job that is already on that leaves the settings the same, or changes only the mute list (a rename, a thread move, a mute).
 * An adopt is always asked: it approves what is on disk, which nothing has tested.
 */
export function testRequiredProblem(
  home: string,
  nowMs: number,
  change: ScheduleChangeT,
  base: ScheduleCardBase | null,
): string | null {
  if (change.op === 'delete') return null
  // Turning off ends disabled whatever else is in the change, and needs nothing from the current job.
  if (change.op === 'update' && change.set.enabled === false) return null
  // Fail closed: a change to an existing job is judged against the job as it is now. If that cannot be read, nothing is let through.
  if (change.op !== 'create' && !base) return READ_FAIL
  const cur = base?.schedule
  const meta =
    change.op === 'create'
      ? change.draft.meta
      : change.op === 'update' && change.set.meta !== undefined
        ? change.set.meta
        : cur?.meta
  const raw = rawOf(meta)
  if (raw === undefined) return null
  const enabledAfter =
    change.op === 'create'
      ? change.draft.enabled
      : change.op === 'update'
        ? (change.set.enabled ?? cur?.enabled)
        : cur?.enabled
  if (enabledAfter !== true) return null
  let hash: string
  try {
    hash = heartbeatConfigHashOf(raw)
  } catch {
    return `${TEST_REQUIRED}. These settings could not be read, so no test can match them. Nothing was saved.`
  }
  // The no-test shortcut (already on, same settings or only the mutes changed) needs the CURRENT settings to parse strictly.
  // If they do not, there is no shortcut: the new settings need their own pass.
  if (change.op === 'update' && cur?.enabled === true) {
    try {
      const before = rawOf(cur.meta)
      if (
        before !== undefined &&
        (heartbeatConfigHashOf(before) === hash || hashWithoutMutes(before) === hashWithoutMutes(raw))
      )
        return null
    } catch {
      // fall through to the pass check
    }
  }
  return hasFreshPass(home, hash, nowMs) ? null : `${TEST_REQUIRED} (Schedules, Heartbeat, Test). Nothing was saved.`
}

/**
 * Run now on a heartbeat (docs/HEARTBEAT.md "A test before turning on"): the words to refuse with, or null. Run now on a heartbeat
 * that is switched OFF would otherwise be a way round the gate on turning it on: it reads the sources and, in live mode, wakes the
 * agent and posts. So a disabled heartbeat is held to the same rule as enabling it: its exact settings need a fresh passing test.
 * A job that is on keeps running by hand (existing heartbeats keep running), and shadow mode only records, so it runs freely.
 * Settings that cannot be read in full are not shadow: they need the test, and no test can match them.
 */
export function runNowProblem(home: string, nowMs: number, job: { enabled: boolean; meta?: unknown }): string | null {
  if (job.enabled) return null
  const raw = rawOf(job.meta)
  if (raw === undefined) return null
  try {
    if (HeartbeatConfig.parse(raw).mode === 'shadow') return null
    if (hasFreshPass(home, heartbeatConfigHashOf(raw), nowMs)) return null
  } catch {
    // unreadable settings: fall through to the refusal
  }
  return `${TEST_REQUIRED} (Schedules, Heartbeat, Test) before Run now on a heartbeat that is off.`
}
