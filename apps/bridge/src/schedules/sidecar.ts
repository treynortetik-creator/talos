// $TALOS_APP_HOME/schedules-meta.json (docs/SCHEDULES.md S3.5): Talos-only facts (a job's result thread) and display
// caches (offers, in-flight runs, finished-run summaries). Mode 0600, tmp + rename, ONE writer: the live, gated bridge.
// It holds NO approval state (N1): deleting or editing it can lose a result thread or an offer timestamp, never an
// approval, and every loss falls back safely (default_thread; the job is offered again; the orphan sweep reads Chronos).
import { join } from 'node:path'
import type { HeartbeatResultT } from '@talos-app/protocol'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'

export const SIDECAR_RETENTION_MS = 8 * 24 * 3600_000
const MAX_RUNS = 200

export type Offer = {
  id: string
  ds: string
  run_id: string
  fire_at: string | null
  window_ends: string | null
  trigger: 'clock' | 'run_now'
  again: boolean
  /** What the notification carried; the claim re-reads the approved text and refuses on a mismatch (review R4). */
  content_hash?: string
  /** The bridge instance that sent it; a restart offers it again (the old session is gone). */
  instance: string
  at: number
}
export type Inflight = {
  id: string
  ds: string
  fire_at: string | null
  instance: string
  claimed_at: number
  /** Set when the run was closed (finished, timed out, or ended by a restart); kept so a late done can still be answered. */
  closed?: string
}
export type RunNote = {
  id: string
  ds: string
  started_at: string
  trigger: 'clock' | 'run_now'
  status?: 'ok' | 'failed' | 'timed_out' | 'session_ended' | 'running'
  summary?: string
  late_note?: string
  report?: string
  finished_at?: string
  duration_s?: number
  /** A heartbeat run's result: the outcome and, per source, ok / ms / unreadable / error (never item text). */
  heartbeat?: HeartbeatResultT
  at: number
}

export type SidecarData = {
  adapter: string
  jobs: Record<string, { thread_id: string | null }>
  offers: Record<string, Offer>
  inflight: Record<string, Inflight>
  runs: Record<string, RunNote>
  /** Failure/hold notices already sent, so a restart does not repeat them. key -> at */
  notified: Record<string, number>
}

const empty = (): SidecarData => ({ adapter: 'chronos', jobs: {}, offers: {}, inflight: {}, runs: {}, notified: {} })

export class Sidecar {
  private data: SidecarData
  readonly path: string
  /** Memory is ahead of the file: a write failed or was refused. `flush()` writes it out. */
  private dirty = false

  /** `canWrite` is the liveness gate (S3.2): checked on EVERY write. `onWriteError` hears a write that failed. */
  constructor(
    home: string,
    private readonly canWrite: () => boolean,
    private readonly onWriteError: (e: Error) => void = () => {},
  ) {
    this.path = join(home, 'schedules-meta.json')
    this.data = this.read()
  }

  private read(): SidecarData {
    const raw = readJsonFile<Partial<SidecarData>>(this.path)
    const d = empty()
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(d) as Array<keyof SidecarData>) {
        const v = (raw as Record<string, unknown>)[k]
        if (v !== undefined && typeof v === typeof d[k]) (d as Record<string, unknown>)[k] = v
      }
    }
    return d
  }

  /** Re-reads the file (another process may have written the thread). Reads need no gate. */
  reload() {
    this.data = this.read()
  }

  get all(): Readonly<SidecarData> {
    return this.data
  }

  /**
   * Writes only for the live, gated bridge. Returns false when the gate said no or the disk refused; either way the file is
   * behind memory until `flush()` (the runner calls it every tick) or the next save gets it out. It never throws: a full
   * disk must not abort the run or offer that was being recorded.
   */
  private save(): boolean {
    if (!this.canWrite()) {
      this.dirty = true
      return false
    }
    try {
      writeJsonAtomic(this.path, this.data, 0o600)
      this.dirty = false
      return true
    } catch (e) {
      this.dirty = true
      this.onWriteError(e as Error)
      return false
    }
  }

  /** Saves a change already made in memory; when the write fails the change is undone, so memory never claims what the file lacks. */
  private commit(undo: () => void): boolean {
    if (this.save()) return true
    undo()
    return false
  }

  /** Writes what an earlier failed or refused save left behind. True when the file is up to date. */
  flush(): boolean {
    return !this.dirty || this.save()
  }

  threadOf(id: string): string | null {
    return this.data.jobs[id]?.thread_id ?? null
  }
  setThread(id: string, thread: string | null): boolean {
    // Gate first: memory must not change when the save is refused.
    if (!this.canWrite()) return false
    const before = this.data.jobs[id]
    this.data.jobs[id] = { thread_id: thread }
    return this.commit(() => {
      if (before) this.data.jobs[id] = before
      else delete this.data.jobs[id]
    })
  }
  forgetJob(id: string): boolean {
    // Gate first: memory must not change when the save is refused.
    if (!this.canWrite()) return false
    const before = this.data.jobs[id]
    delete this.data.jobs[id]
    return this.commit(() => {
      if (before) this.data.jobs[id] = before
    })
  }

  /** A clock offer is keyed (id, ds); a Run now offer sits beside it under its own key. */
  private offerKey = (id: string, ds: string, trigger: Offer['trigger'] = 'clock') =>
    trigger === 'run_now' ? `${id}|${ds}|run_now` : `${id}|${ds}`
  /** The clock offer for (id, ds), if any. */
  offerFor(id: string, ds: string): Offer | undefined {
    return this.data.offers[this.offerKey(id, ds)]
  }
  offerByRun(runId: string): Offer | undefined {
    return Object.values(this.data.offers).find((o) => o.run_id === runId)
  }
  /** Records the offer BEFORE the notification goes out (S3.3). */
  recordOffer(o: Offer): boolean {
    // Gate first: an offer left in memory by a refused save would make every later tick skip the job (same instance).
    if (!this.canWrite()) return false
    const key = this.offerKey(o.id, o.ds, o.trigger)
    const before = this.data.offers[key]
    this.data.offers[key] = o
    // A write that failed must not leave the offer in memory either: every later tick would skip a job that was never sent.
    return this.commit(() => {
      if (before) this.data.offers[key] = before
      else delete this.data.offers[key]
    })
  }

  /** The id of the job a run belongs to: from its in-flight entry, else its offer. */
  jobOfRun(runId: string): { id: string; ds: string } | undefined {
    const f = this.data.inflight[runId]
    if (f) return { id: f.id, ds: f.ds }
    const o = this.offerByRun(runId)
    return o ? { id: o.id, ds: o.ds } : undefined
  }
  setInflight(runId: string, f: Inflight): boolean {
    // No gate before the memory change: run state must keep moving while the socket is down, or a finished run stays open
    // and expires as a false 'ran out of time'. The next gated save writes the whole file, so it persists on reconnect.
    this.data.inflight[runId] = f
    return this.save()
  }
  inflightOf(runId: string): Inflight | undefined {
    return this.data.inflight[runId]
  }
  closeInflight(runId: string, status: string): boolean {
    // No gate before the memory change: run state must keep moving while the socket is down, or a finished run stays open
    // and expires as a false 'ran out of time'. The next gated save writes the whole file, so it persists on reconnect.
    const f = this.data.inflight[runId]
    if (f) f.closed = status
    return this.save()
  }

  note(runId: string): RunNote | undefined {
    return this.data.runs[runId]
  }
  setNote(runId: string, patch: Partial<RunNote> & Pick<RunNote, 'id' | 'ds'>, now: number): boolean {
    // No gate before the memory change: run state must keep moving while the socket is down, or a finished run stays open
    // and expires as a false 'ran out of time'. The next gated save writes the whole file, so it persists on reconnect.
    const cur = this.data.runs[runId]
    this.data.runs[runId] = {
      ...cur,
      ...patch,
      started_at: patch.started_at ?? cur?.started_at ?? new Date(now).toISOString(),
      trigger: patch.trigger ?? cur?.trigger ?? 'clock',
      at: cur?.at ?? now,
    }
    return this.save()
  }
  runsOf(id: string): Array<[string, RunNote]> {
    return Object.entries(this.data.runs)
      .filter(([, r]) => r.id === id)
      .sort((a, b) => (b[1].started_at < a[1].started_at ? -1 : b[1].started_at > a[1].started_at ? 1 : 0))
  }

  wasNotified(key: string): boolean {
    return key in this.data.notified
  }
  markNotified(key: string, now: number): boolean {
    // Gate first: a key set in memory by a refused save would mean the owner is never told (wasNotified says yes).
    if (!this.canWrite()) return false
    const before = this.data.notified[key]
    this.data.notified[key] = now
    return this.commit(() => {
      if (before === undefined) delete this.data.notified[key]
      else this.data.notified[key] = before
    })
  }

  /** Offers, in-flight entries, notes and notices older than 8 days go (S3.5). */
  prune(now: number): boolean {
    const cut = now - SIDECAR_RETENTION_MS
    let changed = false
    const drop = <T>(m: Record<string, T>, old: (v: T) => boolean) => {
      for (const [k, v] of Object.entries(m)) {
        if (old(v)) {
          delete m[k]
          changed = true
        }
      }
    }
    drop(this.data.offers, (o) => o.at < cut)
    drop(this.data.inflight, (f) => f.claimed_at < cut)
    drop(this.data.runs, (r) => r.at < cut)
    drop(this.data.notified, (at) => at < cut)
    const runs = Object.entries(this.data.runs)
    if (runs.length > MAX_RUNS) {
      runs.sort((a, b) => a[1].at - b[1].at)
      for (const [k] of runs.slice(0, runs.length - MAX_RUNS)) delete this.data.runs[k]
      changed = true
    }
    return changed ? this.save() : true
  }
}
