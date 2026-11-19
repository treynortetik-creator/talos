// A thread's live state file (`<agentDir>/threads/<id>.state.md`), seeded at each start so the session finds the sections it keeps
// current (kit/hooks/thread-state.py puts it back in front of the session at every boundary). Never overwritten, never written
// through a link; a failure here is reported by the caller and never stops the start.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** The state file's path for a thread (the id is a validated ThreadId: no separator can be in it). */
export const threadStatePath = (agentDir: string, id: string) => join(agentDir, 'threads', `${id}.state.md`)

/** The seed text: `name` is the thread's display name (its id when it has none), flattened to one short line. */
export function threadStateTemplate(id: string, name: string | null | undefined): string {
  // eslint-free: strip control characters (a name is config text and lands in a heading)
  const label =
    [...(name ?? '')]
      .map((c) => ((c.codePointAt(0) as number) < 0x20 || c === '\x7f' ? ' ' : c))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || id
  return `# ${label} live state (thread ${id})
READ FIRST after any restart or compaction. Rule: update THIS file the same turn anything here changes (an owner ask, a
decision, a landing, a hold). Keep it under 8,000 characters; history goes in the thread or a log, not here.

## Owner asks open (newest first, dated)
## Waiting on the owner
## In flight
## CI (optional: leave empty if this thread does no builds)
## Rules learned
`
}

/**
 * Makes the file when it is missing: `threads/` 0700 if absent (refused when it is a link or not a folder), the file opened with
 * O_CREAT|O_EXCL|O_NOFOLLOW (never overwrites, never follows a link), 0600. `dry` checks the same and writes nothing.
 * Returns what happened, or why not.
 */
export function seedThreadState(
  agentDir: string,
  id: string,
  name: string | null | undefined,
  dry = false,
): { ok: 'created' | 'exists' } | { problem: string } {
  const dir = join(agentDir, 'threads')
  const file = threadStatePath(agentDir, id)
  try {
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return { problem: `${dir} is not a plain folder` }
    let fst: ReturnType<typeof lstatSync> | null = null
    try {
      fst = lstatSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (fst) return fst.isSymbolicLink() ? { problem: `${file} is a link` } : { ok: 'exists' }
    if (dry) return { ok: 'created' }
    if (!st) mkdirSync(dir, { mode: 0o700 })
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      // threads/ could have been swapped for a link between the check above and the open: the file must really be in the agent
      // folder's own threads/, else what was made is removed
      let fine = fstatSync(fd).isFile()
      try {
        fine = fine && !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === join(realpathSync(agentDir), 'threads')
      } catch {
        fine = false
      }
      if (!fine) {
        try {
          unlinkSync(file)
        } catch {}
        return { problem: `${dir} is not the agent folder's own threads folder` }
      }
      writeSync(fd, threadStateTemplate(id, name))
    } finally {
      closeSync(fd)
    }
    return { ok: 'created' }
  } catch (e) {
    // EEXIST: another start made it first (or a link appeared): nothing is overwritten
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: 'exists' }
    return { problem: `${file} could not be made: ${(e as Error).message}` }
  }
}
