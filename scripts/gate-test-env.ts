// The environment the gate's own tests (gate.test.ts, gate-push.test.ts) run gate.sh, gate-push.sh and the hook in. These
// tests also run inside a real gate (its `vitest related` step), and a gate run exports what it decides: gate-push.sh --from
// sets GATE_LANDING_HANDOFF, gate.sh sets TALOS_TEST_TIME_FACTOR, the heavy lock sets TALOS_HELD_LOCKS, a hook hands over
// GIT_DIR and friends. Inherited, those changed what the scripts under test printed (a landing gate silenced the small-machine
// notice, 2026-11-13). So every name the scripts read for the machine, its cores, the time factor, a handoff, a lock, the
// push lease or the private list is dropped here, by prefix where there is one, and each test sets only what it means to.

/** Prefixes of every variable the gate scripts, the hook and the lock read for their own decisions. */
const PREFIXES = ['TALOS_', 'GATE_', 'CHECK_', 'HEAVY_LOCK_', 'CI_', 'WEB_SPECS_', 'WEB_LIMIT']

/** Single names: git's repository pointers (a hook sets them), the e2e worker count, and what the tests' fake tools read. */
const NAMES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'E2E_WORKERS',
  'CALLS',
  'ON_TYPECHECK',
  'ON_EVERY_TYPECHECK',
  'WAIT_FOR_MARK',
  'LEASE_PROBE',
  'SLOW',
  'FAIL',
  'READERS_FAIL',
  'GATE_PUSH_READERS_MAX',
])

/** True for a name the gate scripts or the tests' fakes read, which a test must never inherit. */
export function gateOwned(name: string): boolean {
  return NAMES.has(name) || PREFIXES.some((p) => name.startsWith(p))
}

/** This process's environment without anything a running gate or hook may have set, plus `extra`. */
export function gateTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !gateOwned(k)) out[k] = v
  return { ...out, ...extra }
}
