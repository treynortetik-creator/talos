// Reference implementations for the agents panel contracts (docs/SUBAGENTS.md). FakeAgentsLink is what the bridge does
// with `talos_mod_sync.agents` (validate or drop, trim, emit on change at most every 2 s, re-send an unchanged snapshot
// on a 10 s beat while the mod syncs, the mod-lapse snapshot, the empty snapshot on session end); FakeAgentsView is what the app's session store does with `ready.session_agents`,
// `session.agents` and `session.state`. The contracts in contract/session-agents.ts run against these here and against
// the real bridge (WP-A1) and the real web store (WP-A2) there.
import {
  AGENTS_EMIT_INTERVAL_MS,
  AGENTS_HEARTBEAT_MS,
  AgentsSnapshot,
  type AgentsSnapshotT,
  agentsForSession,
  canStopAgent,
  emptyAgentsSnapshot,
  isEndedAgentStatus,
  MOD_LIVE_WINDOW_MS,
  markAgentsUnknown,
  parseFrame,
  type SessionStateT,
  sameAgentsSnapshot,
  trimAgentsSnapshot,
} from '@talos-app/protocol'
import type { Clock } from './clock.ts'

/** After the live window lapses with no sync, the lapse snapshot goes out this much later (the bridge's slack). */
const LAPSE_SLACK_MS = 500

export class FakeAgentsLink {
  /** Snapshots that failed validation. */
  dropped = 0
  /** What went out, in order, with the clock time (the bridge wraps each in a `session.agents` frame). */
  readonly sent: Array<{ at: number; agents: AgentsSnapshotT }> = []
  private held: AgentsSnapshotT | undefined
  private lastSent: AgentsSnapshotT | undefined
  private lastSentAt = Number.NEGATIVE_INFINITY
  private pending: AgentsSnapshotT | undefined
  private flushTimer: unknown
  private lapseTimer: unknown
  private lapsed = false

  constructor(private readonly clock: Clock) {}

  /** One mod sync. `agents` undefined = the sync had no `agents` member (nothing changed at the mod). */
  sync(agents?: unknown): void {
    this.armLapse()
    const wasLapsed = this.lapsed
    this.lapsed = false
    if (agents === undefined) {
      if (wasLapsed && this.held)
        this.offer(this.held) // the mod is back: its rows are live again
      else this.beat()
      return
    }
    const p = AgentsSnapshot.safeParse(agents)
    if (!p.success) {
      this.dropped++
      return
    }
    if (this.held && this.held.session_id !== p.data.session_id) this.pending = undefined // never mix sessions
    this.held = p.data
    this.offer(p.data)
    this.beat()
  }

  /** `session.end` at the Mac: an empty snapshot for that session. */
  end(): void {
    if (!this.held) return
    this.held = emptyAgentsSnapshot(this.held.session_id, new Date(this.clock.now()).toISOString(), this.held.source)
    this.offer(this.held)
  }

  /** What the bridge holds now (memory only). */
  last(): AgentsSnapshotT | undefined {
    return this.held
  }

  close(): void {
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer)
    if (this.lapseTimer !== undefined) this.clock.clearTimeout(this.lapseTimer)
  }

  private offer(s: AgentsSnapshotT) {
    const trimmed = trimAgentsSnapshot(s).snapshot
    const now = this.clock.now()
    if (now - this.lastSentAt >= AGENTS_EMIT_INTERVAL_MS && this.flushTimer === undefined) return this.emit(trimmed)
    this.pending = trimmed
    if (this.flushTimer === undefined)
      this.flushTimer = this.clock.setTimeout(
        () => {
          this.flushTimer = undefined
          const p = this.pending
          this.pending = undefined
          if (p) this.emit(p)
        },
        this.lastSentAt + AGENTS_EMIT_INTERVAL_MS - now,
      )
  }

  /**
   * Like session.state's heartbeat: on a sync, a held snapshot that has not gone out for AGENTS_HEARTBEAT_MS goes out
   * again with a fresh `at`, so a relay that restarted (and forgot it) gets it back without waiting for a change.
   */
  private beat() {
    const now = this.clock.now()
    if (!this.held || this.flushTimer !== undefined || now - this.lastSentAt < AGENTS_HEARTBEAT_MS) return
    this.emit(trimAgentsSnapshot({ ...this.held, at: new Date(now).toISOString() }).snapshot, true)
  }

  private emit(s: AgentsSnapshotT, force = false) {
    if (!force && sameAgentsSnapshot(this.lastSent, s)) return
    this.lastSent = s
    this.lastSentAt = this.clock.now()
    this.sent.push({ at: this.lastSentAt, agents: s })
  }

  private armLapse() {
    if (this.lapseTimer !== undefined) this.clock.clearTimeout(this.lapseTimer)
    this.lapseTimer = this.clock.setTimeout(() => {
      this.lapseTimer = undefined
      this.lapsed = true
      const h = this.held
      if (!h || h.rows.every((r) => isEndedAgentStatus(r.status))) return
      this.offer(markAgentsUnknown(h, new Date(this.clock.now()).toISOString()))
    }, MOD_LIVE_WINDOW_MS + LAPSE_SLACK_MS)
  }
}

export class FakeAgentsView {
  private snapshot: AgentsSnapshotT | undefined
  private state: SessionStateT | undefined

  /** A raw relay -> app frame. Anything that does not parse is ignored (the last good snapshot stays). */
  receive(raw: Record<string, unknown>): void {
    const r = parseFrame(raw, { direction: 'relay_to_app' })
    if (!r.ok) return
    const f = r.frame
    if (f.type === 'ready') {
      if (f.session_state) this.state = f.session_state
      if (f.session_agents) this.snapshot = f.session_agents
    } else if (f.type === 'session.state') this.state = f.state
    else if (f.type === 'session.agents') this.snapshot = f.agents
  }

  /** Only a snapshot of the current session: the relay may still hold one from a previous session. */
  agents(): AgentsSnapshotT | undefined {
    return agentsForSession(this.snapshot, this.state)
  }

  showsStop(rowId: string): boolean {
    return canStopAgent(this.agents(), rowId, this.state)
  }
}
