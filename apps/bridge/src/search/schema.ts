// The search index schema (docs/V2-FEATURES.md V3.1). `CREATE ... IF NOT EXISTS`, run by EVERY process that opens the
// store, inside the indexer's own try: a process that opens history.sqlite after the table was dropped recreates it.
import type { Database } from 'bun:sqlite'

/** One column per `match_in` value, in this order. rowid = messages.ord. */
export const FTS_COLUMNS = ['text', 'transcript', 'names', 'files', 'card'] as const
/** `ORDER BY bm25(...)` weights, same order as FTS_COLUMNS. */
export const BM25_WEIGHTS = '4.0, 3.0, 2.0, 1.0, 1.5'

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  text, transcript, names, files, card,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
CREATE TABLE IF NOT EXISTS fts_files (media_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, state TEXT NOT NULL);
`

export const KV_HWM = 'search_hwm'
export const KV_DIRTY = 'search_dirty' // '1' = rebuild needed, '2' = rebuilding
export const KV_WEEK = 'search_rebuilt_week'

export function ensureSchema(db: Database): void {
  db.exec(SCHEMA)
}

/** Does this SQLite have FTS5? Creates and drops a temp table. */
export function probeFts5(db: Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)')
    db.exec('DROP TABLE temp.fts_probe')
    return true
  } catch {
    try {
      db.exec('DROP TABLE IF EXISTS temp.fts_probe')
    } catch {
      // nothing to drop
    }
    return false
  }
}
