// Opening a file so that the HANDLE, not a path check made before or after, is what keeps it inside a folder.
//
// `O_NOFOLLOW` only refuses a symlink in the LAST path component. A folder in the middle can still be swapped for a
// symlink between a realpath check and the open, and the open then follows it out of the root. So the open itself must
// refuse links in EVERY component:
//   - macOS: `O_NOFOLLOW_ANY` (0x20000000, macOS 11+) makes open(2) fail with ELOOP on a link anywhere in the path.
//     Bun and Node do not export the constant, so it is spelled out here.
//   - Linux: no such flag without openat2, so open with O_NOFOLLOW, then read where the descriptor really points
//     (/proc/self/fd/N) and require it to equal the path that was asked for.
// A link is not the only way to redirect a path: a REAL folder renamed into place is not a link, so neither flag sees it.
// On both platforms the kernel is therefore asked where the open handle really is (/dev/fd/N on macOS, /proc/self/fd/N
// on Linux) and that must equal the path asked for. On macOS that answer is only taken for a file with one name: for one with
// several (hard links) it can be another of its names, so there the handle must be the very file the path names now, spelled
// as on the disk (macWhere). A file renamed or unlinked after the open is not caught here (the
// handle is still the file that was checked); callers that need "one name" also check st_nlink on the handle.
// ACCEPTED LIMIT (rename residual): a writer who can rename folders beside the root can still win one ordering, a real
// folder moved into place AFTER the handle check, and the check cannot see it. That needs write access next to the
// folder, which can also copy the file, so it is documented in docs/SECURITY.md and not closed here.
// The caller passes a path that is already fully resolved (no links in it); anything that turns into a link afterwards
// fails the open instead of being followed.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { realFileSync } from './real-file.ts'

const O_NOFOLLOW_ANY = 0x20000000

/**
 * Where a macOS handle is, for the check that it is at `resolved`. With one name, or none left (replaced or unlinked since the
 * open): the kernel's own answer (/dev/fd/N), which has no other name to give. With several (hard links) that answer can be
 * another of its names (real-file.ts), so instead the handle must be the very file
 * `resolved` names now (device and inode; bigint, as an APFS inode can pass 2^53) and `resolved` spelled as on the disk, as the
 * kernel's answer requires (one read of the folder per open of such a file: slow only in a very large folder). Anything else is
 * a place that is never `resolved`, so the check refuses it.
 */
function macWhere(fd: number, resolved: string): string {
  const mine = fstatSync(fd, { bigint: true })
  if (mine.nlink <= 1n) return realpathSync(`/dev/fd/${fd}`)
  const folder = dirname(resolved)
  try {
    const there = lstatSync(resolved, { bigint: true })
    if (
      there.dev === mine.dev &&
      there.ino === mine.ino &&
      realpathSync(folder) === folder &&
      readdirSync(folder).includes(basename(resolved))
    )
      return resolved
  } catch {}
  return `${resolved}, or another of its names`
}

/** Test seam: runs after the caller's checks and before the open, i.e. exactly inside the race window. */
export const openSeam: {
  beforeOpen?: (path: string) => void
  afterOpen?: (path: string) => void
  betweenRechecks?: () => void
} = {}

/** Test seam for a create that could not be cleaned up (default: a warning on stderr, which the bridge log keeps). */
export const strayLog: { warn: (m: string) => void } = { warn: (m) => console.warn(m) }

/** Opens `resolved` (an absolute realpath) read-only, never following a link in any component. Throws on failure. */
export function openResolvedNoFollow(resolved: string, extraFlags = 0): number {
  openSeam.beforeOpen?.(resolved)
  // macOS rejects O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL); the latter already covers the last component too
  if (process.platform === 'darwin') {
    const fd = openSync(resolved, constants.O_RDONLY | extraFlags | O_NOFOLLOW_ANY)
    return verified(fd, resolved, extraFlags, () => macWhere(fd, resolved), undefined)
  }
  if (process.platform === 'linux') {
    const whereOf = (fd: number) => () => {
      // A name replaced or unlinked after the open reads "<path> (deleted)": still the file opened at that path. Only when
      // the handle has NO name left (nlink 0): a file still linked elsewhere (a hard link outside the root) keeps the
      // suffix and fails
      const at = readlinkSync(`/proc/self/fd/${fd}`)
      return fstatSync(fd).nlink === 0 ? at.replace(/ \(deleted\)$/, '') : at
    }
    if (extraFlags & constants.O_CREAT) return createInPinnedFolder(resolved, extraFlags, whereOf)
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | extraFlags)
    return verified(fd, resolved, extraFlags, whereOf(fd), undefined)
  }
  throw new Error(`no safe open on ${process.platform}`)
}

/**
 * A create on Linux, through a handle on its folder (review of 1502cd06). Linux has no O_NOFOLLOW_ANY: O_NOFOLLOW covers only
 * the last name, so a create by path follows a folder swapped for a link and makes the file outside (found on Titan,
 * files-put.test.ts). So the folder is opened first, with this same check (its handle must be at its path), and the file is
 * created in THAT folder through /proc/self/fd/<folder>/<name>: the kernel walks into the folder the handle holds, whatever
 * happened to the path since, and O_NOFOLLOW refuses a link at the name. That is openat in effect; nothing is created
 * through a swapped link at all. The one ordering left is the checked folder itself moved after its check: the file is then
 * made inside it, the handle check on the file refuses, and the file is taken out of that same folder (undoCreate).
 */
function createInPinnedFolder(resolved: string, extraFlags: number, whereOf: (fd: number) => () => string): number {
  const cut = resolved.lastIndexOf('/')
  const name = resolved.slice(cut + 1)
  if (cut < 0 || !name || name === '.' || name === '..') throw new Error('not a file path')
  const dirfd = openResolvedNoFollow(resolved.slice(0, cut) || '/', constants.O_DIRECTORY)
  try {
    const inFolder = `/proc/self/fd/${dirfd}/${name}`
    const fd = openSync(inFolder, constants.O_RDONLY | constants.O_NOFOLLOW | extraFlags)
    return verified(fd, resolved, extraFlags, whereOf(fd), inFolder)
  } finally {
    closeSync(dirfd)
  }
}

function verified(
  fd: number,
  resolved: string,
  extraFlags: number,
  whereIs: () => string,
  inFolder: string | undefined,
): number {
  try {
    openSeam.afterOpen?.(resolved)
    const where = whereIs()
    if (where !== resolved) {
      undoCreate(fd, inFolder, extraFlags, where)
      throw new Error('opened file is not at the resolved path')
    }
    return fd
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/**
 * An exclusive create (O_CREAT|O_EXCL) whose handle is not where it was asked for made that file. It is taken out only
 * through the pinned folder handle (`inFolder`, /proc/self/fd/<folder>/<name>: the very folder it was created in, whatever
 * the path says now), and only if it is still the same file (device and inode), a regular file, and empty. Never by a path
 * walk: an lstat and an unlink by path are two walks, and a folder swapped between them would make it delete a same-named
 * file somewhere else (review of 1502cd06). Where there is no pinned folder (macOS: a real folder renamed into place passes
 * O_NOFOLLOW_ANY), or it cannot be removed, it is left and said, with where it is: an empty file, never someone's data.
 */
function undoCreate(fd: number, inFolder: string | undefined, extraFlags: number, where: string): void {
  // O_CREAT without O_EXCL could have opened a file that was already there, so it is never removed (no caller uses it)
  const exclusive = constants.O_CREAT | constants.O_EXCL
  if ((extraFlags & exclusive) !== exclusive) return
  if (inFolder) {
    try {
      const mine = fstatSync(fd)
      const there = lstatSync(inFolder)
      if (there.isFile() && there.dev === mine.dev && there.ino === mine.ino && there.size === 0 && mine.size === 0) {
        unlinkSync(inFolder)
        return
      }
    } catch {
      // said below
    }
  }
  // the path as JSON: a folder name with a newline in it cannot write a line of its own into the bridge log
  strayLog.warn(
    `talos: a file this bridge created (empty when made) was not where it was asked for, and is left at ${JSON.stringify(where)}`,
  )
}

/**
 * Reads a whole small file by name through one safe handle: realpath, open with no link followed and O_NONBLOCK (a named
 * pipe must not freeze the one thread the bridge runs on), fstat the HANDLE (regular file, at most `maxBytes`), read the
 * handle. Returns null for anything else, including a missing file. Never blocks on a pipe.
 */
export function readRegularFile(path: string, maxBytes: number): Buffer | null {
  let fd: number
  try {
    fd = openResolvedNoFollow(realFileSync(path), constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    return readFileSync(fd)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
