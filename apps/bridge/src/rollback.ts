// `talos-app rollback`: put this checkout back on an earlier version that started cleanly (good-starts.ts), and nothing
// else. Each run goes strictly back in history: to the newest recorded version that is an ancestor of the one you are on, so
// repeating it walks back one step at a time and never returns to what it left. It detaches HEAD at that commit, so no branch
// and no commit is moved or lost, then reinstalls packages. It reads $TALOS_APP_HOME but never writes there. It refuses when
// tracked files have uncommitted edits, when git is in the middle of a rebase, merge or the like, and when the older code
// would erase or fail to read the owner's settings, and when a file or folder of yours (ignored by git or not) sits where the
// older version has a tracked file: the checkout runs with --no-overwrite-ignore, which refuses before changing anything. It asks y/N unless told --yes. The question is not tied to a terminal: --yes
// or piped input answers it, and an empty answer (nothing to read) declines.
//
// It must load when the rest of the CLI cannot (a pull, then a failed install), so it imports node builtins and four small
// files only, and cli.ts dispatches it before cli-main.ts is loaded.
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type BridgeEnv, loadEnv, paths } from './config.ts'
import { readGoodStarts } from './good-starts.ts'
import { type Run, runCommand } from './run-command.ts'
import { REPO_DIR } from './version.ts'

export type RollbackDeps = { repoDir?: string; run?: Run }

export type RollbackIo = {
  out(line: string): void
  err(line: string): void
  /** Asks a question on the terminal and returns the answer line ('' when there is no terminal to answer). */
  prompt(question: string): Promise<string>
}

/** A symlinked folder (/var -> /private/var) must compare equal to the path git prints. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const short = (sha: string) => sha.slice(0, 7)

/** What git can be in the middle of: moving HEAD now would leave that half done, or rewrite a branch when it is continued. */
const IN_PROGRESS: Array<[string, string]> = [
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or a patch apply'],
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['sequencer', 'a cherry-pick or revert sequence'],
  ['BISECT_LOG', 'a bisect'],
]

export type LostFields = { ok: true; lost: string[] } | { ok: false; why: string; ran: boolean }

/**
 * Asks the settings loader that is CHECKED OUT in `repoDir` what it would do with the owner's config.json: which fields
 * it would drop (the first write after a start saves what it kept, so they are gone for good) or whether it would refuse
 * the file (the bridge then exits at start). It runs the old code itself, so nothing is guessed from a version number.
 * `ran: false` means the question could not be asked at all.
 */
export function lostFields(repoDir: string, configPath: string, run: Run = runCommand): LostFields {
  const script = `import { readFileSync } from 'node:fs'
const raw = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'))
const { parseConfig } = await import(${JSON.stringify(join(repoDir, 'apps', 'bridge', 'src', 'config-file.ts'))})
const r = parseConfig(raw)
const lost = (a, b, p) => b === undefined ? [p] : a && typeof a === 'object' ? Object.keys(a).flatMap((k) => lost(a[k], b === null || typeof b !== 'object' ? undefined : b[k], p ? p + '.' + k : k)) : []
console.log('ROLLBACK_CHECK ' + JSON.stringify(r.ok ? { ok: true, lost: lost(raw, r.config, '') } : { ok: false, why: String(r.message) }))
`
  const r = run([process.execPath, '--no-env-file', '-e', script], repoDir)
  const line = r.out.split('\n').find((l) => l.startsWith('ROLLBACK_CHECK '))
  if (r.code !== 0 || !line)
    // the runtime ends its output with a version banner: show the line that says what went wrong
    return {
      ok: false,
      ran: false,
      why: r.out.split('\n').find((l) => /^(\w*Error|error): /.test(l)) ?? 'it did not run',
    }
  const parsed = JSON.parse(line.slice('ROLLBACK_CHECK '.length)) as { ok: boolean; lost?: string[]; why?: string }
  return parsed.ok
    ? { ok: true, lost: parsed.lost ?? [] }
    : { ok: false, ran: true, why: parsed.why ?? 'it refused the file' }
}

export async function cmdRollback(
  env: BridgeEnv,
  args: string[],
  io: RollbackIo,
  deps: RollbackDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, 'skip-data-check': { type: 'boolean' } },
    strict: true,
  })
  const repo = deps.repoDir ?? REPO_DIR
  const run = deps.run ?? runCommand
  const git = (...a: string[]) => run(['git', ...a], repo)
  const top = git('rev-parse', '--show-toplevel')
  if (
    top.code !== 0 ||
    !existsSync(join(repo, 'apps', 'bridge', 'package.json')) ||
    realpathOr(top.out) !== realpathOr(repo)
  ) {
    throw new Error(
      `this talos-app is not running from its own git checkout (${repo}), so it cannot roll itself back. Run it from the folder you cloned.`,
    )
  }
  const gitDir = git('rev-parse', '--absolute-git-dir')
  if (gitDir.code !== 0) throw new Error(`could not read the state of ${repo}: ${gitDir.out}`)
  const busy = IN_PROGRESS.find(([name]) => existsSync(join(gitDir.out, name)))
  if (busy) {
    throw new Error(
      `${repo} is in the middle of ${busy[1]} (it is in progress), so it was left alone. Finish it or abort it with git, then run this again.`,
    )
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty.code !== 0) throw new Error(`could not read the state of ${repo}: ${dirty.out}`)
  if (dirty.out) {
    throw new Error(
      `${repo} has changes that are not committed, so it was left alone. Commit or stash them (git stash), then run this again.`,
    )
  }
  const head = git('rev-parse', 'HEAD')
  if (head.code !== 0) throw new Error(`could not read the current commit of ${repo}: ${head.out}`)
  const here = realpathOr(top.out)
  // strictly older than where we are: an ancestor of HEAD, so a second run never goes back to the version the first left
  const mine = readGoodStarts(paths(env.home).goodStarts).filter(
    (s) => s.repo === here && s.commit !== head.out && git('cat-file', '-e', `${s.commit}^{commit}`).code === 0,
  )
  const target = mine.find((s) => git('merge-base', '--is-ancestor', s.commit, head.out).code === 0)
  if (!target) {
    throw new Error(
      // a record that is neither behind nor ahead of HEAD sits on another line of history
      mine.some((s) => git('merge-base', '--is-ancestor', head.out, s.commit).code !== 0)
        ? `versions that started cleanly are recorded for ${repo}, but none is in the history of the version you are on (the branch was probably rebased or switched since). Going to one would move sideways, not back, so nothing was changed.`
        : `no earlier version that started cleanly is recorded for ${repo}. A version is recorded when the bridge connects to the relay after a start, and each run only goes further back than the version you are on. Nothing was changed.`,
    )
  }
  // the full ref, cut by hand: `--short` prints `heads/main` when a tag is also called main, and `git checkout heads/main` detaches
  const ref = git('symbolic-ref', '--quiet', 'HEAD')
  const branchName = ref.code === 0 && ref.out.startsWith('refs/heads/') ? ref.out.slice('refs/heads/'.length) : ''
  const route = `${short(head.out)} -> ${short(target.commit)}`
  io.out(`rollback: ${route} (started cleanly ${target.recorded_at})`)
  if (values['dry-run']) {
    io.out('dry run: nothing was changed.')
    return 0
  }
  if (!values.yes) {
    const answer = (await io.prompt(`Roll back ${route}? Your data is not touched. [y/N] `)).trim()
    if (!/^y(es)?$/i.test(answer)) throw new Error('not confirmed, so nothing was changed.')
  }
  const configPath = paths(env.home).configJson
  const check = !values['skip-data-check'] && existsSync(configPath)
  // what the current code already drops is not this rollback's doing: compare against it
  const before = check ? lostFields(repo, configPath, run) : undefined
  const moved = git('checkout', '--quiet', '--no-overwrite-ignore', '--detach', target.commit)
  if (moved.code !== 0) {
    // git lists the files that are in the way, one per line with a tab, before it aborts having changed nothing
    const inWay = moved.out
      .split('\n')
      .filter((l) => l.startsWith('\t'))
      .map((l) => l.trim())
    throw new Error(
      inWay.length
        ? `the older version tracks ${inWay.slice(0, 3).join(', ')}${inWay.length > 3 ? ` and ${inWay.length - 3} more` : ''}, where you have a file or folder of your own that is not in the version you are on. Going back would overwrite it. Move it aside, then run this again. Nothing was changed.`
        : `git could not switch to ${short(target.commit)}, nothing was changed: ${moved.out.split('\n').slice(-3).join(' ')}`,
    )
  }
  // git can exit 0 with some files not updated: look, before anything is installed on top of a half-done switch
  const now = git('rev-parse', 'HEAD')
  const left = git('status', '--porcelain', '--untracked-files=no')
  if (now.out !== target.commit || left.code !== 0 || left.out) {
    throw new Error(
      `git did not finish the switch (HEAD is at ${short(now.out)}${left.out ? ', with files that differ' : ''}), so nothing was installed. Look at git status in ${repo}.`,
    )
  }
  if (check) {
    const after = lostFields(repo, configPath, run)
    const problem = !after.ok
      ? after.ran
        ? before?.ok === false && before.ran
          ? undefined // the current code cannot read it either: going back does not make that worse
          : `the older code refuses your settings file (${after.why}), so the bridge would not start`
        : `could not check whether the older code can use your settings (${after.why})`
      : after.lost.filter((p) => !(before?.ok && before.lost.includes(p))).length
        ? `the older code does not know ${after.lost.filter((p) => !(before?.ok && before.lost.includes(p))).join(', ')} in your settings and would erase it on its first write`
        : undefined
    if (problem) {
      const back = branchName ? ['switch', branchName] : ['checkout', '--detach', head.out]
      const restored = git(back[0] as string, '--quiet', ...back.slice(1))
      const ok = restored.code === 0 && git('rev-parse', 'HEAD').out === head.out
      throw new Error(
        `${problem}. ${ok ? `Put the checkout back on ${short(head.out)}; nothing else was changed.` : `Could not put the checkout back on ${short(head.out)}: run git ${back.join(' ')} in ${repo}.`} To go anyway, run this again with --skip-data-check (settings the older code does not know are lost).`,
      )
    }
  }
  const install = run(['pnpm', 'install', '--frozen-lockfile'], repo)
  if (install.code !== 0) {
    throw new Error(
      `the code is now at ${short(target.commit)}, but pnpm install --frozen-lockfile failed (${install.code === 127 ? 'pnpm is not installed: run corepack enable' : install.out.split('\n').slice(-3).join(' ')}). Fix that and run it in ${repo}; do not run rollback again for this, it would go back one more version.`,
    )
  }
  const forward = branchName || 'the branch you were on'
  io.out(`rolled back: ${route}`)
  io.out(`Your data in ${env.home} was not touched.`)
  io.out('')
  io.out('What is left (this command changed the code on disk only; nothing was restarted):')
  io.out(
    '  1. Restart the agent so the bridge runs the older code. A bridge that is already running keeps what it loaded. talos-app never restarts the agent for you: that would end the live conversation. Stop it, then run talos-app start --agent-dir <your agent folder> again.',
  )
  io.out(
    `  2. To go forward again later: git switch ${forward} (it was not moved), then pnpm install --frozen-lockfile, then talos-app update. Install first: the newer code may need packages this older one does not have.`,
  )
  io.out(
    '  3. HEAD is detached here. A commit made now belongs to no branch; to keep work from this version, run git switch -c <new-branch-name> first.',
  )
  io.out('  4. The relay, the Mac app and the iPhone app were not changed.')
  return 0
}

/** The entry cli.ts calls: loads the settings of the environment, prints failures the way the rest of the CLI does. */
export async function runRollback(
  args: string[],
  io: RollbackIo,
  envOverride?: Record<string, string | undefined>,
  deps?: RollbackDeps,
): Promise<number> {
  try {
    return await cmdRollback(loadEnv(envOverride ?? process.env), args, io, deps)
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
}

/** A terminal for rollback alone: cli-main's is not loaded here. */
export function rollbackIO(): RollbackIo {
  return {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    async prompt(q) {
      process.stdout.write(q)
      for await (const line of console) return String(line)
      return ''
    },
  }
}
