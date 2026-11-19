import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The environment a test hands to a ci-local.sh it starts itself. On the self-hosted runner the real run is inside a ci-local.sh that was
// given these (the repository, where the statuses say they ran, the workflow run's link, the file for the tested sha, the worktree
// base, the token): a copy under test must not inherit any of them, or it posts to the real commit and writes the real sha file.
export const RUNNER_VARS = [
  'CI_REPO',
  'CI_STATUS_WHERE',
  'CI_STATUS_URL',
  'CI_SHA_FILE',
  'CI_WT_BASE',
  'CI_SLEEP_GUARD',
  'TALOS_CI_FORCE_DESKTOP',
  'TALOS_CI_CACHE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // the outer run's flake file: a run under test that wrote there would put its test's flakes in the real run's status
  'CI_FLAKE_FILE',
  // where the outer run posts (docs/CI-MACHINES.md): a copy under test must post under its own, or not at all
  'CI_ATTEMPT_URL',
  'CI_STATUS_PREFIX',
  // the rest of what ci-runner.yml sets (its test checks the list): the outer run's event, its planned commit and its split.
  // A leaked CI_PLAN_SHA made ci-runner.sh under test refuse its own commit as "not the planned commit".
  // the relay lists the relays job takes from repository variables: a test never reads the real ones
  'CI_RELAY_DEPLOYS',
  'CI_RELAY_HAND_DEPLOYS',
  'PR_NUMBER',
  'PR_HEAD_SHA',
  'PR_HEAD_REPO',
  'PR_DRAFT',
  'INPUT_REF',
  'INPUT_JOBS',
  'INPUT_RUN_ANYWAY',
  // a machine's own cap on full suites at once (its runner .env), and the slot count the runner sized (ci-runner.sh size, in
  // GITHUB_ENV) that ci-local.sh caps by it and its jobs inherit: a test sets its own. An inherited CI_SLOTS=2 left the slots
  // test's third holder waiting for good in CI's check job (red main at 22195ba).
  'CI_MAX_SUITES',
  'CI_SLOTS',
  'CI_DELPHI',
  'CI_CYCLOPS',
  'CI_HESTIA',
  'CI_PLAN_SHA',
  'CI_REMOTE_PARTS',
  'CI_REMOTE_JOBS',
  'CI_SHARD_TOOLS',
  'CI_TOOLS_DELPHI',
  'CI_TOOLS_CYCLOPS',
  'CI_FALLBACK',
  'CI_RUN_PREFIX',
  'CI_TITAN_IMAGE',
  // phase C revised: the e2e packages on Titan (plan's switch and wait, the part's name, workers and the shadow switch for
  // ci-local.sh, the pairs' job and step names, the shadow comparison's knobs); the fallback's deadline; and ci-local.sh's
  // browser-mac part, which no workflow job starts any more
  'CI_TITAN_BROWSER',
  'CI_BROWSER_E2E_WAIT',
  'CI_BROWSER_E2E_PART',
  'CI_BROWSER_E2E_SHADOW',
  'CI_PART_E2E_WORKERS',
  'CI_PART_JOB',
  'CI_PART_RUN_STEP',
  'CI_PAIR_POLL',
  'CI_E2E_SHADOW_WAIT',
  'CI_E2E_SHADOW_QUEUED',
  'CI_E2E_SHADOW_POLL',
  'CI_REMOTE_DEADLINE',
  'CI_BROWSER_MAC_PART',
  'CI_PUSH_BEFORE',
  // check on Titan: plan's switch and wait, the part's name for ci-local.sh, the shadow comparison's knobs, and the part's
  // worker count (check-titan's env: a test under it must pick its own)
  'CI_TITAN_CHECK',
  // the hostile nightly's check and e2e packages on Titan too (plan's switch)
  'CI_TITAN_HOSTILE',
  'CI_CHECK_WAIT',
  'CI_CHECK_PART',
  'CI_CHECK_SHADOW_WAIT',
  'CI_CHECK_SHADOW_QUEUED',
  'CI_CHECK_SHADOW_POLL',
  'CI_WORKERS',
  'CI_RUN_JOBS',
  'CI_OWNER_MACHINE',
  'CI_JOB_STATUS', // the sweep's: a leaked 'cancelled' would close a test's pending as not tested
  'CI_LOGS_OUT',
  'CI_TESTS_OUT',
  // the nightly (ci-runner.sh exports it on a schedule run): a test's ci-local copy would post under nightly-ci/
  'CI_NIGHTLY',
  // the hostile nightly (the workflow sets it for the whole run): a test's ci-local copy would post under hostile-ci/ and burn
  'CI_HOSTILE',
  // a nightly dispatched by hand (the workflow sets it): ci-runner.sh would take the run for a schedule
  'CI_DISPATCH_NIGHTLY',
  'REPO',
  'RUN_ID',
  'CLOSE_POLL',
  // set for the real run (ci-runner.sh exports CI_RUN_ID; the runner sets GITHUB_RUN_ID): parts_poll would read the real run's jobs
  'CI_RUN_ID',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  // the shared heavy lock (Titan's runner .env and gate env): a test's ci-local copy would take the machine's real lock on
  // /mnt/wsl, wait behind real CI and time out, and a test inside a holder would pass through on its marker
  'CI_SHARED_LOCK',
  'TALOS_SHARED_LOCK_HELD',
  'CI_SHARED_CI_FRESH',
  // check's per-test reports (scripts/ci-test-results.ts): a test's runner under test would write into the real run's
  'CI_TEST_RESULTS_DIR',
  'TALOS_TEST_JUNIT_DIR',
  'CI_TEST_RESULTS_ROOT',
  // check-titan's forced "not tested" (a manual dispatch): a test's ci-local copy must not inherit it
  'CI_CHECK_PART_REFUSE',
  // the settle step (docs/CI-MACHINES.md): asked for by ci-runner.sh for a main push run, the push's time from the workflow, and the
  // close job's note that Lemnos stood aside: a test's own copy of ci-local.sh must not wait for a quiet head because the shell had them
  'CI_SETTLE',
  'CI_PUSHED_AT',
  'SUPERSEDED',
  'TALOS_CI_SETTLE_S',
  'TALOS_CI_SETTLE_MAX_S',
  'TALOS_CI_SETTLE_POLL_S',
  'TALOS_CI_SETTLE_STALE_S',
] as const

export function cleanEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !(RUNNER_VARS as readonly string[]).includes(k)) e[k] = v
  return e
}

/** scripts/ci-local/ (the parts scripts/ci-local.sh sources in place) copied into `scriptsDir`, beside a copy of ci-local.sh. */
export function copyCiLocalParts(scriptsDir: string): void {
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'ci-local'), join(scriptsDir, 'ci-local'), { recursive: true })
}

/** scripts/ci-runner/main-queue.sh (the part ci-runner.sh sources for run, fallback, settled, superseded and dispatch-wait) and schedule.sh copied beside a copy of ci-runner.sh. */
export function copyRunnerMainQueue(scriptsDir: string): void {
  const dir = join(scriptsDir, 'ci-runner')
  mkdirSync(dir, { recursive: true })
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'ci-runner', 'main-queue.sh'), join(dir, 'main-queue.sh'))
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'ci-runner', 'schedule.sh'), join(dir, 'schedule.sh')) // plan reads the dispatch marker
}

/**
 * A PATH entry standing in for the system's own folders (/usr/bin, /bin, /usr/sbin, /sbin), minus `without`: a folder of links,
 * made under `dir`, to every tool there but those. "The system folders only" is not enough to keep a tool off PATH: Titan's WSL
 * Ubuntu has claude in /usr/bin, and the owner-machine wall then refused a test that meant to have none.
 */
export function systemPathWithout(dir: string, without: readonly string[]): string {
  const out = join(dir, 'system-bin')
  mkdirSync(out, { recursive: true })
  for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const n of names) {
      if (without.includes(n)) continue
      try {
        symlinkSync(join(d, n), join(out, n))
      } catch (e) {
        // the first folder wins, as on a PATH (merged /usr lists /usr/bin twice; a dangling link there is still a name taken)
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
  }
  return out
}

/** All of scripts/ci-local.sh's code: the script and the parts it sources (scripts/ci-local/), for tests that read its text. */
export function ciLocalSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const parts = readdirSync(join(here, 'ci-local'))
    .filter((f) => f.endsWith('.sh'))
    .sort()
  return [
    readFileSync(join(here, 'ci-local.sh'), 'utf8'),
    ...parts.map((f) => readFileSync(join(here, 'ci-local', f), 'utf8')),
  ].join('\n')
}
