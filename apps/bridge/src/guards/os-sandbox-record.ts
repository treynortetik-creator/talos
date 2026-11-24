// The extra lock's last good reading (docs/SECURITY.md "OS sandbox"): one small file, `config-history/os-sandbox-last` in the Talos home,
// "on" or "off". It is looked at only as a plain file in a real folder (never followed through a link, never opened when it is anything
// else, so a named pipe cannot hold a start), and written only from a reading of config.json that worked. Kept apart from os-sandbox.ts
// so config-file.ts can record a good reading without loading the whole builder. The Swift twin is OsSandbox.lastKnownSwitch.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fsutil.ts'

/** The folder inside the Talos home, and the record in it. The sandbox and the guards keep sessions from writing the folder. */
export const SWITCH_RECORD_DIR = 'config-history'
export const SWITCH_RECORD = join(SWITCH_RECORD_DIR, 'os-sandbox-last')
/** A record is "on\n" or "off\n": anything bigger is not one. */
const RECORD_MAX_BYTES = 16

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** The folder is a real directory (not a link to one, not a file). */
const realFolder = (dir: string): boolean => lstatOrNull(dir)?.isDirectory() === true

/** The state kept by the last good reading; false (off) when there is none, or the folder or the record is anything but what we write. */
export function lastKnownSwitch(talosHome: string): boolean {
  try {
    if (!realFolder(join(talosHome, SWITCH_RECORD_DIR))) return false
    const file = join(talosHome, SWITCH_RECORD)
    const st = lstatOrNull(file)
    if (!st?.isFile() || st.nlink !== 1 || st.size > RECORD_MAX_BYTES) return false // checked before opening: a pipe is never opened
    return readFileSync(file, 'utf8').trim() === 'on'
  } catch {
    return false // a record that cannot be read is no record
  }
}

/**
 * Keeps `on` as the last good reading (only when it changed). 'failed' when the record could not be put right (the folder is a link or a
 * file, the write failed): the caller says so for an `on` that was not kept. A record entry that is not a plain file is removed first
 * (only that one entry).
 */
export function rememberSwitch(talosHome: string, on: boolean): 'ok' | 'failed' {
  try {
    if (!existsSync(talosHome)) return 'ok' // no home: nothing to keep it in, and none is made
    if (lastKnownSwitch(talosHome) === on) return 'ok'
    const dir = join(talosHome, SWITCH_RECORD_DIR)
    const st = lstatOrNull(dir)
    if (st && !st.isDirectory()) return 'failed' // a link or a file where the folder belongs: never written through
    if (!st) mkdirSync(dir, { mode: 0o700 })
    const file = join(talosHome, SWITCH_RECORD)
    const old = lstatOrNull(file)
    if (old && !(old.isFile() && old.nlink === 1)) rmSync(file, { recursive: true, force: true })
    writeFileAtomic(file, on ? 'on\n' : 'off\n', 0o600)
    return 'ok'
  } catch {
    return 'failed'
  }
}
