// The PermissionRequest hook a thread session runs (docs/CLAUDE-CODE.md C3.9): where it comes from, the copy the session runs,
// and the python3 that runs it. The hook is how a thread session's approval prompts reach the phone; a command that runs nothing
// leaves every prompt at the terminal with no card and no word (Delphi, 2026-11-11), so a start whose hook cannot run is refused.
//
// The source is the active SEALED kit release ($TALOS_KIT_HOME, else $TALOS_VENDOR_DIR/kit, else ~/.local/share/talos/kit:
// current -> releases/<version>/talos-kit), never the checkout: a thread working in the checkout under acceptEdits edits its
// files without a prompt, and would rewrite the script that answers its own prompts (R1-1). A release is read-only, outside every
// thread folder, and records a hash of everything in it, which is checked. At every start the hook and its helper are copied
// into the fenced Talos home (workers/_hook) and the session runs that copy, with a python3 resolved now from outside its
// folders (R1-7), written into the command by absolute path. On a Talos distro (rooted-kit.ts) there is no copy: the session runs
// root's own file in root's kit, which the talos user cannot overwrite (Fable R2-3).
import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '../fsutil.ts'
import { realFileOrNull } from '../real-file.ts'
import { kitAnchor, UPDATE_THE_KIT } from './rooted-kit.ts'

/** The checkout's kit: only ever named in the command that installs a release from it, never run from. */
export const KIT_DIR = resolve(import.meta.dir, '..', '..', '..', '..', 'kit')
const HOOK = 'permission-relay.py'
/** The helper the hook imports from its own folder (optional there: the hook runs without it, minus its kill-switch file). */
const HELPER = '_talos_common.py'
const PLUGIN = 'talos-kit'
/**
 * The thread-state hook (kit/hooks/thread-state.py) and the one it reuses for a thread's compaction carry, staged next to the
 * permission hook the same way: only from the verified release, only those bytes. Both or neither: a release that lacks either (an
 * older kit) gives a session without the thread-state hooks, never a start that fails, and no old copy is left to run in its place.
 */
export const STATE_HOOK = 'thread-state.py'
export const STATE_FILES = [STATE_HOOK, 'compaction-guard.py'] as const

/** The kit's vendor folder, exactly as kit/scripts/plugin-release.py vendor_default() finds it (an empty value is unset; absolute). */
export function kitVendor(env: Record<string, string | undefined>, home: string = env.HOME || homedir()): string {
  if (env.TALOS_KIT_HOME) return resolve(env.TALOS_KIT_HOME)
  return resolve(env.TALOS_VENDOR_DIR || join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'talos'), 'kit')
}

/** The one command that installs (builds, seals and activates) a release from this checkout's kit, into `vendor`. */
export const installReleaseCommand = (vendor: string) =>
  `python3 ${KIT_DIR}/scripts/plugin-release.py build --source ${KIT_DIR} --vendor ${vendor} --activate`

/**
 * The folder the session's copy lives in: inside the Talos home, which every thread session is fenced out of and only the owner
 * can write. `_hook` is no thread id (ids are letters, digits and dashes).
 */
export const workerHookDir = (talosHome: string) => join(talosHome, 'workers', '_hook')

const isExecutableFile = (p: string) => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}
// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
const realOrNull = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}
/**
 * Which python3 is trusted: the system's own folder, tried before any PATH entry, and the user the session runs as (an
 * interpreter that user could change is passed over). This is the Linux supervisor's choice. On a Mac, /usr/bin/python3 is
 * Apple's xcrun launcher (a stub that runs the developer tools' python3 and exports SDKROOT, CPATH, LIBRARY_PATH and
 * MANPATH); the Mac app chooses its interpreter itself (WorkerHookPython.swift skips the stub), and only these tests run there. Tests that build a stand-in python3 in a temp folder set these for their
 * own run (no preferred folder, no user's files refused) and put them back; nothing else changes them.
 */
export const PYTHON_RULES: { preferredDir: string | null; trustedOwner: number } = {
  preferredDir: '/usr/bin',
  // besides root, the one owner an interpreter or a folder above it may have: none (-1). Tests name their own user here.
  trustedOwner: -1,
}

/**
 * The session's user could change `p`: owned by that user (who can chmod it), or writable by group or others. A path that
 * cannot be read counts as changeable. Root (uid 0) owning it is the one owner trusted (PYTHON_RULES.trustedOwner: a test's own).
 */
function userCanChange(p: string, trusted: number): boolean {
  try {
    const st = statSync(p)
    return (st.mode & 0o022) !== 0 || (st.uid !== 0 && st.uid !== trusted)
  } catch {
    return true
  }
}

/**
 * Some folder from `dir` up to `/` could be changed by someone other than root, so the interpreter under it could be swapped
 * (a folder renamed and another put in its place): owned by anyone but root, or writable by group or others. A sticky folder that
 * root owns (`/tmp`) is the one writable kind allowed: nobody can rename what another user put there. Unreadable counts as
 * changeable.
 */
export function ancestryChangeable(dir: string, trusted: number = PYTHON_RULES.trustedOwner): boolean {
  for (let d = dir; ; d = dirname(d)) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(d)
    } catch {
      return true
    }
    const stickyRoot = (st.mode & 0o1000) !== 0 && st.uid === 0
    if ((st.mode & 0o022) !== 0 && !stickyRoot) return true
    if (st.uid !== 0 && st.uid !== trusted) return true
    if (dirname(d) === d) return false
  }
}

/** `p` is `folder` or inside it (both real paths). */
const within = (p: string, folder: string) => p === folder || p.startsWith(folder.endsWith(sep) ? folder : folder + sep)

/** A `#!` script (a pyenv or asdf shim, a wrapper): it may pick its interpreter from the folder it is run in. */
const isScript = (p: string) => {
  try {
    const fd = openSync(p, 'r')
    try {
      const b = Buffer.alloc(2)
      return readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === '#!'
    } finally {
      closeSync(fd)
    }
  } catch {
    return true
  }
}

/**
 * The first python3 on `env.PATH` that is a real interpreter, from an absolute entry that is not, and does not lead, inside any
 * of `outside` (the thread's folder, the agent folder): a python3 a thread could put there would run its own approvals (R1-7).
 * Its link is resolved and the REAL file is returned (what the command runs); a version manager's shim (a `#!` script, or one
 * whose real file is not named python3, such as mise's) is passed over, for it reads its choice from the folder it runs in,
 * which is the thread's. An empty or relative entry is the thread folder at run time, so it is never used either.
 * The owner's home is walled off too (a ~/.local/bin, conda, uv or mise python, and its stdlib, is the session's to write), as
 * the Mac does, and so is any interpreter the session's own user could change: the file or its folder owned by that user, or
 * writable by group or others (Fable R1-1). /usr/bin/python3 is tried first, whatever the PATH says.
 */
export function findPython3(
  env: Record<string, string>,
  outside: readonly string[] = [],
  trusted: number = PYTHON_RULES.trustedOwner,
): string | null {
  const home = env.HOME && isAbsolute(env.HOME) ? [env.HOME] : []
  const fences = [...outside, ...home].map(realOrNull).filter((f): f is string => f !== null)
  const preferred = PYTHON_RULES.preferredDir
  const dirs = [...(preferred ? [preferred] : []), ...(env.PATH ?? '').split(delimiter).filter((d) => d !== preferred)]
  for (const d of dirs) {
    if (!isAbsolute(d)) continue
    const p = join(d, 'python3')
    if (!isExecutableFile(p)) continue
    const realDir = realOrNull(d)
    // on macOS the realpath of a file can report another hard-linked name; resolve files with realFileSync (real-file.ts)
    const realBin = realFileOrNull(p)
    if (!realDir || !realBin) continue
    if (fences.some((f) => within(realDir, f) || within(realBin, f))) continue
    if (!/^python3(\.\d+)*$/.test(basename(realBin)) || isScript(realBin)) continue
    if (userCanChange(realBin, trusted) || ancestryChangeable(dirname(realBin), trusted)) continue
    return realBin
  }
  return null
}

/** Why `script` is not a hook that can be run, or null: an absolute path to a readable regular file (links followed). */
function scriptProblem(script: string): string | null {
  if (!isAbsolute(script)) return `the permission hook ${script} is not an absolute path`
  try {
    if (!statSync(script).isFile()) return `the permission hook ${script} is not a file`
    accessSync(script, constants.R_OK)
  } catch {
    return `the permission hook ${script} is missing or cannot be read`
  }
  return null
}

/** One hash over every file's path, executable bit and bytes: kit/scripts/plugin-release.py content_sha, ported (a test pins it). */
/** Names in Python's sorted() order: by code point (the same as UTF-8 bytes), never JS's default UTF-16 units (Fable R1-6). */
const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

export function releaseContentSha(root: string): string {
  const h = createHash('sha256')
  const walk = (dp: string) => {
    const entries = readdirSync(dp, { withFileTypes: true })
    // os.walk lists a link to a folder among the folders and never goes into it; a link to a file is read as the file
    const linkToDir = (n: string) => statSync(join(dp, n)).isDirectory()
    const files = entries
      .filter((e) => (e.isSymbolicLink() ? !linkToDir(e.name) : !e.isDirectory()))
      .map((e) => e.name)
      .sort(byCodePoint)
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name !== '__pycache__')
      .map((e) => e.name)
      .sort(byCodePoint)
    for (const n of files) {
      if (n.endsWith('.pyc')) continue
      const p = join(dp, n)
      const rel = relative(root, p).split(sep).join('/')
      if (rel === '.talos-release') continue
      // a FIFO or a device would block or lie: a release holds regular files only
      if (!statSync(p).isFile()) throw new Error(`${p} is not a regular file`)
      let x = false
      try {
        accessSync(p, constants.X_OK)
        x = true
      } catch {}
      h.update(Buffer.concat([Buffer.from(rel), Buffer.from([0]), Buffer.from(x ? 'x' : '-'), Buffer.from([0])]))
      h.update(readFileSync(p))
      h.update(Buffer.from([0]))
    }
    for (const d of dirs) walk(join(dp, d))
  }
  walk(root)
  return h.digest('hex')
}

/** A release checked once per supervisor run, by what its hook files look like on disk: an edit (even resealed) is a new key. */
const verified = new Map<string, { hook: string; helper: string | null; state: Record<string, string> | null } | null>()
// ctime is in the key: userspace can set mtime back (touch -r), never ctime
const fileKey = (p: string) => {
  try {
    const s = statSync(p)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    return 'none'
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Who may own a file of the release: root alone when root keeps the kit (rooted), else this account or root. A test can own a
 * file only as itself, so the rule is tested on its own here.
 */
export function releaseOwnerOk(owner: number, rooted: { root: number } | null, me: number | undefined): boolean {
  if (rooted) return owner === rooted.root
  return me === undefined || owner === me || owner === 0
}

/**
 * The release's hook, checked, with the SHA-256 of its hook and helper as they were when the release's content was verified: the
 * copy is made only of exactly those bytes, so nothing can be swapped in between the check and the copy.
 */
export type ReleaseHook =
  | {
      source: string
      release: string
      verified: { hook: string; helper: string | null; state: Record<string, string> | null }
      rooted?: true
    }
  | { problem: string }

/**
 * The hook of the active sealed kit release, or why there is none a session may run. `inside` are folders the release must not
 * be in (the starting thread's folder, the agent folder). Each problem says how to fix it.
 */
export function releaseHook(vendor: string, inside: readonly string[] = []): ReleaseHook {
  // on a box root set up, only root's kit (rooted-kit.ts): `vendor` (the home one, TALOS_KIT_HOME) is never used there
  const anchor = kitAnchor()
  if ('refused' in anchor) return { problem: anchor.refused }
  const rooted = anchor.mode === 'rooted' ? anchor : null
  const v = rooted ? rooted.vendor : vendor
  try {
    return checkRelease(v, inside, rooted)
  } catch (e) {
    // a release this cannot even read (a FIFO in it, an unreadable file) is refused, never a start that throws
    return {
      problem: `the kit release cannot be checked (${(e as Error).message}); ${rooted ? UPDATE_THE_KIT : `install a sealed release with: ${installReleaseCommand(v)}`}`,
    }
  }
}

function checkRelease(
  vendor: string,
  inside: readonly string[],
  rooted: { version: string; sha: string; root: number } | null,
): ReleaseHook {
  const fix = rooted ? UPDATE_THE_KIT : `install a sealed release with: ${installReleaseCommand(vendor)}`
  const real = realOrNull(join(vendor, 'current'))
  if (!real) return { problem: `this install has no sealed kit release (${join(vendor, 'current')}); ${fix}` }
  const releases = realOrNull(join(vendor, 'releases'))
  if (!releases || dirname(real) !== releases)
    return {
      problem: `the kit release ${join(vendor, 'current')} does not point at one of ${join(vendor, 'releases')}; ${fix}`,
    }
  // root's record names the version: current must be exactly that release
  if (rooted && basename(real) !== rooted.version)
    return { problem: `the kit installed for this PC is not the one root recorded; ${fix}` }
  const plugin = join(real, PLUGIN)
  const source = join(plugin, 'hooks', HOOK)
  const helper = join(plugin, 'hooks', HELPER)
  const stateFiles = STATE_FILES.map((n) => join(plugin, 'hooks', n))
  // the state files import the helper from their own folder: no helper, no state hook
  const hasState = existsSync(helper) && stateFiles.every((f) => existsSync(f))
  const uid = process.getuid?.()
  // every folder from root's kit up to / root's (or a root-owned sticky one): a folder another account could write lets the
  // kit be renamed away and another put in its place (Fable R1-3)
  if (rooted && ancestryChangeable(vendor, rooted.root))
    return { problem: `the kit's folder ${vendor}, or one above it, is not root's own; ${fix}` }
  // the hook runs in place and imports its helper from root's folder, where Python prefers a matching cached .pyc, which the
  // digest leaves out: root's release holds none (Fable R3-2)
  const cached = rooted ? cachedBytecode(real) : null
  if (cached) return { problem: `the kit installed for this PC holds cached Python code (${cached}); ${fix}` }
  const rootedPaths = rooted ? [vendor, join(vendor, 'current'), join(vendor, 'releases')] : []
  for (const p of rootedPaths) {
    // root's own folders and link: nobody else may have put them there
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(p)
    } catch {
      return { problem: `the kit has no ${p}; ${fix}` }
    }
    if (!releaseOwnerOk(st.uid, rooted, uid) || (!st.isSymbolicLink() && (st.mode & 0o022) !== 0))
      return { problem: `the kit's ${p} is not root's own; ${fix}` }
  }
  for (const p of [
    real,
    plugin,
    join(plugin, 'hooks'),
    source,
    ...(existsSync(helper) ? [helper] : []),
    ...(hasState ? stateFiles : []),
  ]) {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(p)
    } catch {
      return { problem: `the kit release has no ${p}; ${fix}` }
    }
    if (st.isSymbolicLink())
      return { problem: `the kit release's ${p} is a link, not part of a sealed release; ${fix}` }
    if ((st.mode & 0o222) !== 0)
      return { problem: `the kit release's ${p} can be written, so the release is not sealed; ${fix}` }
    if (!releaseOwnerOk(st.uid, rooted, uid))
      return {
        problem: rooted
          ? `the kit release's ${p} is not root's own; ${fix}`
          : `the kit release's ${p} belongs to another account; ${fix}`,
      }
  }
  for (const f of inside.map(realOrNull)) {
    if (f && within(real, f))
      return { problem: `the kit release ${real} is inside ${f}, a folder a thread session works in; ${fix}` }
  }
  const key = `${rooted ? `rooted:${rooted.sha}` : ''}|${plugin}|${fileKey(source)}|${fileKey(helper)}|${stateFiles.map(fileKey).join('|')}|${fileKey(join(plugin, '.talos-release'))}`
  let ok = verified.get(key)
  if (ok === undefined) {
    // rooted: the digest root worked out and recorded (never the release's own record, which travels with it)
    let recorded = rooted ? rooted.sha : ''
    if (!rooted)
      try {
        recorded =
          /^content_sha256=([0-9a-f]{64})$/m.exec(readFileSync(join(plugin, '.talos-release'), 'utf8'))?.[1] ?? ''
      } catch {}
    // the hook's own bytes are read before the whole is hashed: if they change in between, the copy's check refuses them
    const hook = sha(readFileSync(source))
    const help = existsSync(helper) ? sha(readFileSync(helper)) : null
    const state = hasState
      ? Object.fromEntries(STATE_FILES.map((n, k) => [n, sha(readFileSync(stateFiles[k] as string))]))
      : null
    ok = recorded !== '' && releaseContentSha(plugin) === recorded ? { hook, helper: help, state } : null
    verified.set(key, ok)
  }
  if (!ok)
    return {
      problem: rooted
        ? `the kit installed for this PC does not match root's record of it; ${fix}`
        : `the kit release ${real} does not match its own record (it was changed after it was built); remove it, then ${fix}`,
    }
  return { source, release: real, verified: ok, ...(rooted ? { rooted: true as const } : {}) }
}

/** The first __pycache__ folder or .pyc file anywhere under `dir` (links are not followed), or null. */
function cachedBytecode(dir: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) return p
    if (e.isDirectory()) {
      const inner = cachedBytecode(p)
      if (inner) return inner
    }
  }
  return null
}

/**
 * Rooted mode (Fable R2-3): the session runs root's own file where it is, never a copy. A copy in the Talos home is the talos
 * user's to overwrite after a clean start; root's file under /opt/talos-app/kit is not. Only the python3 is resolved here.
 */
export function rootedWorkerHook(
  source: string,
  env: Record<string, string>,
  resolvePython: (env: Record<string, string>, outside: readonly string[]) => string | null = findPython3,
  outside: readonly string[] = [],
): HookPlace | { problem: string } {
  const why = scriptProblem(source)
  if (why) return { problem: why }
  const python = resolvePython(env, outside)
  if (!python || !isAbsolute(python)) return { problem: NO_PYTHON }
  try {
    const helperPath = join(dirname(source), HELPER)
    const helper = scriptProblem(helperPath) === null ? readFileSync(helperPath) : null
    // a Talos distro runs no thread-state hook yet (rootedHookOnly allows exactly one hook): no staged state files
    return { script: source, python, hook: readFileSync(source), helper, state: null }
  } catch (e) {
    return { problem: `the permission hook ${source} cannot be read: ${(e as Error).message}` }
  }
}

/**
 * Where a session's permission hook runs, and its bytes (the hook and its helper): a release that changes the hook changes the
 * launch spec, so sessions restart for it on update (launch-spec.ts).
 */
export type HookPlace = {
  script: string
  python: string
  hook: Buffer
  helper: Buffer | null
  /** The thread-state hook's files by name (STATE_FILES) as staged, or null: no thread-state hook for this session. */
  state: Record<string, Buffer> | null
}

/**
 * Makes `dir` if it is missing (one level: its parent must already be there), never through a link (R1-9), then checks it is a
 * plain folder of this account that no other account can write. Why not, or null.
 */
function plainFolder(d: string, make = true): string | null {
  // not there: made now, or (a dry plan) one the real start would make, which it then checks as below
  if (!make && !existsSync(d) && !isLink(d)) return null
  try {
    if (!existsSync(d) && !isLink(d)) mkdirSync(d, { mode: 0o700 })
  } catch {
    return `${d} cannot be read`
  }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(d)
  } catch {
    return `${d} cannot be read`
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${d} is not a plain folder`
  if (process.getuid && st.uid !== process.getuid()) return `${d} belongs to another account`
  if ((st.mode & 0o022) !== 0) return `${d} can be written by other accounts`
  return null
}
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export const NO_PYTHON =
  "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run"

/** Why a session could not run the hook: the start's preflight, before a slot is taken (nothing is written). */
export function permissionHookProblem(
  vendor: string,
  env: Record<string, string>,
  /** Every folder a session works in (the agent folder and each thread's): the same fences the start itself uses. */
  outside: readonly string[] = [],
): string | null {
  const r = releaseHook(vendor, outside)
  if ('problem' in r) return r.problem
  return findPython3(env, outside) ? null : NO_PYTHON
}

/**
 * The hook the session runs: `source` (a release's, checked by releaseHook) and its helper copied into the fenced folder (0600,
 * written whole), and the python3 the session's PATH names outside `outside`, resolved now and written into the command. Or why
 * not: then the start is refused.
 */
export function installWorkerHook(
  talosHome: string,
  source: string,
  env: Record<string, string>,
  resolvePython: (env: Record<string, string>, outside: readonly string[]) => string | null = findPython3,
  outside: readonly string[] = [],
  /** The hashes releaseHook verified: only those exact bytes are copied. */
  expect?: { hook: string; helper: string | null; state: Record<string, string> | null },
  /** Only what it would be (the update check's dry plan): no folder made or checked, nothing copied. */
  dry = false,
): HookPlace | { problem: string } {
  const why = scriptProblem(source)
  if (why) return { problem: why }
  const python = resolvePython(env, outside)
  if (!python || !isAbsolute(python)) return { problem: NO_PYTHON }
  const dir = workerHookDir(talosHome)
  const script = join(dir, HOOK)
  // workers/ first, checked, then _hook in it: nothing is ever made through a link planted at either (R1-9). A dry plan runs the
  // same checks and makes nothing (a folder not there yet is one the real start would make): the two agree on refuse or accept
  for (const d of [dirname(dir), dir]) {
    const unsafe = plainFolder(d, !dry)
    if (unsafe) return { problem: `the permission hook's folder ${unsafe}` }
  }
  if ((!dry || existsSync(dir)) && realOrNull(dir) !== join(realOrNull(talosHome) ?? talosHome, 'workers', '_hook')) {
    const unsafe = `${dir} is not inside the Talos home`
    return { problem: `the permission hook's folder ${unsafe}` }
  }
  let hookBytes: Buffer
  let helperBytes: Buffer | null
  let stateBytes: Record<string, Buffer> | null = null
  try {
    hookBytes = readFileSync(source)
    const helperPath = join(dirname(source), HELPER)
    helperBytes = scriptProblem(helperPath) === null ? readFileSync(helperPath) : null
    // the thread-state files, only when every one is there (as in the release check)
    const statePaths = STATE_FILES.map((n) => join(dirname(source), n))
    if (helperBytes && statePaths.every((f) => scriptProblem(f) === null))
      stateBytes = Object.fromEntries(STATE_FILES.map((n, k) => [n, readFileSync(statePaths[k] as string)]))
    const stateShas = stateBytes ? Object.fromEntries(Object.entries(stateBytes).map(([n, b]) => [n, sha(b)])) : null
    if (
      expect &&
      (sha(hookBytes) !== expect.hook ||
        (helperBytes ? sha(helperBytes) : null) !== expect.helper ||
        JSON.stringify(stateShas && sortedEntries(stateShas)) !==
          JSON.stringify(expect.state && sortedEntries(expect.state)))
    )
      return { problem: `the permission hook ${source} changed after its release was checked` }
    if (dry) return { script, python, hook: hookBytes, helper: helperBytes, state: stateBytes }
    writeFileAtomic(script, hookBytes, 0o600)
    // a source with no helper leaves none here either: an old one would be imported in its place
    if (helperBytes) writeFileAtomic(join(dir, HELPER), helperBytes, 0o600)
    else rmSync(join(dir, HELPER), { force: true })
    for (const n of STATE_FILES) {
      if (stateBytes) writeFileAtomic(join(dir, n), stateBytes[n] as Buffer, 0o600)
      else rmSync(join(dir, n), { force: true })
    }
  } catch (e) {
    return { problem: `the permission hook could not be copied into ${dir}: ${(e as Error).message}` }
  }
  return { script, python, hook: hookBytes, helper: helperBytes, state: stateBytes }
}

const sortedEntries = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))
