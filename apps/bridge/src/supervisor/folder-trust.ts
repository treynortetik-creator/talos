// Folder trust, answered by the owner's own choice of folder. A thread session that starts in a folder Claude Code has not seen
// stops on "Do you trust the files in this folder?" and the phone could only say "open Terminals". The owner picking that folder
// for the thread is the consent, so the supervisor records it where Claude Code does when a person says yes: the project entry of
// Claude Code's global config (`<config home>/.claude.json`, `projects[<absolute folder>].hasTrustDialogAccepted = true`; read
// from Claude Code 2.1.328's own file on the owner's Mac, and the same key the repo's real-claude tests plant).
//
// What it will write is narrow, and every rule is checked here, whoever calls:
//   - only the thread's own folder, as its resolved real path, and only when that folder is one the owner set for a thread
//     (`chosen`), never a parent of it, the home folder, `/`, or a folder that holds the Talos data or the agent folder;
//   - never the agent folder itself: Main's trust is first-start's (it proves the folder holds `.talos-version` first);
//   - never through a link: a configured folder that is a link leading up into its own parent is refused, and a path that is not
//     already its own real path is refused;
//   - only the one key: the file is read, that key is set, every other key is written back as it was read, in a temp file beside
//     it with the file's own mode, and renamed over it. Claude Code rewrites this file itself at any time, so the file is read
//     again just before the rename (changed: start over on what is there now) and once more after it (the key must be there, and
//     every other key and value must be what was read).
//   - under Claude Code's own lock. Claude Code 2.1.328 saves the file in saveConfigWithLock with proper-lockfile on
//     `<config file>.lock` (read from the binary: `lockfilePath: `${file}.lock``, a lock folder made by mkdir, ELOCKED when held,
//     stale after 10 s and kept fresh by its holder). This takes that same lock around read, modify and rename. A held lock is
//     waited for a moment (LOCK_DELAYS_MS) and never taken over: no lock, no write, and the prompt card is the way out.
// A refusal or a failure is returned, never thrown and never silent: the caller says it, and the prompt card is still the way out.
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export type FolderTrustResult = { ok: true; wrote: boolean } | { ok: false; why: string }

export type FolderTrustInput = {
  /** Claude Code's global config file: `<CLAUDE_CONFIG_DIR or home>/.claude.json`. */
  configFile: string
  /** The folder the session launches in, already resolved (its real path). */
  folder: string
  /** The folders the owner set for threads, as configured (not resolved). The folder must be one of them. */
  chosen: readonly string[]
  home: string
  talosHome: string
  agentDir: string
}

/** The tries the write makes while another writer keeps changing the file (each one starts over on what is there). */
export const TRUST_WRITE_TRIES = 5
/** The waits (ms, each stretched by up to 2x) between looks at a lock Claude Code holds: about 1.5 s in all, then it gives up. */
export const LOCK_DELAYS_MS = [20, 40, 80, 160, 320, 640]
const MAX_CONFIG_BYTES = 32 * 1024 * 1024

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const real = (p: string): string | null => {
  try {
    return trim(realpathSync(p))
  } catch {
    return null
  }
}
const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)

/** Why `folder` may not be trusted for the owner's choice, or null. Pure but for realpath. */
export function trustRefusal(i: FolderTrustInput): string | null {
  const f = i.folder
  if (
    !f.startsWith('/') ||
    f.split('/').some((p) => p === '.' || p === '..') ||
    f.length > 512 ||
    [...f].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  )
    return 'the folder is not a plain absolute path'
  const r = real(f)
  if (r === null) return 'the folder does not exist'
  if (r !== trim(f)) return 'the folder is not its own real path (a link)'
  const home = real(i.home)
  if (home === null || !within(r, home) || r === home) return 'the folder is not inside the home folder'
  if (within(r, join(home, '.claude'))) return 'the folder is inside ~/.claude'
  const talos = real(i.talosHome) ?? trim(i.talosHome)
  if (within(r, talos) || within(talos, r)) return 'the folder holds, or is inside, the Talos data folder'
  const agent = real(i.agentDir)
  if (agent !== null && within(agent, r))
    return "the folder is the agent folder or one that holds it (Main's trust is its own first start's)"
  // a folder the owner set for a thread, by its real path
  const mine = i.chosen.filter((c) => c.startsWith('/') && real(c) === r)
  if (mine.length === 0) return 'the folder is not one the owner chose for a thread'
  // a chosen folder written as a path that is a link leading up into its own parent ("proj/link" -> "proj") is a trick, not a choice
  if (mine.every((c) => within(trim(c), r) && trim(c) !== r))
    return 'the configured folder is a link into its own parent'
  return null
}

type Parsed = { raw: string; obj: Record<string, unknown>; mode: number }

function readConfig(file: string): Parsed | { problem: string } {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (e) {
    return { problem: `the Claude Code config cannot be opened (${(e as NodeJS.ErrnoException).code ?? 'error'})` }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { problem: 'the Claude Code config is not a normal file' }
    const raw = readFileSync(fd, 'utf8')
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      return { problem: 'the Claude Code config is not valid JSON, so it was left as it is' }
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
      return { problem: 'the Claude Code config is not a JSON object' }
    return { raw, obj: obj as Record<string, unknown>, mode: st.mode & 0o777 }
  } finally {
    closeSync(fd)
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Takes Claude Code's own config lock (`<file>.lock`, a folder made by mkdir); never a held one. null: not taken, with why. */
function takeConfigLock(configFile: string, sleep: (ms: number) => void): { release: () => void } | { why: string } {
  const lock = `${configFile}.lock`
  for (let k = 0; ; k++) {
    try {
      mkdirSync(lock)
      return {
        release: () => {
          try {
            rmdirSync(lock)
          } catch {} // already gone (Claude Code's own stale rule took it): nothing of ours is left
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        return { why: `Claude Code's config lock could not be taken (${(e as NodeJS.ErrnoException).code ?? 'error'})` }
      const wait = LOCK_DELAYS_MS[k]
      if (wait === undefined)
        return { why: 'Claude Code is saving its config right now (its lock is held), so trust was not recorded' }
      sleep(wait * (1 + Math.random()))
    }
  }
}

/**
 * Sets `projects[folder].hasTrustDialogAccepted = true` in Claude Code's config, when the rules above allow it, under its lock.
 * `beforeRename` and `sleep` are test seams (a concurrent writer lands between the read and the rename; the wait for the lock).
 */
export function preAcceptFolderTrust(
  i: FolderTrustInput,
  beforeRename?: () => void,
  sleep: (ms: number) => void = sleepSync,
): FolderTrustResult {
  const why = trustRefusal(i)
  if (why) return { ok: false, why }
  // a config that is itself a link (dotfiles) is written where it really is, so the link stays a link
  const file = real(i.configFile)
  if (file === null) return { ok: false, why: 'Claude Code has no config file here yet, so nothing was written' }
  // Claude Code names its lock after the path it was given, not the one it resolves to
  const held = takeConfigLock(i.configFile, sleep)
  if ('why' in held) return { ok: false, why: held.why }
  try {
    return writeTrust(i, file, beforeRename)
  } finally {
    held.release()
  }
}

function writeTrust(i: FolderTrustInput, file: string, beforeRename?: () => void): FolderTrustResult {
  for (let attempt = 0; attempt < TRUST_WRITE_TRIES; attempt++) {
    const cur = readConfig(file)
    if ('problem' in cur) return { ok: false, why: cur.problem }
    const projects = cur.obj.projects
    if (projects !== undefined && (typeof projects !== 'object' || projects === null || Array.isArray(projects)))
      return { ok: false, why: "the Claude Code config's projects is not an object, so it was left as it is" }
    const map = (projects ?? {}) as Record<string, unknown>
    const have = Object.hasOwn(map, i.folder) ? map[i.folder] : undefined
    if (have !== undefined && (typeof have !== 'object' || have === null || Array.isArray(have)))
      return {
        ok: false,
        why: "the folder's entry in the Claude Code config is not an object, so it was left as it is",
      }
    if ((have as Record<string, unknown> | undefined)?.hasTrustDialogAccepted === true)
      return { ok: true, wrote: false }
    const next = {
      ...cur.obj,
      projects: { ...map, [i.folder]: { ...(have as object | undefined), hasTrustDialogAccepted: true } },
    }
    const text = `${JSON.stringify(next, null, 2)}${cur.raw.endsWith('\n') ? '\n' : ''}`
    const tmp = join(dirname(file), `.claude.json.tmp.${process.pid}.${randomBytes(6).toString('hex')}`)
    try {
      writeFileSync(tmp, text, { mode: cur.mode, flag: 'wx' })
      beforeRename?.()
      // another writer (Claude Code rewrites this file itself): what is there now must be what this was made from
      const now = readConfig(file)
      if ('problem' in now) {
        rmSync(tmp, { force: true })
        return { ok: false, why: now.problem }
      }
      if (now.raw !== cur.raw) {
        rmSync(tmp, { force: true })
        continue
      }
      renameSync(tmp, file)
    } catch (e) {
      rmSync(tmp, { force: true })
      return {
        ok: false,
        why: `the Claude Code config could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'})`,
      }
    }
    // after the write: the key must be there (a writer that held the old text in memory may have put it back)
    // and everything else, at every depth, is what was read plus that one key (nothing of Claude Code's was lost or changed)
    const after = readConfig(file)
    if (!('problem' in after) && isDeepStrictEqual(after.obj, JSON.parse(text))) return { ok: true, wrote: true }
  }
  return { ok: false, why: 'the Claude Code config kept changing under the write, so trust was not recorded' }
}

/** Claude Code's global config file for a config home (CLAUDE_CONFIG_DIR when set, else the home folder): see worker-mcp.ts. */
export const trustConfigFile = (configHome: string) => join(configHome.replace(/\/+$/, '') || '/', '.claude.json')
