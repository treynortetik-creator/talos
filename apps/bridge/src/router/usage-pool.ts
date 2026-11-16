// Every session's latest plan-usage reading, and the newest per limit kind (packages/protocol usage-readings.ts says why).
//
// Main's readings come from the Talos mod's state. The mod re-sends its state every few seconds whether or not Claude Code has
// heard anything new, so the time of a reading is the last state (its `at`, the mod's sync) that was evidence it was fresh: one
// whose figures changed, or one sent while a turn ran or just as it ended, since a running turn is what makes API calls. The first reading of a session that is idle is of
// unknown age and carries no time: it loses to any timed reading. KNOWN LIMITATION: one long tool call inside a turn counts as
// fresh for its whole run.
//
// A thread session's readings come from its usage file (written by its status line), for the session id workers.json names for
// the thread, read on the hub's poll. A thread that leaves workers.json leaves its readings behind; a parked one keeps them, since
// they are still the newest the pool has. A file that cannot be read or parsed gives that thread no reading and one log line per
// distinct problem: the figure the app shows then carries its true (older) time, never a fresh-looking one.
import { lstatSync, readFileSync } from 'node:fs'
import {
  MAX_THREAD_SESSION_STATES,
  newestReadings,
  type RateLimitT,
  readingsFromUsageFile,
  type SessionStateT,
  USAGE_AS_OF_FEATURE,
  USAGE_FILE_MAX_BYTES,
  type WorkersFileT,
  withoutAsOf,
  workerUsagePath,
} from '@talos-app/protocol'
import type { Logger } from '../log.ts'

type MainTrack = { session: string; key: string; busy: boolean; asOf: string | undefined }
type ThreadTrack = { fileKey: string; readings: RateLimitT[]; problem?: string }

const limitsKey = (ls: readonly RateLimitT[]) => JSON.stringify(withoutAsOf(ls))

export class UsagePool {
  private main: MainTrack | undefined
  /** Main's last timed readings, kept after its mod lapses: they age like anyone's. */
  private mainKept: RateLimitT[] = []
  private readonly threads = new Map<string, ThreadTrack>()
  private asOfOk = false

  constructor(private readonly log?: Logger) {}

  /** From `ready.features`: `as_of` goes to the app only through a relay that lists USAGE_AS_OF_FEATURE. */
  setRelayFeatures(features: readonly string[]): void {
    this.asOfOk = features.includes(USAGE_AS_OF_FEATURE)
  }

  /** Main's readings with their times. `state` is main's LIVE state (undefined when the mod is not live). */
  private mainReadings(state: SessionStateT | undefined, nowMs: number): RateLimitT[] {
    if (!state) {
      this.main = undefined
      return this.mainKept // untimed ones were dropped when they were taken: a dead mod's figures of unknown age feed nothing
    }
    const key = limitsKey(state.rate_limits)
    const busy = state.busy === true || state.compacting === true
    const was = this.main?.session === state.session_id ? this.main : undefined
    // the mod's own time for this state (its last sync), never later than now
    const sent = Date.parse(state.at)
    const now = new Date(Number.isFinite(sent) ? Math.min(sent, nowMs) : nowMs).toISOString()
    let asOf: string | undefined
    if (!was) asOf = busy ? now : undefined
    else if (was.key !== key || busy || was.busy) asOf = now
    else asOf = was.asOf
    this.main = { session: state.session_id, key, busy, asOf }
    const readings: RateLimitT[] = state.rate_limits.map(({ as_of: _a, ...r }) => (asOf ? { ...r, as_of: asOf } : r))
    this.mainKept = readings.filter((r) => r.as_of !== undefined)
    return readings
  }

  /** Reads each thread session's usage file (the hub's poll). */
  readThreads(talosHome: string, file: WorkersFileT | null, nowMs: number): void {
    if (!file) return
    const seen = new Set<string>()
    for (const [thread, e] of Object.entries(file.threads)) {
      if (!e.session_id) continue
      if (seen.size >= MAX_THREAD_SESSION_STATES) break
      seen.add(thread)
      this.readThread(thread, workerUsagePath(talosHome, thread), e.session_id, nowMs)
    }
    for (const t of [...this.threads.keys()]) if (!seen.has(t)) this.threads.delete(t)
  }

  private readThread(thread: string, path: string, sessionId: string, nowMs: number): void {
    const had = this.threads.get(thread)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch {
      // no file yet: the session has had no API response, or this Mac's app predates the recorder
      this.threads.set(thread, { fileKey: 'none', readings: [] })
      return
    }
    const fileKey = `${sessionId}:${st.ino}:${st.size}:${st.mtimeMs}`
    if (had?.fileKey === fileKey) return
    const fail = (problem: string) => {
      if (had?.problem !== problem) this.log?.warn('thread usage reading not used', { thread, problem })
      this.threads.set(thread, { fileKey, readings: [], problem })
    }
    if (!st.isFile()) {
      fail('not a plain file')
      return
    }
    if (st.size > USAGE_FILE_MAX_BYTES) {
      fail('too big')
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // the file's own text never goes into the log
      fail('unreadable')
      return
    }
    const r = readingsFromUsageFile(raw, { sessionId, nowMs, mtimeMs: st.mtimeMs })
    // a file from the thread's earlier session is not a problem, just not this session's
    if (r.ok) this.threads.set(thread, { fileKey, readings: r.readings })
    else if (r.reason === 'another session') this.threads.set(thread, { fileKey, readings: [] })
    else fail(r.reason)
  }

  /** The newest reading per kind across main (live state) and every thread session, with `as_of`. */
  readings(mainState: SessionStateT | undefined, nowMs: number, opts: { maxAgeMs?: number } = {}): RateLimitT[] {
    const sources = [this.mainReadings(mainState, nowMs), ...[...this.threads.values()].map((t) => t.readings)]
    return newestReadings(sources, nowMs, opts)
  }

  /** Main's state as the app gets it: the pooled readings, `as_of` only when the relay passes it. */
  forApp(state: SessionStateT, nowMs: number): SessionStateT {
    const pooled = this.readings(state, nowMs)
    return { ...state, rate_limits: this.asOfOk ? pooled : withoutAsOf(pooled) }
  }
}
