// A test-only seam for the bridge's own SQLite files (history.sqlite, the memory index). The bridge test run's preload
// (test/preload.ts) sets synchronous = NORMAL for them: with WAL that drops the fsync at every commit and keeps it at a checkpoint,
// so a killed process loses nothing and only a power cut could lose the last commits. What these tests check is behaviour (locks,
// transactions, races), and on an encrypted btrfs temp folder the per-commit fsyncs made SQLite-heavy tests take minutes. (OFF was
// tried first: a single-process run of the whole suite then crashed Bun 1.3.11 within seconds, as NORMAL's and main's did later in
// the run; the gate's runner, one process per file, crashed on main and not with NORMAL.) The product never sets it: each opener
// first sets the product's own value (FULL with fullfsync, sqlite-sync.ts) and then calls this, so only a test run ends at
// NORMAL; test/sqlite-test-seam.test.ts asserts both. Tests whose point is durability (a kill or a crash mid-write, a damaged
// file reopened) put the product value back for their file (test/sqlite-durable.ts).
import type { Database } from 'bun:sqlite'

export const SQLITE_TEST: { synchronous: 'NORMAL' | null } = { synchronous: null }

/** Called right after the bridge opens one of its own SQLite files: nothing at all unless a test run set the seam. */
export function applySqliteTestSeam(db: Database): void {
  if (SQLITE_TEST.synchronous === 'NORMAL') db.exec('PRAGMA synchronous = NORMAL')
}
