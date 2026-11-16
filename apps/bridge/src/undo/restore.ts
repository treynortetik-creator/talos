// Restore: put a folder back the way its undo point saw it (snapshot.ts). Only the files: the conversation keeps going.
//
// planRestore says what would change. `rewrite`: files the point has that now differ. `recreate`: files the point has
// that are gone. `extra`: files that are new since the point; they are only listed (the card shows them), and
// applyRestore deletes just the ones the owner approved, by exact path. `blocked`: files that cannot come back because
// something new is in their way (a folder where the file was, a file or a link where its folder was); nothing in the
// way is ever cleared, so they are listed instead. Ignored files (like .env) are neither restored nor listed: a git
// point never held them. A git point is of the whole repo, so a restore undoes the repo, not only the session's
// subfolder.
//
// A git point is checked out through a temporary index (a copy of the real one, moved to the point's tree with
// read-tree -m, so unchanged files are not read again), and checkout-index writes only the paths that changed. HEAD, the
// branch, the real index, the stash and the reflog never move. Files outside a sparse checkout stay out. A folder in
// the middle of a rebase, merge, cherry-pick, revert or bisect is refused: the owner finishes or aborts that first. A
// copy point is copied back file by file, its mode included. Nothing is ever written or deleted through a link to a
// folder. applyRestore plans again itself, so what it does is judged on the folder as it is now, not as the card saw it.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { IN_PROGRESS } from '../git-in-progress.ts'
import { type AsyncRunResult, type RunAsync, runCommandAsync } from '../run-command.ts'
import { fsTypeOf, PROVEN_FS } from './fs-type.ts'
import { readIgnored, type UndoPointRow } from './points.ts'
import { cleanEnv, copyIndex, PROBE_PREFIX, QUIET, realpathOrAncestor } from './snapshot.ts'

export type RestoreOpts = {
  undoDir: string
  env?: Record<string, string | undefined>
  run?: RunAsync
} & RestoreSeams

/**
 * Test seams: a file's birth time (ms), a path's device, the probe of one folder, and the memory of failed probe answers per
 * device (default the bridge's own, and Date.now).
 */
export type RestoreSeams = {
  birthOf?: (path: string) => Promise<number | undefined>
  devOf?: (path: string) => Promise<number>
  probe?: (dir: string) => Promise<boolean>
  /** The name of the file system holding a folder (fs-type.ts); undefined when it cannot be told. */
  fsTypeOf?: (path: string) => Promise<string | undefined>
  trustCache?: TrustCache
  now?: () => number
}

export type RestorePlan =
  | {
      ok: true
      kind: 'git' | 'copy'
      root: string
      rewrite: string[]
      recreate: string[]
      /** New since the point: the only files ever offered for deletion. */
      extra: string[]
      blocked: string[]
      /** Not tracked and not ignored now, but there before (git ignored them then) or not provably new: never deleted. */
      leftInPlace: string[]
      /**
       * Why nothing is offered for deletion, when nothing is: no record of what was ignored then; an ignored file from
       * then is gone now (its content may be in a new file); or this folder keeps no birth times Talos can trust.
       */
      noDeletes?:
        | { why: 'no_record' }
        | { why: 'incomplete' }
        | { why: 'ignored_gone'; example: string }
        | { why: 'unprovable' }
        | { why: 'fs_unproven'; fs: string }
    }
  | { ok: false; why: string }

export type RestoreDone =
  | {
      ok: true
      rewritten: string[]
      recreated: string[]
      deleted: string[]
      kept: string[]
      blocked: string[]
      /** Files a copy could not put back (each one's error is in the log line of the caller). */
      failed: string[]
    }
  /** `partial`: some files may already have been written (the owner checks the folder): `mayHaveChanged` lists them. */
  | { ok: false; why: string; partial?: true; mayHaveChanged?: string[] }

/** A git call can be slow on a big repo; a restore the owner is waiting on still gets an end. */
const GIT_TIMEOUT_MS = 60_000

type Point = Pick<
  UndoPointRow,
  'kind' | 'root' | 'ref' | 'commit_id' | 'path' | 'state' | 'thread_id' | 'turn' | 'ignored_json' | 'created_at'
>
type Plan = Extract<RestorePlan, { ok: true }>

export async function planRestore(row: Point, o: RestoreOpts): Promise<RestorePlan> {
  try {
    if (row.state !== 'ready') return { ok: false, why: 'This message has no undo point.' }
    if (!existsSync(row.root)) return { ok: false, why: 'The folder is not there any more.' }
    return row.kind === 'git'
      ? await withGit(row, o, (g) => gitPlan(g, ignoredThen(row), row.created_at, o))
      : await copyPlan(row, o)
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  }
}

export async function applyRestore(row: Point, o: RestoreOpts & { deletes: readonly string[] }): Promise<RestoreDone> {
  try {
    if (row.state !== 'ready') return { ok: false, why: 'This message has no undo point.' }
    if (!existsSync(row.root)) return { ok: false, why: 'The folder is not there any more.' }
    if (row.kind === 'git')
      return await withGit(row, o, async (g): Promise<RestoreDone> => {
        const busy = await inProgress(g)
        if (busy) return { ok: false, why: `The folder is in the middle of ${busy}. Finish or abort it first.` }
        const plan = await gitPlan(g, ignoredThen(row), row.created_at, o)
        if (!plan.ok) return plan
        const paths = [...plan.rewrite, ...plan.recreate]
        if (paths.length) {
          const r = await g.git(['checkout-index', '-f', '-z', '--stdin'], `${paths.join('\0')}\0`)
          // it writes as it goes: a failure may come after some files are already back
          if (r.code !== 0)
            return {
              ok: false,
              partial: true,
              mayHaveChanged: paths,
              why: `The restore stopped partway: check the folder. (${(r.stderr || 'git checkout-index failed').slice(0, 200)})`,
            }
        }
        // the files are already rewritten: anything that throws from here on is a partial restore
        const removed = await removeApproved(plan, o.deletes, paths).catch(() => undefined)
        if (!removed)
          return {
            ok: false,
            partial: true,
            mayHaveChanged: paths,
            why: 'The restore stopped partway: check the folder.',
          }
        return {
          ok: true,
          rewritten: plan.rewrite,
          recreated: plan.recreate,
          blocked: plan.blocked,
          ...removed,
        }
      })
    const plan = await copyPlan(row, o)
    if (!plan.ok) return plan
    const copy = await realpathOrAncestor(row.path as string)
    const failed: string[] = []
    const put: string[] = []
    for (const p of [...plan.rewrite, ...plan.recreate]) {
      try {
        await copyBack(join(copy, p), plan.root, p)
        put.push(p)
      } catch {
        failed.push(p) // the others still come back: a half-done restore says exactly what it did
      }
    }
    // the files are already copied back: anything that throws from here on is a partial restore
    const removed = await removeApproved(plan, o.deletes, put).catch(() => undefined)
    if (!removed)
      return { ok: false, partial: true, mayHaveChanged: put, why: 'The restore stopped partway: check the folder.' }
    return {
      ok: true,
      rewritten: plan.rewrite.filter((p) => put.includes(p)),
      recreated: plan.recreate.filter((p) => put.includes(p)),
      blocked: plan.blocked,
      ...removed,
      failed: [...failed, ...removed.failed],
    }
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  }
}

// ---- what is in the way ------------------------------------------------------------------------------------------

/**
 * Whether `rel` can be written under `root` without clearing anything: every folder on the way is a real folder (not a
 * link, not a file), and the path itself, if there, is not a folder.
 */
async function writable(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/')
  let at = root
  for (const part of parts.slice(0, -1)) {
    at = join(at, part)
    const st = await lstat(at).catch(() => undefined)
    if (!st) return true // the rest is missing: mkdir makes real folders
    if (!st.isDirectory()) return false
  }
  const st = await lstat(join(root, rel)).catch(() => undefined)
  return !st?.isDirectory()
}

async function splitBlocked(root: string, paths: string[]): Promise<{ ok: string[]; blocked: string[] }> {
  const ok: string[] = []
  const blocked: string[] = []
  for (const p of paths) ((await writable(root, p)) ? ok : blocked).push(p)
  return { ok, blocked }
}

// ---- git -----------------------------------------------------------------------------------------------------

type Git = {
  root: string
  git(args: string[], input?: string): Promise<AsyncRunResult & { timedOut: boolean }>
  /** git on the REAL index, read-only (ls-files). */
  gitReal(args: string[]): Promise<AsyncRunResult>
}

/** Runs `fn` with git aimed at a temporary index that holds the point's tree. The real index is only read. */
async function withGit<T extends { ok: boolean }>(
  row: Point,
  o: RestoreOpts,
  fn: (g: Git) => Promise<T | { ok: false; why: string }>,
): Promise<T | { ok: false; why: string }> {
  if (!row.commit_id) return { ok: false, why: 'This undo point has no commit.' }
  const commit = row.commit_id
  const run = o.run ?? runCommandAsync
  const tmp = await mkdtemp(join(tmpdir(), 'talos-restore-'))
  try {
    const base = { ...cleanEnv(o.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    const env = { ...base, GIT_INDEX_FILE: join(tmp, 'index') }
    const g: Git = {
      root: row.root,
      git: async (args, input) => {
        const signal = AbortSignal.timeout(GIT_TIMEOUT_MS)
        const r = await run(['git', ...QUIET, ...args], row.root, {
          env,
          signal,
          ...(input === undefined ? {} : { input }),
        })
        return { ...r, timedOut: signal.aborted }
      },
      gitReal: (args) =>
        run(['git', ...QUIET, ...args], row.root, { env: base, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) }),
    }
    const ok = await g.git(['cat-file', '-e', `${commit}^{commit}`])
    if (ok.code !== 0) return { ok: false, why: 'The undo point is gone from the repository.' }
    // start from the real index so files that did not change keep their stat info and are not read again
    const real = await g.gitReal(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    if (real.code === 0 && existsSync(real.stdout))
      await copyIndex(real.stdout, join(tmp, 'index')).catch(() => undefined)
    let read = await g.git(['read-tree', '-m', commit])
    if (read.code !== 0) {
      // an index git cannot merge from (a conflict in it): the point's tree alone, every file read once
      await rm(join(tmp, 'index'), { force: true })
      read = await g.git(['read-tree', commit])
    }
    if (read.code !== 0) return { ok: false, why: read.stderr || 'git read-tree failed' }
    return await fn(g)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Every file git ignored when the point was taken, each with its [mtimeMs, size] then; null when the point kept none. */
function ignoredThen(row: Point): Then | null {
  const rec = readIgnored(row.ignored_json)
  if (!rec) return null
  return { paths: new Set(rec.paths), stats: rec.stats, ...(rec.incomplete ? { incomplete: true as const } : {}) }
}

type Then = { paths: Set<string>; stats: Record<string, [number, number]>; incomplete?: true }

async function gitPlan(g: Git, then: Then | null, takenAt: number, o: RestoreOpts): Promise<RestorePlan> {
  // stat info for the temporary index, so unchanged files read as unchanged (only that index is written). It exits 1
  // when files differ, which is the point; only a timeout is a failure.
  const refresh = await g.git(['update-index', '-q', '--refresh'])
  if (refresh.timedOut) return { ok: false, why: 'Comparing the folder took too long.' }
  const diff = await g.git(['diff-files', '--raw', '-z', '--no-renames'])
  if (diff.code !== 0) return { ok: false, why: diff.stderr || 'git diff-files failed' }
  // a sparse checkout: what is outside it stays out (the real index marks those paths S)
  const sparse = new Set<string>()
  const tags = await g.gitReal(['ls-files', '-t', '-z'])
  if (tags.code === 0) for (const e of tags.stdout.split('\0')) if (e.startsWith('S ')) sparse.add(e.slice(2))
  const rewrite: string[] = []
  const recreate: string[] = []
  const parts = diff.stdout.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] as string
    const path = parts[i + 1] as string
    const [srcMode, , , , status] = meta.replace(/^:/, '').split(' ')
    if (srcMode === '160000' || sparse.has(path)) continue // a repo inside the repo: only its commit was kept
    if (status === 'D') recreate.push(path)
    else rewrite.push(path)
  }
  const extra = await g.git(['ls-files', '-z', '--others', '--exclude-standard', '--no-directory'])
  if (extra.code !== 0) return { ok: false, why: extra.stderr || 'git ls-files failed' }
  const rw = await splitBlocked(g.root, rewrite)
  const rc = await splitBlocked(g.root, recreate)
  return {
    ok: true,
    kind: 'git',
    root: g.root,
    rewrite: rw.ok,
    recreate: rc.ok,
    ...(await newSince(
      g.root,
      // a folder ending in / is a repo of its own inside this one: never offered for deletion
      extra.stdout.split('\0').filter((p) => p && !p.endsWith('/') && !basename(p).startsWith(PROBE_PREFIX)),
      // a repo inside the repo was kept as its commit only: its own untracked and ignored files are in no record
      (await holdsNestedRepo(g)) ? null : then,
      takenAt,
      o,
      await gitDirOf(g),
    )),
    blocked: [...rw.blocked, ...rc.blocked],
  }
}

/**
 * Splits the files that are untracked and not ignored now into the provably new ones and the rest. A file git ignored
 * when the point was taken (the turn may have un-ignored it: an .env) was there before; with no record of that, none
 * is provably new, so none is offered for deletion. A file must also have been born after the point: a rename keeps the
 * birth time, so an ignored file the turn renamed (its content never saved) is not new either. A file system that does
 * not keep birth times proves nothing: such a file is left in place.
 */
async function newSince(
  root: string,
  now: string[],
  then: Then | null,
  takenAt: number,
  o: RestoreOpts,
  gitDir: string,
): Promise<{ extra: string[]; leftInPlace: string[]; noDeletes?: NonNullable<Plan['noDeletes']> }> {
  const none = (noDeletes: NonNullable<Plan['noDeletes']>) => ({ extra: [], leftInPlace: now, noDeletes })
  if (!then) return none({ why: 'no_record' })
  // more ignored files than the point kept: any of the rest may be gone or copied, so nothing can be proved new
  if (then.incomplete) return none({ why: 'incomplete' })
  // an ignored file from then that is gone or changed now: its old content may be in one of the new files (cp .env x;
  // rm .env, a move out of the folder, or cp .env .env.bak then an edit), and undo never restores ignored files, so no
  // new file is offered at all
  for (const p of then.paths) {
    const was = then.stats[p]
    if (!was) return none({ why: 'no_record' }) // an older record, with no stats: nothing to compare
    const st = await lstat(join(root, p)).catch(() => undefined)
    if (!st || st.mtimeMs !== was[0] || st.size !== was[1]) return none({ why: 'ignored_gone', example: p })
  }
  // birth times are trusted only on the folder's own device, only on a file system proven to keep them (PROVEN_FS),
  // and only when the probe agrees there
  const devOf = o.devOf ?? (async (p: string) => (await lstat(p)).dev)
  const trust = now.length ? await trustedDevice(root, gitDir, o) : undefined
  if (trust && 'why' in trust) return none(trust)
  const dev = trust?.dev
  if (now.length && dev === undefined) return none({ why: 'unprovable' })
  const birthOf =
    o.birthOf ??
    (async (p: string) => {
      const st = await lstat(p).catch(() => undefined)
      return st?.birthtimeMs
    })
  const extra: string[] = []
  const leftInPlace: string[] = []
  let unprovable = false
  for (const p of now) {
    if (then.paths.has(p)) {
      leftInPlace.push(p)
      continue
    }
    const birth = await birthOf(join(root, p))
    // no birth time (0 or none) proves nothing. A birth time equal to the change time is no doubt here: a new file has
    // just that, on Linux too (btrfs, ext4), and a file system that reports the change time instead fails the probe.
    // A file on another device (a mount inside the folder) was never probed: no proof either
    const onDev = (await devOf(join(root, p)).catch(() => undefined)) === dev
    if (birth === undefined || !(birth > 0) || !onDev) unprovable = true
    else (birth >= takenAt ? extra : leftInPlace).push(p)
  }
  // all or nothing: one file that cannot be proved new means none is offered, so the card never says "none" while
  // its Delete box holds names
  if (unprovable) return none({ why: 'unprovable' })
  return { extra, leftInPlace }
}

/** Devices (st_dev) whose file system failed the probe, and when: they are asked again a day on. */
export type TrustCache = Map<number, number>
const TRUST_CACHE: TrustCache = new Map()
/** A device that failed the probe is asked again after this long (and after a restart: the memory is the process's). */
export const TRUST_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The device holding `root` when its file system keeps birth times; why not, when it is a file system not proven to
 * (any not in PROVEN_FS, or one that cannot be told: fs-type.ts); undefined when the probe says no. The probe runs
 * on that same device: in the repo's git dir when it is there, else in the folder itself. Only a failed answer is
 * remembered: a device number is reused once a volume is unmounted, so a trusted one is asked again each plan.
 */
async function trustedDevice(
  root: string,
  gitDir: string,
  o: RestoreSeams,
): Promise<{ dev: number } | { why: 'fs_unproven'; fs: string } | undefined> {
  const devOf = o.devOf ?? (async (p: string) => (await lstat(p)).dev)
  const dev = await devOf(root).catch(() => undefined)
  if (dev === undefined) return undefined
  // the file system first: one not proven to keep birth times is never asked, whatever a probe would say there
  const unproven = await unprovenFs(root, o)
  if (unproven) return unproven
  const cache = o.trustCache ?? TRUST_CACHE
  const now = (o.now ?? Date.now)()
  const failedAt = cache.get(dev)
  if (failedAt !== undefined && now - failedAt < TRUST_TTL_MS) return undefined
  const dir = (await devOf(gitDir).catch(() => undefined)) === dev ? gitDir : root
  if (await (o.probe ?? probeBirthTimes)(dir)) {
    cache.delete(dev)
    return { dev }
  }
  cache.set(dev, now)
  return undefined
}

/** Why not, when the folder is on a file system not proven to keep birth times (fs-type.ts), or one that cannot be told. */
async function unprovenFs(root: string, o: RestoreSeams): Promise<{ why: 'fs_unproven'; fs: string } | undefined> {
  const fs = await (o.fsTypeOf ?? ((p: string) => fsTypeOf(p)))(root).catch(() => undefined)
  return fs !== undefined && PROVEN_FS.has(fs) ? undefined : { why: 'fs_unproven', fs: fs ?? 'unknown' }
}

type ProbeStat = { birthtimeMs: number; ctimeMs: number }

/**
 * Does this folder's file system keep birth times? A hidden file made here, then renamed a little later, must report
 * a birth time that is real (above 0), unchanged by the rename, and apart from the change time the rename moved. A
 * volume that reports the change time instead (some exFAT, SMB or NFS mounts), or none, fails, and then no new file is
 * offered for deletion. On a coarse clock (1 s on HFS+ and FAT) birth and the moved change time can share a tick: then
 * it is tried once more, a second apart. Not caught: a server that makes up a birth time from the file's other times
 * (the earliest of them); it is wrong only for a file there before that the turn both moved and rewrote. The file is
 * always removed; one a kill leaves behind is empty and named .talos-undo-probe-*.
 */
export async function probeBirthTimes(
  dir: string,
  t: { stat?: (p: string) => Promise<ProbeStat>; waitMs?: number[] } = {},
): Promise<boolean> {
  const stat = t.stat ?? lstat
  for (const wait of t.waitMs ?? [50, 1100]) {
    const a = join(dir, `${PROBE_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`)
    const b = `${a}-moved`
    try {
      await writeFile(a, '', { flag: 'wx' })
      const before = (await stat(a)).birthtimeMs
      await new Promise((r) => setTimeout(r, wait))
      await rename(a, b)
      const after = await stat(b)
      if (!(before > 0) || after.birthtimeMs !== before) return false
      if (after.birthtimeMs !== after.ctimeMs) return true
      // the same tick: no answer yet, so once more with a longer wait
    } catch {
      return false
    } finally {
      await unlink(a).catch(() => undefined)
      await unlink(b).catch(() => undefined)
    }
  }
  return false
}

/** True when the point's tree (in the temporary index) holds a repo of its own (a gitlink). */
async function holdsNestedRepo(g: Git): Promise<boolean> {
  const r = await g.git(['ls-files', '-s', '-z'])
  return r.code !== 0 || r.stdout.split('\0').some((e) => e.startsWith('160000 '))
}

/** The repo's own git dir (the probe goes there, out of the files a restore puts back). */
async function gitDirOf(g: Git): Promise<string> {
  const d = await g.git(['rev-parse', '--absolute-git-dir'])
  return d.code === 0 && d.stdout ? d.stdout : join(g.root, '.git')
}

/** What git is in the middle of, as rollback.ts names it, or undefined. */
async function inProgress(g: Git): Promise<string | undefined> {
  const dir = await g.git(['rev-parse', '--absolute-git-dir'])
  if (dir.code !== 0) return 'something git cannot tell'
  return IN_PROGRESS.find(([name]) => existsSync(join(dir.stdout, name)))?.[1]
}

// ---- copy ----------------------------------------------------------------------------------------------------

type Entry = { kind: 'file' | 'link'; size: number; mode: number }

/** Every file and link under `dir`, by path relative to it. Links are never followed. */
async function listTree(dir: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(p)
      else if (e.isSymbolicLink()) out.set(p, { kind: 'link', size: 0, mode: 0 })
      else if (e.isFile()) {
        const st = await lstat(join(dir, p))
        out.set(p, { kind: 'file', size: st.size, mode: st.mode & 0o777 })
      }
    }
  }
  await walk('')
  return out
}

async function same(a: string, b: string, ea: Entry, eb: Entry): Promise<boolean> {
  if (ea.kind !== eb.kind) return false
  if (ea.kind === 'link') return (await readlink(a)) === (await readlink(b))
  if (ea.size !== eb.size || ea.mode !== eb.mode) return false
  return (await readFile(a)).equals(await readFile(b))
}

async function copyPlan(row: Point, o: RestoreOpts): Promise<RestorePlan> {
  const copy = row.path
  if (!copy || !existsSync(copy)) return { ok: false, why: 'The saved copy is gone.' }
  // only the copy this store made for this point: <store>/<thread>/<turn>
  const store = await realpathOrAncestor(o.undoDir)
  const real = await realpathOrAncestor(copy)
  if (dirname(dirname(real)) !== store || basename(real) !== row.turn)
    return { ok: false, why: 'The saved copy is not where Talos keeps them.' }
  const root = await realpathOrAncestor(row.root)
  const [saved, now] = await Promise.all([listTree(real), listTree(root)])
  const rewrite: string[] = []
  const recreate: string[] = []
  for (const [p, e] of saved) {
    const cur = now.get(p)
    if (!cur) recreate.push(p)
    else if (!(await same(join(real, p), join(root, p), e, cur))) rewrite.push(p)
  }
  const added = [...now.keys()].filter((p) => !saved.has(p))
  const rw = await splitBlocked(root, rewrite)
  const rc = await splitBlocked(root, recreate)
  // a copy holds every file the folder had, so what it lacks is new; still, nothing is deleted on a file system not
  // proven (the same rule as a git folder's: the copy of a case-sensitive one, say, can drop a name)
  const noDeletes = added.length ? await copyNoDeletes(root, added, o) : undefined
  return {
    ok: true,
    kind: 'copy',
    root,
    rewrite: rw.ok,
    recreate: rc.ok,
    extra: noDeletes ? [] : added,
    blocked: [...rw.blocked, ...rc.blocked],
    leftInPlace: noDeletes ? added : [],
    ...(noDeletes ? { noDeletes } : {}),
  }
}

/**
 * Why none of a copy's new files may be deleted: the folder's file system is not proven, or one of them is on another
 * device (a mount inside the folder, never checked). All or nothing, as for a git folder.
 */
async function copyNoDeletes(
  root: string,
  added: string[],
  o: RestoreOpts,
): Promise<NonNullable<Plan['noDeletes']> | undefined> {
  const unproven = await unprovenFs(root, o)
  if (unproven) return unproven
  const devOf = o.devOf ?? (async (p: string) => (await lstat(p)).dev)
  const dev = await devOf(root).catch(() => undefined)
  if (dev === undefined) return { why: 'unprovable' }
  for (const p of added) if ((await devOf(join(root, p)).catch(() => undefined)) !== dev) return { why: 'unprovable' }
  return undefined
}

/** Puts one saved file back. The plan checked nothing is in the way; it is checked again right before the write. */
async function copyBack(from: string, root: string, rel: string): Promise<void> {
  if (!(await writable(root, rel))) throw new Error(`something is in the way of ${rel}`)
  const to = join(root, rel)
  await mkdir(dirname(to), { recursive: true })
  const st = await lstat(from)
  await rm(to, { force: true })
  if (st.isSymbolicLink()) await symlink(await readlink(from), to)
  else {
    await copyFile(from, to)
    await chmod(to, st.mode & 0o777)
  }
}

// ---- deletes ---------------------------------------------------------------------------------------------------

/**
 * Deletes the approved paths that are new files right now, and the folders that leaves empty. Nothing else: never a
 * folder, never through a link to a folder, never the file just restored under another case of the same name.
 */
async function removeApproved(
  plan: Plan,
  approved: readonly string[],
  restored: readonly string[],
): Promise<{ deleted: string[]; kept: string[]; failed: string[] }> {
  const extra = new Set(plan.extra)
  const keep = new Set<string>()
  for (const p of restored) {
    const st = await lstat(join(plan.root, p)).catch(() => undefined)
    if (st) keep.add(`${st.dev}:${st.ino}`)
  }
  const deleted: string[] = []
  const failed: string[] = []
  for (const p of new Set(approved)) {
    if (!extra.has(p) || isAbsolute(p) || normalize(p) !== p || p.split('/').includes('..')) continue
    const abs = join(plan.root, p)
    if (!abs.startsWith(plan.root + sep) || !(await writable(plan.root, p))) continue
    const st = await lstat(abs).catch(() => undefined)
    if (!st || st.isDirectory() || keep.has(`${st.dev}:${st.ino}`)) continue
    try {
      await unlink(abs)
    } catch {
      failed.push(p) // the restore already ran: say which new file stayed, never "nothing was changed"
      continue
    }
    deleted.push(p)
    for (let d = dirname(abs); d !== plan.root && d.startsWith(plan.root + sep); d = dirname(d)) {
      try {
        await rmdir(d) // only when empty
      } catch {
        break
      }
    }
  }
  return { deleted, kept: plan.extra.filter((p) => !deleted.includes(p)), failed }
}
