// A history.sqlite the database cannot trust must not keep the bridge from starting: the owner's phone would go quiet and
// nothing would say why. The live bridge moves such a file (and its -wal and -shm) aside, never deletes it, starts on a new
// empty history, and leaves a note in the new history's kv so the owner hears about it once the relay is reachable.
//
// The rule:
//   1. Read the whole file through the OS first. A read error there (EIO, no permission) is the disk or the account, not the
//      file: nothing is touched and the start is refused.
//   2. Run one whole-file `quick_check`.
//   3. If it is not ok, try dropping the search tables (inside a transaction). If the check is then ok, the problems were only in
//      search: the usual pass rebuilds them and the history stays.
//   4. Anything else (a drop that fails, a problem outside search, a bad free list, a thrown "corrupt") moves the file.
// The new history starts without the old seen ids, so a recent message the relay sends again can reach the agent twice. That is
// accepted (a card decision cannot run twice) and the owner's note says so.
import { Database } from 'bun:sqlite'
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { type HistoryStore, MAX_FUTURE_MS, openHistory } from './history-store.ts'
import type { Logger } from './log.ts'
import { KV_DIRTY } from './search/schema.ts'

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
  text: 'The Mac’s history was reset after this was sent, so it was not run. Send it again.',
} as const

/**
 * What SQLite throws when the trouble is not the file's content: someone else holds it (busy, locked), the disk fails (I/O), or
 * it cannot be opened. Those leave the file alone and refuse the start. Any other error from the check means the file is bad
 * (SQLite says "corrupt" or "not a database", or runs out of memory reading garbled data).
 */
const notTheFile = (e: unknown) =>
  /^SQLITE_(BUSY|LOCKED|CANTOPEN|IOERR)/.test((e as { code?: string } | null)?.code ?? '')

export type RecoverHooks = {
  /** Test seam: the read used for step 1 (a test makes one page fail with EIO). */
  readAt?: typeof readSync
  /** Test seam: makes the new history (a full disk fails here). */
  openFresh?: (path: string) => HistoryStore
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

/** One whole-file `quick_check` on a fresh connection: true when it says `ok`. Throws when the trouble is not the file's content. */
function healthy(path: string): boolean {
  const db = new Database(path, { readwrite: true })
  try {
    db.exec('PRAGMA query_only = ON') // the check runs no write; closing the last connection can still fold the -wal into the file
    const rows = db.query('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>
    return rows.length === 1 && rows[0]?.quick_check === 'ok'
  } catch (e) {
    if (notTheFile(e)) throw e
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
    db.exec('BEGIN')
    db.exec('DROP TABLE IF EXISTS msg_fts')
    db.exec('DROP TABLE IF EXISTS fts_files')
    db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      KV_DIRTY,
      '1',
    )
    const rows = db.query('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') throw new Error('still not ok')
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
  try {
    const ok = healthy(path)
    if (ok || dropSearchTables(path)) {
      if (!ok) log.warn('search tables were damaged; dropped, a rebuild is queued', {})
      return { store: openHistory(path) }
    }
  } catch (e) {
    if (notTheFile(e)) throw e
  }
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
  return `Your message history on this Mac could not be read, so Talos started a new one. The damaged file was kept as ${name} in the Talos folder. Earlier messages are not searchable, replies that had not reached the app yet are lost, a message given to a thread's own session that it had not read yet is lost (send it again), and a card that was still waiting may need to be sent again. A recent message may arrive at your agent a second time. A control you sent before this, such as Clear, is not run if it arrives again; tap it again if you still want it. New messages work as usual.`
}
