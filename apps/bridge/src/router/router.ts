// The hub's routing table (docs/OPTION-C.md "Routing"). Every channel notification the live bridge would push into the
// main session passes through `route()`. For a thread that has its own session, an owner message (or a card action on a
// card that thread's worker raised) is held in history.sqlite instead, a wake file names it for the supervisor, and the
// worker fetches it with `read_inbound`. If nobody claims it in time, the hub claims it for main and main answers, with a
// system row saying so. A message is never pushed to both: main is told only after the hub's own claim succeeds.
import {
  AGENTS_MD_WORDING,
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  type ErrorCodeT,
  HUB_FEATURE_SCHEDULES,
  leadThreadFor,
  type SessionStateT,
  supervisorFresh,
  THREAD_SESSIONS_FEATURE,
  threadSessionMode,
  trustOn,
  WAKE_STATUS_MAX,
  WORKER_LIVE_STATES,
  type WorkerEntryT,
  type WorkerStatusItemT,
  type WorkersFileT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { claudeConfigDir } from '../claude-dir.ts'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { statusFrame } from '../frames-out.ts'
import type { Notification } from '../notify.ts'
import { say } from '../owner-words.ts'
import { BridgeStopping, isStopping } from '../stopping.ts'
import { noteHandOver, pointBefore, waitForRestore, workerFolder } from '../undo/route-point.ts'
import { dropWake } from '../wake-me/drop.ts'
import { pendingOf } from '../wake-me/service.ts'
import { WakeMeStore } from '../wake-me/store.ts'
import { WorkersReader, writeControl, writeWake } from '../worker/files.ts'
import {
  cleanHandoffText,
  firstWords,
  HANDOFF_CLAIM_MS,
  HandoffLedger,
  handoffLabel,
  handoffNotification,
  type StoredHandoff,
} from '../worker/handoff.ts'
import { placeFilesInInbox } from '../worker/inbox.ts'
import { type RouteRow, WorkerStore } from '../worker/store.ts'
import { allowsStart, type GovernorReading, governorNow } from './governor.ts'
import { tellOldSupervisor } from './old-supervisor-notice.ts'
import { mainNeedsYou, statusLine } from './status-line.ts'
import { WorkerContextFeed } from './worker-context.ts'

export type Emit = (n: Notification) => Promise<void>

/** Owner notification kinds a worker can take. Hooks, digests, shares and backlog stay with main. */
const WORKER_KINDS = new Set(['text', 'file'])

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
  get needs_mac() {
    return say({ mac: 'its session needs you at the Mac', linux: 'its session needs you at your computer' })
  },
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

/**
 * How long a live thread may stay live after the governor's park wake before the bridge writes another. Well past the reader's
 * take (each second) and its next workers.json (every 5 s); well inside WAKE_MAX_AGE_MS, so a retry is never itself stale.
 */
export const GOVERNOR_PARK_RETRY_MS = 30_000

/** Starts in a row a hand-over to main may fail for a reason of its own before it is given up. */
const REDELIVER_ATTEMPTS = 3

export class ThreadRouter {
  /** Threads already told their supervisor is older than their settings, this run (old-supervisor-notice.ts). */
  private readonly oldSupervisorTold = new Set<string>()
  readonly store: WorkerStore
  readonly workers: WorkersReader
  readonly handoffs: HandoffLedger
  /** The agents' wake_me timers, read for `workers.status` (the Schedules service writes them). */
  private readonly wakes: WakeMeStore
  private timers = new Map<string, unknown>()
  /**
   * Messages main claimed for a fallback whose hand-over has not begun. `close()` (the first thing a stopping bridge does that
   * reaches the router) gives these claims back, so the next start routes or falls them back once; a claim that stayed would
   * make every later start skip a message nobody delivered. A claim leaves the set the moment its hand-over begins.
   */
  private readonly claiming = new Set<string>()
  private readonly redelivering = new Set<string>()
  private delivering: Promise<void> = Promise.resolve()
  private lastStatusKey = ''
  /**
   * Park-all: when the governor's park wake was last written for each thread, on the bridge's clock. A thread that is still live
   * GOVERNOR_PARK_RETRY_MS later (the reader refused it as stale, dropped it, or never saw it) gets another, and so does one whose
   * time is ahead of the clock (the clock was set back): a park that did not take is never left for good.
   */
  private parkSentAt = new Map<string, number>()
  private relayListsFeature = false
  private readonly contextFeed: WorkerContextFeed
  /** Each thread's session as last seen (id, start time, pane), so a session that started since is noticed once. */
  private readonly sessionsSeen = new Map<string, string>()
  private readonly workerFeatures: (thread: string) => readonly string[] | undefined
  private readonly onCardUndelivered: (cardId: string, told?: false | 'unknown') => void

  constructor(
    private readonly ctx: BridgeContext,
    private readonly mainEmit: Emit,
    opts: {
      store?: WorkerStore
      workers?: WorkersReader
      /** A card's decision was held for a worker and never acted on (main could not be told, or the worker stopped): the owner must hear it. */
      onCardUndelivered?: (cardId: string, told?: false | 'unknown') => void
      /** What the connected worker for a thread can do (undefined: none connected). The hub knows; tests may not have one. */
      workerFeatures?: (thread: string) => readonly string[] | undefined
    } = {},
  ) {
    this.workerFeatures = opts.workerFeatures ?? (() => undefined)
    this.onCardUndelivered = opts.onCardUndelivered ?? (() => {})
    this.store = opts.store ?? new WorkerStore(ctx.store.db)
    this.workers = opts.workers ?? new WorkersReader(ctx.paths.home)
    this.handoffs = new HandoffLedger(ctx.store.db)
    this.wakes = new WakeMeStore(ctx.store.db)
    this.contextFeed = new WorkerContextFeed({
      claudeDir: () => {
        try {
          return claudeConfigDir(ctx.env.userHome, ctx.env.claudeConfigDir)
        } catch {
          return undefined // a CLAUDE_CONFIG_DIR that is not absolute: Claude Code itself is unusable, nothing to read
        }
      },
    })
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
      if (ctx.closing) return // the rest stay undelivered; the next start delivers each once
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
    const into = row.dir === 'to_main' ? 'main' : { worker: workerFolder(ctx, this.workers.read(), row.lead) }
    await waitForRestore(ctx, into)
    noteHandOver(ctx, into)
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
    return governorNow(this.ctx)
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
    } else if (kind === 'schedule_run') {
      // A job firing in a thread that has its own session runs there (docs/OPTION-C.md "Thread schedules"). A heartbeat wake is the
      // bridge's own check-in and stays main's, whichever thread it posts to; so does a held notice or anything not `trust=owner`.
      if (n.meta.trust !== 'owner' || n.meta.heartbeat !== undefined) return { to: 'main' }
      // only a plain session job: a headless or "both" job, a command and a job nobody can read are main's
      if (!ctx.schedules?.sessionOnly(n.meta.schedule_id ?? '')) return { to: 'main' }
    } else if (kind === 'wake') {
      // A wake_me timer goes back to the session that set it: a thread session's own wake wakes that session (starting it if
      // parked), main's is main's. Only the bridge's own wake (trust=agent) is ever routed to a thread.
      if (n.meta.trust !== 'agent' || n.meta.wake_for !== 'thread') return { to: 'main' }
      // never main's to take: a session that can't have it any more drops it (fallback -> dropWake)
      const t = ctx.config.thread(thread)
      if (!t || t.archived || threadSessionMode(ctx.config.config, thread) !== 'dedicated')
        return { to: 'fallback', thread, reason: 'worker_unavailable' }
      return this.reach(thread)
    } else if (!WORKER_KINDS.has(kind) || n.meta.trust !== 'owner') return { to: 'main' }
    if (kind === 'schedule_run') {
      // a job runs in its own thread's session only; a sub-thread without a lead of its own leaves its jobs to main
      if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return { to: 'main' }
      // a session that is already running and did not say it can take a scheduled run (an older worker) is not handed one: main runs it
      const f = this.workerFeatures(thread)
      if (f && !f.includes(HUB_FEATURE_SCHEDULES)) return { to: 'fallback', thread, reason: 'worker_unavailable' }
      return this.reach(thread)
    }
    // a card's answer goes back to the session that raised it, or to main: never on to a parent's lead, which did not raise it
    if (kind === 'card_action')
      return threadSessionMode(ctx.config.config, thread) === 'dedicated' ? this.reach(thread) : { to: 'main' }
    // the thread's own lead, or, for a sub-thread without one, its parent's lead (docs/THREADS.md "Sub-threads")
    const lead = leadThreadFor(ctx.config.config, thread)
    if (!lead) return { to: 'main' }
    return this.reach(lead)
  }

  /** Can the thread's session take something now? Not-reachable becomes a fallback to main; a cold one is started by the wake. */
  private reach(thread: string): Decision {
    const { ctx } = this
    const file = this.workers.read()
    if (!supervisorFresh(file, ctx.clock.now()) || !file?.supervisor.workers_supported)
      return { to: 'fallback', thread, reason: 'worker_unavailable' }
    // an entry the Mac set aside or this build cannot read: never "off", never started on a guess (protocol audit O3)
    if (file.unavailable.includes(thread)) return { to: 'fallback', thread, reason: 'worker_unavailable' }
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
    const first = this.decide(n)
    // nothing starts a turn in a folder being undone (an owner message, a scheduled run, a notice alike); then decide
    // again, on what is true after the wait. pointBefore waits once more right before each hand-over.
    await waitForRestore(
      this.ctx,
      first.to === 'worker' ? { worker: workerFolder(this.ctx, this.workers.read(), first.thread) } : 'main',
    )
    const d = this.decide(n)
    // an owner message's undo point is taken of the folder its turn runs in, right before each hand-over
    if (d.to === 'main') {
      await pointBefore(this.ctx, n, 'main')
      return this.mainEmit(n)
    }
    const messageId = n.meta.message_id ?? ''
    if (d.to === 'fallback') return this.routeFallback(n, d.thread, d.reason, messageId)
    // the thread's session reads files from its own inbox only: copy them there, or let main have the whole message
    let held = n
    try {
      held = placeFilesInInbox(n, {
        root: this.ctx.paths.inbox,
        mediaDir: this.ctx.paths.media,
        thread: d.thread,
        now: this.ctx.clock.now(),
      })
    } catch (e) {
      this.ctx.log.warn('files not placed in the thread inbox', { thread: d.thread, error: (e as Error).message })
      return this.routeFallback(n, d.thread, 'worker_unavailable', messageId)
    }
    await pointBefore(this.ctx, n, { worker: workerFolder(this.ctx, this.workers.read(), d.thread) })
    this.ctx.seen.routerOwns(messageId)
    const now = this.ctx.clock.now()
    const row: RouteRow = {
      message_id: messageId,
      thread_id: d.thread,
      notification: held,
      woke_at: now,
      deadline_at: now + (d.cold ? CLAIM_DEADLINE_COLD_MS : CLAIM_DEADLINE_MS),
      cold: d.cold,
    }
    // A route still waiting on this thread means a worker start is already under way: only the first cold message starts it
    const startsWorker = d.cold && this.store.unclaimed(d.thread).length === 0
    // the same id routed before: never hold it twice. Main runs it now: its point is taken only when the one recorded
    // is of another folder (main may already have run it, and a point of its folder now could hold that turn's edits)
    if (!this.store.addRoute(row)) {
      // the earlier route row may still wait for the thread's worker: main takes the claim first (with its intent row, in the
      // same step), so only one of them runs it and a stop or crash mid-emit leaves the hand-over for `resume`
      if (!this.claimLate(messageId)) return this.notHandedOver(messageId, d.thread)
      await this.pointBeforeLate(n, messageId, { replace: 'elsewhere' })
      // a failure of the emit that is not a stop leaves the claim and its row, and the caller's replay is refused: the message
      // reaches main at the next start through `resume` (bounded at REDELIVER_ATTEMPTS): a delay, not a loss
      await this.mainEmit(held)
      this.endMainHandover(messageId)
      return
    }
    this.wake(d.thread, n.meta.kind === 'card_action' ? 'card_action' : 'message')
    if (d.cold) {
      // shown where the owner is waiting: the message's own thread (a sub-thread answered by its parent's lead included)
      const shownIn = this.shownIn(n, d.thread)
      this.ctx.transport.sendEphemeral(statusFrame(now, shownIn, 'working', 'Starting a session for this thread…'))
      // Only trust mode gets here in the "limits are close" band (allowsStart); say so, as the phone's resume button does
      // Said once, on the message that starts the worker; later messages to the same starting thread do not repeat it
      if (startsWorker && this.governor().state === 'paused')
        postSystemNotice(this.ctx, 'Plan limits are close, so this thread session may run out sooner.', {
          thread: threadRef(this.ctx, shownIn),
        }).catch((e) => this.ctx.log.warn('limits notice not posted', { error: (e as Error).message }))
    }
    this.arm(row)
  }

  /**
   * Where the owner is waiting on a routed item: a card action's card thread, else the message's own thread (a sub-thread
   * answered by its parent's lead included), else the session's thread.
   */
  private shownIn(n: Notification, lead: string): string {
    if (n.meta.kind === 'card_action') return (n.meta.card_id && this.ctx.ledger.get(n.meta.card_id)?.thread_id) || lead
    return n.meta.thread_id || lead
  }

  /** Writes the thread's wake file naming every message its worker has not claimed yet. */
  private wake(thread: string, reason: 'message' | 'card_action') {
    const ids = this.store
      .unclaimed(thread)
      .map((r) => r.message_id)
      .slice(-50)
    if (!ids.length) return
    try {
      writeWake(
        this.ctx.paths.home,
        {
          v: 1,
          thread_id: thread,
          message_ids: ids,
          at: new Date(this.ctx.clock.now()).toISOString(),
          reason,
          action: 'pointer',
        },
        (msg, f) => this.ctx.log.warn(msg, f),
      )
    } catch (e) {
      this.ctx.log.warn('wake file not written', { thread, error: (e as Error).message })
    }
  }

  private arm(row: RouteRow) {
    if (row.notification.meta.kind === 'handoff') return // main wrote it: no deadline, and main never answers it for the lead
    const wait = Math.max(0, row.deadline_at - this.ctx.clock.now())
    const t = this.ctx.clock.setTimeout(() => {
      this.timers.delete(row.message_id)
      void this.onDeadline(row).catch((e) => {
        if (!isStopping(e)) this.ctx.log.error('route deadline failed', { error: (e as Error).message })
      })
    }, wait)
    this.timers.set(row.message_id, t)
  }

  private async onDeadline(row: RouteRow) {
    if (!this.claimLate(row.message_id)) return // the worker got it
    const entry = this.workers.read()?.threads[row.thread_id]
    const reason: ErrorCodeT = entry?.state === 'failed' ? failureReason(entry) : 'worker_unavailable'
    await this.fallbackLate(row.notification, row.thread_id, reason, row.message_id)
  }

  /**
   * Claims the message for main; true when this call took the claim, which is then given back if the bridge stops first.
   * INVARIANT: a main claim on a routed message (one with a worker_routes row) that has no main_handover row means main has the
   * message. A claim for a routed message is therefore only taken through `claimLate`, which writes the row in the same
   * synchronous step; a crash after it leaves the row, and `resume` repeats the hand-over. A message with no route row
   * (`routeFallback`) is claimed after its emit and is at-least-once: a replay that finds the claim emits again.
   */
  private claimForMain(messageId: string): boolean {
    if (this.ctx.closing) return false // `close()` already gave the claims back; a new one would never be
    const took = this.store.claim(messageId, 'main', this.ctx.clock.now())
    if (took) this.claiming.add(messageId)
    return took
  }

  /** `claimForMain` for a message that has a route row: the hand-over intent row is written at once, before any await. */
  private claimLate(messageId: string): boolean {
    if (!this.claimForMain(messageId)) return false
    try {
      this.store.beginMainHandover(messageId, this.ctx.clock.now())
    } catch (e) {
      this.ctx.log.warn('main hand-over not recorded', { error: (e as Error).message })
    }
    return true
  }

  /**
   * A claim for main that was refused. Stopping: nothing was decided, so the frame is not marked done (BridgeStopping, as every
   * other stop refusal) and the replay decides. Otherwise main or a worker holds it: main has it, or its intent row and
   * `resume` own it, or the worker does; the frame is done and nothing is handed over again.
   */
  private notHandedOver(messageId: string, thread: string): void {
    if (this.ctx.closing) {
      this.ctx.log.info('routed message seen again, not handed over: stopping', { thread })
      throw new BridgeStopping()
    }
    this.ctx.log.info('routed message seen again, not handed over', {
      thread,
      reason: `already claimed by ${this.store.claimedBy(messageId) ?? 'main'}`,
    })
  }

  /**
   * main's point before a hand-over of a message this call claimed with `claimLate`. The claim leaves `claiming` when the
   * hand-over begins, or when the wait failed for a reason other than stopping (then it is as it always was); a refusal because
   * the bridge is stopping leaves it for `close()` to give back.
   */
  private async pointBeforeLate(n: Notification, messageId: string, opts: { replace?: boolean | 'elsewhere' } = {}) {
    try {
      await pointBefore(this.ctx, n, 'main', opts)
    } catch (e) {
      if (!isStopping(e)) this.claiming.delete(messageId)
      throw e
    }
    this.claiming.delete(messageId)
  }

  /**
   * route()'s own fallback to main. A message that was routed before has a route row (armed, or its worker's): it is claimed now,
   * with its intent row, like any late hand-over. One never routed has no row: nothing can claim it meanwhile (a worker reads
   * route rows only), so main's claim is taken AFTER the emit returns, and a stop or crash mid-emit leaves nothing: the relay
   * replays the frame and it is routed again (a duplicate only when main had it).
   */
  private async routeFallback(n: Notification, lead: string, reason: ErrorCodeT, messageId: string) {
    if (messageId && this.store.route(messageId)) {
      if (!this.claimLate(messageId)) return this.notHandedOver(messageId, lead)
      await this.pointBeforeLate(n, messageId)
      // a failed emit (not a stop) leaves claim and row and the replay is refused; the next start's `resume` hands it over
      // (bounded at REDELIVER_ATTEMPTS): a delay, not a loss
      return this.fallback(n, lead, reason, () => this.endMainHandover(messageId))
    }
    // Only a worker's claim refuses (it cannot stand without a route row; the guard stays). A MAIN claim here is emitted anyway:
    // every earlier build claimed before its emit, so a stop or crash there left a main claim on a frame that is not done, and
    // its replay must reach main. This build claims after the emit, and the frame is marked done at once after that, so a replay
    // that finds the claim can only come from a crash between the two: a duplicate inside the documented window, never a loss.
    if (messageId && this.store.claimedBy(messageId)?.startsWith('worker:')) return this.notHandedOver(messageId, lead)
    await pointBefore(this.ctx, n, 'main')
    return this.fallback(n, lead, reason, () => {
      if (!messageId) return
      try {
        this.store.claim(messageId, 'main', this.ctx.clock.now())
      } catch (e) {
        this.ctx.log.warn('main claim not recorded', { error: (e as Error).message })
      }
    })
  }

  /**
   * A fallback with nobody waiting on the write (a deadline or a switch-off, not the caller's own emit). The caller of
   * `route` hears a failed write and ends the card itself; here nobody does, so a card decision that main cannot be
   * told about ends the card and tells the owner. Anything else is logged by the caller.
   * `again`: a start repeating a hand-over a stop cut short. main may already have run that turn, so its point is taken only
   * when the one recorded is of another folder (as `route` does for an id it saw before).
   * While the hand-over runs a `main_handover` row stands (written with the claim by `claimLate`, deleted when `mainEmit`
   * returns); only a row left behind is repeated by `resume`.
   */
  private async fallbackLate(n: Notification, thread: string, reason: ErrorCodeT, claimed: string, again = false) {
    try {
      // main runs it now, in its own folder: that point replaces the one taken of the worker's
      await waitForRestore(this.ctx, 'main')
      await pointBefore(this.ctx, n, 'main', { replace: again ? 'elsewhere' : true })
      this.claiming.delete(claimed) // the hand-over begins: the claim stays
      await this.fallback(n, thread, reason, () => this.endMainHandover(claimed))
    } catch (e) {
      if (isStopping(e)) throw e // not delivered, and no failure to tell the owner of: `close()` gave the claim back
      this.claiming.delete(claimed) // a failure of its own: the claim is as it always was
      const cardId = n.meta.kind === 'card_action' ? n.meta.card_id : undefined
      if (!cardId) throw e
      this.endMainHandover(claimed) // the card ends here: a start must not end it again
      this.ctx.log.warn('card decision not delivered to main', { card_id: cardId, error: (e as Error).message })
      this.onCardUndelivered(cardId)
    }
  }

  /**
   * main has the message: the hand-over row goes. Dying between `mainEmit` returning and this delete leaves the row, and the
   * next start gives main the message a second time: nothing on main's side drops a repeated message id (`heldForMain` only
   * tracks the id for the unanswered report), so this is a duplicate, never a loss, by choice.
   */
  private endMainHandover(id: string) {
    try {
      this.store.endMainHandover(id)
    } catch (e) {
      this.ctx.log.warn('main hand-over not cleared', { error: (e as Error).message })
    }
  }

  private async fallback(n: Notification, lead: string, reason: ErrorCodeT, delivered?: () => void) {
    const { ctx } = this
    // the message's own thread: a sub-thread's message held for its parent's lead is still that sub-thread's
    // a thread session's wake is only ever that session's: dropped with a report, never main's own words
    if (n.meta.kind === 'wake') {
      await dropWake(ctx, n, this.wakeDropReason(n.meta.thread_id ?? '', reason), this.mainEmit)
      return delivered?.()
    }
    const thread = this.shownIn(n, lead)
    ctx.log.info('thread session fallback', { thread, lead, reason })
    // main has it now: a main session that dies with it in flight must be reported (D39). A scheduled run is not an owner message:
    // the Schedules service reports a run nobody finished.
    if (n.meta.message_id && n.meta.kind !== 'schedule_run' && n.meta.kind !== 'wake')
      ctx.seen.heldForMain(thread, n.meta.message_id)
    await this.mainEmit({ content: n.content, meta: { ...n.meta, routed: 'fallback', reason } })
    delivered?.()
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

  private wakeDropReason(thread: string, reason: ErrorCodeT): string {
    const t = this.ctx.config.thread(thread)
    if (!t) return 'its thread was deleted'
    if (t.archived) return 'its thread was archived'
    if (threadSessionMode(this.ctx.config.config, thread) !== 'dedicated')
      return 'its thread no longer has its own session'
    return REASON_TEXT[reason] ?? `its session did not take it (${reason})`
  }

  /** A thread switched off with messages still waiting: they are main's now, at once. */
  private releaseSwitchedOff() {
    const { ctx } = this
    for (const row of this.store.allUnclaimed()) {
      // still that lead's: it has its session, and (for an owner message) it is still the lead that answers the message's
      // thread. A sub-thread that got its own lead, lost its parent or was archived meanwhile is main's at once.
      const msgThread = row.notification.meta.thread_id
      const answers =
        row.notification.meta.kind === 'card_action' ||
        row.notification.meta.kind === 'handoff' ||
        row.notification.meta.kind === 'schedule_run' ||
        row.notification.meta.kind === 'wake' ||
        !msgThread ||
        leadThreadFor(ctx.config.config, msgThread) === row.thread_id
      if (threadSessionMode(ctx.config.config, row.thread_id) === 'dedicated' && answers) continue
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
      if (!this.claimLate(row.message_id)) continue
      void this.fallbackLate(row.notification, row.thread_id, 'worker_unavailable', row.message_id).catch((e) => {
        if (!isStopping(e)) ctx.log.error('switch-off fallback failed', { error: (e as Error).message })
      })
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
    const jobs = new Map<string, string[]>()
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
      // a wake the session read is done with: it asks for no answer, so a session parking after it is not "unanswered"
      if (c.kind === 'wake') {
        settled.push(c.message_id)
        continue
      }
      if (this.store.answeredIn(c.thread_id, c.message_thread, c.at)) {
        settled.push(c.message_id)
        continue
      }
      const e = file.threads[c.thread_id]
      if (!e || !runEnded(e, c.at)) continue
      if (c.kind === 'schedule_run') {
        jobs.set(c.thread_id, [...(jobs.get(c.thread_id) ?? []), c.message_id])
        continue
      }
      // said where the owner sent it: a sub-thread's message answered by its parent's lead gets the notice in the sub-thread
      report.set(c.message_thread, [...(report.get(c.message_thread) ?? []), c.message_id])
    }
    // end the cards first: a crash between the two leaves the claim open, and the next tick tries again
    for (const id of unfinished) this.onCardUndelivered(id, 'unknown')
    this.store.settleClaims(settled, now)
    // a scheduled run the session took and never reported on: say so (the run list shows it as it stands), never "send it again"
    for (const [thread, ids] of jobs) {
      this.store.settleClaims(ids, now)
      postSystemNotice(
        ctx,
        "This thread's session stopped before it finished a scheduled job. Open Schedules to see how the run ended.",
        { thread: threadRef(ctx, thread) },
      ).catch((e) => ctx.log.warn('unfinished job notice not posted', { error: (e as Error).message }))
    }
    for (const [thread, ids] of report) {
      this.store.settleClaims(ids, now)
      postSystemNotice(ctx, "This thread's session stopped before it answered. Send the message again to carry on.", {
        thread: threadRef(ctx, thread),
      }).catch((e) => ctx.log.warn('unanswered notice not posted', { error: (e as Error).message }))
    }
  }

  /**
   * After a (re)start: re-arm every unclaimed route (ones past their deadline fall back now), and finish every hand-over to main
   * that a stop cut short (a `main_handover` row, see `fallbackLate`; an old database has none). The original reason is not
   * stored: 'worker_unavailable'. A card decision is never replayed to main: its card ends once, as an unknown outcome. A repeat
   * that fails for a reason of its own is given up after REDELIVER_ATTEMPTS starts, with an error in the log.
   */
  resume(): void {
    this.store.dropStaleMainHandovers() // before re-arming: an unclaimed route is the deadline path's, not a repeat's
    for (const row of this.store.allUnclaimed()) if (!this.timers.has(row.message_id)) this.arm(row)
    if (this.ctx.closing) return
    for (const row of this.store.pendingMainHandovers()) {
      const id = row.message_id
      const { kind, card_id: cardId } = row.notification.meta
      if (this.redelivering.has(id)) continue
      if (kind === 'card_action' || kind === 'handoff') {
        // the card first: a crash between the two repeats the end (a card already ended ignores it), never loses it
        if (kind === 'card_action' && cardId) this.onCardUndelivered(cardId, 'unknown')
        this.endMainHandover(id)
        continue
      }
      this.redelivering.add(id)
      void this.fallbackLate(row.notification, row.thread_id, 'worker_unavailable', id, true)
        .catch((e) => {
          if (isStopping(e)) return
          let failed = REDELIVER_ATTEMPTS
          try {
            failed = this.store.failMainHandover(id)
          } catch {}
          this.ctx.log.error('main redelivery failed', { error: (e as Error).message, attempts: failed })
          if (failed >= REDELIVER_ATTEMPTS) {
            this.endMainHandover(id) // given up: never again
            postSystemNotice(
              this.ctx,
              'A message could not be handed to the main session. Send it again to carry on.',
              { thread: threadRef(this.ctx, this.shownIn(row.notification, row.thread_id)) },
            ).catch((err) => this.ctx.log.warn('hand-over notice not posted', { error: (err as Error).message }))
          }
        })
        .finally(() => this.redelivering.delete(id))
    }
  }

  /** Called from the bridge's poll: governor park-all, workers.status and each worker's context (`sendState`). */
  tick(send: (status: WorkersStatusT) => void, sendState?: (state: SessionStateT) => void): void {
    const { ctx } = this
    const now = ctx.clock.now()
    const file = this.workers.read()
    // every thread session's latest usage reading first, so the governor below sees the newest
    ctx.usage?.readThreads(ctx.paths.home, file, now)
    const g = this.governor()
    this.noteSessionStarts(file)
    tellOldSupervisor(ctx, file, this.oldSupervisorTold)
    this.releaseSwitchedOff()
    for (const lead of this.handoffs.openLeads())
      if (threadSessionMode(ctx.config.config, lead) !== 'dedicated') this.handoffs.closeLead(lead)
    this.expireUnclaimedHandoffs(now)
    void this.deliverHandoffs().catch((e) => ctx.log.warn('hand-offs not delivered', { error: (e as Error).message }))
    if (file && supervisorFresh(file, now)) this.reportUnanswered(file, now)
    if (g.state === 'park_all' && file && supervisorFresh(file, now)) {
      for (const [id, e] of Object.entries(file.threads)) {
        if (!WORKER_LIVE_STATES.includes(e.state)) {
          this.parkSentAt.delete(id)
          continue
        }
        const sent = this.parkSentAt.get(id)
        if (sent !== undefined && sent <= now && now - sent < GOVERNOR_PARK_RETRY_MS) continue
        try {
          writeControl(
            ctx.paths.home,
            {
              v: 1,
              thread_id: id,
              message_ids: [],
              at: new Date(now).toISOString(),
              reason: 'governor',
              action: 'park',
            },
            (msg, f) => this.ctx.log.warn(msg, f),
          )
          this.parkSentAt.set(id, now)
        } catch (err) {
          ctx.log.warn('park wake not written', { thread: id, error: (err as Error).message })
        }
      }
    }
    if (g.state !== 'park_all') this.parkSentAt.clear()
    const status = this.status(file, g, now)
    const key = JSON.stringify({ ...status, at: '' })
    if (this.relayListsFeature && key !== this.lastStatusKey) {
      this.lastStatusKey = key
      send(status)
    }
    // A scoped session.state only goes to a relay that lists thread-sessions/1: an older app's strict SessionState refuses `scope`.
    if (this.relayListsFeature && sendState)
      this.contextFeed.tick(file, (t) => threadSessionMode(ctx.config.config, t) === 'dedicated', sendState)
  }

  /**
   * A thread session that started since the last look (a new session id, or the same one started again; after a bridge
   * restart, each live one once): when its AGENTS.md was changed outside Settings, one quiet line in its thread. Never waited on, never holds it.
   */
  private noteSessionStarts(file: WorkersFileT | null): void {
    const { ctx } = this
    const am = ctx.agentsMd
    if (!am || !file) return
    for (const [thread, e] of Object.entries(file.threads)) {
      // only a running session counts: a park or an exit (pane 0) is no start, and its key is not kept
      if (!e.session_id || !e.pane_pid || !WORKER_LIVE_STATES.includes(e.state)) continue
      // a start resumed under the same session id (an idle session woken with --resume) is a start too: its time and pane change
      const key = `${e.session_id}|${e.started_at ?? ''}|${e.pane_pid ?? ''}`
      if (this.sessionsSeen.get(thread) === key) continue
      this.sessionsSeen.set(thread, key)
      if (!ctx.config.thread(thread) || threadSessionMode(ctx.config.config, thread) !== 'dedicated') continue
      void am
        .changedOutside(thread)
        .then((changed) =>
          changed
            ? postSystemNotice(ctx, AGENTS_MD_WORDING.changedOutside, { thread: threadRef(ctx, thread) })
            : undefined,
        )
        .catch((err) => ctx.log.warn('AGENTS.md start line not posted', { thread, error: (err as Error).message }))
    }
  }

  /** Forget the last status so the next tick sends it again (after `ready`). */
  resendStatus(): void {
    this.lastStatusKey = ''
    this.contextFeed.reset()
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
      if (e?.error) {
        item.error = e.error.code
        item.error_at = e.error.at
      }
      if (e) Object.assign(item, statusLine(e, now))
      const w = pendingOf(this.wakes, t.id)
      if (w.total > 0) Object.assign(item, { wakes: w.wakes, wakes_total: w.total })
      threads.push(item)
    }
    // main's own wakes, and those of any lane that is not a dedicated thread now (it went back to main, which runs them)
    const mainWakes = this.mainWakes(cfg)
    // Main's own wait (a prompt at the Mac), for the app and the relay's once-per-wait push
    const mainWait = mainNeedsYou(this.ctx.paths.home, now)
    return {
      supported: fresh && file?.supervisor.workers_supported === true,
      supervisor_online: fresh,
      threads: threads.slice(0, 40),
      governor: g.resets_at ? { state: g.state, resets_at: g.resets_at } : { state: g.state },
      at: new Date(now).toISOString(),
      ...(mainWait ? { main_needs_you: mainWait } : {}),
      ...(mainWakes.total > 0 ? { main_wakes: mainWakes.wakes, main_wakes_total: mainWakes.total } : {}),
    }
  }

  private mainWakes(cfg: typeof this.ctx.config.config): ReturnType<typeof pendingOf> {
    const lanes = new Set(this.wakes.allOpen().map((r) => r.lane))
    const all: ReturnType<typeof pendingOf> = { wakes: [], total: 0 }
    for (const lane of lanes) {
      if (lane !== 'main' && threadSessionMode(cfg, lane) === 'dedicated') continue
      const p = pendingOf(this.wakes, lane)
      all.wakes.push(...p.wakes)
      all.total += p.total
    }
    all.wakes.sort((a, b) => a.at.localeCompare(b.at))
    all.wakes = all.wakes.slice(0, WAKE_STATUS_MAX)
    return all
  }

  close(): void {
    for (const t of this.timers.values()) this.ctx.clock.clearTimeout(t)
    this.timers.clear()
    // synchronous, before the store can close: a claim whose hand-over never began goes back (see `claiming`)
    for (const id of this.claiming) {
      try {
        this.store.release(id, 'main')
      } catch (e) {
        this.ctx.log.warn('claim not given back', { id, error: (e as Error).message })
      }
    }
    this.claiming.clear()
  }
}
