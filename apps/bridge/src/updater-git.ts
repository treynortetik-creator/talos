// The updater's git. The checkout the updater moves is a folder an agent can write to (its .git/config, hooks, refs, control files),
// so plain `git` there would run what that folder names: `core.fsmonitor` (a program, run by `git status`), hooks (`.git/hooks`,
// `core.hooksPath`, run by checkout and pull), filters, aliases, and it would read grafts and replace refs that forge ancestry.
// Every git call in the update, rollback, good-start and version paths goes through here: no fsmonitor, no hooks, no commit graph,
// the git folder and work tree given outright, and an environment of only what git needs (no GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*,
// GIT_EXEC_PATH or other GIT_* from the caller; no system or user git config; no prompt; no replace objects). And before the first
// call `checkoutProblem` refuses a checkout that is not a plain clone. The same rules as auto-update-apply.sh's g() and preflight().
// This is a TRIPWIRE for the git path: the main protection is the write guard on the checkout's folder (kit/hooks/pre-tool-guard.py,
// apps/bridge/src/guards/rules.ts); the real fix is the sha256-pinned release tarball (the archive checkout, which has no .git).
// Node builtins and run-command.ts only: rollback.ts must load when the rest of the CLI cannot.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Run, RunResult } from './run-command.ts'

/** The `-c` options in front of every updater git command. An empty core.fsmonitor is "off" (proved by updater-trust.test.ts). */
export const UPDATER_GIT_OPTS: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.commitGraph=false',
]
/** How many arguments follow `git` before the git subcommand: the options, safe.directory, --git-dir and --work-tree. */
export const UPDATER_GIT_OPTS_LEN = 10

/** What git is given from the caller's environment; everything else, GIT_* included, is dropped. The agent socket is for an ssh remote. */
const KEEP = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]

export function updaterGitEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  }
  for (const k of KEEP) {
    const v = src[k]
    if (v) env[k] = v
  }
  return env
}

function realOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * The argument vector of one hardened git command in the checkout `repo` (the command word `git` included). safe.directory names the
 * checkout so a clone owned by another user still resolves with the global config gone; the git folder and work tree are given
 * outright, so a core.worktree or a GIT_DIR cannot move them.
 */
export function updaterGitArgv(repo: string, ...args: string[]): string[] {
  const r = realOr(repo)
  return [
    'git',
    ...UPDATER_GIT_OPTS,
    '-c',
    `safe.directory=${r}`,
    `--git-dir=${join(r, '.git')}`,
    `--work-tree=${r}`,
    ...args,
  ]
}

/** What a plain clone (and a developer's) has in its own config; anything else, a program or an include, refuses the checkout. */
function configAllowed(key: string, value: string | undefined): boolean {
  // scripts/install-hooks.sh (run by the checkout's own install) sets core.hooksPath to the checkout's own .githooks: that value only
  if (key === 'core.hookspath' && value === '.githooks') return true
  return (
    /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)$/.test(key) ||
    /^remote\..+\.(url|fetch)$/.test(key) ||
    /^branch\..+\.(remote|merge|rebase)$/.test(key) ||
    key === 'user.name' ||
    key === 'user.email' ||
    key === 'talos.nohooks'
  )
}

/**
 * Why `repo` is not a plain git clone, or undefined when it is: `.git` a real folder (not a gitdir file or a link), none of the
 * control files that forge history (info/attributes, info/grafts, shallow, objects/info/alternates, config.worktree, refs/replace),
 * and every key of its own config on the short list. `localConfig` returns `git config --local --no-includes --list -z` output
 * (undefined when git could not be run).
 */
/** The problem `checkoutProblem` names when there is no .git at all: callers keep their own "not a git checkout" answer for it. */
export const NO_GIT = 'it has no .git folder'

export function checkoutProblem(repo: string, localConfig: () => string | undefined): string | undefined {
  const gd = join(repo, '.git')
  const st = lstatSync(gd, { throwIfNoEntry: false })
  if (!st) return NO_GIT
  if (!st.isDirectory()) return '.git is a link or a file, not a folder'
  // (commondir and gitdir make git read its config, refs, grafts, shallow and alternates from ANOTHER folder)
  for (const f of [
    'info/attributes',
    'info/grafts',
    'shallow',
    'objects/info/alternates',
    'config.worktree',
    'commondir',
    'gitdir',
  ]) {
    if (lstatSync(join(gd, f), { throwIfNoEntry: false })) return `.git/${f} exists`
  }
  try {
    if (existsSync(join(gd, 'refs', 'replace')) && readdirSync(join(gd, 'refs', 'replace')).length > 0)
      return 'it has a refs/replace entry'
    if (/ refs\/replace\//.test(readFileSync(join(gd, 'packed-refs'), 'utf8')))
      return 'packed-refs has a refs/replace entry'
  } catch {
    // no packed-refs: nothing there
  }
  const cfg = localConfig()
  if (cfg === undefined) return 'its config could not be read'
  for (const entry of cfg.split('\0')) {
    if (!entry) continue
    const nl = entry.indexOf('\n')
    const key = nl < 0 ? entry : entry.slice(0, nl)
    const value = nl < 0 ? undefined : entry.slice(nl + 1)
    if (!configAllowed(key, value)) return `its config sets ${key}`
  }
  return undefined
}

/** The same check through a runner of git commands: the plain `checkoutProblem` with the config read by the hardened git. */
export function checkoutProblemVia(run: Run, repo: string): string | undefined {
  return checkoutProblem(repo, () => {
    const r = run(updaterGitArgv(repo, 'config', '--local', '--no-includes', '--list', '-z'), repo, {
      env: updaterGitEnv(),
    })
    return r.code === 0 ? r.out : undefined
  })
}

/**
 * A `git(...)` that runs hardened through `run` (the runner a caller injects in tests, or runCommand) in `repo`. Before the first call
 * the checkout is checked once; a checkout that is not a plain clone answers every call with a failure that says why.
 */
export function updaterGit(run: Run, repo: string): (...args: string[]) => RunResult {
  let problem: string | undefined | null = null
  return (...args) => {
    if (problem === null) problem = checkoutProblemVia(run, repo)
    if (problem) return { code: 1, out: `not a plain git clone: ${problem}` }
    return run(updaterGitArgv(repo, ...args), repo, { env: updaterGitEnv() })
  }
}
