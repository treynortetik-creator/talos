// The hub's routing table (docs/OPTION-C.md "Routing"). Every channel notification the live bridge would push into the
// main session passes through `route()`. For a thread that has its own session, an owner message (or a card action on a
// card that thread's worker raised) is held in history.sqlite instead, a wake file names it for the supervisor, and the
// worker fetches it with `read_inbound`. If nobody claims it in time, the hub claims it for main and main answers, with a
// system row saying so. A message is never pushed to both: main is told only after the hub's own claim succeeds.
import {
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  dedicatedSettings,
  type ErrorCodeT,
  supervisorFresh,
  THREAD_SESSIONS_FEATURE,
  threadSessionMode,
  trustOn,
  WORKER_LIVE_STATES,
  type WorkerEntryT,
  type WorkerStatusItemT,
  type WorkersFileT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { statusFrame } from '../frames-out.ts'
import type { Notification } from '../notify.ts'
import { WorkersReader, writeWake } from '../worker/files.ts'
import {
  cleanHandoffText,
  firstWords,
  HANDOFF_CLAIM_MS,
  HandoffLedger,
  handoffLabel,
  handoffNotification,
  type StoredHandoff,
} from '../worker/handoff.ts'
import { type RouteRow, WorkerStore } from '../worker/store.ts'
import { allowsStart, type GovernorReading, governor } from './governor.ts'

export type Emit = (n: Notification) => Promise<void>

/** Owner notification kinds a worker can take. Voice calls, hooks, digests, schedules, shares and backlog stay with main. */
const WORKER_KINDS = new Set(['text', 'file', 'voice_note'])

export type Decision =
  | { to: 'main' }
  | { to: 'fallback'; thread: string; reason: ErrorCodeT }
  | { to: 'worker'; thread: string; cold: boolean }

const failureReason = (e: WorkerEntryT): ErrorCodeT =>
  e.error?.code === 'needs_mac'
    ? 'needs_mac'
    : e.error?.code === 'folder_claimed'
      ? 'worker_folder_claimed'
      : 'worker_unavailable'

const REASON_TEXT: Partial<Record<ErrorCodeT, string>> = {
  worker_unavailable: 'its session is not available',
  worker_cap: 'every thread session is busy',
  usage_governor: 'plan limits are close, so thread sessions are paused',
  worker_folder_claimed: 'another session is working in its folder',
  needs_mac: 'its session needs you at the Mac',
}

/**
 * Has the run that claimed a message at `at` definitely ended? Only states that say so count; `stopping` and `parking` are
 * still finishing that turn, and a missing or unreadable date proves nothing.
 */
function runEnded(e: WorkerEntryT, at: number): boolean {
  if (e.state === 'parked' || e.state === 'failed' || e.state === 'off') return true
  if (!e.started_at || !WORKER_LIVE_STATES.includes(e.state)) return false
  return Date.parse(e.started_at) > at
}

export class ThreadRouter {
  readonly store: WorkerStore
  readonly workers: WorkersReader
  readonly handoffs: HandoffLedger
  private timers = new Map<string, unknown>()
  private delivering: Promise<void> = Promise.resolve()
  private lastStatusKey = ''
  private parkAllSent = false
  private relayListsFeature = false
  private readonly onCardUndelivered: (cardId: string, told?: false | 'unknown') => void

  constructor(
    private readonly ctx: BridgeContext,
    private readonly mainEmit: Emit,
    opts: {
      store?: WorkerStore
      workers?: WorkersReader
      /** A card's decision was held for a worker and never acted on (main could not be told, or the worker stopped): the owner must hear it. */
      onCardUndelivered?: (cardId: string, told?: false | 'unknown') => void
    } = {},
  ) {
    this.onCardUndelivered = opts.onCardUndelivered ?? (() => {})
    this.store = opts.store ?? new WorkerStore(ctx.store.db)
    this.workers = opts.workers ?? new WorkersReader(ctx.paths.home)
    this.handoffs = new HandoffLedger(ctx.store.db)
  }

  /** Why a lead cannot take a hand-off right now (plain words), or undefined when it can. */
  leadUnreachable(thread: string): string | undefined {
    const d = this.reach(thread)
    if (d.to !== 'fallback') return undefined
    return `That lead can't take it right now: ${REASON_TEXT[d.reason] ?? d.reason}.`
  }

  /**
   * Shows and delivers every recorded hand-off exactly once, one run at a time. Three steps, each remembered, so a crash
   * or a failure between them resumes instead of repeating: the thread row (its message id comes from the hand-off id, so
   * it can never be posted twice), then the route to the receiver (a lead holds it like an owner message, so `read_inbound`
   * returns it with trust=agent and the wake file names it; main is told), then the delivered mark. No deadline and no
   * fallback while it waits: main sent or wrote it itself, but a TASK nobody picks up in 15 minutes comes back to main.
   */
  deliverHandoffs(): Promise<void> {
    const run = this.delivering.then(() => this.deliverAllHandoffs())
    this.delivering = run.catch(() => {})
    return run
  }

  private async deliverAllHandoffs(): Promise<void> {
    const { ctx } = this
    for (const row of this.handoffs.undelivered()) {
      const now = ctx.clock.now()
      try {
        await this.deliverHandoff(row, now)
      } catch (e) {
        ctx.log.warn('hand-off not delivered, will retry', { id: row.id, error: (e as Error).message })
      }
    }
  }

  private async deliverHandoff(row: StoredHandoff, now: number) {
    const { ctx } = this
    const ref = threadRef(ctx, row.lead)
    const mainName = ctx.config.config.agent.name
    const n = handoffNotification(row, { mainName, leadName: ref.name, ts: new Date(row.at).toISOString() })
    if (row.posted_at === null) {
      const id = `m_${row.id.slice(2)}`
      if (!ctx.store.getMessage(id))
        await postSystemNotice(ctx, cleanHandoffText(row.text), {
          thread: ref,
          id,
          handoff: { label: handoffLabel(row, mainName, ref.name), type: row.type },
        })
      this.handoffs.markPosted(row.id, now)
    }
    if (row.dir === 'to_main') await this.mainEmit(n)
    else {
      const cold = (() => {
        const d = this.reach(row.lead)
        return d.to === 'worker' ? d.cold : true
      })()
      const fresh = this.store.addRoute({
        message_id: row.id,
        thread_id: row.lead,
        notification: n,
        woke_at: now,
        deadline_at: now,
        cold,
      })
      this.wake(row.lead, 'message')
      if (cold && fresh)
        ctx.transport.sendEphemeral(statusFrame(now, row.lead, 'working', 'Starting a session for this thread…'))
    }
    this.handoffs.markDelivered(row.id, now)
  }

  /**
   * A TASK its lead has not taken in 15 minutes (the session would not start, a wake is held, it needs the Mac, it is
   * crash-looping) comes back to main as a plain note, and its slot is freed.
   */
  private expireUnclaimedHandoffs(now: number) {
    const { ctx } = this
    for (const row of this.store.allUnclaimed()) {
      if (row.notification.meta.kind !== 'handoff' || now - row.woke_at < HANDOFF_CLAIM_MS) continue
      if (!this.store.claim(row.message_id, 'main', now)) continue
      this.handoffs.close(row.message_id)
      const d = this.reach(row.thread_id)
      // a reason only when the router knows one; a warm lead gets no guess
      const why = d.to === 'fallback' ? (REASON_TEXT[d.reason] ?? d.reason) : 'not picked up within 15 minutes'
      const what = `"${firstWords(row.notification.content.split('\n\n').slice(1).join(' '), 12)}"`
      void this.tellMain(
        row.thread_id,
        `The ${threadRef(ctx, row.thread_id).name} lead didn't pick this up (TASK ${what}): ${why}.`,
      )
    }
  }

  /** A plain BLOCK-style row in the lead's thread and a note to main, from the bridge itself. */
  private async tellMain(thread: string, text: string) {
    const { ctx } = this
    const ref = threadRef(ctx, thread)
    try {
      await postSystemNotice(ctx, text, {
        thread: ref,
        toAgent: true,
        handoff: {
          label: `${cleanHandoffText(ctx.config.config.agent.name)} (the bridge)`,
          type: 'BLOCK',
        },
      })
    } catch (e) {
      ctx.log.warn('hand-off notice not posted', { thread, error: (e as Error).message })
    }
  }

  /** From `ready.features`: an older relay answers `workers.status` with an error, so it gets none. */
  setRelayFeatures(features: readonly string[]): void {
    this.relayListsFeature = features.includes(THREAD_SESSIONS_FEATURE)
  }

  governor(): GovernorReading {
    return governor(dedicatedSettings(this.ctx.config.config), this.ctx.mod.liveState())
  }

  decide(n: Notification): Decision {
    const { ctx } = this
    if (ctx.mode !== 'live') return { to: 'main' }
    const kind = n.meta.kind ?? ''
    let thread = n.meta.thread_id ?? ''
    if (kind === 'card_action') {
      const raiser = n.meta.card_id ? this.store.cardRaiser(n.meta.card_id) : undefined
      if (!raiser) return { to: 'main' }
      thread = raiser
    } else if (!WORKER_KINDS.has(kind) || n.meta.trust !== 'owner') return { to: 'main' }
    if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return { to: 'main' }
    return this.reach(thread)
  }

  /** Can the thread's session take something now? Not-reachable becomes a fallback to main; a cold one is started by the wake. */
  private reach(thread: string): Decision {
    const { ctx } = this
    const file = this.workers.read()
    if (!supervisorFresh(file, ctx.clock.now()) || !file?.supervisor.workers_supported)
      return { to: 'fallback', thread, reason: 'worker_unavailable' }
    const entry = file.threads[thread]
    const state = entry?.state ?? 'off'
    if (state === 'failed' && entry) return { to: 'fallback', thread, reason: failureReason(entry) }
    if (state === 'stopping') return { to: 'fallback', thread, reason: 'worker_unavailable' }
    // live/busy workers keep getting pointers under the governor; anything that would need a start or resume does not
    const warm = state === 'live' || state === 'busy'
    if (!warm && !allowsStart(this.governor(), { trust: trustOn(ctx.config.config) }))
      return { to: 'fallback', thread, reason: 'usage_governor' }
    return { to: 'worker', thread, cold: !warm }
  }

  /** The emit the bridge installs (after driving-mode meta). */
  async route(n: Notification): Promise<void> {
    const d = this.decide(n)
    if (d.to === 'main') return this.mainEmit(n)
    const messageId = n.meta.message_id ?? ''
    if (d.to === 'fallback') {
      // claimed for main first, so a late read_inbound can't take it too
      this.store.claim(messageId, 'main', this.ctx.clock.now())
      return this.fallback(n, d.thread, d.reason)
    }
    this.ctx.seen.routerOwns(messageId)
    const now = this.ctx.clock.now()
    const row: RouteRow = {
      message_id: messageId,
      thread_id: d.thread,
      notification: n,
      woke_at: now,
      deadline_at: now + (d.cold ? CLAIM_DEADLINE_COLD_MS : CLAIM_DEADLINE_MS),
      cold: d.cold,
    }
    // A route still waiting on this thread means a worker start is already under way: only the first cold message starts it
    const startsWorker = d.cold && this.store.unclaimed(d.thread).length === 0
    if (!this.store.addRoute(row)) return this.mainEmit(n) // the same id routed before: never hold it twice
    this.wake(d.thread, n.meta.kind === 'card_action' ? 'card_action' : 'message')
    if (d.cold) {
      this.ctx.transport.sendEphemeral(statusFrame(now, d.thread, 'working', 'Starting a session for this thread…'))
      // Only trust mode gets here in the "limits are close" band (allowsStart); say so, as the phone's resume button does
      // Said once, on the message that starts the worker; later messages to the same starting thread do not repeat it
      if (startsWorker && this.governor().state === 'paused')
        postSystemNotice(this.ctx, 'Plan limits are close, so this thread session may run out sooner.', {
          thread: threadRef(this.ctx, d.thread),
        }).catch((e) => this.ctx.log.warn('limits notice not posted', { error: (e as Error).message }))
    }
    this.arm(row)
  }

  /** Writes the thread's wake file naming every message its worker has not claimed yet. */
  private wake(thread: string, reason: 'message' | 'card_action') {
    const ids = this.store
      .unclaimed(thread)
      .map((r) => r.message_id)
      .slice(-50)
    if (!ids.length) return
    try {
      writeWake(this.ctx.paths.home, {
        v: 1,
        thread_id: thread,
        message_ids: ids,
        at: new Date(this.ctx.clock.now()).toISOString(),
        reason,
        action: 'pointer',
      })
    } catch (e) {
      this.ctx.log.warn('wake file not written', { thread, error: (e as Error).message })
    }
  }

  private arm(row: RouteRow) {
    if (row.notification.meta.kind === 'handoff') return // main wrote it: no deadline, and main never answers it for the lead
    const wait = Math.max(0, row.deadline_at - this.ctx.clock.now())
    const t = this.ctx.clock.setTimeout(() => {
      this.timers.delete(row.message_id)
      void this.onDeadline(row).catch((e) =>
        this.ctx.log.error('route deadline failed', { error: (e as Error).message }),
      )
    }, wait)
    this.timers.set(row.message_id, t)
  }

  private async onDeadline(row: RouteRow) {
    if (!this.store.claim(row.message_id, 'main', this.ctx.clock.now())) return // the worker got it
    const entry = this.workers.read()?.threads[row.thread_id]
    const reason: ErrorCodeT = entry?.state === 'failed' ? failureReason(entry) : 'worker_unavailable'
    await this.fallbackLate(row.notification, row.thread_id, reason)
  }

  /**
   * A fallback with nobody waiting on the write (a deadline or a switch-off, not the caller's own emit). The caller of
   * `route` hears a failed write and ends the card itself; here nobody does, so a card decision that main cannot be
   * told about ends the card and tells the owner. Anything else is logged by the caller.
   */
  private async fallbackLate(n: Notification, thread: string, reason: ErrorCodeT) {
    try {
      await this.fallback(n, thread, reason)
    } catch (e) {
      const cardId = n.meta.kind === 'card_action' ? n.meta.card_id : undefined
      if (!cardId) throw e
      this.ctx.log.warn('card decision not delivered to main', { card_id: cardId, error: (e as Error).message })
      this.onCardUndelivered(cardId)
    }
  }

  private async fallback(n: Notification, thread: string, reason: ErrorCodeT) {
    const { ctx } = this
    ctx.log.info('thread session fallback', { thread, reason })
    // main has it now: a main session that dies with it in flight must be reported (D39)
    if (n.meta.message_id) ctx.seen.track(thread, n.meta.message_id)
    await this.mainEmit({ content: n.content, meta: { ...n.meta, routed: 'fallback', reason } })
    try {
      await postSystemNotice(
        ctx,
        `Thread session didn't pick this up (${REASON_TEXT[reason] ?? reason}). Main answered.`,
        { thread: threadRef(ctx, thread) },
      )
    } catch (e) {
      ctx.log.warn('fallback notice not posted', { error: (e as Error).message })
    }
  }

  /** A thread switched off with messages still waiting: they are main's now, at once. */
  private releaseSwitchedOff() {
    const { ctx } = this
    for (const row of this.store.allUnclaimed()) {
      if (threadSessionMode(ctx.config.config, row.thread_id) === 'dedicated') continue
      if (row.notification.meta.kind === 'handoff') {
        // the lead is gone: the TASK comes back to main, which is told
        if (!this.store.claim(row.message_id, 'main', ctx.clock.now())) continue
        this.handoffs.close(row.message_id)
        void this.tellMain(
          row.thread_id,
          `The ${threadRef(ctx, row.thread_id).name} thread went back to the main session, so your pending TASK came back unanswered: ${row.notification.content.split('\n\n').slice(1).join(' ').slice(0, 200)}`,
        )
        continue
      }
      const t = this.timers.get(row.message_id)
      if (t !== undefined) ctx.clock.clearTimeout(t)
      this.timers.delete(row.message_id)
      if (!this.store.claim(row.message_id, 'main', ctx.clock.now())) continue
      void this.fallbackLate(row.notification, row.thread_id, 'worker_unavailable').catch((e) =>
        ctx.log.error('switch-off fallback failed', { error: (e as Error).message }),
      )
    }
  }

  /**
   * A worker that ends between `read_inbound` and its answer. The phone has shown 'seen' and the deadline stood down, so
   * without this the owner gets a read receipt and then silence. One row per thread, whatever the number of messages.
   * Kept in SQL, so a hub restart neither loses nor repeats it. Only called on a fresh workers.json: an unknown supervisor
   * proves nothing about the worker.
   */
  private reportUnanswered(file: WorkersFileT, now: number) {
    const { ctx } = this
    const settled: string[] = []
    const report = new Map<string, string[]>()
    const unfinished: string[] = []
    for (const c of this.store.openClaims()) {
      if (c.kind === 'card_action') {
        // An approval the worker read is owed a result: keep the claim open until its run has ended, then end the card as
        // "may have run". Any other tap (or an approval already finished) has nothing left to wait for.
        const card = this.ctx.ledger.get(c.message_id)
        if (card?.state === 'resolved' && card.resolution?.action === 'primary') {
          const e = file.threads[c.thread_id]
          if (!e || !runEnded(e, c.at)) continue
          unfinished.push(c.message_id)
        }
        settled.push(c.message_id)
        continue
      }
      if (this.store.answeredSince(c.thread_id, c.at)) {
        settled.push(c.message_id)
        continue
      }
      const e = file.threads[c.thread_id]
      if (!e || !runEnded(e, c.at)) continue
      report.set(c.thread_id, [...(report.get(c.thread_id) ?? []), c.message_id])
    }
    // end the cards first: a crash between the two leaves the claim open, and the next tick tries again
    for (const id of unfinished) this.onCardUndelivered(id, 'unknown')
    this.store.settleClaims(settled, now)
    for (const [thread, ids] of report) {
      this.store.settleClaims(ids, now)
      postSystemNotice(ctx, "This thread's session stopped before it answered. Send the message again to carry on.", {
        thread: threadRef(ctx, thread),
      }).catch((e) => ctx.log.warn('unanswered notice not posted', { error: (e as Error).message }))
    }
  }

  /** After a (re)start: re-arm every unclaimed route; ones past their deadline fall back now. */
  resume(): void {
    for (const row of this.store.allUnclaimed()) if (!this.timers.has(row.message_id)) this.arm(row)
  }

  /** Called from the bridge's poll: governor park-all and workers.status. */
  tick(send: (status: WorkersStatusT) => void): void {
    const { ctx } = this
    const now = ctx.clock.now()
    const g = this.governor()
    const file = this.workers.read()
    this.releaseSwitchedOff()
    for (const lead of this.handoffs.openLeads())
      if (threadSessionMode(ctx.config.config, lead) !== 'dedicated') this.handoffs.closeLead(lead)
    this.expireUnclaimedHandoffs(now)
    void this.deliverHandoffs().catch((e) => ctx.log.warn('hand-offs not delivered', { error: (e as Error).message }))
    if (file && supervisorFresh(file, now)) this.reportUnanswered(file, now)
    if (g.state === 'park_all' && !this.parkAllSent && file && supervisorFresh(file, now)) {
      this.parkAllSent = true
      for (const [id, e] of Object.entries(file.threads)) {
        if (!WORKER_LIVE_STATES.includes(e.state)) continue
        try {
          writeWake(ctx.paths.home, {
            v: 1,
            thread_id: id,
            message_ids: [],
            at: new Date(now).toISOString(),
            reason: 'governor',
            action: 'park',
          })
        } catch (err) {
          ctx.log.warn('park wake not written', { thread: id, error: (err as Error).message })
        }
      }
    }
    if (g.state !== 'park_all') this.parkAllSent = false
    const status = this.status(file, g, now)
    const key = JSON.stringify({ ...status, at: '' })
    if (this.relayListsFeature && key !== this.lastStatusKey) {
      this.lastStatusKey = key
      send(status)
    }
  }

  /** Forget the last status so the next tick sends it again (after `ready`). */
  resendStatus(): void {
    this.lastStatusKey = ''
  }

  status(file: WorkersFileT | null, g: GovernorReading, now: number): WorkersStatusT {
    const fresh = supervisorFresh(file, now)
    const cfg = this.ctx.config.config
    const threads: WorkerStatusItemT[] = []
    for (const t of cfg.threads) {
      if (threadSessionMode(cfg, t.id) !== 'dedicated') continue
      const e = file?.threads[t.id]
      const item: WorkerStatusItemT = { thread_id: t.id, state: e?.state ?? 'off' }
      if (e?.model) item.model = e.model
      if (e?.cwd) item.cwd = e.cwd
      if (e?.last_turn_at) item.last_turn_at = e.last_turn_at
      if (e?.parked_at) item.parked_at = e.parked_at
      if (e?.error) item.error = e.error.code
      threads.push(item)
    }
    return {
      supported: fresh && file?.supervisor.workers_supported === true,
      supervisor_online: fresh,
      threads: threads.slice(0, 40),
      governor: g.resets_at ? { state: g.state, resets_at: g.resets_at } : { state: g.state },
      at: new Date(now).toISOString(),
    }
  }

  close(): void {
    for (const t of this.timers.values()) this.ctx.clock.clearTimeout(t)
    this.timers.clear()
  }
}
