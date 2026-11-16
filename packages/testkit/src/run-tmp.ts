// One temp folder per test run (#161), for the bridge's bun run (apps/bridge/test/run-tmp.ts) and the root vitest run
// (vitest.run-tmp.ts). It becomes TMPDIR, so every folder a test makes with tmpdir(), in process or in anything it spawns with
// that environment, goes under it, and end() removes it. Bun's spawn with no `env` passes the environment Bun started with,
// not a TMPDIR set at run time, so the bridge's `test` script and test-parallel.ts make the run folder before bun starts and
// this adopts it. A full run used to leave about 1 GB in some 4,000 folders behind, and on a tmpfs /tmp
// with a quota the next run failed with EDQUOT. A run that was killed leaves its folder; a later run removes any of the same
// prefix older than a day. Node only (not exported from the index, which also runs in the browser).
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

export function pruneOldRuns(outer: string, prefix: string, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(outer)
  } catch {
    return // an unreadable temp folder: nothing to prune
  }
  for (const f of names) {
    if (!f.startsWith(prefix)) continue
    const p = join(outer, f)
    try {
      if (now - statSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true })
    } catch {
      // already gone
    }
  }
}

/**
 * Makes this run's folder under the current temp folder and points TMPDIR at it; end() removes it and restores TMPDIR. When
 * TMPDIR already is a run folder of this prefix (made before the runtime started, so even a child spawned with no `env` has
 * it), that folder is the run's: nothing is nested, and end() removes it.
 */
export function startRunTmp(prefix: string): { dir: string; end: () => void } {
  const current = tmpdir()
  if (basename(current).startsWith(prefix)) {
    pruneOldRuns(dirname(current), prefix)
    return { dir: current, end: () => rmSync(current, { recursive: true, force: true }) }
  }
  const outer = current
  pruneOldRuns(outer, prefix)
  const dir = mkdtempSync(join(outer, prefix))
  const before = process.env.TMPDIR
  process.env.TMPDIR = dir
  return {
    dir,
    end: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // a child still writing: a later run prunes it
      }
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    },
  }
}
