// The undo_points table in history.sqlite: one row per owner message, saying where the undo point taken before that
// message's turn lives (a ref in the folder's repo, or a copy under the undo store) and whether it can be used.
//
// Retention: per thread, the newest 50 git points and the newest 10 copies (rows of any state count). A pruned point's
// ref is deleted with `update-ref -d <ref> <commit>`, so a ref that something else has moved since is left alone, and
// its objects go with git's normal gc. A pruned copy's folder is removed only when it is exactly <store>/<thread>/<turn>
// once links are resolved. A row goes once its ref or copy is gone or is no longer ours; a ref that could not be
// deleted (a lock held by another git) keeps its row, so the next prune tries again. A copy's folder is named by thread
// and turn only, so record and prune for one thread must not run at the same time: the caller runs both on the
// thread's own chain.
// A column added later follows history-store.ts: PRAGMA table_info, then ALTER TABLE ... ADD COLUMN.
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { type RunAsync, runCommandAsync } from '../run-command.ts'
import { overlaps } from './busy.ts'
import {
  cleanEnv,
  ignoredJson,
  NAMES_DIFFER,
  QUIET,
  realpathOrAncestor,
  type Snapshot,
  type UndoState,
} from './snapshot.ts'

export const UNDO_RETENTION = { git: 50, copy: 10 }
/** A git that hangs (a folder on a network drive) must not hold retention up. */
const GIT_TIMEOUT_MS = 10_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS undo_points (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  turn TEXT NOT NULL,
  kind TEXT NOT NULL,
  root TEXT NOT NULL,
  ref TEXT,
  commit_id TEXT,
  path TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS undo_points_thread ON undo_points(thread_id, kind, created_at);
`

export type UndoPointRow = {
  message_id: string
  thread_id: string
  turn: string
  kind: 'git' | 'copy'
  /** The folder the point was taken of (a repo's top level for a git point). */
  root: string
  ref: string | null
  commit_id: string | null
  path: string | null
  state: UndoState
  created_at: number
  /** JSON list of what git ignored when the point was taken; null when not kept (then no deletions are offered). */
  ignored_json: string | null
  /** Why a point was not saved, when the owner should be told (snapshot.ts NAMES_DIFFER); null otherwise. */
  why: string | null
}

export type PruneOpts = {
  /** The undo store (`paths(home).undo`): a copy outside it is never removed. */
  undoDir: string
  env?: Record<string, string | undefined>
  keep?: typeof UNDO_RETENTION
  run?: RunAsync
  /** How long one git call may take (tests make it short). */
  gitTimeoutMs?: number
}

const COLS = 'message_id, thread_id, turn, kind, root, ref, commit_id, path, state, created_at, ignored_json, why'

export class UndoPoints {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
    // what git ignored when the point was taken (snapshot.ts): rows from before it have none, and offer no deletions
    const cols = db.query('PRAGMA table_info(undo_points)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'ignored_json')) db.exec('ALTER TABLE undo_points ADD COLUMN ignored_json TEXT')
    // why a point was not saved, when the card should say (rows from before it have none)
    if (!cols.some((c) => c.name === 'why')) db.exec('ALTER TABLE undo_points ADD COLUMN why TEXT')
  }

  /**
   * Saves the point for one message. A ready point replaces any row; a failed one never replaces a ready row (that
   * point is still on disk and still what the folder looked like before the turn), unless `replace` says the turn ran
   * somewhere else: then the new row wins whatever its state, and the caller releases the old point.
   */
  record(
    p: { message_id: string; thread_id: string; turn: string; snapshot: Snapshot; at: number },
    opts: { replace?: boolean } = {},
  ): void {
    const s = p.snapshot
    const ready = s.state === 'ready'
    const set = COLS.split(', ')
      .filter((c) => c !== 'message_id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')
    this.db
      .query(
        `INSERT INTO undo_points (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET ${set}
         WHERE ? OR excluded.state = 'ready' OR undo_points.state != 'ready'`,
      )
      .run(
        p.message_id,
        p.thread_id,
        p.turn,
        s.kind,
        s.root,
        ready && s.kind === 'git' ? s.ref : null,
        ready && s.kind === 'git' ? s.commit : null,
        ready && s.kind === 'copy' ? s.path : null,
        s.state,
        p.at,
        // kept only when every ignored path has its own stats: one without them would read as never ignored
        ready && s.kind === 'git' && s.ignored?.every((f) => s.ignoredStats && Object.hasOwn(s.ignoredStats, f))
          ? ignoredJson(s.ignoredStats ?? {}, s.ignoredIncomplete === true) // the paths are its keys: each kept once
          : null,
        s.state === 'not_saved' && s.why === NAMES_DIFFER ? NAMES_DIFFER : null, // only a reason the card names
        opts.replace ? 1 : 0,
      )
  }

  /**
   * The row with what git ignored then widened by every later git point of the same folder: a file ignored after this
   * point and kept by a later one (an .env made since) is not new either. Any of them without a record: none.
   */
  withLaterIgnored(row: UndoPointRow): UndoPointRow {
    if (row.kind !== 'git') return row
    // every later row of a folder in or around this one: one that is not a ready git point with a record (not saved,
    // too large, a copy) knows nothing of what was ignored then, so nothing can be proved new
    const later = (
      this.db
        .query('SELECT root, kind, state, ignored_json FROM undo_points WHERE created_at >= ?')
        .all(row.created_at) as Array<{
        root: string
        kind: string
        state: string
        ignored_json: string | null
      }>
    ).filter((r) => r.root === '' || overlaps(r.root, row.root)) // a folder not known could have been this one
    if (later.some((r) => r.kind !== 'git' || r.state !== 'ready')) return { ...row, ignored_json: null }
    const stats: Record<string, [number, number]> = Object.create(null)
    let incomplete = false
    for (const r of [{ ignored_json: row.ignored_json }, ...later]) {
      const rec = readIgnored(r.ignored_json)
      if (!rec) return { ...row, ignored_json: null }
      if (rec.incomplete) incomplete = true
      // this point's own stats first: a file only a later point recorded keeps that point's stats
      for (const [p, st] of Object.entries(rec.stats)) if (!Object.hasOwn(stats, p)) stats[p] = st
    }
    return { ...row, ignored_json: JSON.stringify({ stats, ...(incomplete ? { incomplete: true } : {}) }) }
  }

  get(messageId: string): UndoPointRow | undefined {
    const row = this.db.query(`SELECT ${COLS} FROM undo_points WHERE message_id = ?`).get(messageId)
    return (row as UndoPointRow | null) ?? undefined
  }

  /**
   * Drops the thread's points past the retention, with their refs and copies. Returns how many rows went. Git and file
   * errors never throw (the row stays for the next prune); a database error does, so the caller catches it.
   */
  async prune(threadId: string, o: PruneOpts): Promise<number> {
    const keep = o.keep ?? UNDO_RETENTION
    const run = o.run ?? runCommandAsync
    const env = cleanEnv(o.env ?? process.env)
    const store = await realpathOrAncestor(o.undoDir)
    let dropped = 0
    for (const kind of ['git', 'copy'] as const) {
      const old = this.db
        .query(
          `SELECT ${COLS} FROM undo_points WHERE thread_id = ? AND kind = ?
           ORDER BY created_at DESC, ord DESC LIMIT -1 OFFSET ?`,
        )
        .all(threadId, kind, keep[kind]) as UndoPointRow[]
      for (const row of old) {
        let gone: boolean
        try {
          // one turn's point can be shared by several messages (a backlog): it goes with the last row that names it
          gone =
            this.shared(row) ||
            (await releasePoint(row, { run, env, store, timeoutMs: o.gitTimeoutMs ?? GIT_TIMEOUT_MS }))
        } catch {
          gone = false
        }
        if (!gone) continue
        // only the row as it was read: one recorded again for the same message while this ran is a new point
        this.db
          .query(
            `DELETE FROM undo_points WHERE message_id = ? AND created_at = ? AND state = ?
             AND commit_id IS ? AND path IS ?`,
          )
          .run(row.message_id, row.created_at, row.state, row.commit_id, row.path)
        dropped++
      }
    }
    return dropped
  }

  /** True when another message's row names the same ref or copy. */
  private shared(row: UndoPointRow): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM undo_points WHERE message_id != ? AND state = 'ready' AND (
             (ref IS NOT NULL AND ref = ? AND root = ? AND commit_id IS ?) OR (path IS NOT NULL AND path = ?)) LIMIT 1`,
        )
        .get(row.message_id, row.ref, row.root, row.commit_id, row.path) !== null
    )
  }
}

/**
 * The ignored record a point keeps: `{stats}`, each ignored file with its [mtimeMs, size] then. Older forms (a bare
 * list, or `{paths, dirs}`) have no stats: one that lists a folder (`dir/`) never named the files inside it, so it is
 * incomplete; any other is no record (null), so a later point's stats can never stand in for its own.
 */
export function readIgnored(
  json: string | null,
): { paths: string[]; stats: Record<string, [number, number]>; incomplete?: true } | null {
  if (json === null) return null
  try {
    const v = JSON.parse(json) as unknown
    const o = (Array.isArray(v) ? { paths: v } : v) as { paths?: unknown; stats?: unknown; incomplete?: unknown } | null
    if (!o || typeof o !== 'object') return null
    const stats: Record<string, [number, number]> = Object.create(null)
    if (o.stats && typeof o.stats === 'object')
      for (const [p, st] of Object.entries(o.stats as Record<string, unknown>)) {
        // one entry that is not a pair of numbers: that file's state then is not known, so there is no record
        if (!Array.isArray(st) || st.length !== 2 || !st.every((n) => typeof n === 'number')) return null
        stats[p] = [st[0] as number, st[1] as number]
      }
    const paths = Array.isArray(o.paths)
      ? o.paths.filter((p): p is string => typeof p === 'string')
      : Object.keys(stats)
    if (!Array.isArray(o.paths) && o.stats === undefined) return null
    if (o.incomplete === true || paths.some((p) => p.endsWith('/'))) return { paths, stats, incomplete: true }
    if (paths.some((p) => !Object.hasOwn(stats, p))) return null
    return { paths, stats }
  } catch {
    return null
  }
}

export type ReleaseOpts = { run: RunAsync; env: Record<string, string | undefined>; store: string; timeoutMs: number }

/** What a point needs to be released: a row, or a snapshot that came too late to be one. */
export type PointLocation = Pick<UndoPointRow, 'kind' | 'root' | 'ref' | 'commit_id' | 'path' | 'turn'>

/** Removes a point's ref or copy. True when nothing of it is left that is ours to remove. Never throws for git. */
export async function releasePoint(row: PointLocation, o: ReleaseOpts): Promise<boolean> {
  if (row.kind === 'git') {
    if (!row.ref || !row.commit_id) return true
    // a folder that was deleted: gone. One whose parent is missing too may be on a drive that is not mounted: kept.
    if (!existsSync(row.root)) return existsSync(dirname(row.root))
    const git = async (...args: string[]) => {
      const signal = AbortSignal.timeout(o.timeoutMs)
      const r = await o.run(['git', ...QUIET, ...args], row.root, { env: o.env, signal })
      return { ...r, timedOut: signal.aborted }
    }
    const del = await git('update-ref', '-d', row.ref, row.commit_id)
    if (del.code === 0 && !del.timedOut) return true
    const now = await git('rev-parse', '-q', '--verify', row.ref)
    if (now.timedOut) return false
    if (now.code === 0) return now.stdout !== row.commit_id // moved by something else: not ours now
    // 1: the ref is missing; 128 with no .git left: the folder is no longer a repo. Anything else (127: no git, 128 for
    // a repo git refuses to read) is tried again later.
    return now.code === 1 || (now.code === 128 && !existsSync(join(row.root, '.git')))
  }
  if (!row.path || !existsSync(row.path)) return true
  // only a folder this store made: <store>/<thread>/<turn>, links resolved
  const real = await realpathOrAncestor(row.path)
  if (basename(real) !== row.turn || dirname(dirname(real)) !== o.store) return true
  await rm(real, { recursive: true, force: true })
  return !existsSync(real)
}
