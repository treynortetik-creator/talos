// The Schedules service (docs/SCHEDULES.md S3): the bridge's side of the scheduler. It owns
//   - the own serial queue (a slow Chronos never delays a chat message),
//   - discovery, the watcher and the health re-check, all behind the liveness gate (S3.2),
//   - the session runner: offers, claims at start, orphans, time-outs (S3.3),
//   - the owner frames (list, get, patch, run now, control) and the card apply (S3.4),
//   - failures reaching the app (S3.6) and `schedule.status` (S2.2).
// Chronos keeps the registry, the due logic, the claim and the approved record; nothing here does schedule maths.
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import {
  dateOfRunKey,
  needsSchedulesV2,
  runsInSession,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  type SchedulerAdapter,
  type ScheduleSnapshotT,
  safeLine,
} from '@talos-app/protocol'
import { type BridgeContext, defaultThreadRef, threadRef } from '../context.ts'
import { reapOrphans } from '../heartbeat/orphans.ts'
import { HeartbeatRunner, type HeartbeatSeams, type HeartbeatWake, type RunnerDeps } from '../heartbeat/runner.ts'
import { HeartbeatTester } from '../heartbeat/test-run.ts'
import { makeWake, triageAvailable } from '../heartbeat/wake.ts'
import type { AdapterError, ChronosAdapter } from './chronos-adapter.ts'
import { type Discovered, discover } from './discovery.ts'
import { InstanceRegistry } from './instances.ts'
import { JobMemory } from './job-memory.ts'
import { newBackgroundMemoryState } from './job-memory-background.ts'
import { proposerKey, pruneScheduleKv, startedKey } from './kv-prune.ts'
import {
  applyCard,
  applyCardInner,
  endCard,
  failStuckCards,
  onCardResolved,
  prepareCard,
  publishCard,
} from './service-cards.ts'
import {
  ack,
  dispatch,
  err,
  handleOwnerFrame,
  onControl,
  onGet,
  onPatch,
  onRunNow,
  readOnly,
  runNowDay,
  stale,
  startProbe,
  withRuns,
} from './service-frames.ts'
import { agentOrigin, baseOf, changeFromArgs, toolPropose, tooOldFor } from './service-propose.ts'
import {
  chronosLimits,
  closeRun,
  expireRuns,
  heartbeatRun,
  noticeHeldById,
  noticeUnreadableAtSlot,
  offer,
  runnerTick,
  startHeartbeat,
  sweepOrphans,
} from './service-runner.ts'
import { MAIN_PROPOSER, NEEDS_V2 } from './service-shared.ts'
import {
  degraded,
  markAll,
  noteByDay,
  noticeHeld,
  noticesFor,
  overlay,
  postFailure,
  reportFailure,
  safeSnapshot,
  sendStatus,
  syncJobMemory,
} from './service-snapshot.ts'
import {
  heartbeatJobOfThread,
  heartbeatPlainLine,
  heartbeatRunEnded,
  inScope,
  isHeartbeatJob,
  lookupSnapshot,
  savedThreadMap,
  saveThreadMap,
  threadFromStores,
  threadMapFile,
  toolList,
  toolRunDone,
  toolRunDoneQueued,
  toolRunStart,
} from './service-tools.ts'
import { Sidecar } from './sidecar.ts'
import { hasHeartbeatMeta } from './worker-scope.ts'

export { RUN_TIMEOUT_MS, readChronosLimits, runTimeoutMs } from './run-limits.ts'
export const RUNNER_EVERY_MS = 60_000
export const REFRESH_EVERY_MS = 30_000
export const DISCOVER_EVERY_MS = 5 * 60_000
export type ScheduleServiceDeps = {
  /** Is the relay socket authenticated right now? (S3.2) */
  connected: () => boolean
  /** This bridge process's instance id; Chronos writes it into every claim's owner file (N11). */
  instance: string
  /** CHRONOS_NOW from the injected clock (test builds only). */
  chronosNow?: () => string | undefined
  /** fs.watch on the scheduler's files. Default true. */
  watch?: boolean
  /** Test seam: the `chronos api version` budget in discovery (ms). */
  discoveryTimeoutMs?: number
  /** Test seam: wraps the discovered adapter. */
  wrapAdapter?: (a: SchedulerAdapter) => SchedulerAdapter
  /** Test seams for the heartbeat runner. Production passes nothing. */
  heartbeat?: HeartbeatSeams
}

type Problem = { code: 'adapter_timeout' | 'registry_unreadable'; text: string; at: number }
// Most methods are thin calls into the service-*.ts modules, which run with `this` set to the service. The members those modules
// reach are therefore not `private`.
export class ScheduleService {
  readonly sidecar: Sidecar
  readonly jobMemory: JobMemory
  readonly bgMemory = newBackgroundMemoryState()
  readonly instances: InstanceRegistry
  disc: Discovered | null = null
  private unansweredAt = 0
  private queueTail: Promise<unknown> = Promise.resolve()
  private started = false
  stopped = false
  private timers: { refresh?: unknown; runner?: unknown; discover?: unknown } = {}
  private watchers: FSWatcher[] = []
  private watchKey = ''
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  private relayFeatures: string[] = []
  lastGood: ScheduleSnapshotT | null = null
  problem: Problem | null = null
  statusSig: Map<string, string> | null = null
  healthSig = ''
  pendingAlerts: Array<{ kind: 'job_failed' | 'scheduler_stuck'; key: string }> = []
  wasStuck = false
  runNowAt = new Map<string, number>()
  /** Proposal times per lane: 'main', or a thread session's thread id. One looping lane cannot use up another's hour. */
  proposalAt = new Map<string, number[]>()
  probing = false
  /** Heartbeat jobs with a run in flight: one at a time per job, and never awaited by the runner tick (S3.1 own queue). */
  readonly hbRunning = new Set<string>()
  readonly heartbeat: HeartbeatRunner
  /** Answers `heartbeat.test` on a runner of its own: a test never waits for a real slot, and a real slot never waits for a test. */
  readonly tester: HeartbeatTester
  /**
   * Wake runs the agent is working on (HB4): a live one holds the slot's Chronos claim until schedule_run_done; a test one holds
   * nothing. Memory only: after a restart the wake is dead anyway and the saved store settles it (WAKE_STALE_MS, wakeEnded).
   */
  readonly wakeRuns = new Map<string, { started: boolean }>()
  /** Wake closes started from the schedule queue and not waited on there (a slow source must not hold the queue). */
  readonly wakeEnds = new Set<Promise<unknown>>()

  constructor(
    readonly ctx: BridgeContext,
    readonly deps: ScheduleServiceDeps,
  ) {
    this.instances = new InstanceRegistry(join(ctx.paths.home, 'instances'))
    this.sidecar = new Sidecar(
      ctx.paths.home,
      () => this.gate(),
      (e) => this.log('schedules-meta.json not written; trying again next tick', { error: e.message }),
    )
    this.jobMemory = new JobMemory(
      ctx.paths.home,
      () => this.gate(),
      (id) => this.sidecar.bumpEpoch(id),
    )
    const seams = deps.heartbeat ?? {}
    const real = makeWake({
      home: ctx.paths.home,
      now: () => this.now(),
      emit: (n) => ctx.emit(n),
      thread: (id) => this.threadOfJob(id),
      jobName: (id) => safeLine(this.lastGood?.schedules.find((j) => j.id === id)?.name ?? id),
      log: (m, f) => this.log(m, f),
      available: () => {
        const v = seams.triageAvailable ? seams.triageAvailable() : triageAvailable(ctx.mod)
        return v === true ? 'yes' : v === false ? 'no' : v
      },
      onSent: (a) => this.wakeRuns.set(a.runId, { started: false }),
    })
    // A heartbeat with no thread of its own is never woken: the card limits key on the thread, so the default thread cannot be one.
    const wake: HeartbeatWake =
      seams.wake ??
      (async (req) =>
        this.threadOfJob(req.job_id).id === defaultThreadRef(ctx).id
          ? { delivered: false, no_thread: true }
          : real(req))
    const runnerDeps: RunnerDeps = {
      ctx,
      builtin: (selfJobId) => ({
        home: ctx.paths.home,
        userHome: ctx.env.userHome,
        runs: () => Object.entries(this.sidecar.all.runs),
        missed: () =>
          (this.lastGood?.schedules ?? [])
            .filter((j) => j.today === 'missed')
            .map((j) => ({
              id: j.id,
              name: j.name,
              ds: dateOfRunKey(this.chronos()?.dayOf(j.id) ?? this.iso().slice(0, 10)),
            })),
        jobName: (id) => safeLine(this.lastGood?.schedules.find((j) => j.id === id)?.name ?? id),
        selfJobId,
        ...(seams.ghBin ? { ghBin: seams.ghBin } : {}),
      }),
      threadFor: (id) => this.threadOfJob(id),
      alive: () => !this.stopped,
      ...(seams.workAllowed ? { workAllowed: seams.workAllowed } : {}),
      wake,
      ...(seams.secondMs ? { secondMs: seams.secondMs } : {}),
      ...(seams.hooks ? { hooks: seams.hooks } : {}),
    }
    this.heartbeat = new HeartbeatRunner(runnerDeps)
    this.tester = new HeartbeatTester({
      runner: new HeartbeatRunner(runnerDeps),
      home: ctx.paths.home,
      now: () => this.now(),
      send: (f) => ctx.transport.sendEphemeral(f),
      log: (m, f) => this.log(m, f),
    })
  }

  // ---- gate, queue, clocks --------------------------------------------------------------------------------------

  /** S3.2: live mode, an authenticated relay socket, and not superseded. Checked at every tick and every write. */
  gate(): boolean {
    return this.ctx.mode === 'live' && !this.stopped && this.deps.connected()
  }

  now() {
    return this.ctx.clock.now()
  }
  iso(ms = this.now()) {
    return new Date(ms).toISOString()
  }

  /** The schedule queue: serial, and separate from the inbound chat queue. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(fn, fn)
    this.queueTail = run.catch(() => {})
    return run
  }

  /** Resolves when everything queued so far has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.queueTail.then(() => Promise.all([...this.wakeEnds, this.tester.idle()])).then(() => {})
  }

  log(msg: string, f: Record<string, unknown> = {}) {
    this.ctx.log.warn(msg, f)
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  /** Called by the bridge on every `ready` (S1.5 deploy order: the relay says what it supports). */
  onReady(features: string[]) {
    this.relayFeatures = features
    if (!this.gate()) return
    if (!this.started)
      void this.start().catch((e) => this.log('schedules start failed', { error: (e as Error).message }))
    else {
      void this.enqueue(async () => {
        await this.refresh()
        await this.runnerTick()
      })
    }
  }

  relaySupports(): boolean {
    return this.relayFeatures.includes(SCHEDULES_FEATURE)
  }

  /**
   * `schedules/2` (docs/HEARTBEAT.md): jobs with several fire times and jobs with `meta` travel to the app only when the
   * relay says it reads them. An older relay checks `schedule.detail` and card frames against the protocol it was built with,
   * and an older app reads a whole snapshot against its strict schema, so one such row would cost the whole frame.
   */
  relaySupportsV2(): boolean {
    return this.relayFeatures.includes(SCHEDULES_FEATURE_V2)
  }

  /**
   * Whether THIS requester can read `schedules/2`: the relay has to carry it AND the app has to have said it reads it in the
   * request. The relay's feature list says what the relay does; only the app knows what the app parses.
   */
  appCanRead(appReads: readonly string[] | undefined): boolean {
    return this.relaySupportsV2() && (appReads ?? []).includes(SCHEDULES_FEATURE_V2)
  }

  /** The snapshot as the app may have it: rows that need `schedules/2` become `unreadable` entries until the relay can carry them. */
  forApp(snap: ScheduleSnapshotT, appReads: readonly string[] | undefined): ScheduleSnapshotT {
    if (this.appCanRead(appReads)) return snap
    const keep = snap.schedules.filter((s) => !needsSchedulesV2(s))
    if (keep.length === snap.schedules.length) return snap
    const held = snap.schedules.filter((s) => needsSchedulesV2(s)).map((s) => ({ id: s.id, unreadable: NEEDS_V2 }))
    return { ...snap, schedules: keep, unreadable: [...snap.unreadable, ...held].slice(0, 200) }
  }

  /** `start()` has begun. Settled by the time the bridge's `ready` handler returns (it is set before the first await). */
  get hasStarted(): boolean {
    return this.started
  }
  /** The refresh, runner and discovery loops are on the clock. A test advances time only once this is true. */
  get armed(): boolean {
    return this.timers.runner !== undefined
  }

  async start(): Promise<void> {
    if (this.started || !this.gate()) return
    this.started = true
    this.instances.register(this.deps.instance) // before any claim, so another bridge's sweep can see this one is alive
    await this.enqueue(async () => {
      // before any slot, and in the queue so it never overlaps a store write of this process: sources a crash left running
      try {
        await reapOrphans(this.ctx.paths.home, (m, f) => this.log(m, f))
      } catch (e) {
        this.log('heartbeat orphan sweep failed', { error: (e as Error).message })
      }
      if (this.stopped) return
      await this.ensure()
      if (this.stopped) return
      await this.failStuckCards()
      this.sidecar.prune(this.now())
      this.pruneKv()
      await this.sweepOrphans()
      if (this.stopped) return
      await this.refresh()
      await this.runnerTick()
    }).catch((e) => {
      if (!this.stopped) this.log('schedules start failed', { error: (e as Error).message })
    })
    if (!this.stopped) this.arm()
  }

  /** `final` false = superseded: the process lives on and may still finish its run, so its instance is not stamped stopped. */
  stop(final = true) {
    this.stopped = true
    this.wakeRuns.clear() // a wake open at shutdown is the next bridge's orphan sweep to settle; no card is believed after this
    this.heartbeat.abortAll() // sources are killed by process group; a run in flight posts nothing and saves no result (a source's record stays for the next start)
    this.tester.abortAll() // the same for a test the owner is waiting on: its sources die with the bridge
    if (final) this.instances.markStopped(this.deps.instance, this.now())
    this.chronos()?.close()
    for (const k of Object.keys(this.timers) as Array<keyof typeof this.timers>) {
      if (this.timers[k] !== undefined) this.ctx.clock.clearTimeout(this.timers[k])
      delete this.timers[k]
    }
    this.closeWatchers()
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
  }

  private arm() {
    // One tick of each loop at a time: a slow or hung scheduler must not pile up a backlog behind itself.
    const queued = new Set<string>()
    const every = (key: keyof typeof this.timers, ms: number, fn: () => Promise<void>) => {
      const tick = () => {
        this.timers[key] = this.ctx.clock.setTimeout(() => {
          if (this.stopped) return
          if (this.gate() && !queued.has(key)) {
            queued.add(key)
            void this.enqueue(fn)
              .catch((e) => this.log('schedule loop failed', { loop: key, error: (e as Error).message }))
              .finally(() => queued.delete(key))
          }
          tick()
        }, ms)
      }
      tick()
    }
    every('refresh', REFRESH_EVERY_MS, async () => {
      await this.refresh(true)
    })
    every('runner', RUNNER_EVERY_MS, () => this.runnerTick())
    every('discover', DISCOVER_EVERY_MS, () => this.rediscover())
  }

  /** The adapter, discovering it first when needed. Works headless too (read-only use). */
  async ensure(): Promise<Discovered> {
    // A discovery that got no answer (a busy Mac) is never final: ask again, at most once per runner tick.
    if (this.disc && !(this.disc.unanswered && this.now() - this.unansweredAt >= RUNNER_EVERY_MS)) return this.disc
    const d = await discover(this.ctx.env, {
      meta: {
        threadOf: (id) => this.sidecar.threadOf(id),
        memoryOf: (id) => this.sidecar.memoryOf(id),
        offerAgeS: (id, ds) => {
          const o = this.sidecar.offerFor(id, ds)
          return o ? Math.max(0, Math.round((this.now() - o.at) / 1000)) : null
        },
      },
      now: () => this.now(),
      clockIso: () => this.iso(),
      ...(this.deps.chronosNow ? { chronosNow: this.deps.chronosNow } : {}),
      onProblem: (e) => this.onProblem(e),
      ...(this.deps.discoveryTimeoutMs ? { timeoutMs: this.deps.discoveryTimeoutMs } : {}),
    })
    if (d.unanswered) this.unansweredAt = this.now()
    this.log('schedule discovery', { state: d.state, unanswered: Boolean(d.unanswered) })
    if (this.deps.wrapAdapter) d.adapter = this.deps.wrapAdapter(d.adapter)
    this.disc = d
    return d
  }

  private async rediscover() {
    const before = this.disc
    this.disc = null
    const d = await this.ensure().catch(() => before as Discovered)
    // A probe that got no answer never replaces a ready Chronos: keep the working adapter until a real answer arrives.
    if (before && (before.state === d.state || (d.unanswered && before.chronos)))
      this.disc = before.chronos ? before : d
    this.armWatchers()
  }

  /** One line for a failing test or a log: where discovery stands. */
  discoveryNote(): string {
    const d = this.disc
    return d
      ? `discovery=${d.state}${d.unanswered ? ' (unanswered)' : ''}${d.sessionRunner ? ` runner=${d.sessionRunner}` : ''}`
      : 'discovery=none'
  }

  get adapter(): SchedulerAdapter {
    if (!this.disc) throw new Error('scheduler not discovered')
    return this.disc.adapter
  }

  onProblem(e: AdapterError) {
    if (e.kind === 'timeout') this.problem = { code: 'adapter_timeout', text: e.message, at: this.now() }
    else if (e.kind === 'parse') this.problem = { code: 'registry_unreadable', text: e.message, at: this.now() }
  }

  /** Whether Talos manages this registry: Chronos 0.3 with session_runner talos AND approval_required (S3.7). */
  managed(snap: ScheduleSnapshotT | null = this.lastGood): boolean {
    if (this.disc?.state !== 'ready' || !snap) return false
    return !snap.health.issues.some((i) => i.code === 'session_runner_conflict')
  }

  // ---- snapshots ------------------------------------------------------------------------------------------------

  safeSnapshot(...a: Parameters<typeof safeSnapshot>) {
    return safeSnapshot.call(this, ...a)
  }

  degraded(...a: Parameters<typeof degraded>) {
    return degraded.call(this, ...a)
  }

  overlay(...a: Parameters<typeof overlay>) {
    return overlay.call(this, ...a)
  }

  noteByDay(...a: Parameters<typeof noteByDay>) {
    return noteByDay.call(this, ...a)
  }

  // ---- refresh, status, notices ---------------------------------------------------------------------------------

  /** Re-snapshot; tell the app what moved (an invalidation signal: ids and hashes only); report failures and holds. */
  async refresh(fromLoop = false): Promise<ScheduleSnapshotT | null> {
    if (!this.disc) await this.ensure()
    if (fromLoop) this.chronos()?.invalidate()
    const snap = await this.safeSnapshot()
    this.armWatchers()
    if (!this.gate()) return snap
    await this.noticesFor(snap)
    await this.syncBackgroundMemory(snap)
    this.sendStatus(snap)
    return snap
  }

  /** What a card may say about Chronos and memory: it can give background jobs memory, it is too old to, or none was found. */
  chronosMemoryState(): 'ok' | 'too_old' | 'not_found' {
    const c = this.chronos()
    return !c ? 'not_found' : c.hasFeature('memory') ? 'ok' : 'too_old'
  }

  syncBackgroundMemory(...a: Parameters<typeof syncJobMemory>) {
    return syncJobMemory.call(this, ...a)
  }

  chronos(): ChronosAdapter | null {
    return this.disc?.chronos ?? null
  }

  sendStatus(...a: Parameters<typeof sendStatus>) {
    return sendStatus.call(this, ...a)
  }

  noticesFor(...a: Parameters<typeof noticesFor>) {
    return noticesFor.call(this, ...a)
  }

  markAll(...a: Parameters<typeof markAll>) {
    return markAll.call(this, ...a)
  }

  reportFailure(...a: Parameters<typeof reportFailure>) {
    return reportFailure.call(this, ...a)
  }

  postFailure(...a: Parameters<typeof postFailure>) {
    return postFailure.call(this, ...a)
  }

  threadOfJob(jobId: string) {
    const t = this.sidecar.threadOf(jobId)
    return t && this.ctx.config.thread(t) && !this.ctx.config.thread(t)?.archived
      ? threadRef(this.ctx, t)
      : defaultThreadRef(this.ctx)
  }

  noticeHeld(...a: Parameters<typeof noticeHeld>) {
    return noticeHeld.call(this, ...a)
  }

  // ---- watching -------------------------------------------------------------------------------------------------

  private closeWatchers() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.watchKey = ''
  }

  /** fs.watch on the scheduler's files; the 30 s poll backs it up (S3.2). Live bridge only. */
  private armWatchers() {
    if (this.deps.watch === false || !this.gate()) return this.closeWatchers()
    const paths = (this.disc?.adapter.watchPaths() ?? []).filter((p) => existsSync(p))
    const key = paths.join('\n')
    if (key === this.watchKey) return
    this.closeWatchers()
    this.watchKey = key
    for (const p of paths) {
      try {
        this.watchers.push(watch(p, { persistent: false }, () => this.poke()))
      } catch {
        // the poll still runs
      }
    }
  }

  private poke() {
    if (this.pokeTimer || this.stopped) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      if (!this.gate()) return
      void this.enqueue(() => this.refresh(true)).catch(() => {})
    }, 300)
    this.pokeTimer.unref?.()
  }

  // ---- the session runner (S3.3) --------------------------------------------------------------------------------

  runnerTick(...a: Parameters<typeof runnerTick>) {
    return runnerTick.call(this, ...a)
  }

  offer(...a: Parameters<typeof offer>) {
    return offer.call(this, ...a)
  }

  startHeartbeat(...a: Parameters<typeof startHeartbeat>) {
    return startHeartbeat.call(this, ...a)
  }

  heartbeatRun(...a: Parameters<typeof heartbeatRun>) {
    return heartbeatRun.call(this, ...a)
  }

  noticeUnreadableAtSlot(...a: Parameters<typeof noticeUnreadableAtSlot>) {
    return noticeUnreadableAtSlot.call(this, ...a)
  }

  noticeHeldById(...a: Parameters<typeof noticeHeldById>) {
    return noticeHeldById.call(this, ...a)
  }

  /** N11: a claim left by an earlier bridge instance that is gone (even one that died between `GO` and its sidecar write) is finished. */
  sweptOrphans = false
  sweepOrphans(...a: Parameters<typeof sweepOrphans>) {
    return sweepOrphans.call(this, ...a)
  }

  limitsProblemLogged = false
  chronosLimits(...a: Parameters<typeof chronosLimits>) {
    return chronosLimits.call(this, ...a)
  }

  expireRuns(...a: Parameters<typeof expireRuns>) {
    return expireRuns.call(this, ...a)
  }

  closeRun(...a: Parameters<typeof closeRun>) {
    return closeRun.call(this, ...a)
  }

  // ---- the agent's run tools (S6.1) -----------------------------------------------------------------------------

  toolRunStart(...a: Parameters<typeof toolRunStart>) {
    return toolRunStart.call(this, ...a)
  }

  toolRunDone(...a: Parameters<typeof toolRunDone>) {
    return toolRunDone.call(this, ...a)
  }

  toolRunDoneQueued(...a: Parameters<typeof toolRunDoneQueued>) {
    return toolRunDoneQueued.call(this, ...a)
  }

  // ---- heartbeat cards (HB4) -----------------------------------------------------------------------------------
  // The `card` tool asks here for every card. A heartbeat has a thread of its own (a heartbeat without one is refused when it is
  // proposed), and every card made in that thread follows the heartbeat's rules, whatever run id or origin it names.

  isHeartbeatJob(...a: Parameters<typeof isHeartbeatJob>) {
    return isHeartbeatJob.call(this, ...a)
  }

  heartbeatJobOfThread(...a: Parameters<typeof heartbeatJobOfThread>) {
    return heartbeatJobOfThread.call(this, ...a)
  }

  /**
   * The read a card's thread lookup waits on. The lookup gives up after HB_THREAD_LOOKUP_MS but the read it started keeps going,
   * so a burst of cards while Chronos is slow would start one read each. Callers share the one in flight; it clears when it settles.
   */
  lookupRead: Promise<ScheduleSnapshotT> | null = null
  lookupSnapshot(...a: Parameters<typeof lookupSnapshot>) {
    return lookupSnapshot.call(this, ...a)
  }

  threadMapFile(...a: Parameters<typeof threadMapFile>) {
    return threadMapFile.call(this, ...a)
  }
  savedMapJson = ''
  saveThreadMap(...a: Parameters<typeof saveThreadMap>) {
    return saveThreadMap.call(this, ...a)
  }
  savedThreadMap(...a: Parameters<typeof savedThreadMap>) {
    return savedThreadMap.call(this, ...a)
  }
  threadFromStores(...a: Parameters<typeof threadFromStores>) {
    return threadFromStores.call(this, ...a)
  }

  heartbeatRunEnded(...a: Parameters<typeof heartbeatRunEnded>) {
    return heartbeatRunEnded.call(this, ...a)
  }

  heartbeatPlainLine(...a: Parameters<typeof heartbeatPlainLine>) {
    return heartbeatPlainLine.call(this, ...a)
  }

  // ---- the agent's list and propose tools ------------------------------------------------------------------------

  toolList(...a: Parameters<typeof toolList>) {
    return toolList.call(this, ...a)
  }

  inScope(...a: Parameters<typeof inScope>) {
    return inScope.call(this, ...a)
  }

  /** At start: kv rows of cards and runs that are over, unknown or a week old (a crash or a headless process can skip the cleanup). */
  private pruneKv() {
    try {
      const { ctx } = this
      const n = pruneScheduleKv({
        now: this.now(),
        kv: ctx.store,
        card: (id) => {
          const row = ctx.ledger.get(id)
          if (!row) return undefined
          // a card the owner declined or sent back stays 'resolved' in the ledger but is over
          const declined =
            row.state === 'resolved' && row.resolution?.action !== undefined && row.resolution.action !== 'primary'
          return { state: declined ? 'declined' : row.state, created_at: row.created_at }
        },
        run: (id) => this.sidecar.inflightOf(id),
      })
      if (n) this.log('old schedule rows removed', { count: n })
    } catch (e) {
      this.log('schedule row sweep failed', { error: (e as Error).message })
    }
  }

  /** The card is over (resolved, declined, expired or replaced): its proposer row has no reader left. */
  forgetCard(cardId: string) {
    try {
      this.ctx.store.kvDelete(proposerKey(cardId))
    } catch (e) {
      this.log('schedule card row not removed', { card: cardId, error: (e as Error).message })
    }
  }

  /** The run is closed: the "this session started it" row has no reader left. */
  closeInflight(runId: string, status: string): boolean {
    const ok = this.sidecar.closeInflight(runId, status)
    try {
      this.ctx.store.kvDelete(startedKey(runId))
    } catch (e) {
      this.log('schedule run row not removed', { run: runId, error: (e as Error).message })
    }
    return ok
  }

  /** The thread session that proposed this card, or null when main (or the owner's form) did. */
  cardProposer(cardId: string): string | null {
    const v = this.ctx.store.kvGet(proposerKey(cardId))
    return v === undefined || v === MAIN_PROPOSER ? null : v
  }

  /** Can the router hand this job's run to a thread session? Only a plain session job; an unknown job is main's. */
  sessionOnly(jobId: string): boolean {
    const j = this.lastGood?.schedules.find((x) => x.id === jobId)
    return j !== undefined && runsInSession(j) && j.kind !== 'command' && !hasHeartbeatMeta(j.meta)
  }

  toolPropose(...a: Parameters<typeof toolPropose>) {
    return toolPropose.call(this, ...a)
  }

  agentOrigin(...a: Parameters<typeof agentOrigin>) {
    return agentOrigin.call(this, ...a)
  }

  changeFromArgs(...a: Parameters<typeof changeFromArgs>) {
    return changeFromArgs.call(this, ...a)
  }

  // ---- cards ------------------------------------------------------------------------------------------------------

  tooOldFor(...a: Parameters<typeof tooOldFor>) {
    return tooOldFor.call(this, ...a)
  }

  baseOf(...a: Parameters<typeof baseOf>) {
    return baseOf.call(this, ...a)
  }

  prepareCard(...a: Parameters<typeof prepareCard>) {
    return prepareCard.call(this, ...a)
  }

  publishCard(...a: Parameters<typeof publishCard>) {
    return publishCard.call(this, ...a)
  }

  onCardResolved(...a: Parameters<typeof onCardResolved>) {
    return onCardResolved.call(this, ...a)
  }

  applyCard(...a: Parameters<typeof applyCard>) {
    return applyCard.call(this, ...a)
  }

  endCard(...a: Parameters<typeof endCard>) {
    return endCard.call(this, ...a)
  }

  applyCardInner(...a: Parameters<typeof applyCardInner>) {
    return applyCardInner.call(this, ...a)
  }

  failStuckCards(...a: Parameters<typeof failStuckCards>) {
    return failStuckCards.call(this, ...a)
  }

  // ---- owner frames (S2.2) --------------------------------------------------------------------------------------

  handleOwnerFrame(...a: Parameters<typeof handleOwnerFrame>) {
    return handleOwnerFrame.call(this, ...a)
  }

  err(...a: Parameters<typeof err>) {
    return err.call(this, ...a)
  }
  ack(...a: Parameters<typeof ack>) {
    return ack.call(this, ...a)
  }

  stale(...a: Parameters<typeof stale>) {
    return stale.call(this, ...a)
  }

  dispatch(...a: Parameters<typeof dispatch>) {
    return dispatch.call(this, ...a)
  }

  onGet(...a: Parameters<typeof onGet>) {
    return onGet.call(this, ...a)
  }

  withRuns(...a: Parameters<typeof withRuns>) {
    return withRuns.call(this, ...a)
  }

  readOnly(...a: Parameters<typeof readOnly>) {
    return readOnly.call(this, ...a)
  }

  onPatch(...a: Parameters<typeof onPatch>) {
    return onPatch.call(this, ...a)
  }

  runNowDay(...a: Parameters<typeof runNowDay>) {
    return runNowDay.call(this, ...a)
  }

  onRunNow(...a: Parameters<typeof onRunNow>) {
    return onRunNow.call(this, ...a)
  }

  onControl(...a: Parameters<typeof onControl>) {
    return onControl.call(this, ...a)
  }

  startProbe(...a: Parameters<typeof startProbe>) {
    return startProbe.call(this, ...a)
  }

  // ---- headless -------------------------------------------------------------------------------------------------

  /**
   * A headless `claude -p` job started by Chronos (CHRONOS_JOB set) posts to that job's thread (S3.6). Read-only: the
   * sidecar is re-read, never written.
   */
  headlessJobThread(): string | null {
    const job = this.ctx.env.chronosJob
    if (!job || this.ctx.mode !== 'headless') return null
    this.sidecar.reload()
    const t = this.sidecar.threadOf(job)
    return t && this.ctx.config.thread(t) ? t : null
  }

  /** `list_threads` marks the job's thread (S3.6). */
  jobThreadMark(): string | null {
    return this.headlessJobThread()
  }

  /** CLI/tests: the adapter after discovery. */
  async adapterForCli(): Promise<Discovered> {
    return this.ensure()
  }

  /** Runs after the card path wrote something outside the loops, e.g. the CLI's adopt: forget the cache. */
  forget() {
    this.chronos()?.invalidate()
  }
}
