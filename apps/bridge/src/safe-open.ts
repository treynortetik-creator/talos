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
// on Linux) and that must equal the path asked for. A file renamed or unlinked after the open is not caught here (the
// handle is still the file that was checked); callers that need "one name" also check st_nlink on the handle.
// ACCEPTED LIMIT (rename residual): a writer who can rename folders beside the root can still win one ordering, a real
// folder moved into place AFTER the handle check, and the check cannot see it. That needs write access next to the
// folder, which can also copy the file, so it is documented in docs/SECURITY.md and not closed here.
// The caller passes a path that is already fully resolved (no links in it); anything that turns into a link afterwards
// fails the open instead of being followed.
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'

const O_NOFOLLOW_ANY = 0x20000000

/** Test seam: runs after the caller's checks and before the open, i.e. exactly inside the race window. */
export const openSeam: {
  beforeOpen?: (path: string) => void
  afterOpen?: (path: string) => void
  betweenRechecks?: () => void
} = {}

/** Opens `resolved` (an absolute realpath) read-only, never following a link in any component. Throws on failure. */
export function openResolvedNoFollow(resolved: string, extraFlags = 0): number {
  openSeam.beforeOpen?.(resolved)
  // macOS rejects O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL); the latter already covers the last component too
  if (process.platform === 'darwin') {
    const fd = openSync(resolved, constants.O_RDONLY | extraFlags | O_NOFOLLOW_ANY)
    return verified(fd, resolved, () => realpathSync(`/dev/fd/${fd}`))
  }
  if (process.platform === 'linux') {
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | extraFlags)
    return verified(fd, resolved, () => readlinkSync(`/proc/self/fd/${fd}`))
  }
  throw new Error(`no safe open on ${process.platform}`)
}

function verified(fd: number, resolved: string, whereIs: () => string): number {
  try {
    openSeam.afterOpen?.(resolved)
    if (whereIs() !== resolved) throw new Error('opened file is not at the resolved path')
    return fd
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/**
 * Reads a whole small file by name through one safe handle: realpath, open with no link followed and O_NONBLOCK (a named
 * pipe must not freeze the one thread the bridge runs on), fstat the HANDLE (regular file, at most `maxBytes`), read the
 * handle. Returns null for anything else, including a missing file. Never blocks on a pipe.
 */
export function readRegularFile(path: string, maxBytes: number): Buffer | null {
  let fd: number
  try {
    fd = openResolvedNoFollow(realpathSync(path), constants.O_NONBLOCK)
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
