// The heartbeat's durable state (docs/HEARTBEAT.md): $TALOS_APP_HOME/heartbeat-state.json (shadow mode has its own file, so
// shadow rows are never read as "already shown" by the live heartbeat). Mode 0600, tmp + rename. It holds no approval state:
// deleting it re-baselines (items show again once, sources start over). A row that cannot be read costs that row and is
// counted; a file that cannot be read at all is set aside and the heartbeat starts over, and the owner is told.
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { HeartbeatItemRead, IsoTs, RunKey } from '@talos-app/protocol'
import { z } from 'zod'
import { writeJsonAtomic } from '../fsutil.ts'

export const STORE_SCHEMA = 'talos.heartbeat-state/1'
export const RETENTION_MS = 14 * 24 * 3600_000
export const MAX_ITEMS = 2000

/** One state file per heartbeat job, so two jobs never share cursors, dedupe, wakes or a pending post. */
export const storeFile = (home: string, shadow: boolean, jobId: string) =>
  join(home, `heartbeat-state.${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}${shadow ? '.shadow' : ''}.json`)

/** `source` ids are `[a-z0-9-]`, so the first "|" always ends the source: the pair is unambiguous. */
export const itemId = (source: string, key: string) => `${source}|${key}`

const Cursor = z.record(z.string(), z.unknown()).nullable()
const StoredItemSchema = HeartbeatItemRead.extend({
  state: z.enum(['new', 'surfaced']),
  surfaced_at: IsoTs.nullable(),
  attempts: z.number().int().min(0).max(1000),
})
export type StoredItem = z.infer<typeof StoredItemSchema>
const SourceState = z.object({
  cursor: Cursor,
  last_ok: IsoTs.nullable(),
  fail_streak: z.number().int().min(0).max(1_000_000),
})
export type SourceState = z.infer<typeof SourceState>

/** A post that was decided and stored but may not have gone out yet (crash safety). */
const Pending = z.object({
  run_key: RunKey,
  message_id: z.string().min(1).max(100),
  frame_id: z.string().min(1).max(100),
  thread_id: z.string().min(1).max(100),
  text: z.string().max(4000),
  silent: z.boolean(),
  /** Item ids this post delivers: marked surfaced once it is accepted. */
  ids: z.array(z.string()).max(2000),
  /** Posts tried so far. A recovery retries once, then stops asking. */
  attempts: z.number().int().min(0).max(10),
  created_at: IsoTs,
})
export type Pending = z.infer<typeof Pending>

/** An agent wake that was handed over and has not come back (HB4). Its items stay `new` until the run reports done ok. */
const Wake = z.object({
  run_id: z.string().min(1).max(64),
  run_key: RunKey,
  /** Item ids in the run pack. */
  ids: z.array(z.string()).max(2000),
  at: IsoTs,
})
export type Wake = z.infer<typeof Wake>

export type HeartbeatStore = {
  schema: typeof STORE_SCHEMA
  items: Record<string, StoredItem>
  sources: Record<string, SourceState>
  /** Work-class items refused while the gate was off: item id -> sig, so each is reported once. */
  refused: Record<string, string>
  wakes_today: { date: string; count: number }
  pending: Pending | null
  /** The wake in flight, if any. Written BEFORE the notification is sent, so a crash never loses track of it. */
  wake: Wake | null
  /** When this heartbeat last completed a live run. A gap of over 72 hours here (not a source's own silence) skips the backlog. */
  last_run: string | null
  /** "Install talos-app-mod" has been said and the agent has not been available since, so it is not said again. */
  triage_said: boolean
  /** Slots in a row where the mod had not reported (unknown): a few are waited out, then the items become lines. */
  triage_unknown: number
  /** "Needs a thread of its own" has been said and no wake has gone out since. */
  thread_said: boolean
}

export const emptyStore = (): HeartbeatStore => ({
  schema: STORE_SCHEMA,
  items: {},
  sources: {},
  refused: {},
  wakes_today: { date: '0000-00-00', count: 0 },
  pending: null,
  wake: null,
  last_run: null,
  triage_said: false,
  triage_unknown: 0,
  thread_said: false,
})

export type LoadedStore = {
  store: HeartbeatStore
  /** The file existed and could not be read as a store: it was set aside and this is a fresh one. */
  corrupt: boolean
  /** Item rows dropped because they could not be read. */
  unreadable: number
}

/** `setAside` false (a dry run) reads only: a file that cannot be read is treated as empty and left where it is. */
export function loadStore(path: string, setAside = true): LoadedStore {
  if (!existsSync(path)) return { store: emptyStore(), corrupt: false, unreadable: 0 }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return unreadableStore(path, setAside)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unreadableStore(path, setAside)
  const r = raw as Record<string, unknown>
  if (r.schema !== STORE_SCHEMA) return unreadableStore(path, setAside)
  const store = emptyStore()
  let unreadable = 0
  if (r.items && typeof r.items === 'object' && !Array.isArray(r.items)) {
    for (const [id, row] of Object.entries(r.items)) {
      const p = StoredItemSchema.safeParse(row)
      if (p.success && itemId(p.data.source, p.data.key) === id) store.items[id] = p.data
      else unreadable++
    }
  } else if (r.items !== undefined) unreadable++
  if (r.sources && typeof r.sources === 'object' && !Array.isArray(r.sources)) {
    for (const [id, s] of Object.entries(r.sources)) {
      const p = SourceState.safeParse(s)
      if (p.success) store.sources[id] = p.data
    }
  }
  if (r.refused && typeof r.refused === 'object' && !Array.isArray(r.refused))
    for (const [id, sig] of Object.entries(r.refused)) if (typeof sig === 'string') store.refused[id] = sig
  const w = z
    .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().min(0) })
    .safeParse(r.wakes_today)
  if (w.success) store.wakes_today = w.data
  const pend = Pending.safeParse(r.pending)
  if (pend.success) store.pending = pend.data
  const wk = Wake.safeParse(r.wake)
  if (wk.success) store.wake = wk.data
  const lr = IsoTs.safeParse(r.last_run)
  if (lr.success) store.last_run = lr.data
  if (r.triage_said === true) store.triage_said = true
  if (r.thread_said === true) store.thread_said = true
  if (typeof r.triage_unknown === 'number' && Number.isInteger(r.triage_unknown) && r.triage_unknown >= 0)
    store.triage_unknown = Math.min(r.triage_unknown, 1000)
  return { store, corrupt: false, unreadable }
}

function unreadableStore(path: string, move: boolean): LoadedStore {
  if (move)
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // nothing more can be done; the next save replaces it
    }
  return { store: emptyStore(), corrupt: true, unreadable: 0 }
}

export function saveStore(path: string, store: HeartbeatStore): void {
  writeJsonAtomic(path, store, 0o600)
}

/** Items older than 14 days go, then the oldest past 2,000. Surfaced rows go first: an unshown row is never the one dropped. */
export function prune(store: HeartbeatStore, nowMs: number): void {
  const entries = Object.entries(store.items)
  for (const [id, it] of entries) {
    const seen = Date.parse(it.last_seen)
    if (Number.isFinite(seen) && nowMs - seen > RETENTION_MS && it.state === 'surfaced') delete store.items[id]
  }
  const left = Object.entries(store.items)
  if (left.length > MAX_ITEMS) {
    left.sort((a, b) => {
      const sa = a[1].state === 'surfaced' ? 0 : 1
      const sb = b[1].state === 'surfaced' ? 0 : 1
      return sa - sb || Date.parse(a[1].last_seen) - Date.parse(b[1].last_seen)
    })
    for (const [id] of left.slice(0, left.length - MAX_ITEMS)) delete store.items[id]
  }
  const refused = Object.keys(store.refused)
  if (refused.length > MAX_ITEMS)
    for (const id of refused.slice(0, refused.length - MAX_ITEMS)) delete store.refused[id]
}

/** The local date (YYYY-MM-DD) of `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms))
      .slice(0, 10)
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/**
 * Wakes spent on `date`: the count only when the store's day IS that day. A day the store has not seen, or a stored day
 * later than today (the clock was once set forward), is zero, so a stale bucket never pins the count.
 */
export function wakesOn(store: HeartbeatStore, date: string): number {
  return store.wakes_today.date === date ? store.wakes_today.count : 0
}
export function addWake(store: HeartbeatStore, date: string): void {
  store.wakes_today = { date, count: wakesOn(store, date) + 1 }
}
