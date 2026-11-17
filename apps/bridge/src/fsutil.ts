// Shared local state lives in files under $TALOS_APP_HOME, written atomically (tmp + rename) with 0600 (dirs 0700).
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode })
  try {
    // never through a link: chmod follows it and would change the folder it points at
    if (!lstatSync(path).isSymbolicLink()) chmodSync(path, mode)
  } catch {
    // not ours to chmod (e.g. a shared parent); the create above already used the mode
  }
}

/** The one place a durable write reaches the disk, so a test can see it happen. */
export const diskSync = {
  fsync: (fd: number): void => fsyncSync(fd),
  /** Writes some of `bytes` from `offset`; returns how many it took (a write may take fewer than asked). */
  write: (fd: number, bytes: Uint8Array, offset: number): number => writeSync(fd, bytes, offset, bytes.length - offset),
}

/** Flushes a folder's entries (a new or renamed file) to disk. A platform that cannot open a folder for this is left as it is. */
function syncDir(dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    diskSync.fsync(fd)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw e
  } finally {
    closeSync(fd)
  }
}

/**
 * `durable`: the bytes are flushed to disk before the rename, and the folder after it, so a power cut cannot leave an answered
 * `consumed` for a file that is gone. Costs two syncs; used where a peer is told "it is safe" the moment this returns.
 */
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
  o: { durable?: boolean } = {},
): void {
  // Only create a missing parent. Never chmod it: callers also write into folders that are not ours (the agent folder's
  // .mcp.json), and tightening those to 0700 would break shared or served folders. Our own dirs go through ensureDir.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    if (o.durable) {
      const fd = openSync(tmp, 'w', mode)
      try {
        const bytes = typeof data === 'string' ? Buffer.from(data) : data
        // a write may take fewer bytes than it was given: go on until every byte is written, and fail if one makes no progress
        for (let done = 0; done < bytes.length; ) {
          const n = diskSync.write(fd, bytes, done)
          if (!(n > 0)) throw new Error(`short write: ${done} of ${bytes.length} bytes written`)
          done += n
        }
        diskSync.fsync(fd)
      } finally {
        closeSync(fd)
      }
    } else writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
    if (o.durable) syncDir(dirname(path))
  } catch (e) {
    removeFile(tmp) // a failed write never leaves its temp file behind
    throw e
  }
}

export function readJsonFile<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600, o: { durable?: boolean } = {}): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode, o)
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

/** mtime in ms, 0 when the file is missing. Used to notice edits made by other processes. */
export function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function fileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}
