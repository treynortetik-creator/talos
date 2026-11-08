// The `queued` and `working` status rows the relay derives itself: the 30 s "busy with another task" timer after the Mac
// takes a message, and the sweeps that put stale rows back to idle. Hub (hub.ts) owns one of these and forwards to it.
import { threadSessionMode } from '@talos-app/protocol'
import { type HubDeps, QUEUED_AFTER_MS } from './hub-types.ts'
import { mkFrame } from './util.ts'

/** What the status rows use of Hub, and nothing else. */
export type StatusDeps = {
  cfg(): Parameters<typeof threadSessionMode>[0]
  fanOut(frame: Record<string, unknown>): void
  bridgeOnline(): boolean
}

export class StatusTimers {
  private queuedTimers = new Map<string, { handle: unknown; threadId: string }>()
  constructor(
    private d: HubDeps,
    private deps: StatusDeps,
  ) {}

  startQueuedTimer(seq: number, type: string): void {
    if (type !== 'message' && type !== 'voice_note') return
    const ev = this.d.store.getEventBySeq(seq)
    if (!ev) return
    const msgId = String(ev.client_msg_id)
    const threadId = String(ev.thread_id)
    this.clearQueuedTimer(msgId)
    const handle = this.d.clock.setTimeout(() => {
      this.queuedTimers.delete(msgId)
      if (!this.deps.bridgeOnline()) return
      const got = this.d.store.getMeta(msgId).receipt
      if (got === 'seen' || got === 'not_delivered') return
      const status = {
        thread_id: threadId,
        state: 'queued' as const,
        label: 'Busy with another task',
        since: new Date(this.d.clock.now()).toISOString(),
      }
      this.d.store.setStatus(status, true)
      this.deps.fanOut(mkFrame(this.d.clock, 'status', status))
    }, QUEUED_AFTER_MS)
    this.queuedTimers.set(msgId, { handle, threadId })
  }
  clearQueuedTimer(msgId: string): void {
    const t = this.queuedTimers.get(msgId)
    if (t) this.d.clock.clearTimeout(t.handle)
    this.queuedTimers.delete(msgId)
  }
  /** A reply means the message was handled: a derived `queued` row (ours, not the bridge's) goes idle. */
  clearDerivedQueued(threadId: string): void {
    const cur = this.d.store.getStatus(threadId)
    if (!cur || !cur.derived || cur.state !== 'queued') return
    this.setIdle(threadId)
  }
  /**
   * A session's turn ended (its `busy` went true -> false): the 'working' rows it owned cannot be true any more, and an
   * interrupted turn (Stop) or a worker that replied without `set_status idle` would leave them standing. `main` owns
   * every thread that is not dedicated; a thread session owns only its own thread.
   */
  settleWorking(scope: 'main' | { thread_id: string }): void {
    const cfg = this.deps.cfg()
    for (const s of this.d.store.allStatuses()) {
      if (s.state !== 'working') continue
      const dedicated = threadSessionMode(cfg, s.thread_id) === 'dedicated'
      if (scope === 'main' ? dedicated : s.thread_id !== scope.thread_id) continue
      this.setIdle(s.thread_id)
    }
  }
  setIdle(threadId: string): void {
    const status = { thread_id: threadId, state: 'idle' as const, since: new Date(this.d.clock.now()).toISOString() }
    this.d.store.setStatus(status)
    this.deps.fanOut(mkFrame(this.d.clock, 'status', status))
  }
  /** The bridge dropped (or a new one authed): 'working' and derived 'queued' rows cannot be true any more. */
  resetStaleStatuses(): void {
    for (const s of this.d.store.allStatuses()) {
      if (s.state === 'working') this.setIdle(s.thread_id)
      else if (s.state === 'queued' && this.d.store.getStatus(s.thread_id)?.derived) this.setIdle(s.thread_id)
    }
  }
  clearThreadQueued(threadId: string): void {
    for (const [id, t] of this.queuedTimers) if (t.threadId === threadId) this.clearQueuedTimer(id)
  }
  clearQueuedTimers(): void {
    for (const id of [...this.queuedTimers.keys()]) this.clearQueuedTimer(id)
  }
}
