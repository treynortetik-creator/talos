// A dedicated thread's inbox (docs/OPTION-C.md "Leads and the fence"). The files the owner sends to a thread that has its own
// session are copied from media/ (one flat folder for every thread) into `<inbox root>/<thread>/` (`~/.talos-inbox`, outside
// the Talos home), and the path the session is told is the copy. There is no deny on it and no carve-out: another thread's
// session can read it, which docs/OPTION-C.md says plainly.
//
// Nothing here follows a link. The root and the thread folder are looked at with lstat before anything is read or written,
// and looked at AGAIN (device and inode) right before each write, rename and unlink, so a folder swapped for a link or for
// another folder after the first look is refused. The source is opened by a handle that refuses a link in any component.
// Folders are 0700 and files 0600. A thread's folder is removed when the thread is archived or deleted.
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, join, sep } from 'node:path'
import { ThreadId } from '@talos-app/protocol'
import type { Notification } from '../notify.ts'
import { openResolvedNoFollow } from '../safe-open.ts'

/** A copy older than this is removed (the routing rows that name it are pruned after the same time). */
const INBOX_MAX_AGE_MS = 7 * 24 * 3600_000
/** One thread's inbox is cut back to this size, oldest files first. */
const INBOX_MAX_BYTES = 1024 * 1024 * 1024
/** The largest file copied (the same limit as a download). */
const MAX_COPY_BYTES = 50 * 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const FILE_KEY = /^file_path(_\d+)?$/
/** The line `moreFiles` (notify.ts) adds when a message carries more than ten files. */
const MORE_FILES = /\((\d+) more files? beyond file_path_10: [^)]*\)/

export class InboxError extends Error {}

/** Test seam: runs right before each re-check, i.e. inside the window between the first look and the act. */
export const inboxSeam: { beforeRecheck?: ((stage: 'write' | 'rename' | 'unlink') => void) | undefined } = {}

export const inboxPath = (root: string, thread: string) => join(root, thread)

type Folder = { path: string; recheck(stage: 'write' | 'rename' | 'unlink'): void }

const identity = (path: string): string => {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    throw new InboxError(`${path} is gone`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InboxError(`${path} is a link or not a folder`)
  return `${st.dev}:${st.ino}`
}

/**
 * The folder `<root>/<thread>`, made if `create` (both 0700; an existing root looser than that is tightened). The root and the
 * thread folder must be real folders: a link there (made by anything running as this user) would send a copy somewhere else,
 * so it throws. Without `create`, a folder that is not there returns undefined. `recheck` looks at both again.
 */
function openFolder(root: string, thread: string, create: boolean): Folder | undefined {
  if (!ThreadId.safeParse(thread).success) throw new InboxError(`"${thread}" is not a thread id`)
  const dirs = [root, join(root, thread)]
  for (const dir of dirs) {
    let st: ReturnType<typeof lstatSync> | undefined
    try {
      st = lstatSync(dir)
    } catch {
      st = undefined
    }
    if (!st) {
      if (!create) return undefined
      mkdirSync(dir, { mode: 0o700 })
    } else if (st.isSymbolicLink() || !st.isDirectory()) throw new InboxError(`${dir} is a link or not a folder`)
    else if (create && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700) // just looked at with lstat: a real folder
  }
  const ids = dirs.map(identity)
  return {
    path: dirs[1] as string,
    recheck(stage) {
      inboxSeam.beforeRecheck?.(stage)
      dirs.forEach((d, i) => {
        if (identity(d) !== ids[i]) throw new InboxError(`${d} changed while it was being used`)
      })
    },
  }
}

/** Copies one downloaded file into the thread's inbox and returns the copy's path. The source must be a regular file inside `mediaDir`. */
export function copyToInbox(o: { root: string; mediaDir: string; thread: string; source: string }): string {
  let real: string
  let mediaReal: string
  try {
    real = realpathSync(o.source)
    mediaReal = realpathSync(o.mediaDir)
  } catch {
    throw new InboxError(`cannot find ${basename(o.source)}`)
  }
  if (!real.startsWith(`${mediaReal}${sep}`)) throw new InboxError(`${basename(o.source)} is not in the media folder`)
  const name = basename(real)
  if (!SAFE_NAME.test(name)) throw new InboxError(`${name} is not a name this folder keeps`)
  const folder = openFolder(o.root, o.thread, true)
  if (!folder) throw new InboxError('no inbox folder')
  const dest = join(folder.path, name)
  let bytes: Uint8Array
  let fd: number
  try {
    fd = openResolvedNoFollow(real)
  } catch {
    throw new InboxError(`cannot read ${name}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new InboxError(`${name} is not a regular file`)
    if (st.size > MAX_COPY_BYTES) throw new InboxError(`${name} is over 50 MB`)
    bytes = new Uint8Array(readFileSync(fd))
  } finally {
    closeSync(fd)
  }
  // written under a temp name, then renamed into place: a link already at `dest` is replaced, never written through
  const tmp = join(folder.path, `.${Math.random().toString(36).slice(2)}.tmp`)
  folder.recheck('write')
  const out = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(out, bytes)
    fchmodSync(out, 0o600)
  } finally {
    closeSync(out)
  }
  try {
    folder.recheck('rename')
    renameSync(tmp, dest)
  } catch (e) {
    try {
      folder.recheck('unlink')
      unlinkSync(tmp)
    } catch {
      // the folder is not ours any more, or the file is gone: leave it
    }
    throw e
  }
  return dest
}

/**
 * The same notification with every file path replaced by its copy in the thread's inbox. `file_path`, `file_path_2` ... are
 * read from meta (an owner message carries at most ten files); a line that names more files by their media path is replaced
 * by one that says they were left out. Throws `InboxError` when any file cannot be placed, so the caller can hand the whole
 * message to the main session instead of giving the thread a path it cannot read.
 */
export function placeFilesInInbox(
  n: Notification,
  o: { root: string; mediaDir: string; thread: string; now: number },
): Notification {
  const keys = Object.keys(n.meta).filter((k) => FILE_KEY.test(k))
  if (!keys.length) return n
  const meta = { ...n.meta }
  const done = new Map<string, string>()
  for (const k of keys) {
    const src = n.meta[k] as string
    let copy = done.get(src)
    if (copy === undefined) {
      copy = copyToInbox({ root: o.root, mediaDir: o.mediaDir, thread: o.thread, source: src })
      done.set(src, copy)
    }
    meta[k] = copy
  }
  const content = n.content.replace(
    MORE_FILES,
    (_m, count: string) => `(${count} more files were left out: a thread session is given ten files at most)`,
  )
  pruneInbox(o.root, o.thread, o.now)
  return { content, meta }
}

/** Removes copies past the age limit, then the oldest until the folder is within the size limit. Plain files only; never follows a link. */
export function pruneInbox(
  root: string,
  thread: string,
  now: number,
  limits: { maxAgeMs: number; maxBytes: number } = { maxAgeMs: INBOX_MAX_AGE_MS, maxBytes: INBOX_MAX_BYTES },
): void {
  let folder: Folder | undefined
  let names: string[]
  try {
    folder = openFolder(root, thread, false)
    if (!folder) return
    names = readdirSync(folder.path)
  } catch {
    return
  }
  const files: Array<{ path: string; at: number; size: number }> = []
  for (const name of names) {
    const path = join(folder.path, name)
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink() || !st.isFile()) {
        folder.recheck('unlink')
        unlinkSync(path) // nothing of ours is a link or a folder: a link goes, its target is left alone
        continue
      }
      files.push({ path, at: st.mtimeMs, size: st.size })
    } catch (e) {
      if (e instanceof InboxError) return // the folder is not the one we looked at: stop
    }
  }
  let total = files.reduce((s, f) => s + f.size, 0)
  files.sort((a, b) => a.at - b.at)
  for (const f of files) {
    if (now - f.at <= limits.maxAgeMs && total <= limits.maxBytes) break
    try {
      folder.recheck('unlink')
      unlinkSync(f.path)
      total -= f.size
    } catch (e) {
      if (e instanceof InboxError) return
    }
  }
}

/** `pruneInbox` for every thread folder under the root. */
export function pruneInboxes(root: string, now: number, limits?: { maxAgeMs: number; maxBytes: number }): void {
  let threads: string[]
  try {
    threads = readdirSync(root)
  } catch {
    return
  }
  for (const t of threads) if (ThreadId.safeParse(t).success) pruneInbox(root, t, now, limits)
}

/** Removes a thread's whole inbox folder. A link there is removed itself and its target is left alone. */
export function removeInbox(root: string, thread: string): void {
  if (!ThreadId.safeParse(thread).success) return
  try {
    if (lstatSync(root).isSymbolicLink()) return
  } catch {
    return
  }
  const path = join(root, thread)
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) unlinkSync(path)
    else if (st.isDirectory()) rmSync(path, { recursive: true, force: true })
  } catch {
    // not there, or not ours to remove
  }
}

/** Removes the inbox of every thread that is not in `live` (archived, deleted, or never a thread of this config). */
export function removeGoneInboxes(root: string, live: Iterable<string>): void {
  const keep = new Set(live)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const t of names) if (!keep.has(t)) removeInbox(root, t)
}

/** The ids of the threads that are not archived: the only ones that keep an inbox. */
export const liveThreadIds = (config: { threads: ReadonlyArray<{ id: string; archived: boolean }> }): string[] =>
  config.threads.filter((t) => !t.archived).map((t) => t.id)
