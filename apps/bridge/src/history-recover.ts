// A history.sqlite the database cannot trust must not keep the bridge from starting: the owner's phone would go quiet and
// nothing would say why. The live bridge moves such a file (and its -wal and -shm) aside, never deletes it, starts on a new
// empty history, and leaves a note in the new history's kv so the owner hears about it once the relay is reachable.
//
// The rule:
//   1. Read the whole file through the OS first. A read error there (EIO, no permission) is the disk or the account, not the
//      file: nothing is touched and the start is refused.
//   2. Run one whole-file `quick_check`, then FTS5's own `integrity-check` on the search index: `quick_check` covers FTS5
//      only from SQLite 3.44.0, and macOS 15 (whose SQLite Bun uses there) ships 3.43.2. It reads only the index's own
//      tables, never the messages, and runs in a transaction that is rolled back. It runs only where quick_check did not
//      already do it, and only on an index small enough to check in about 2.4 s (FTS_CHECK_MAX_INDEX_BYTES).
//   3. If it is not ok, try dropping the search tables (inside a transaction). If the check is then ok, the problems were only in
//      search: the usual pass rebuilds them and the history stays.
//   4. Anything else about the content (a drop that fails, a problem outside search, a bad free list, a thrown "corrupt", out of
//      memory every time) moves the file. An error that says nothing about the content (busy, locked, a WAL lock, I/O, no
//      permission, read-only, cannot open, a full disk, or one that is not from SQLite) never moves it: after a short retry the
//      start is refused instead. Retries are judged by SQLite's numeric code, which Bun always sets.
// The new history starts without the old seen ids, so a recent message the relay sends again can reach the agent twice. That is
// accepted (a card decision cannot run twice) and the owner's note says so.
import { Database } from 'bun:sqlite'
import { closeSync, existsSync, linkSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { type HistoryStore, MAX_FUTURE_MS, openHistory } from './history-store.ts'
import type { Logger } from './log.ts'
import { say } from './owner-words.ts'
import { KV_DIRTY } from './search/schema.ts'
import { applyDurableSync } from './sqlite-sync.ts'

/** kv key in the NEW history: the name of the file that was kept, until the owner has been told. */
export const HISTORY_KEPT_ASIDE_KEY = 'history_kept_aside'

/** kv key in the NEW history: when (the Mac's clock, ISO) the old one was kept aside. Absent means no reset. */
export const HISTORY_RESET_KEY = 'history_reset_at'

/**
 * True for an owner control the owner signed before the history was reset. The new history cannot tell whether it was already
 * handed over, so it is refused and run by nothing; the owner taps again. The time compared is the frame's own `ts`, which the
 * owner's signature covers (the relay's stamps are not). That is the phone's clock and the reset time is the Mac's, so the cut
 * is moved `MAX_FUTURE_MS` later, the most the Mac accepts a phone to be ahead: a replay is always older than the reset in
 * real time, so it falls before the cut however far ahead the phone ran. A phone running behind has its first controls after a
 * reset refused until its own clock passes the cut, and the owner taps again.
 */
export function signedBeforeReset(store: Pick<HistoryStore, 'kvGet'>, ts: string): boolean {
  const resetAt = Date.parse(store.kvGet(HISTORY_RESET_KEY) ?? '')
  return Number.isFinite(resetAt) && Date.parse(ts) <= resetAt + MAX_FUTURE_MS
}

export const RESET_REFUSAL = {
  ok: false,
  code: 'control_stale',
  text: say({
    mac: 'The Mac’s history was reset after this was sent, so it was not run. Send it again.',
    linux: 'This computer’s history was reset after this was sent, so it was not run. Send it again.',
  }),
} as const

/** SQLite's primary result codes this file cares about (the low byte of an extended code). */
const RC = {
  ERROR: 1,
  PERM: 3,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  FULL: 13,
  CANTOPEN: 14,
  PROTOCOL: 15,
  SCHEMA: 17,
  MISUSE: 21,
  NOLFS: 22,
  AUTH: 23,
} as const
const NAMED: Record<string, number> = { ...RC, CORRUPT: 11, NOTADB: 26 }
/**
 * The primary result code of an error SQLite threw: from `errno` (Bun always sets it; it leaves `code` unset for a plain
 * SQLITE_ERROR), else from the code's name. undefined for an error that did not come from SQLite.
 */
function primaryCode(e: unknown): number | undefined {
  const o = e as { errno?: unknown; code?: unknown } | null
  // SQLite's codes are positive; Bun's file-system errors carry a negative errno (EACCES is -13), and those are not SQLite's
  if (typeof o?.errno === 'number') return o.errno > 0 ? o.errno & 0xff : undefined
  const m = typeof o?.code === 'string' ? /^SQLITE_([A-Z]+)/.exec(o.code) : null
  return m ? NAMED[m[1] as string] : undefined
}
/** SQLite's name for an error: its own code name when Bun gives one, else built from the primary code. */
function codeName(e: unknown): string {
  const named = (e as { code?: unknown } | null)?.code
  if (typeof named === 'string' && named.startsWith('SQLITE_')) return named
  const rc = primaryCode(e)
  if (rc === undefined) return 'not a SQLite error'
  const name = Object.entries(NAMED).find(([, n]) => n === rc)?.[0]
  return name ? `SQLITE_${name}` : `SQLite error ${rc}`
}

/**
 * The start refused for an error that says nothing about the content. This is the line the owner sees: the bridge prints it as it
 * exits, Claude Code keeps it in its MCP log, and the Mac app's "bridge is not running" line quotes it. So it names the code and
 * says the history was left alone.
 */
function refusal(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  return new Error(
    `history.sqlite could not be checked (${codeName(e)}: ${msg}); it was left as it is, and the bridge will check it again at its next start`,
    { cause: e },
  )
}

/** The search drop's own "the check is still not ok": a verdict on the content, not an error from SQLite. */
const STILL_NOT_OK = 'still not ok'
/**
 * Errors that say nothing about the file's content: someone else holds it (busy, locked, a WAL lock protocol error), or the disk
 * or the OS refuses it (I/O, cannot open, no permission, read-only, full, no large files, not authorized). The file is never moved
 * for one of these, and the start is refused. An error that did not come from SQLite at all is the same.
 */
const NOT_THE_CONTENT: ReadonlySet<number> = new Set([
  RC.PERM,
  RC.BUSY,
  RC.LOCKED,
  RC.READONLY,
  RC.IOERR,
  RC.FULL,
  RC.CANTOPEN,
  RC.PROTOCOL,
  RC.NOLFS,
  RC.AUTH,
  RC.INTERRUPT, // the caller stopped it
  RC.SCHEMA, // the schema changed under the statement: run it again next start
  RC.MISUSE, // our own bug, which would move the file again on every start
])
const notTheFile = (e: unknown) => {
  if (e instanceof Error && e.message === STILL_NOT_OK) return false
  const rc = primaryCode(e)
  return rc === undefined || NOT_THE_CONTENT.has(rc)
}
/**
 * Kinds that pass on their own (another connection, a scanner, a brief lock, a moment of memory pressure): tried again after a
 * short wait. Out of memory every time is the file (garbled data makes SQLite ask for absurd sizes), so it then counts as content.
 * The trade: a healthy file under lasting real memory pressure would be moved aside too. macOS and Linux overcommit memory, so an
 * allocation that keeps failing is in practice garbled data, and moving aside never deletes.
 */
const PASSING: ReadonlySet<number> = new Set([RC.BUSY, RC.LOCKED, RC.IOERR, RC.PROTOCOL, RC.NOMEM])
/** Another connection owns the -wal: whatever was held is not ours to put back. */
const OTHER_OWNER: ReadonlySet<number> = new Set([RC.BUSY, RC.LOCKED, RC.PROTOCOL])
const RETRY_WAIT_MS = [250, 1000] as const

export type RecoverHooks = {
  /** Test seam: the read used for step 1 (a test makes one page fail with EIO). */
  readAt?: typeof readSync
  /** Test seam: makes the new history (a full disk fails here). */
  openFresh?: (path: string) => HistoryStore
  /** Test seam: the platform whose path is taken (the side files are held on Linux only). */
  platform?: NodeJS.Platform
  /** Test seam: the start check's `quick_check` query (a test makes it throw what a lock, the OS or garbled data would). */
  quickCheck?: (db: Database) => Array<{ quick_check?: unknown }>
  /** Test seam: the statement that runs the search index's own check (a test makes it throw what SQLite would). */
  ftsCheck?: (db: Database) => void
  /** Test seam: the wait between retries of a passing error. */
  sleep?: (ms: number) => void
  /** Test seam: the search repair (drop the search tables, check again). */
  dropSearch?: (path: string) => boolean
  /** Test seam: opens the history that checked out (a test makes a migration fail). */
  openExisting?: (path: string) => HistoryStore
  /** Test seam: called when the -wal and -shm are held (links taken). */
  onHold?: () => void
}

function readThrough(path: string, readAt: typeof readSync) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (let pos = 0; ; ) {
      const n = readAt(fd, buf, 0, buf.length, pos)
      if (n === 0) return
      pos += n
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Linux only: the same `quick_check` on a READ-ONLY connection, which never folds or deletes the -wal and -shm when it closes.
 * True only for a clear `ok`; anything else (not ok, an error, a -wal it cannot open read-only) is null: not judged healthy.
 */
function healthyReadOnly(path: string): boolean | null {
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    const rows = db.query('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>
    return rows.length === 1 && rows[0]?.quick_check === 'ok' ? true : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** The check, tried again after a short wait while the error is one that passes on its own; the last error is thrown as it is. */
function checkWithRetry(
  path: string,
  check: (path: string) => boolean,
  o: { sleep: (ms: number) => void; retry: boolean; seen: Set<number> },
): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      return check(path)
    } catch (e) {
      const rc = primaryCode(e)
      if (rc !== undefined) o.seen.add(rc)
      const wait = RETRY_WAIT_MS[attempt]
      if (o.retry && wait !== undefined && rc !== undefined && PASSING.has(rc)) {
        o.sleep(wait)
        continue
      }
      if (rc === RC.NOMEM) return false // out of memory every time: the content, so the repair runs (and, failing that, it moves)
      throw e
    }
  }
}

/** `quick_check` runs FTS5's own check from SQLite 3.44.0 on. */
function quickCheckCoversFts5(db: Database): boolean {
  const v = (db.query('SELECT sqlite_version() AS v').get() as { v: string }).v.split('.').map(Number)
  return (v[0] ?? 0) > 3 || ((v[0] ?? 0) === 3 && (v[1] ?? 0) >= 44)
}

/**
 * Above this size of index (its data blocks) the index's own check is not run at start: it holds the file's one write lock while it
 * reads the index, and the other bridge processes give up a write after 5 s (history-store's busy_timeout). Its time follows the
 * index's size, not the number of messages: on the stock-Mac lane 15-48 ms per MB (long texts and attached files are the slow end),
 * so at this cap at most about 2.4 s. A larger index is left to the weekly rebuild, which drops and remakes it.
 */
const FTS_CHECK_MAX_INDEX_BYTES = 48 * 1024 * 1024
/** How long the check waits for a write another process holds before it counts as busy (a passing error: retried, then refused). */
const FTS_CHECK_BUSY_MS = 2000
/** The statement that runs FTS5's own check. It writes nothing, but SQLite runs it as an INSERT, so it takes the write lock. */
const runFtsIntegrityCheck = (db: Database) => db.run("INSERT INTO msg_fts(msg_fts) VALUES('integrity-check')")

/**
 * FTS5's own check of the search index, where quick_check did not already run it: false only when SQLite answers that the index is
 * damaged (SQLITE_CORRUPT, which a damaged FTS5 index gives as SQLITE_CORRUPT_VTAB). It reads only the index's own shadow tables
 * (msg_fts is not an external-content table), never `messages`, and runs in a transaction that is always rolled back. A passing
 * error, or one that is not about the file, is thrown as from quick_check. Any other error (this SQLite has no FTS5, say) says
 * nothing about the file: the step is skipped and the file is judged by quick_check alone, as before this check existed.
 */
function searchIndexSound(db: Database, log: Logger, run: (db: Database) => void = runFtsIntegrityCheck): boolean {
  if (quickCheckCoversFts5(db)) return true // the same check already ran inside quick_check: do not pay for it twice
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_fts'").get()) return true
    const bytes = (db.query('SELECT COALESCE(SUM(length(block)), 0) AS b FROM msg_fts_data').get() as { b: number }).b
    if (bytes > FTS_CHECK_MAX_INDEX_BYTES) {
      log.info('search index too large to check at start; the weekly rebuild remakes it', {
        mb: Math.round(bytes / 1e6),
      })
      return true
    }
    db.exec(`PRAGMA busy_timeout = ${FTS_CHECK_BUSY_MS}`)
    db.exec('PRAGMA query_only = OFF')
    db.exec('BEGIN')
    try {
      run(db)
    } finally {
      // SQLite may have rolled back already (after an I/O error, say): a second ROLLBACK would throw and hide the first error
      if (db.inTransaction) db.exec('ROLLBACK')
    }
    return true
  } catch (e) {
    const rc = primaryCode(e)
    if (rc === NAMED.CORRUPT) return false
    // any other answer, not-a-database included, is not this step's to judge: quick_check, which reads every page, said ok
    if (notTheFile(e) || (rc !== undefined && PASSING.has(rc))) throw e
    return true
  }
}

/**
 * One whole-file `quick_check` on a fresh connection, then the search index's own check: true when both say ok. Throws when the
 * trouble is not the file's content.
 */
function healthy(
  path: string,
  quickCheck: ((db: Database) => Array<{ quick_check?: unknown }>) | undefined,
  ftsCheck: ((db: Database) => void) | undefined,
  log: Logger,
): boolean {
  const db = new Database(path, { readwrite: true })
  try {
    applyDurableSync(db) // closing the last connection can fold the -wal into the file: that write syncs as every other does
    db.exec('PRAGMA query_only = ON') // quick_check runs no write; closing the last connection can still fold the -wal into the file
    const rows = quickCheck
      ? quickCheck(db)
      : (db.query('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>)
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') return false
    // quick_check covers FTS5 only from SQLite 3.44.0: the index's own check sees what an older one does not
    return searchIndexSound(db, log, ftsCheck)
  } catch (e) {
    const rc = primaryCode(e)
    // not about the content, or worth another try: the caller decides. Anything else is the content answering: not ok.
    if (notTheFile(e) || (rc !== undefined && PASSING.has(rc))) throw e
    return false
  } finally {
    db.close()
  }
}

/**
 * Drops the search tables (the next start makes empty ones and the usual pass refills them) inside a transaction, together with the
 * mark that queues the rebuild, and keeps both only if the file then checks out. So "every problem is in a search table" is decided by the check itself, not by reading
 * its lines: a problem anywhere else, a line nobody expected, or tables that cannot be dropped leave it not ok.
 */
export function dropSearchTables(path: string): boolean {
  const db = new Database(path, { readwrite: true })
  try {
    applyDurableSync(db) // the drop and the rebuild mark are a write like any other (sqlite-sync.ts)
    db.exec('BEGIN')
    db.exec('DROP TABLE IF EXISTS msg_fts')
    db.exec('DROP TABLE IF EXISTS fts_files')
    db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      KV_DIRTY,
      '1',
    )
    const rows = db.query('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') throw new Error(STILL_NOT_OK)
    db.exec('COMMIT')
    return true
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // nothing open
    }
    if (notTheFile(e)) throw e // a busy file is not a bad one
    return false
  } finally {
    db.close()
  }
}

function keptName(path: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
  let name = `${path}.corrupt-${stamp}`
  for (let n = 2; existsSync(name); n++) name = `${path}.corrupt-${stamp}-${n}`
  return name
}

const SIDES = ['', '-wal', '-shm']

/**
 * Hard links to the -wal and -shm taken before the check. Closing the check's read-write connection can delete them (Bun's own
 * SQLite on Linux does, for a file that is not a database), and a file kept aside must keep them. Best effort: where a link
 * cannot be made (no hard links on that disk) the side is simply not held. `release` drops the links: the file is good (a -wal
 * the close folded in must not come back) or busy (another connection owns the -wal now). `restore`, only on the way to
 * keeping the file aside, puts back each held side that is gone or is no longer the same file (the check made a new one).
 * `putBackMissing`, after a disk or open error (the file stays where it is), puts back only a side that is gone.
 */
function holdSideFiles(path: string) {
  const held: Array<{ side: string; ino: number }> = []
  for (const side of ['-wal', '-shm']) {
    const link = `${path}${side}.held`
    rmSync(link, { force: true }) // a crashed start's link is never restored: by now it may be older than the live file
    if (!existsSync(path + side)) continue
    try {
      linkSync(path + side, link)
      held.push({ side, ino: statSync(link).ino })
    } catch {
      rmSync(link, { force: true })
    }
  }
  const inoOf = (f: string) => {
    try {
      return statSync(f).ino
    } catch {
      return undefined
    }
  }
  return {
    release: () => {
      for (const { side } of held) rmSync(`${path}${side}.held`, { force: true })
    },
    putBackMissing: () => {
      for (const { side } of held)
        if (inoOf(path + side) === undefined) renameSync(`${path}${side}.held`, path + side)
        else rmSync(`${path}${side}.held`, { force: true })
    },
    restore: () => {
      for (const { side, ino } of held)
        if (inoOf(path + side) === ino) rmSync(`${path}${side}.held`, { force: true })
        else renameSync(`${path}${side}.held`, path + side)
    },
  }
}

const NO_HOLD = { release: () => {}, putBackMissing: () => {}, restore: () => {} }

export type OpenedHistory = { store: HistoryStore; keptAs?: string }

/**
 * Opens history.sqlite like `openHistory`, except that a file that fails the rule above is kept aside and replaced by an empty
 * one. Only for the live bridge: another process must never move a file the live bridge may have open. If the new history
 * cannot be made (a full disk), the file goes back where it was, so the next start tries again and the owner is still told.
 */
export function openHistoryOrKeepAside(
  path: string,
  log: Logger,
  now: number,
  hooks: RecoverHooks = {},
): OpenedHistory {
  if (!existsSync(path)) return { store: openHistory(path) }
  for (const f of [path, `${path}-wal`]) if (existsSync(f)) readThrough(f, hooks.readAt ?? readSync)
  // Bun's SQLite on Linux deletes the -wal and -shm when the check's read-write connection closes on a file that is not a
  // database, and a file kept aside must keep them: hold them, but only on Linux and only for a file a read-only check did NOT
  // find healthy. A healthy, live database is never linked (on macOS a link to a live -wal makes SQLite fail with
  // SQLITE_IOERR_VNODE), and macOS keeps the plain path.
  const platform = hooks.platform ?? process.platform
  const hold = platform === 'linux' && healthyReadOnly(path) !== true
  if (hold) hooks.onHold?.()
  const side = hold ? holdSideFiles(path) : NO_HOLD
  const seen = new Set<number>()
  let verdict: 'healthy' | 'repaired' | 'damaged' = 'damaged'
  try {
    // Runs once, at start, before anything else is served: a blocking wait here holds up nothing. Not while side files are held
    // (Linux, a file the read-only check did not find healthy): a retry could check the file without a -wal the last close took,
    // or hold links to a -wal another connection has since folded in.
    const ok = checkWithRetry(path, (p) => healthy(p, hooks.quickCheck, hooks.ftsCheck, log), {
      sleep: hooks.sleep ?? Bun.sleepSync,
      retry: !hold,
      seen,
    })
    verdict = ok ? 'healthy' : (hooks.dropSearch ?? dropSearchTables)(path) ? 'repaired' : 'damaged'
  } catch (e) {
    if (notTheFile(e)) {
      // another connection owns the -wal (busy, locked, a WAL lock, seen on any try): not ours. Otherwise the file stays, so keep
      // what a close took.
      if ([...seen].some((rc) => OTHER_OWNER.has(rc)) || OTHER_OWNER.has(primaryCode(e) ?? -1)) side.release()
      else side.putBackMissing()
      throw refusal(e)
    }
  }
  // Only the check and the repair are judged above. Letting go of the held side files and opening the store come after, so their
  // errors (a link that cannot be removed, a migration that fails on an older file) refuse the start instead of moving a file that
  // checked out.
  if (verdict !== 'damaged') {
    side.release()
    if (verdict === 'repaired') log.warn('search tables were damaged; dropped, a rebuild is queued', {})
    return { store: (hooks.openExisting ?? openHistory)(path) }
  }
  side.restore()
  const kept = keptName(path, now)
  const moved: string[] = []
  const putBack = () => {
    for (const side of SIDES) rmSync(path + side, { force: true }) // whatever a failed new history left
    for (const side of moved) renameSync(kept + side, path + side)
  }
  try {
    for (const side of SIDES)
      if (existsSync(path + side)) {
        renameSync(path + side, kept + side)
        moved.push(side)
      }
  } catch (e) {
    for (const side of moved) renameSync(kept + side, path + side)
    throw new Error(`history.sqlite is damaged and could not be moved aside: ${(e as Error).message}`)
  }
  let store: HistoryStore | undefined
  try {
    store = (hooks.openFresh ?? openHistory)(path)
    store.kvSet(HISTORY_KEPT_ASIDE_KEY, basename(kept))
    store.kvSet(HISTORY_RESET_KEY, new Date(now).toISOString())
  } catch (e) {
    store?.close()
    putBack()
    throw e
  }
  log.error('history.sqlite is damaged; kept aside and started a new history', { kept_as: basename(kept) })
  return { store, keptAs: basename(kept) }
}

export function historyKeptAsideText(name: string): string {
  return say({
    mac: `Your message history on this Mac could not be read, so Talos started a new one. The damaged file was kept as ${name} in the Talos folder. Earlier messages are not searchable, replies that had not reached the app yet are lost, a message given to a thread's own session that it had not read yet is lost (send it again), and a card that was still waiting may need to be sent again. A recent message may arrive at your agent a second time. A control you sent before this, such as Clear, is not run if it arrives again; tap it again if you still want it. New messages work as usual.`,
    linux: `Your message history on this computer could not be read, so Talos started a new one. The damaged file was kept as ${name} in the Talos folder. Earlier messages are not searchable, replies that had not reached the app yet are lost, a message given to a thread's own session that it had not read yet is lost (send it again), and a card that was still waiting may need to be sent again. A recent message may arrive at your agent a second time. A control you sent before this, such as Clear, is not run if it arrives again; tap it again if you still want it. New messages work as usual.`,
  })
}
