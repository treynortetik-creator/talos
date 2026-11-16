// Restarts a session asked for, counted in history.sqlite beside the other Option C tables so the limit holds across a bridge
// restart. Two kinds share the one table, apart by key: the main session's restarts of a thread's own session (`thread_session
// restart`, keyed by that thread) and restarts of Main itself (`restart_main`, keyed MAIN_SESSION_KEY, which no thread can be:
// `talos__` ids are the app's). The owner's button is never counted and never limited.
import type { Database } from 'bun:sqlite'

/** Restarts the main session may ask for, per thread, in any rolling hour. A wake is not counted. */
export const MAIN_RESTARTS_PER_HOUR = 3
const WINDOW_MS = 3600_000
/** The key `restart_main` counts under. Thread ids starting with `talos__` are refused to agents and the owner alike. */
export const MAIN_SESSION_KEY = 'talos__main'
/** Rows are kept this long, then pruned; far past any window. */
const KEEP_MS = 7 * 24 * 3600_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS main_restarts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  why TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS main_restarts_thread ON main_restarts(thread_id, at);
`

/** `limit` says which rule refused: three an hour, or the minimum gap after the last one. */
type RestartAttempt<T> =
  | { ok: false; refused: true; next_at: number; limit: 'hour' | 'gap' }
  | (T & { refused?: false })

/** Thrown inside the transaction to undo the row when the action itself refused. */
class Undo<T> {
  constructor(readonly result: T) {}
}

export class MainRestartLedger {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
  }

  /**
   * The restarts that count at `now`: those in the last hour, plus any dated up to an hour ahead (a clock set back cannot
   * hand out fresh restarts). A row dated further ahead than that is a wildly wrong clock and never locks a thread out.
   */
  private counted(thread: string, now: number): number[] {
    return (
      this.db
        .query('SELECT at FROM main_restarts WHERE thread_id = ? AND at > ? AND at <= ? ORDER BY at')
        .all(thread, now - WINDOW_MS, now + WINDOW_MS) as Array<{ at: number }>
    ).map((r) => r.at)
  }

  /** The restarts recorded for `thread` in the rows kept (a week), oldest first, at most `limit` of the newest. */
  recent(thread: string, limit = 10): Array<{ at: number; why: string }> {
    return (
      this.db
        .query('SELECT at, why FROM main_restarts WHERE thread_id = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(thread, limit) as Array<{ at: number; why: string }>
    ).reverse()
  }

  /**
   * Checks the limit, records the restart and runs `act` (it writes the wake file) in one immediate transaction, so a second
   * caller cannot take the same last slot. When `act` returns `ok: false` nothing is counted. At the limit `act` never runs
   * and the result says when the next restart is allowed. `minGapMs`: also refuse within that long after the last counted one.
   * `act` may throw: the row is rolled back and the error goes to the caller.
   */
  attempt<T extends { ok: boolean }>(
    thread: string,
    now: number,
    why: string,
    act: () => T,
    o: { minGapMs?: number } = {},
  ): RestartAttempt<T> {
    const run = this.db.transaction((): RestartAttempt<T> => {
      const ats = this.counted(thread, now)
      const last = ats[ats.length - 1]
      if (o.minGapMs && last !== undefined && last > now - o.minGapMs)
        return { ok: false, refused: true, next_at: last + o.minGapMs, limit: 'gap' }
      if (ats.length >= MAIN_RESTARTS_PER_HOUR)
        return {
          ok: false,
          refused: true,
          next_at: (ats[ats.length - MAIN_RESTARTS_PER_HOUR] as number) + WINDOW_MS,
          limit: 'hour',
        }
      this.db.query('DELETE FROM main_restarts WHERE at < ?').run(now - KEEP_MS)
      this.db.query('INSERT INTO main_restarts(thread_id, at, why) VALUES (?, ?, ?)').run(thread, now, why)
      const r = act()
      if (!r.ok) throw new Undo(r)
      return r
    })
    try {
      return run.immediate()
    } catch (e) {
      if (e instanceof Undo) return e.result as T
      throw e
    }
  }
}
