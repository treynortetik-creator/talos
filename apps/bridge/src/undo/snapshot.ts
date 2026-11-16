// Undo points: what a folder looked like just before a turn ran, so the owner can put the files back later.
//
// A git folder gets a commit under refs/talos/undo/<thread>/<turn>, built from a temporary index (GIT_INDEX_FILE): every
// file git would see, untracked ones included and ignored ones left out. Nothing the owner works with moves: HEAD, the
// branch, the real index, the stash and the reflog stay byte for byte as they were. A repo inside the repo (a submodule or
// an embedded clone) is kept as its commit id only, and an LFS file as its pointer, as `git add` would store them.
//
// The refs are ordinary refs: `git push --mirror` (or a fetch of refs/*) carries them, and `git log --all` lists their
// commits. Both are accepted: the refs are what keep the saved files alive, so they cannot be hidden.
//
// A folder git ignores (it, or a folder above it, matches .gitignore, .git/info/exclude or core.excludesFile) would make
// a commit holding none of its files, so it is copied instead, like a folder outside git.
//
// Any other folder, or any folder when git is not on PATH, is copied under the undo store in the Talos home, with an APFS
// clone on macOS and a reflink where Linux has one (a plain copy otherwise). A folder over the cap is not copied.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdtemp, readdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureDir } from '../fsutil.ts'
import { type AsyncRunResult, type RunAsync, runCommandAsync } from '../run-command.ts'

export type UndoState = 'ready' | 'not_saved' | 'too_large'
export type Snapshot =
  /**
   * `ignored`: every file git ignored in the folder when the point was taken, so a restore never takes such a file for a
   * new one. Undefined when git could not list them: then a restore offers no deletions.
   */
  | {
      state: 'ready'
      kind: 'git'
      root: string
      ref: string
      commit: string
      ignored?: string[]
      /** Each ignored file's [mtimeMs, size] then: one changed since may have left its old content in a new file. */
      ignoredStats?: Record<string, [number, number]>
      /** More ignored files than a point keeps, or a larger record: it is incomplete, so a restore offers no deletions. */
      ignoredIncomplete?: true
    }
  | { state: 'ready'; kind: 'copy'; root: string; path: string }
  | { state: 'too_large'; kind: 'git' | 'copy'; root: string }
  | { state: 'not_saved'; kind: 'git' | 'copy'; root: string; why: string }

/**
 * The ignored record a point keeps is at most this large in history.sqlite (about 2,000 files at this repo's ~130 bytes
 * each), with at most this many files: past either it keeps none and says so (incomplete), and offers no deletions.
 * Up to 50 points are kept per thread, so a thread's records stay under ~13 MB.
 */
export const IGNORED_MAX_BYTES = 256 * 1024
export const IGNORED_MAX_PATHS = 5_000

/**
 * The ignored record as history.sqlite stores it (points.ts). Past the size cap, counted in UTF-8 bytes as stored, it
 * keeps no file and says so: never stored whole.
 */
export function ignoredJson(stats: Record<string, [number, number]>, incomplete: boolean): string {
  const whole = JSON.stringify({ stats, ...(incomplete ? { incomplete: true } : {}) })
  return Buffer.byteLength(whole) > IGNORED_MAX_BYTES ? JSON.stringify({ stats: {}, incomplete: true }) : whole
}

/** A copy is skipped when the folder holds more than this, and a git point when its new and changed files do. */
export const COPY_LIMITS = { bytes: 200 * 1024 * 1024, files: 20_000 }

export type SnapshotOpts = {
  folder: string
  thread: string
  turn: string
  /** Where copies go: `paths(home).undo`. */
  undoDir: string
  /** The environment the commands run with (default the bridge's own). Its GIT_* variables are never passed on. */
  env?: Record<string, string | undefined>
  /** Kills the running command; the result is then not_saved. */
  signal?: AbortSignal
  limits?: Partial<typeof COPY_LIMITS>
  run?: RunAsync
  /** Tests: their own memory of roots past the ignored cap, and clock (default the bridge's, and Date.now). */
  ignoredCache?: IgnoredCache
  now?: () => number
}

/** Thread and message ids already fit a ref name; anything else is refused rather than escaped. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/

/** Never throws: anything that goes wrong is a not_saved point, so a turn is never held up by its undo point. */
export async function snapshotFolder(o: SnapshotOpts): Promise<Snapshot> {
  const root = resolve(o.folder)
  try {
    if (!SAFE_ID.test(o.thread) || !SAFE_ID.test(o.turn))
      return { state: 'not_saved', kind: 'copy', root, why: 'bad thread or turn id' }
    const run = o.run ?? runCommandAsync
    const env = cleanEnv(o.env ?? process.env)
    const top = await run(['git', 'rev-parse', '--show-toplevel'], root, { env, ...sig(o.signal) })
    if (o.signal?.aborted) return { state: 'not_saved', kind: 'copy', root, why: 'stopped' }
    // 127: git is not on PATH. Any other failure: not a repo. Either way the folder is copied.
    if (top.code === 0 && top.stdout && !(await ignoredByGit(run, top.stdout, root, env, o.signal)))
      return await gitSnapshot({ ...o, run, env, top: top.stdout })
    return await copySnapshot(o, root, env)
  } catch (e) {
    return { state: 'not_saved', kind: 'copy', root, why: (e as Error).message }
  }
}

const sig = (signal?: AbortSignal) => (signal ? { signal } : {})

/** True when git ignores `folder` (inside the repo at `top`), itself or through a folder above it. */
async function ignoredByGit(
  run: RunAsync,
  top: string,
  folder: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<boolean> {
  const real = await realpath(folder)
  if (real === top) return false
  const rel = relative(top, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  // the trailing slash: a directory pattern (`sub/`) matches only a path git knows is a directory
  // ./ first: a folder named ":sub" is that name, never pathspec magic (check-ignore takes no --literal-pathspecs)
  const r = await run(['git', ...QUIET, 'check-ignore', '-q', '--', `./${rel}/`], top, { env, ...sig(signal) })
  return r.code === 0
}

/** The bridge's environment without GIT_* (a GIT_DIR or GIT_INDEX_FILE from whoever started the bridge would aim git elsewhere). */
export function cleanEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('GIT_')) out[k] = v
  return out
}

/**
 * Settings that would otherwise write outside the temporary index or run the owner's code: a split index makes
 * shared-index files in .git, a file system monitor starts a daemon, auto gc repacks, logAllRefUpdates=always gives our
 * ref a reflog, and hooks (post-index-change, reference-transaction) are the owner's scripts. Clean filters still run, as
 * they must for `git add` to store what a commit would: an LFS file becomes its pointer, and git-lfs keeps the content in
 * .git/lfs/objects, as it does for any `git add`.
 */
export const QUIET = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.splitIndex=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'gc.auto=0',
  '-c',
  'core.logAllRefUpdates=false',
]

async function gitSnapshot(
  o: SnapshotOpts & { run: RunAsync; env: Record<string, string | undefined>; top: string },
): Promise<Snapshot> {
  const root = o.top
  const ref = `refs/talos/undo/${o.thread}/${o.turn}`
  const notSaved = (why: string): Snapshot => ({ state: 'not_saved', kind: 'git', root, why })
  let tmp: string | undefined
  const listing = new AbortController()
  const stopListing = () => listing.abort()
  if (o.signal?.aborted) listing.abort()
  o.signal?.addEventListener('abort', stopListing, { once: true })
  let ignoredP: Promise<IgnoredRecord | undefined> | undefined
  try {
    tmp = await mkdtemp(join(tmpdir(), 'talos-undo-'))
    const indexFile = join(tmp, 'index')
    const env = {
      ...o.env,
      GIT_INDEX_FILE: indexFile,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Talos',
      GIT_AUTHOR_EMAIL: 'talos@localhost',
      GIT_COMMITTER_NAME: 'Talos',
      GIT_COMMITTER_EMAIL: 'talos@localhost',
    }
    const git = async (...args: string[]): Promise<AsyncRunResult> => {
      if (o.signal?.aborted) return { code: 130, stdout: '', stderr: 'stopped' }
      return o.run(['git', ...QUIET, ...args], root, { env, ...sig(o.signal) })
    }
    // Start from a copy of the real index (asked for without GIT_INDEX_FILE, which --git-path would echo back): it keeps
    // tracked files that a .gitignore now matches, and unchanged files are not hashed again. The real one is only read.
    const realIndex = await o.run(
      ['git', ...QUIET, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
      root,
      {
        env: o.env,
        ...sig(o.signal),
      },
    )
    if (realIndex.code !== 0 || !realIndex.stdout) return notSaved(realIndex.stderr || 'git rev-parse failed')
    try {
      await copyIndex(realIndex.stdout, indexFile)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // no index yet: start empty
    }
    // the ignored listing runs beside the steps below: it reads the temp index, which they only replace whole (git
    // writes an index to a lock file and renames it), and add stores no ignored file, so each version lists the same
    ignoredP = listIgnored(o, root, env, listing.signal).catch(() => undefined) // undefined: no record
    // The same cap as a copy, on what add would newly store: untracked files that are not ignored, and tracked files that
    // changed (the refresh, on the temp index only, keeps an untouched file from counting). It is measured before add
    // runs, so a point that is too large writes no object and no ref, and its temp index is removed. Two edges: a file
    // whose mode alone changed counts with its whole size (so the cap errs toward too_large), and in an LFS repo the
    // refresh runs git-lfs's clean filter on a touched file, which can store its content in .git/lfs/objects.
    const untracked = await git('ls-files', '-z', '--others', '--exclude-standard', '--no-directory')
    if (untracked.code !== 0) return notSaved(untracked.stderr || 'git ls-files failed')
    await git('update-index', '-q', '--refresh')
    const changed = await git('diff-files', '--name-only', '-z')
    if (changed.code !== 0) return notSaved(changed.stderr || 'git diff-files failed')
    const names = [...untracked.stdout.split('\0'), ...changed.stdout.split('\0')].filter(Boolean)
    if (await overCap(root, names, { ...COPY_LIMITS, ...o.limits }, o.signal))
      return { state: 'too_large', kind: 'git', root }
    // --sparse: in a sparse checkout, untracked files outside it are saved too, and the files it leaves out keep their
    // place in the index (git 2.34+; an older git has no sparse checkout to need it)
    let add = await git('add', '-A', '--sparse', '--', '.', NO_PROBES)
    if (add.code !== 0 && /unknown option|usage: git add/.test(add.stderr))
      add = await git('add', '-A', '--', '.', NO_PROBES)
    if (add.code !== 0) return notSaved(add.stderr || 'git add failed')
    const tree = await git('write-tree')
    if (tree.code !== 0) return notSaved(tree.stderr || 'git write-tree failed')
    const head = await git('rev-parse', '-q', '--verify', 'HEAD^{commit}')
    const parent = head.code === 0 && head.stdout ? ['-p', head.stdout] : [] // no commit yet: a commit with no parent
    const commit = await git('commit-tree', '--no-gpg-sign', ...parent, '-m', `Talos undo point ${o.turn}`, tree.stdout)
    if (commit.code !== 0) return notSaved(commit.stderr || 'git commit-tree failed')
    const rec = await ignoredP
    const keepIgnored = rec && !rec.incomplete ? rec : undefined
    const upd = await git('update-ref', ref, commit.stdout)
    if (upd.code !== 0) return notSaved(upd.stderr || 'git update-ref failed')
    return {
      state: 'ready',
      kind: 'git',
      root,
      ref,
      commit: commit.stdout,
      ...(keepIgnored ? { ignored: keepIgnored.paths, ignoredStats: keepIgnored.stats } : {}),
      ...(rec?.incomplete ? { ignored: [], ignoredStats: {}, ignoredIncomplete: true as const } : {}),
    }
  } catch (e) {
    return notSaved((e as Error).message)
  } finally {
    // a point that ended early stops its listing, which reads the temp index, before that index is removed
    listing.abort()
    o.signal?.removeEventListener('abort', stopListing)
    await ignoredP?.catch(() => undefined)
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Roots whose last listing ran past either cap, with when and their top ignored folders' mtimes then. */
export type IgnoredCache = Map<string, { at: number; dirs: Record<string, number> }>
const IGNORED_CACHE: IgnoredCache = new Map()
/** A root marked incomplete from memory is listed again after this long, in case it shrank under the cap. */
export const IGNORED_RELIST_MS = 60 * 60 * 1000

type IgnoredRecord = { paths: string[]; stats: Record<string, [number, number]>; incomplete: boolean }

/**
 * Every file git ignores here now (.env, build/sub/secret), one by one, with its mtime and size: a later restore must
 * never take one of these for a new file, even when the turn un-ignored, renamed or copied it, at any depth, and an
 * ignored file changed since may have left its old content in a new one (cp .env .env.bak, then an edit). Past a cap
 * the record says so (incomplete), never silently cut. git lists an ignored repo inside the repo as one folder (`dir/`),
 * not its files: that is incomplete too. A root that was past either cap last time, whose top ignored folders have not
 * changed, is incomplete again without listing (at most an hour): the listing alone takes about a second there.
 * Undefined when git could not list them.
 */
async function listIgnored(
  o: SnapshotOpts & { run: RunAsync },
  root: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<IgnoredRecord | undefined> {
  const cache = o.ignoredCache ?? IGNORED_CACHE
  const now = (o.now ?? Date.now)()
  const incomplete: IgnoredRecord = { paths: [], stats: {}, incomplete: true }
  const known = cache.get(root)
  if (known && now - known.at < IGNORED_RELIST_MS && (await sameTimes(root, known.dirs))) return incomplete
  const ign = await o.run(
    ['git', ...QUIET, 'ls-files', '-z', '--others', '-i', '--exclude-standard', '--no-directory'],
    root,
    {
      env,
      signal,
      stopAt: { nuls: IGNORED_MAX_PATHS, bytes: IGNORED_MAX_BYTES },
    },
  )
  if (ign.code !== 0 || signal.aborted) return undefined
  // a restore's probe file, caught while it exists, is no file of the owner's (it is gone again in ms)
  const listed = ign.stdout.split('\0').filter((p) => p && !(p.split('/').pop() ?? '').startsWith(PROBE_PREFIX))
  if (ign.stopped || listed.length > IGNORED_MAX_PATHS || ign.stdout.length > IGNORED_MAX_BYTES) {
    cache.set(root, { at: now, dirs: await topTimes(root, listed) })
    return incomplete
  }
  cache.delete(root)
  if (listed.some((p) => p.endsWith('/'))) return incomplete
  const stats: Record<string, [number, number]> = Object.create(null) // a file named __proto__ is a key too
  let gone = false
  for (let i = 0; i < listed.length && !gone; i += 256)
    await Promise.all(
      listed.slice(i, i + 256).map(async (p) => {
        const st = await lstat(join(root, p)).catch(() => undefined)
        if (st) stats[p] = [st.mtimeMs, st.size]
        else gone = true // gone while listed: its state then is not known
      }),
    )
  if (signal.aborted) return undefined
  if (gone) return incomplete
  // the record as it is stored: past the size cap it is incomplete, remembered like a list past the count cap
  if (Buffer.byteLength(JSON.stringify({ stats })) > IGNORED_MAX_BYTES) {
    cache.set(root, { at: now, dirs: await topTimes(root, listed) })
    return incomplete
  }
  return { paths: listed, stats, incomplete: false }
}

/** The mtimes of the root and of the top folders the listed paths sit in (`node_modules` for node_modules/a/b.js). */
async function topTimes(root: string, listed: string[]): Promise<Record<string, number>> {
  // the root itself too ('' ), so files past a cap that sit right in it are seen to change
  const tops = new Set(['', ...listed.filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/')))])
  const out: Record<string, number> = {}
  for (const d of tops) {
    const st = await lstat(join(root, d)).catch(() => undefined)
    if (st) out[d] = st.mtimeMs
  }
  return out
}

async function sameTimes(root: string, dirs: Record<string, number>): Promise<boolean> {
  for (const [d, t] of Object.entries(dirs)) {
    const st = await lstat(join(root, d)).catch(() => undefined)
    if (st?.mtimeMs !== t) return false
  }
  return true
}

/** True when the listed files (relative to `root`) hold more than the limits. A file that vanished counts as nothing. */
async function overCap(root: string, names: string[], limits: typeof COPY_LIMITS, signal?: AbortSignal) {
  if (names.length > limits.files) return true
  let bytes = 0
  for (let i = 0; i < names.length; i += 256) {
    if (signal?.aborted) throw new Error('stopped')
    const sizes = await Promise.all(
      names.slice(i, i + 256).map((n) =>
        lstat(join(root, n)).then(
          (st) => (st.isFile() ? st.size : 0),
          () => 0,
        ),
      ),
    )
    for (const sz of sizes) bytes += sz
    if (bytes > limits.bytes) return true
  }
  return false
}

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
/** The real path of `p`, or of its nearest folder that exists with the rest appended (the store may not exist yet). */
export async function realpathOrAncestor(p: string): Promise<string> {
  const abs = resolve(p)
  try {
    return await realpath(abs)
  } catch {
    const up = dirname(abs)
    return up === abs ? abs : join(await realpathOrAncestor(up), abs.slice(up.length))
  }
}

/**
 * Copies a git index and keeps its modification time. Git trusts an entry whose file is no newer than the index (the
 * racy-git rule): a copy stamped now would make an edit made in the same second as the real index look unchanged.
 */
export async function copyIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to)
  const st = await stat(from)
  await utimes(to, st.atime, st.mtime)
}

/**
 * The name of restore.ts's birth-time probe file. A point never keeps one (it may be caught while it exists, for a few
 * ms), so a later undo never brings one back, and a restore never lists one as a file of the owner's.
 */
export const PROBE_PREFIX = '.talos-undo-probe-'
/** The pathspec that keeps probe files out of a git point, at any depth. */
const NO_PROBES = `:(exclude,glob)**/${PROBE_PREFIX}*`

/** True when `p` is `dir` or anywhere under it. */
export const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** True when the folder holds more than the limits. Stops counting as soon as it knows. */
async function overLimits(folder: string, limits: typeof COPY_LIMITS, signal?: AbortSignal): Promise<boolean> {
  let files = 0
  let bytes = 0
  const stack = [folder]
  while (stack.length) {
    if (signal?.aborted) throw new Error('stopped')
    const dir = stack.pop() as string
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      files++
      if (e.isFile()) bytes += (await lstat(p)).size
      if (files > limits.files || bytes > limits.bytes) return true
    }
  }
  return false
}

/** Why a copy point was not saved: its copy did not hold exactly the folder's names (card.ts says so). */
export const NAMES_DIFFER = 'names_differ'

/**
 * Every name under `dir`, as the bytes the file system gave, a folder's own entries after it. A link is a name, never
 * followed. A restore's probe file at the top is left out (the copy drops it).
 */
async function namesOf(dir: string): Promise<Set<string>> {
  const out = new Set<string>()
  const walk = async (rel: Buffer) => {
    const at = rel.length ? Buffer.concat([Buffer.from(dir), Buffer.from('/'), rel]) : Buffer.from(dir)
    // names as bytes (Bun gives no Dirent name with a buffer encoding, so each is lstat'd for its kind)
    // (Bun hands back plain Uint8Arrays: made Buffers, so they decode and print as bytes)
    for (const raw of await readdir(at, { encoding: 'buffer' })) {
      const name = Buffer.from(raw)
      if (!rel.length && name.toString('utf8').startsWith(PROBE_PREFIX)) continue
      const p = rel.length ? Buffer.concat([rel, Buffer.from('/'), name]) : name
      out.add(p.toString('hex'))
      // a name gone since its folder was read is still a name (the compare then fails on it), never a folder to walk
      const st = await lstat(Buffer.concat([at, Buffer.from('/'), name])).catch(() => undefined)
      if (st?.isDirectory()) await walk(p)
    }
  }
  await walk(Buffer.alloc(0))
  return out
}

async function sameNames(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([namesOf(a), namesOf(b)])
  return x.size === y.size && [...x].every((n) => y.has(n))
}

async function copySnapshot(
  o: SnapshotOpts,
  folder: string,
  env: Record<string, string | undefined>,
): Promise<Snapshot> {
  let root = folder
  const notSaved = (why: string): Snapshot => ({ state: 'not_saved', kind: 'copy', root, why })
  try {
    root = await realpath(folder)
    const store = await realpathOrAncestor(o.undoDir)
    if (inside(store, root) || inside(root, store)) return notSaved('the folder holds, or is in, the undo store')
    if (await overLimits(root, { ...COPY_LIMITS, ...o.limits }, o.signal))
      return { state: 'too_large', kind: 'copy', root }
    ensureDir(o.undoDir)
    ensureDir(join(o.undoDir, o.thread))
    const dest = join(o.undoDir, o.thread, o.turn)
    const part = `${dest}.part-${randomBytes(4).toString('hex')}`
    // cp by full path: the PATH given may not have it. A clone first; a plain copy where the disk or cp cannot clone.
    const cp = ['/bin/cp', '/usr/bin/cp'].find((c) => existsSync(c))
    if (!cp) return notSaved('no cp')
    const tries =
      process.platform === 'darwin'
        ? [
            [cp, '-c', '-pR', root, part],
            [cp, '-pR', root, part],
          ]
        : [
            [cp, '-a', '--reflink=auto', root, part],
            [cp, '-a', root, part],
          ]
    let last = ''
    for (const cmd of tries) {
      const r = await (o.run ?? runCommandAsync)(cmd, dirname(dest), { env, ...sig(o.signal) })
      if (r.code === 0 && !o.signal?.aborted) {
        // a probe file caught by the copy is dropped from it. The probe only writes at a git toplevel or in its git dir,
        // so only the copy's top level is looked at: no walk, so no link to a folder is ever followed
        for (const n of await readdir(part)) if (n.startsWith(PROBE_PREFIX)) await rm(join(part, n), { force: true })
        // the copy must hold exactly the folder's names, byte for byte: a case-insensitive undo store keeps one of A.txt
        // and a.txt, and a restore would then take the other for a new file. Not trusted, so not saved
        const same = await sameNames(root, part).catch(() => undefined)
        if (same !== true) {
          await rm(part, { recursive: true, force: true })
          return notSaved(same === false ? NAMES_DIFFER : 'the names could not be compared')
        }
        await rm(dest, { recursive: true, force: true })
        await rename(part, dest)
        return { state: 'ready', kind: 'copy', root, path: dest }
      }
      last = r.stderr || `cp exited ${r.code}`
      await rm(part, { recursive: true, force: true })
      if (o.signal?.aborted) return notSaved('stopped')
    }
    return notSaved(last)
  } catch (e) {
    return notSaved((e as Error).message)
  }
}
