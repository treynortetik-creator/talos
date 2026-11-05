// The bridge's half of the agents panel (docs/SUBAGENTS.md 5.3). ModLink hands it every authenticated sync's `agents`
// member (or its absence); this class validates, holds the last good snapshot IN MEMORY ONLY, and emits `session.agents`
// on change at most every AGENTS_EMIT_INTERVAL_MS (trailing edge: the latest change always goes out), trimmed under the
// frame cap, plus a re-send on a AGENTS_HEARTBEAT_MS beat while the mod syncs (a restarted relay refills `ready`), one
// `unknown` snapshot when the mod lapses, and nothing of an old session once a new one appears. Behaviour reference:
// FakeAgentsLink in @talos-app/testkit; contract: defineAgentsBridgeContract (apps/bridge/test-contract).
//
// Privacy: nothing here is written anywhere. Logs carry row counts and reasons, never row text.
import {
  AGENTS_EMIT_INTERVAL_MS,
  AGENTS_HEARTBEAT_MS,
  AgentsSnapshot,
  type AgentsSnapshotT,
  isEndedAgentStatus,
  markAgentsUnknown,
  sameAgentsSnapshot,
  trimAgentsSnapshot,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import type { Logger } from '../log.ts'

export class ModAgents {
  private held: AgentsSnapshotT | undefined
  private lastSent: AgentsSnapshotT | undefined
  private lastSentAt = Number.NEGATIVE_INFINITY
  private pending: AgentsSnapshotT | undefined
  private flushTimer: unknown
  private lapsed = false
  /** The mod's last `agents` did not parse: the held snapshot is older than what the mod reports. */
  private untrusted = false

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    /** Where a snapshot goes: the bridge wraps it in a `session.agents` frame (only to a relay with `agents/1`). */
    private readonly emitFn: (snapshot: AgentsSnapshotT) => void,
  ) {}

  /** The last good snapshot (memory only). checkSessionControl reads it for `agent_stop`. */
  last(): AgentsSnapshotT | undefined {
    return this.held && this.untrusted ? { ...this.held, can_stop: false } : this.held
  }

  /** An authenticated sync. `raw` undefined = the sync carried no `agents` member (nothing changed at the mod). */
  onSync(raw: unknown): void {
    const wasLapsed = this.lapsed
    this.lapsed = false
    if (raw === undefined) {
      if (wasLapsed && this.held)
        this.offer(this.held) // the mod is back: its rows are live again
      else this.beat()
      return
    }
    const p = AgentsSnapshot.safeParse(raw)
    if (!p.success) {
      this.log.warn('mod sync: agents dropped', { reason: p.error.issues[0]?.path.join('.') || 'did not fit' })
      // review R2: the mod meant something newer than what we hold, so the held rows no longer back a Stop. The app
      // keeps the last good rows (the contract: nothing goes out), but last() says can_stop:false until the mod's
      // next good snapshot (it re-sends one at least every 30 s).
      this.untrusted = true
      return
    }
    if (this.held && this.held.session_id !== p.data.session_id) {
      this.pending = undefined // never let an old session's rows go out after a new session's
      this.log.info('mod sync: agents of a new session', { rows: p.data.rows.length })
    }
    this.held = p.data
    this.untrusted = false
    this.offer(p.data)
    this.beat()
  }

  /** No sync inside the live window: one last snapshot with live rows `unknown` and no Stop (only if a row was live). */
  onLapse(): void {
    this.lapsed = true
    const h = this.held
    if (!h || h.rows.every((r) => isEndedAgentStatus(r.status))) return
    this.offer(markAgentsUnknown(h, this.isoNow()))
  }

  /**
   * The relay (re)connected and advertises `agents/1`: it may hold nothing, so the held snapshot goes out again now
   * (or with the pending flush), without waiting for the beat.
   */
  resend(): void {
    if (!this.held) return
    const snap = this.lapsed ? markAgentsUnknown(this.held, this.isoNow()) : { ...this.held, at: this.isoNow() }
    this.lastSent = undefined
    if (this.flushTimer !== undefined) {
      this.pending = trimAgentsSnapshot(snap).snapshot
      return
    }
    this.emit(trimAgentsSnapshot(snap).snapshot, true)
  }

  close(): void {
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString()
  }

  private offer(s: AgentsSnapshotT) {
    const t = trimAgentsSnapshot(s)
    if (t.trimmed) this.log.info('agents snapshot trimmed', { rows: t.snapshot.rows.length, bytes: t.bytes })
    const now = this.clock.now()
    if (now - this.lastSentAt >= AGENTS_EMIT_INTERVAL_MS && this.flushTimer === undefined) return this.emit(t.snapshot)
    this.pending = t.snapshot
    if (this.flushTimer === undefined)
      this.flushTimer = this.clock.setTimeout(
        () => {
          this.flushTimer = undefined
          const p = this.pending
          this.pending = undefined
          if (p) this.emit(p)
        },
        Math.max(0, this.lastSentAt + AGENTS_EMIT_INTERVAL_MS - now),
      )
  }

  /** Like session.state's heartbeat: a held snapshot that has not gone out for AGENTS_HEARTBEAT_MS goes out again. */
  private beat() {
    const now = this.clock.now()
    if (!this.held || this.flushTimer !== undefined || now - this.lastSentAt < AGENTS_HEARTBEAT_MS) return
    this.emit(trimAgentsSnapshot({ ...this.held, at: this.isoNow() }).snapshot, true)
  }

  private emit(s: AgentsSnapshotT, force = false) {
    if (!force && sameAgentsSnapshot(this.lastSent, s)) return
    this.lastSent = s
    this.lastSentAt = this.clock.now()
    try {
      this.emitFn(s)
    } catch (e) {
      this.log.warn('session.agents not sent', { error: (e as Error).message })
    }
  }
}
