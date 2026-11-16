// The bridge's record of each `wake_me` timer (docs/OPTION-C.md "Wake me"), in history.sqlite so it outlives a bridge restart.
// The scheduler holds the one-shot job that fires it; this row is the proof that the job is a wake this bridge set (the job's
// id alone proves nothing: anyone who can write the registry can choose an id), who it belongs to and what its note says.
//
// A row moves creating -> pending -> firing -> fired, and is deleted once the scheduler's job is gone. Every move is one
// conditional UPDATE, so two ticks (or a tick and the owner's Cancel) can never both act on the same wake.
import type { Database } from 'bun:sqlite'

export type WakeState = 'creating' | 'pending' | 'firing' | 'fired'

export type WakeRow = {
  id: string
  /** Whose it is: 'main', or the thread id of the thread session that set it. */
  lane: string
  /** The thread it is shown and delivered in (main's: the default thread). */
  thread_id: string
  /** When it fires (ms), as the scheduler will run it. */
  at: number
  /** The note, already made visible and safe (one line, hidden characters escaped). */
  note: string
  set_at: number
  state: WakeState
  changed_at: number
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS wake_me (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  note TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_me_lane ON wake_me(lane, at);
CREATE TABLE IF NOT EXISTS wake_me_fires (lane TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS wake_me_fires_lane ON wake_me_fires(lane, at);`

/** The states that count as "still to fire" for the per-lane limits and the lists. */
const OPEN: readonly WakeState[] = ['creating', 'pending']

export class WakeMeStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
  }

  /**
   * Counts the open wakes and records the new one in a single transaction, so two calls at once cannot both slip under the
   * cap. `cap` counts every lane's open wakes together. Returns how many of THIS lane's were open before it, or `null` when
   * the cap is reached (nothing written).
   */
  reserve(row: Omit<WakeRow, 'state' | 'changed_at'>, cap: number): number | null {
    return this.db
      .transaction((): number | null => {
        const all = this.db.query(`SELECT COUNT(*) AS n FROM wake_me WHERE state IN ('creating', 'pending')`).get() as {
          n: number
        }
        if (all.n >= cap) return null
        const n = this.openCount(row.lane)
        this.db
          .query(
            `INSERT INTO wake_me (id, lane, thread_id, at, note, set_at, state, changed_at)
             VALUES (?, ?, ?, ?, ?, ?, 'creating', ?)`,
          )
          .run(row.id, row.lane, row.thread_id, row.at, row.note, row.set_at, row.set_at)
        return n
      })
      .immediate()
  }

  openCount(lane: string): number {
    const r = this.db
      .query(`SELECT COUNT(*) AS n FROM wake_me WHERE lane = ? AND state IN ('creating', 'pending')`)
      .get(lane) as { n: number }
    return r.n
  }

  get(id: string): WakeRow | undefined {
    return (this.db.query('SELECT * FROM wake_me WHERE id = ?').get(id) as WakeRow | null) ?? undefined
  }

  /** Moves a wake from one of `from` to `to`; true only for the one caller that made the move. */
  move(id: string, from: readonly WakeState[], to: WakeState, now: number, at?: number): boolean {
    const marks = from.map(() => '?').join(', ')
    const r = this.db
      .query(
        `UPDATE wake_me SET state = ?, changed_at = ?${at === undefined ? '' : ', at = ?'} WHERE id = ? AND state IN (${marks})`,
      )
      .run(...([to, now, ...(at === undefined ? [] : [at]), id, ...from] as Array<string | number>))
    return r.changes === 1
  }

  /** Deletes the row if it is still in one of `from`; true only for the caller that deleted it. */
  remove(id: string, from: readonly WakeState[]): boolean {
    const marks = from.map(() => '?').join(', ')
    return this.db.query(`DELETE FROM wake_me WHERE id = ? AND state IN (${marks})`).run(id, ...from).changes === 1
  }

  /** Records that a lane's wake fired (sent to its session) at `at`, and forgets fires older than two days. */
  recordFire(lane: string, at: number) {
    this.db.query('INSERT INTO wake_me_fires (lane, at) VALUES (?, ?)').run(lane, at)
    this.db.query('DELETE FROM wake_me_fires WHERE at < ?').run(at - 2 * 24 * 3600_000)
  }

  /** A lane's fires at or after `since`, oldest first (their times). */
  firesSince(lane: string, since: number): number[] {
    return (
      this.db.query('SELECT at FROM wake_me_fires WHERE lane = ? AND at >= ? ORDER BY at').all(lane, since) as Array<{
        at: number
      }>
    ).map((r) => r.at)
  }

  /** A lane's open wakes, soonest first. */
  open(lane: string): WakeRow[] {
    return this.db
      .query(`SELECT * FROM wake_me WHERE lane = ? AND state IN ('creating', 'pending') ORDER BY at, id`)
      .all(lane) as WakeRow[]
  }

  /** Every open wake, soonest first (the owner's lists and the sweep). */
  allOpen(): WakeRow[] {
    return this.db
      .query(`SELECT * FROM wake_me WHERE state IN ('creating', 'pending') ORDER BY at, id`)
      .all() as WakeRow[]
  }

  /** Rows in one state (the sweep's leftovers: a crash between two steps). */
  inState(state: WakeState): WakeRow[] {
    return this.db.query('SELECT * FROM wake_me WHERE state = ? ORDER BY at, id').all(state) as WakeRow[]
  }
}

export const OPEN_WAKE_STATES = OPEN
