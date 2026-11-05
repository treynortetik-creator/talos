// Shared local state lives in files under $TALOS_APP_HOME, written atomically (tmp + rename) with 0600 (dirs 0700).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode })
  try {
    chmodSync(path, mode)
  } catch {
    // not ours to chmod (e.g. a shared parent); the create above already used the mode
  }
}

export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  // Only create a missing parent. Never chmod it: callers also write into folders that are not ours (the agent folder's
  // .mcp.json), and tightening those to 0700 would break shared or served folders. Our own dirs go through ensureDir.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
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

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
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

export { existsSync }
