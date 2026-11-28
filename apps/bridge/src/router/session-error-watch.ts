// A thread session whose turn ended on an API error or a refusal: found in its transcript, never on the screen (docs/CLAUDE-CODE.md).
// Claude Code writes a FINAL failure as an `assistant` record with `isApiErrorMessage: true` and an `error` kind, and a refusal as the
// same record with `message.stop_reason: "refusal"` (it carries `error: "invalid_request"`, so the refusal is classified FIRST); a
// retry is only a `system` record with subtype `api_error`, and a refusal that a fallback model took over leaves a `system` record
// and no error record at all. So: the turn ended on an error exactly when the LAST user or assistant record of the main chain is such
// an assistant record, and the file has been quiet a few seconds. Nothing of the record's own text is ever used or shown: the kind
// comes from its fields and the words from session-error-words.ts. One episode per record uuid, remembered across restarts.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { WORKER_LIVE_STATES, type WorkersFileT } from '@talos-app/protocol'
import type { ErrorKind, OtherWhat, RefusalReason } from './session-error-words.ts'
import { findTranscript, transcriptPath } from './worker-context.ts'

/** The end of the file read first, then this much if no conversation record was in it (one tool result can be huge). */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024] as const
/** The newest write must be at least this old: a retry or the turn's own continuation has not started a new record. */
export const QUIET_MS = 8_000
/** An error older than the bridge's start by more than this is history, not news (the uuid memory covers the rest): an hour. */
export const SINCE_SLACK_MS = 60 * 60_000
/** A session whose transcript is not where its folder name says is looked for at most this often. */
const FIND_EVERY_MS = 60_000
/** `apiError` values that mean the request itself is too big. */
const TOO_BIG_API = new Set(['pdf_too_large', 'autocompact_thrashing'])
const TOO_BIG_DETAILS = /prompt (is )?too long|request[ _]too[ _]large|too many (images|pixels)|too large/i

export type Found = {
  kind: ErrorKind
  /** The failed record's uuid: one episode each, and the key of the memory. */
  uuid: string
  /** When the record was written (ms), or undefined when it has no readable time. */
  at: number | undefined
  refusal?: RefusalReason
  what?: OtherWhat
  /** When the last good assistant record before this one was written (ms), when it is in the part of the file that was read. */
  prevAt?: number
  /** An error another path owns (a usage limit): remembered, never offered. */
  skip?: true
}
export type Episode = {
  thread: string
  session: string
  found: Found /** When the session started (ms), when workers.json says. */
  startedAt?: number
}

type Row = Record<string, unknown>
const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The last `user` or `assistant` record of the main chain in these lines (sidechain records and every other record kind are skipped). */
export function lastConversationRecord(lines: readonly string[]): Row | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(row) || (row.type !== 'user' && row.type !== 'assistant') || row.isSidechain === true) continue
    return row
  }
  return undefined
}

/**
 * What a record that ended a turn on an error is, in Talos's kinds, or 'skip' for one another path already owns (a usage limit:
 * supervisor/usage-limit.ts and Claude's own wait), or undefined when it is not an error record at all. A refusal is decided FIRST:
 * it carries `error: "invalid_request"`, which alone would read as "too big" or "other".
 */
export function classify(row: Row): Omit<Found, 'uuid' | 'at'> | 'skip' | undefined {
  const msg = isObj(row.message) ? row.message : {}
  if (msg.stop_reason === 'refusal') {
    const details = isObj(msg.stop_details) ? msg.stop_details : {}
    const c = str(details.category)
    return { kind: 'refusal', refusal: c === 'bio' ? 'biology' : c === 'cyber' ? 'cybersecurity' : 'other' }
  }
  if (row.isApiErrorMessage !== true) return undefined
  const error = str(row.error)
  const api = str(row.apiError)
  if (api === 'usage_limit_reached' || (error === 'rate_limit' && isObj(row.quotaLimits))) return 'skip'
  if (error === 'authentication_failed') return { kind: 'auth' }
  if (error === 'rate_limit') return { kind: 'rate' }
  if (error === 'server_error') return { kind: 'servers' }
  if (error === 'invalid_request') {
    const details = str(row.errorDetails)
    if ((api && TOO_BIG_API.has(api)) || (details !== undefined && TOO_BIG_DETAILS.test(details)))
      return { kind: 'too_big' }
    return { kind: 'other', what: 'unknown' }
  }
  if (error === 'billing_error') return { kind: 'other', what: 'billing' }
  if (error === 'model_not_found') return { kind: 'other', what: 'model not found' }
  if (error === 'max_output_tokens') return { kind: 'other', what: 'reply too long' }
  return { kind: 'other', what: 'unknown' }
}

/** The lines at the end of the file at `path` (the first one dropped when the read began inside it), or undefined when it cannot be read. */
export function readEnd(path: string, bytes: number): { lines: string[]; whole: boolean } | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined // not there, or a link
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return undefined // a pipe or anything else is never read
    const len = Math.min(st.size, bytes)
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, st.size - len)
    const lines = buf.subarray(0, n).toString('utf8').split('\n')
    if (st.size > len) lines.shift() // starts mid-line
    return { lines, whole: st.size <= len }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** When the last good assistant record (a real model's reply, not a synthetic error) before the record `uuid` was written, or undefined. */
export function previousGoodAssistantAt(lines: readonly string[], uuid: string): number | undefined {
  let passed = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(row)) continue
    if (!passed) {
      if (row.uuid === uuid) passed = true
      continue
    }
    const msg = isObj(row.message) ? row.message : {}
    if (
      row.type !== 'assistant' ||
      row.isSidechain === true ||
      row.isApiErrorMessage === true ||
      msg.model === '<synthetic>'
    )
      continue
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    return Number.isFinite(ts) ? ts : undefined
  }
  return undefined
}

/** The uuid of the last user or assistant record of this session's transcript now, or undefined when it cannot be read. */
export function lastRecordUuid(claudeDir: string, cwd: string, sessionId: string): string | undefined {
  let path: string | undefined = transcriptPath(claudeDir, cwd, sessionId)
  try {
    statSync(path)
  } catch {
    path = findTranscript(claudeDir, sessionId)
  }
  if (!path) return undefined
  for (const want of TAIL_BYTES) {
    const r = readEnd(path, want)
    if (!r) return undefined
    const row = lastConversationRecord(r.lines)
    if (row) return str(row.uuid)
    if (r.whole) return undefined
  }
  return undefined
}

type Look = { key: string; found: Found | undefined }
type Located = { session: string; path: string | undefined; at: number }

export type WatchDeps = {
  /** Claude Code's config folder; undefined when it cannot be known (nothing is read). */
  claudeDir: () => string | undefined
  now: () => number
  /** When this bridge began watching (ms): older errors are history. */
  sinceMs: number
  quietMs?: number
  /** The uuid memory (kept across restarts). */
  seen: (key: string) => boolean
  mark: (key: string) => void
  /** Did the owner end this thread's turn by hand at or after `at`? */
  ownerEndedSince: (thread: string, at: number) => boolean
  /** Offers the owner the card (or the plain line). Never throws. */
  raise: (e: Episode) => Promise<void>
  warn?: (msg: string, f?: Record<string, unknown>) => void
}

export const episodeKey = (thread: string, uuid: string) => `session_error:${thread}:${uuid}`

export class SessionErrorWatch {
  private looks = new Map<string, Look>()
  private located = new Map<string, Located>()

  constructor(private readonly d: WatchDeps) {}

  /** One look at every dedicated thread session that is up and idle. */
  tick(file: WorkersFileT | null, dedicated: (thread: string) => boolean): void {
    const claudeDir = this.d.claudeDir()
    if (!file || !claudeDir) return
    const live = new Set<string>()
    for (const [thread, e] of Object.entries(file.threads)) {
      if (!dedicated(thread) || !e.session_id) continue
      live.add(thread)
      // up, and not in a turn (a busy session has not ended it); Claude Code's own wait at a usage limit is not an error to report
      if (!WORKER_LIVE_STATES.includes(e.state) || e.state === 'busy' || e.state === 'starting' || e.limit_wait)
        continue
      const path = this.pathOf(thread, claudeDir, e.cwd, e.session_id)
      if (!path) continue
      let st: { mtimeMs: number; size: number }
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (this.d.now() - st.mtimeMs < (this.d.quietMs ?? QUIET_MS)) continue
      const found = this.look(thread, path, `${st.mtimeMs}:${st.size}`)
      if (!found) continue
      const key = episodeKey(thread, found.uuid)
      if (this.d.seen(key)) continue
      // older than this bridge's watch, a limit another path owns, or an error the owner already moved past: remembered, never announced
      const at = found.at ?? this.d.now()
      if (found.skip || at < this.d.sinceMs || this.d.ownerEndedSince(thread, at)) {
        this.d.mark(key)
        continue
      }
      this.d.mark(key) // BEFORE the offer: a crash or a slow send never offers it twice
      const started = e.started_at ? Date.parse(e.started_at) : Number.NaN
      void this.d
        .raise({ thread, session: e.session_id, found, ...(Number.isFinite(started) ? { startedAt: started } : {}) })
        .catch((err) => this.d.warn?.('session error not offered', { thread, error: (err as Error).message }))
    }
    for (const m of [this.looks, this.located]) for (const t of [...m.keys()]) if (!live.has(t)) m.delete(t)
  }

  /** The turn-ending error at the end of this transcript, read once per change of the file. */
  private look(thread: string, path: string, key: string): Found | undefined {
    const hit = this.looks.get(thread)
    if (hit && hit.key === `${path}:${key}`) return hit.found
    const found = this.read(path)
    this.looks.set(thread, { key: `${path}:${key}`, found })
    return found
  }

  private read(path: string): Found | undefined {
    for (const want of TAIL_BYTES) {
      const r = readEnd(path, want)
      if (!r) return undefined
      const row = lastConversationRecord(r.lines)
      if (row) {
        const f = this.found(row)
        const prev = f ? previousGoodAssistantAt(r.lines, f.uuid) : undefined
        return f && prev !== undefined ? { ...f, prevAt: prev } : f
      }
      if (r.whole) return undefined
    }
    return undefined
  }

  private found(row: Row): Found | undefined {
    const c = classify(row)
    if (c === undefined) return undefined
    const uuid = str(row.uuid)
    if (!uuid) return undefined
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    const at = Number.isFinite(ts) ? ts : undefined
    return c === 'skip' ? { kind: 'other', uuid, at, skip: true } : { ...c, uuid, at }
  }

  /** The transcript's path: where the folder name says, else (on a miss, at most once a minute) wherever that session id lives. */
  private pathOf(thread: string, claudeDir: string, cwd: string, sessionId: string): string | undefined {
    const direct = transcriptPath(claudeDir, cwd, sessionId)
    try {
      statSync(direct)
      return direct
    } catch {
      // not there: look in every project folder
    }
    const now = this.d.now()
    const hit = this.located.get(thread)
    if (hit && hit.session === sessionId) {
      if (hit.path) return hit.path
      if (now - hit.at < FIND_EVERY_MS) return undefined
    }
    const path = findTranscript(claudeDir, sessionId)
    this.located.set(thread, { session: sessionId, path, at: now })
    return path
  }
}
