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
] as const

export function cleanEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !(RUNNER_VARS as readonly string[]).includes(k)) e[k] = v
  return e
}
