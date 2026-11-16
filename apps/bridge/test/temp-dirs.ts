// Temp folders made by bridge tests are removed by the run, never left in $TMPDIR (a bridge home can be hundreds of MB,
// and a full run makes thousands). bun test runs one file at a time, so once a folder is made from another test file,
// the folders of the files before it are no longer used and go; preload.ts removes the rest when the run ends.
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made = new Map<string, string>() // folder -> the test file that made it, or '' when the stack does not say

/** The test file on the call stack; '' for a folder made after an await has lost its test frame (kept to the end). */
function callerFile(): string {
  return /([^\s(]+\.test\.tsx?)/.exec(new Error().stack ?? '')?.[1] ?? ''
}

/** A folder a locked-down test left at mode 000 or 500 cannot be emptied until it is writable again. */
function unlock(dir: string) {
  try {
    if (!statSync(dir).isDirectory()) return
    chmodSync(dir, 0o700)
    for (const n of readdirSync(dir)) unlock(join(dir, n))
  } catch {}
}

function remove(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    unlock(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

/** `mkdtemp` under $TMPDIR, removed once the test file that made it has finished. */
export function testTempDir(prefix: string): string {
  const file = callerFile()
  if (file)
    for (const [dir, owner] of made)
      if (owner && owner !== file) {
        remove(dir)
        made.delete(dir)
      }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.set(dir, file)
  return dir
}

/** Every folder still listed (preload.ts calls this once, after the last test file). */
export function removeTestTempDirs() {
  for (const dir of made.keys()) remove(dir)
  made.clear()
}
