// How the bridge's own SQLite files (history.sqlite, the memory index) reach the disk. Every open that can write calls this
// right after it sets WAL, so no file is left to the platform's default: Bun's bundled SQLite on Linux defaults to FULL, but the
// system SQLite Bun uses on macOS defaults to NORMAL, where a power cut can lose the last commits; history.sqlite holds the
// outbox, so a lost commit there is a reply the owner was told is queued and that is never sent.
//   synchronous = FULL       every commit waits for its sync, not only checkpoints
//   fullfsync = ON           on macOS that sync is F_FULLFSYNC, the only one that reaches the platter or flash through the
//                            drive's own cache; fsync alone does not on Apple hardware. Other platforms ignore it.
//   checkpoint_fullfsync = ON  and the same at a checkpoint
// The cost, measured on a Mac (2026-11-13): one 600-byte insert per commit went from about 0.01 ms (the macOS default) to between
// 0.3 ms (the average of 10,000 commits in a row) and 1.2 ms (the median of 300 timed one by one). So the bulk rebuilds commit in
// batches: the search rebuild 500 rows per pass, the memory index 100 notes per commit. A few small loops still commit per row
// (settling claims once per stopped thread, the undo-point prune, at most 20 search-file marks per tick, the card-row backfill).
// The bridge's tests lower synchronous afterwards through their own seam (the seam module beside this file), which the product
// never sets.
import type { Database } from 'bun:sqlite'

export function applyDurableSync(db: Database): void {
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA fullfsync = ON')
  db.exec('PRAGMA checkpoint_fullfsync = ON')
}
