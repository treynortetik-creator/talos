// The Schedules service (docs/SCHEDULES.md S3): the bridge's side of the scheduler. It owns
//   - the own serial queue (a slow Chronos never delays a chat message),
//   - discovery, the watcher and the health re-check, all behind the liveness gate (S3.2),
//   - the session runner: offers, claims at start, orphans, time-outs (S3.3),
//   - the owner frames (list, get, patch, run now, control) and the card apply (S3.4),
//   - failures reaching the app (S3.6) and `schedule.status` (S2.2).
// Chronos keeps the registry, the due logic, the claim and the approved record; nothing here does schedule maths.
import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import {
  type ApplyResult,
  type CardBinding,
  type CardT,
  type ChronosChangeT,
  changeNeedsSchedulesV2,
  composeScheduleCard,
  dateOfRunKey,
  type ErrorCodeT,
  type Frame,
  fromChronosChange,
  type HealthIssueT,
  heartbeatConfigFromMeta,
  heartbeatMetaProblem,
  type MessageT,
  needsSchedulesV2,
  newUlid,
  REPORT_MAX_BYTES,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  type ScheduleApproved,
  type ScheduleCardBase,
  ScheduleCardBindingError,
  ScheduleCardPayload,
  ScheduleChange,
  type ScheduleChangeT,
  type ScheduleDetailT,
  type ScheduleRunT,
  type SchedulerAdapter,
  type SchedulerHealthT,
  type ScheduleSnapshotT,
  type ScheduleT,
  safeLine,
  toChronosChange,
  trustOn,
  type ValidateResult,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import { localClock } from '../clock-meta.ts'
import { type BridgeContext, defaultThreadRef, postSystemNotice, threadRef } from '../context.ts'
import {
  cardCreateFrame,
  cardUpdateFrame,
  errorFrame,
  scheduleAckFrame,
  scheduleDetailFrame,
  scheduleStatusFrame,
  schedulesSnapshotFrame,
} from '../frames-out.ts'
import { HeartbeatRunner, type HeartbeatSeams, type RunOutput } from '../heartbeat/runner.ts'
import {
  cardActionNotification,
  scheduleHeldNotification,
  scheduleRunNotification,
  systemNotification,
} from '../notify.ts'
import { assertFrameFits, RelayRejectedError } from '../transport.ts'
import { handoffSince } from '../worker/handoff.ts'
import { type AdapterError, type ChronosAdapter, healthState, issueFor } from './chronos-adapter.ts'
import type { ClosedAdapter } from './closed-adapter.ts'
import { type Discovered, discover, hostLabel, localZone } from './discovery.ts'
import { detailText, listText, shortWhen } from './format.ts'
import { InstanceRegistry } from './instances.ts'
import { type Offer, Sidecar } from './sidecar.ts'

export const RUNNER_EVERY_MS = 60_000
export const REFRESH_EVERY_MS = 30_000
export const DISCOVER_EVERY_MS = 5 * 60_000
/**
 * Chronos's own default `timeout_min` (40): the time-out when its config cannot be read. A session run with no
 * schedule_run_done by `timeout_min` is finished as timed_out. Chronos reports `run_hung` at `timeout_min + 5`, so the
 * bridge must give up first; it also stays under `stale_claim_min`, so a live run is never taken over before it is
 * timed out. The snapshot does not carry either number, so they are read from Chronos's config file. A key that is
 * missing means Chronos's default for that key (timeout_min 40, stale_claim_min 45; chronoslib.py DEFAULTS), never the
 * other key's value.
 */
export const RUN_TIMEOUT_MS = 40 * 60_000
const CHRONOS_STALE_CLAIM_MIN = 45
/** The shortest limit handed out: a tiny stale_claim_min must not give zero or a negative time-out. */
const MIN_RUN_TIMEOUT_MS = 60_000
export function runTimeoutMs(c: { timeout_min?: unknown; stale_claim_min?: unknown } | null): number {
  // Chronos reads both through float()/int(), so "60" counts; anything else that is not a number is its default
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
    return Number.isFinite(n) ? n : undefined
  }
  const t = num(c?.timeout_min)
  const timeout = t !== undefined && t > 0 ? t : RUN_TIMEOUT_MS / 60_000
  const stale = Math.trunc(num(c?.stale_claim_min) ?? CHRONOS_STALE_CLAIM_MIN)
  return Math.max(MIN_RUN_TIMEOUT_MS, Math.round(Math.min(timeout, stale - 1) * 60_000))
}
/**
 * Chronos's config as the bridge needs it: the file named by TALOS_APP_CHRONOS_CONFIG (a leading ~ means the home
 * folder, as in Chronos) or ~/.config/chronos/config.json. null when it cannot be used, with `problem` told why. A
 * missing file at the standard place is not a problem: Chronos runs on its defaults there too.
 */
export function readChronosLimits(
  named: string | undefined,
  userHome: string,
  problem: (msg: string) => void,
): { timeout_min?: unknown; stale_claim_min?: unknown } | null {
  const standard = join(userHome, '.config', 'chronos', 'config.json')
  const path = named ? (named === '~' || named.startsWith('~/') ? join(userHome, named.slice(1)) : named) : standard
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
    problem(
      `Chronos config ${path} is not a JSON object; using Chronos's defaults (timeout 40 min, stale claim 45 min)`,
    )
  } catch (e) {
    if (!(named === undefined && (e as NodeJS.ErrnoException).code === 'ENOENT'))
      problem(
        `could not read Chronos config ${path} (${(e as Error).message}); using Chronos's defaults (timeout 40 min, stale claim 45 min)`,
      )
  }
  return null
}
export const STALE_MS = 2 * 60_000
const RUN_NOW_GAP_MS = 2 * 60_000
const PROPOSALS_PER_HOUR = 10
const MAX_PENDING_SCHEDULE_CARDS = 20
/** A failure older than this (by its job date) is history, not news, when the bridge first sees it. */
const NOTICE_MAX_AGE_MS = 48 * 3600_000
const OWNER_SPOKE_MS = 30 * 60_000

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
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
type ToolOut = { ok: boolean; text: string }
const fail = (text: string): ToolOut => ({ ok: false, text })
const yes = (text: string): ToolOut => ({ ok: true, text })

const FAILURE_WORDS: Record<string, string> = {
  failed: 'it reported a failure',
  timed_out: 'it ran out of time',
  launch_stalled: 'it never started (macOS may be waiting for permission)',
  session_ended: 'the session restarted mid-run',
  missed: 'no session was running in its window',
}

const FAILURE_STATUSES = new Set(['failed', 'timed_out', 'launch_stalled', 'session_ended'])
/** One notice per cause: the run id when Chronos has one, and the job's day, so the two paths can't both fire. */
const failKeys = (id: string, runId: string | undefined, ds: string, status: string) => [
  ...(runId ? [`fail|${id}|${runId}|${status}`] : []),
  `fail|${id}|${ds}|${status}`,
]

const SKIP_WORDS: Record<string, string> = {
  already_done: 'already done',
  running_elsewhere: 'running elsewhere',
  not_due: 'not due',
  window_passed: 'window passed',
  held: 'on hold',
  paused: 'paused',
  failed_today: 'failed today',
  schedule_invalid: 'not runnable in a session',
  schedule_not_found: 'no such job',
}

/** The meta and `when` the job will have after `change`, checked as a heartbeat (`heartbeatMetaProblem`). */
function heartbeatProblemOf(change: ScheduleChangeT, base: ScheduleCardBase | null): string | null {
  if (change.op === 'delete') return null
  if (change.op === 'create')
    return heartbeatProblem(
      change.draft.meta,
      change.draft.when,
      change.draft.runner,
      change.draft.permissions,
      'claude',
    )
  const cur = base?.schedule
  // Switching a job off, or moving its result thread, never starts anything: a heartbeat that is already headless or restricted
  // must stay switch-off-able. Anything that keeps it enabled is judged in full.
  if (
    change.op === 'update' &&
    Object.entries(change.set).every(([k, v]) => k === 'thread_id' || (k === 'enabled' && v === false))
  )
    return null
  if (change.op === 'adopt') return heartbeatProblem(cur?.meta, cur?.when, cur?.runner, cur?.permissions, cur?.kind)
  const meta = change.set.meta === undefined ? cur?.meta : change.set.meta
  return heartbeatProblem(
    meta,
    change.set.when ?? cur?.when,
    change.set.runner ?? cur?.runner,
    change.set.permissions ?? cur?.permissions,
    cur?.kind,
  )
}

/**
 * The contract's check (`heartbeatMetaProblem`), plus one rule of the runner: a heartbeat is checked by THIS bridge, in the
 * live session. A job that runs headless, is restricted (always headless) or is a command would be started by Chronos with the
 * job's prompt: an agent run on every slot, which is what a heartbeat is there to avoid. Refused before any card exists.
 */
function heartbeatProblem(
  meta: unknown,
  when: { type?: string } | null | undefined,
  runner: string | undefined,
  permissions: string | undefined,
  kind: string | undefined,
): string | null {
  const p = heartbeatMetaProblem(meta, when)
  if (p) return p
  if (!heartbeatConfigFromMeta(meta)) return null
  if (runner !== 'session' || permissions === 'restricted' || kind === 'command')
    return 'A heartbeat has to run in the live session (runner "session", full permissions, a Claude job): any other kind would start the agent in the background on every slot. Nothing was saved.'
  return null
}

export class ScheduleService {
  readonly sidecar: Sidecar
  private readonly instances: InstanceRegistry
  private disc: Discovered | null = null
  private unansweredAt = 0
  private queueTail: Promise<unknown> = Promise.resolve()
  private started = false
  private stopped = false
  private timers: { refresh?: unknown; runner?: unknown; discover?: unknown } = {}
  private watchers: FSWatcher[] = []
  private watchKey = ''
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  private relayFeatures: string[] = []
  private lastGood: ScheduleSnapshotT | null = null
  private problem: Problem | null = null
  private statusSig: Map<string, string> | null = null
  private healthSig = ''
  private pendingAlerts: Array<{ kind: 'job_failed' | 'scheduler_stuck'; key: string }> = []
  private wasStuck = false
  private runNowAt = new Map<string, number>()
  private proposalAt: number[] = []
  private probing = false
  /** Heartbeat jobs with a run in flight: one at a time per job, and never awaited by the runner tick (S3.1 own queue). */
  private readonly hbRunning = new Set<string>()
  private readonly heartbeat: HeartbeatRunner

  constructor(
    private readonly ctx: BridgeContext,
    private readonly deps: ScheduleServiceDeps,
  ) {
    this.instances = new InstanceRegistry(join(ctx.paths.home, 'instances'))
    this.sidecar = new Sidecar(
      ctx.paths.home,
      () => this.gate(),
      (e) => this.log('schedules-meta.json not written; trying again next tick', { error: e.message }),
    )
    const seams = deps.heartbeat ?? {}
    this.heartbeat = new HeartbeatRunner({
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
      ...(seams.wake ? { wake: seams.wake } : {}),
      ...(seams.secondMs ? { secondMs: seams.secondMs } : {}),
      ...(seams.hooks ? { hooks: seams.hooks } : {}),
    })
  }

  // ---- gate, queue, clocks --------------------------------------------------------------------------------------

  /** S3.2: live mode, an authenticated relay socket, and not superseded. Checked at every tick and every write. */
  gate(): boolean {
    return this.ctx.mode === 'live' && !this.stopped && this.deps.connected()
  }

  private now() {
    return this.ctx.clock.now()
  }
  private iso(ms = this.now()) {
    return new Date(ms).toISOString()
  }

  /** The schedule queue: serial, and separate from the inbound chat queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(fn, fn)
    this.queueTail = run.catch(() => {})
    return run
  }

  /** Resolves when everything queued so far has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.queueTail.then(() => {})
  }

  private log(msg: string, f: Record<string, unknown> = {}) {
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

  private relaySupports(): boolean {
    return this.relayFeatures.includes(SCHEDULES_FEATURE)
  }

  /**
   * `schedules/2` (HEARTBEAT-SPEC 15, HB1): jobs with several fire times and jobs with `meta` travel to the app only when the
   * relay says it reads them. An older relay checks `schedule.detail` and card frames against the protocol it was built with,
   * and an older app reads a whole snapshot against its strict schema, so one such row would cost the whole frame.
   */
  private relaySupportsV2(): boolean {
    return this.relayFeatures.includes(SCHEDULES_FEATURE_V2)
  }

  /**
   * Whether THIS requester can read `schedules/2`: the relay has to carry it AND the app has to have said it reads it in the
   * request. The relay's feature list says what the relay does; only the app knows what the app parses.
   */
  private appCanRead(appReads: readonly string[] | undefined): boolean {
    return this.relaySupportsV2() && (appReads ?? []).includes(SCHEDULES_FEATURE_V2)
  }

  /** Words for a job the app can't be sent yet. */
  private static readonly NEEDS_V2 =
    'This job has several fire times or settings that need schedules/2. Update the relay and the app, then it shows here.'

  /** The snapshot as the app may have it: rows that need `schedules/2` become `unreadable` entries until the relay can carry them. */
  private forApp(snap: ScheduleSnapshotT, appReads: readonly string[] | undefined): ScheduleSnapshotT {
    if (this.appCanRead(appReads)) return snap
    const keep = snap.schedules.filter((s) => !needsSchedulesV2(s))
    if (keep.length === snap.schedules.length) return snap
    const held = snap.schedules
      .filter((s) => needsSchedulesV2(s))
      .map((s) => ({ id: s.id, unreadable: ScheduleService.NEEDS_V2 }))
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
      await this.ensure()
      if (this.stopped) return
      await this.failStuckCards()
      this.sidecar.prune(this.now())
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
    this.heartbeat.abortAll() // sources are killed by process group; a run that was in flight writes and posts nothing
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

  private get adapter(): SchedulerAdapter {
    if (!this.disc) throw new Error('scheduler not discovered')
    return this.disc.adapter
  }

  private onProblem(e: AdapterError) {
    if (e.kind === 'timeout') this.problem = { code: 'adapter_timeout', text: e.message, at: this.now() }
    else if (e.kind === 'parse') this.problem = { code: 'registry_unreadable', text: e.message, at: this.now() }
  }

  /** Whether Talos manages this registry: Chronos 0.3 with session_runner talos AND approval_required (S3.7). */
  private managed(snap: ScheduleSnapshotT | null = this.lastGood): boolean {
    if (this.disc?.state !== 'ready' || !snap) return false
    return !snap.health.issues.some((i) => i.code === 'session_runner_conflict')
  }

  // ---- snapshots ------------------------------------------------------------------------------------------------

  /** Never throws: a hung or unreadable scheduler is a snapshot with a health issue, from the last good one when we have it. */
  private async safeSnapshot(): Promise<ScheduleSnapshotT> {
    const d = await this.ensure()
    try {
      const snap = this.overlay(await d.adapter.snapshot())
      if (this.problem && (this.problem.code === 'adapter_timeout' || this.problem.code === 'registry_unreadable'))
        this.problem = null
      if (d.state === 'ready') this.lastGood = snap
      return snap
    } catch (e) {
      const err = e as AdapterError
      this.onProblem(err)
      return this.degraded(err)
    }
  }

  private degraded(err: AdapterError): ScheduleSnapshotT {
    const p = this.problem ?? { code: 'registry_unreadable' as const, text: err.message, at: this.now() }
    const base = this.lastGood
    const at = this.iso()
    const code = p.code
    const text =
      code === 'adapter_timeout'
        ? "The scheduler didn't answer in time."
        : `The scheduler's answer couldn't be read${err.path ? ` (at ${err.path})` : ''}.`
    const fix =
      code === 'adapter_timeout'
        ? "The scheduler's files may be in a protected or cloud-synced folder that isn't available."
        : "Fix jobs.json at the Mac or restore it from the scheduler's history."
    const issue: HealthIssueT = { ...issueFor(code, at, null, text), fix }
    const issues = [issue, ...(base?.health.issues ?? []).filter((i) => i.code !== code)].slice(0, 10)
    const health: SchedulerHealthT = {
      state: healthState(issues, base?.health.paused_all ?? false),
      adapter: base?.health.adapter ?? { id: 'chronos', version: null, api: 1 },
      tz: base?.health.tz ?? localZone(this.ctx.env),
      host_label: base?.health.host_label ?? hostLabel(),
      session_runner: base?.health.session_runner ?? 'unknown',
      paused_all: base?.health.paused_all ?? false,
      headless: base?.health.headless ?? 'unknown',
      tick_age_s: base?.health.tick_age_s ?? null,
      issues,
      checked_at: at,
    }
    return { protocol: 1, health, schedules: base?.schedules ?? [], unreadable: base?.unreadable ?? [], as_of: at }
  }

  /** Puts the summaries and late notes the bridge kept (Chronos stores none) onto each job's last run (S6.1). */
  private overlay(snap: ScheduleSnapshotT): ScheduleSnapshotT {
    return {
      ...snap,
      schedules: snap.schedules.map((s) => {
        const r = s.last_run
        if (!r) return s
        const n = (r.run_id ? this.sidecar.note(r.run_id) : undefined) ?? this.noteByDay(s.id, r.ds)
        if (!n) return s
        return {
          ...s,
          last_run: {
            ...r,
            // Chronos knows a session run only as ran/failed; the bridge knows why it failed (S3.3)
            ...(n.status && n.status !== 'running' && (r.status === 'failed' || r.status === 'ok')
              ? { status: n.status }
              : {}),
            ...(n.summary ? { summary: n.summary.slice(0, 280) } : {}),
            ...(n.late_note ? { late_note: n.late_note.slice(0, 280) } : {}),
            ...(n.report ? { has_report: true } : {}),
          },
        }
      }),
    }
  }

  private noteByDay(id: string, ds: string) {
    return this.sidecar.runsOf(id).find(([, n]) => n.ds === ds)?.[1]
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
    this.sendStatus(snap)
    return snap
  }

  private chronos(): ChronosAdapter | null {
    return this.disc?.chronos ?? null
  }

  private sendStatus(snap: ScheduleSnapshotT) {
    const sig = new Map(snap.schedules.map((s) => [s.id, `${s.etag}|${s.state_rev}`]))
    const healthSig = JSON.stringify([
      snap.health.state,
      snap.health.paused_all,
      snap.health.issues.map((i) => [i.code, i.schedule_id]),
    ])
    const stuck = snap.health.state === 'stuck'
    if (stuck && !this.wasStuck) {
      const code = snap.health.issues.find((i) => i.severity === 'error')?.code ?? 'stuck'
      this.pendingAlerts.push({ kind: 'scheduler_stuck', key: `stuck:${code}`.slice(0, 80) })
    }
    this.wasStuck = stuck
    if (this.statusSig === null) {
      // the first look is a baseline: the app asks for the list itself when it opens the tab
      this.statusSig = sig
      this.healthSig = healthSig
      this.pendingAlerts = this.pendingAlerts.filter((a) => a.kind === 'job_failed')
      if (!this.pendingAlerts.length) return
    }
    const changed: Array<{ id: string; etag: string; state_rev: string }> = []
    for (const s of snap.schedules)
      if (this.statusSig.get(s.id) !== `${s.etag}|${s.state_rev}`)
        changed.push({ id: s.id, etag: s.etag, state_rev: s.state_rev })
    const removed = [...this.statusSig.keys()].filter((id) => !sig.has(id))
    const alert = this.pendingAlerts.shift() ?? null
    if (!changed.length && !removed.length && !alert && healthSig === this.healthSig) return
    this.statusSig = sig
    this.healthSig = healthSig
    this.ctx.transport.sendEphemeral(
      scheduleStatusFrame(this.now(), {
        health: snap.health,
        changed: changed.slice(0, 200),
        removed: removed.slice(0, 200),
        alert,
      }),
    )
    if (this.pendingAlerts.length) void this.enqueue(async () => this.sendStatus(snap))
  }

  /** Failures and holds the bridge has not yet reported (S3.6, S6.3). Each is reported once per cause. */
  private async noticesFor(snap: ScheduleSnapshotT) {
    const cutoff = this.iso(this.now() - NOTICE_MAX_AGE_MS).slice(0, 10)
    for (const s of snap.schedules) {
      const r = s.last_run
      // `ds` is a run key (a date, or a slot like 2026-10-05T0945): its DATE is what ages out, never the whole string
      if (r && FAILURE_STATUSES.has(r.status) && dateOfRunKey(r.ds) >= cutoff) {
        const keys = failKeys(s.id, r.run_id, r.ds, r.status)
        if (!keys.some((k) => this.sidecar.wasNotified(k))) await this.reportFailure(s, r.status, r.ds, keys)
      }
      if (s.today === 'missed') {
        // One notice per job per DAY: with several fire times, each slot a closed session misses would otherwise say it again.
        const ds = dateOfRunKey(this.chronos()?.dayOf(s.id) ?? this.iso().slice(0, 10))
        const keys = failKeys(s.id, undefined, ds, 'missed')
        if (ds >= cutoff && !keys.some((k) => this.sidecar.wasNotified(k)))
          await this.reportFailure(s, 'missed', ds, keys)
      }
      if (s.today === 'held' && this.managed(snap)) await this.noticeHeld(s)
    }
  }

  /** Marks every key; false (and stop) on the first refused save, so the caller does not post a notice that noticesFor will repeat. */
  private markAll(keys: string[]): boolean {
    for (const k of keys) if (!this.sidecar.markNotified(k, this.now())) return false
    return true
  }

  private async reportFailure(s: ScheduleT, status: string, ds: string, keys: string[]) {
    if (!this.markAll(keys)) return
    await this.postFailure(s.id, s.name, status)
    this.pendingAlerts.push({ kind: 'job_failed', key: `${s.id}:${ds}`.slice(0, 80) })
  }

  /** A `system` row in the job's own thread (pin-notice path). */
  private async postFailure(jobId: string, name: string, status: string) {
    const why = FAILURE_WORDS[status] ?? status
    const text =
      status === 'missed'
        ? `Scheduled job "${safeLine(name)}" was missed: no session was running in its window. Open Schedules.`
        : `Scheduled job "${safeLine(name)}" didn't finish: ${why}. Open Schedules.`
    await postSystemNotice(this.ctx, text, { thread: this.threadOfJob(jobId) })
  }

  private threadOfJob(jobId: string) {
    const t = this.sidecar.threadOf(jobId)
    return t && this.ctx.config.thread(t) && !this.ctx.config.thread(t)?.archived
      ? threadRef(this.ctx, t)
      : defaultThreadRef(this.ctx)
  }

  /** The job's files changed outside the app: Chronos holds it. Tell the session once per version (S6.3). */
  private async noticeHeld(s: ScheduleT) {
    const key = `held|${s.id}|${s.content_hash}`
    if (this.sidecar.wasNotified(key)) return
    if (!this.sidecar.markNotified(key, this.now())) return
    const ts = this.iso()
    await this.ctx.emit(
      scheduleHeldNotification({
        thread: this.threadOfJob(s.id),
        jobId: s.id,
        at: ts,
        ts,
        id: `held-${s.id}-${s.content_hash.slice(7, 19)}`,
      }),
    )
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

  /** Asks Chronos which jobs a live session may take now (this also refreshes its session heartbeat), and offers them. */
  async runnerTick(): Promise<void> {
    if (!this.gate()) return
    this.sidecar.flush() // a write that failed or was refused earlier goes out now
    const d = await this.ensure()
    if (d.state !== 'ready') return
    // Start-up could not sweep when its first discovery went unanswered: finish that once discovery has recovered.
    if (!this.sweptOrphans) await this.sweepOrphans()
    if (!this.managed()) {
      if (!this.lastGood) await this.refresh()
      if (!this.managed()) return // no offers while Chronos's own timers could double-fire (S3.7)
    }
    let due: Awaited<ReturnType<SchedulerAdapter['dueForSession']>>
    try {
      due = await d.adapter.dueForSession()
    } catch (e) {
      this.onProblem(e as AdapterError)
      return
    }
    for (const j of due) {
      if (!this.gate()) return
      const prev = this.sidecar.offerFor(j.id, j.ds)
      if (prev && prev.instance === this.deps.instance) continue
      const claimed = prev && this.sidecar.inflightOf(prev.run_id)
      if (claimed && !claimed.closed) continue
      await this.offer(j.id, j.ds, j.fire_at, j.window_ends, 'clock', false)
    }
    await this.expireRuns()
  }

  /**
   * Records the offer in the sidecar FIRST, then sends one `schedule_run` notification (S3.3). Returns the run id, or why
   * the job could not be offered.
   */
  private async offer(
    id: string,
    ds: string | null,
    fireAt: string | null,
    windowEnds: string | null,
    trigger: 'clock' | 'run_now',
    again: boolean,
  ): Promise<{ ok: true; runId: string } | { ok: false; code: 'held' | 'schedule_invalid' | 'schedule_not_found' }> {
    const d = this.adapter
    const sp = await d.sessionPrompt(id)
    if (!sp.ok) {
      if (sp.code === 'held') await this.noticeHeldById(id)
      return { ok: false, code: sp.code }
    }
    // A heartbeat job never reaches the agent through here: its slot is a check the bridge runs itself (HEARTBEAT-SPEC 4). This is
    // the one place every route to a `schedule_run` notification passes (the clock, Run now, a re-offer after an edit).
    // Fail closed: if the job cannot be read, nobody can say it is not a heartbeat, so it is not offered to the agent either.
    let detail: Awaited<ReturnType<SchedulerAdapter['detail']>> | undefined
    try {
      detail = await d.detail(id, null)
    } catch (e) {
      this.log('job not readable at its slot; not offered', { job: id, error: (e as Error).message })
      await this.noticeUnreadableAtSlot(id, ds)
      return { ok: false, code: 'schedule_invalid' }
    }
    if (!detail) return { ok: false, code: 'schedule_not_found' }
    const hb = heartbeatConfigFromMeta(detail.detail.schedule.meta)
    if (hb) return this.startHeartbeat({ id, ds, fireAt, windowEnds, trigger, again, hb, contentHash: sp.contentHash })
    const snap = this.lastGood ?? (await this.safeSnapshot())
    const job = snap.schedules.find((s) => s.id === id)
    const runId = `r_${newUlid()}`
    const o: Offer = {
      id,
      ds: ds ?? '',
      run_id: runId,
      fire_at: fireAt,
      window_ends: windowEnds,
      trigger,
      again,
      content_hash: sp.contentHash,
      instance: this.deps.instance,
      at: this.now(),
    }
    if (!this.sidecar.recordOffer(o)) return { ok: false, code: 'schedule_invalid' }
    const ts = this.iso()
    await this.ctx.emit(
      scheduleRunNotification({
        thread: this.threadOfJob(id),
        runId,
        jobId: id,
        name: job?.name ?? id,
        ds: ds ?? undefined,
        fireAt: fireAt ?? undefined,
        windowEnds: windowEnds ?? undefined,
        guard: sp.guard,
        prompt: sp.prompt,
        ts,
      }),
    )
    return { ok: true, runId }
  }

  /**
   * A heartbeat slot: record the offer first (so the next tick does not start it again), then claim and run it in the
   * background. Returns at once; the run closes itself with `finish`, like a session run that reports done.
   */
  private startHeartbeat(a: {
    id: string
    ds: string | null
    fireAt: string | null
    windowEnds: string | null
    trigger: 'clock' | 'run_now'
    again: boolean
    hb: NonNullable<ReturnType<typeof heartbeatConfigFromMeta>>
    contentHash: string
  }): { ok: true; runId: string } | { ok: false; code: 'schedule_invalid' } {
    if (this.hbRunning.has(a.id)) return { ok: false, code: 'schedule_invalid' }
    const runId = `r_${newUlid()}`
    const o: Offer = {
      id: a.id,
      ds: a.ds ?? '',
      run_id: runId,
      fire_at: a.fireAt,
      window_ends: a.windowEnds,
      trigger: a.trigger,
      again: a.again,
      content_hash: a.contentHash,
      instance: this.deps.instance,
      at: this.now(),
    }
    if (!this.sidecar.recordOffer(o)) return { ok: false, code: 'schedule_invalid' }
    this.hbRunning.add(a.id)
    void this.heartbeatRun(a, runId)
      .catch((e) => this.log('heartbeat run failed', { job: a.id, error: (e as Error).message }))
      .finally(() => this.hbRunning.delete(a.id))
    return { ok: true, runId }
  }

  private async heartbeatRun(a: Parameters<ScheduleService['startHeartbeat']>[0], runId: string): Promise<void> {
    const claimed = await this.enqueue(async () => {
      if (this.stopped) return null
      const r = await this.adapter.claim(a.id, {
        runId,
        ds: a.trigger === 'run_now' ? null : a.ds,
        fireAt: a.fireAt,
        manual: a.trigger === 'run_now',
        again: a.again,
        bridgeInstance: this.deps.instance,
      })
      if (!r.ok) return null // another runner has it, or it is done: nothing to close
      this.sidecar.setInflight(runId, {
        id: a.id,
        ds: r.ds,
        fire_at: a.fireAt,
        instance: this.deps.instance,
        claimed_at: this.now(),
      })
      this.sidecar.setNote(
        runId,
        { id: a.id, ds: r.ds, status: 'running', trigger: a.trigger, started_at: this.iso() },
        this.now(),
      )
      return r
    })
    if (!claimed) return
    const name = this.lastGood?.schedules.find((s) => s.id === a.id)?.name ?? a.id
    const started = this.now()
    let out: RunOutput | null = null
    try {
      out = await this.heartbeat.run({
        jobId: a.id,
        jobName: safeLine(name),
        runKey: claimed.ds,
        config: 'config' in a.hb ? { config: a.hb.config, skipped: a.hb.skipped } : { problem: a.hb.problem },
        trigger: a.trigger,
      })
    } catch (e) {
      this.log('heartbeat run threw', { job: a.id, error: (e as Error).message })
    }
    if (out?.aborted) return // stopped mid-run: Chronos's claim is for the next bridge's orphan sweep, not for this one to close
    const status: 'ok' | 'failed' = out ? out.status : 'failed'
    const summary = out?.summary ?? 'Check failed'
    const report = out?.report ?? 'The heartbeat run stopped with an error before it could report.'
    await this.enqueue(async () => {
      if (this.stopped) return
      const r = await this.adapter.finish(a.id, { runId, status, report })
      if (!r.ok) return
      this.sidecar.closeInflight(runId, status)
      this.sidecar.setNote(
        runId,
        {
          id: a.id,
          ds: claimed.ds,
          status,
          summary: summary.slice(0, 280),
          report: excerptOf(report),
          finished_at: this.iso(),
          duration_s: Math.max(0, Math.round((this.now() - started) / 1000)),
          ...(out ? { heartbeat: out.result } : {}),
        },
        this.now(),
      )
      // The run said what failed in its own words; the generic "didn't finish" notice would repeat it. Without its own
      // line (the post itself failed), the generic notice is the only way the owner hears, so it is left to noticesFor.
      if (status === 'failed' && out?.said && this.markAll(failKeys(a.id, runId, claimed.ds, 'failed')))
        this.pendingAlerts.push({ kind: 'job_failed', key: `${a.id}:${claimed.ds}`.slice(0, 80) })
      await this.refresh()
    })
  }

  /** One plain line per job and slot when the job could not be read at its slot (it is tried again on the next tick). */
  private async noticeUnreadableAtSlot(id: string, ds: string | null) {
    const key = `unreadable|${id}|${ds ?? ''}`
    if (this.sidecar.wasNotified(key) || !this.sidecar.markNotified(key, this.now())) return
    const name = this.lastGood?.schedules.find((s) => s.id === id)?.name ?? id
    await postSystemNotice(
      this.ctx,
      `Scheduled job "${safeLine(name)}" couldn't be read at its time, so it was not started. It is tried again shortly.`,
      { thread: this.threadOfJob(id) },
    )
  }

  private async noticeHeldById(id: string) {
    const s = (this.lastGood ?? (await this.safeSnapshot())).schedules.find((x) => x.id === id)
    if (s) await this.noticeHeld(s)
  }

  /** N11: a claim left by an earlier bridge instance that is gone (even one that died between `GO` and its sidecar write) is finished. */
  private sweptOrphans = false
  private async sweepOrphans() {
    const d = this.disc
    if (d?.state !== 'ready' || !this.gate()) return
    let orphans: Awaited<ReturnType<SchedulerAdapter['orphanedSessionClaims']>>
    try {
      orphans = await d.adapter.orphanedSessionClaims(this.deps.instance)
    } catch (e) {
      this.onProblem(e as AdapterError)
      return
    }
    this.sweptOrphans = true
    this.instances.prune(this.now())
    for (const o of orphans) {
      // Close only a claim whose owner is provably gone. A live bridge (a second agent folder, a test, a restart overlap)
      // keeps its run; an owner we cannot tell about is left to Chronos's stale_claim_min.
      // Chronos 0.3.1 does not send bridge_instance; the sidecar remembers who claimed the run
      const owner = o.bridgeInstance || this.sidecar.inflightOf(o.runId)?.instance || ''
      if (this.instances.stateOf(owner) !== 'gone') continue
      await this.closeRun(o.id, o.ds, o.runId, 'session_ended', 'The session restarted mid-run.')
    }
    // runs the sidecar still calls open whose Chronos claim is already gone are closed in the note too
  }

  private limitsProblemLogged = false
  /** `timeout_min` and `stale_claim_min` from Chronos's config file; null when unusable (logged once). */
  private chronosLimits() {
    return readChronosLimits(this.ctx.env.chronosConfig, this.ctx.env.userHome, (msg) => {
      if (this.limitsProblemLogged) return
      this.limitsProblemLogged = true
      this.log(msg)
    })
  }

  /** No schedule_run_done within the time-out: finished as timed_out (S3.3). */
  private async expireRuns() {
    const now = this.now()
    const limit = runTimeoutMs(this.chronosLimits())
    for (const [runId, f] of Object.entries(this.sidecar.all.inflight)) {
      if (f.closed || f.instance !== this.deps.instance || now - f.claimed_at < limit) continue
      await this.closeRun(f.id, f.ds, runId, 'timed_out', 'The agent never reported back.')
    }
  }

  private async closeRun(id: string, ds: string, runId: string, status: 'timed_out' | 'session_ended', report: string) {
    const r = await this.adapter.finish(id, { runId, status, report })
    this.sidecar.closeInflight(runId, status)
    this.sidecar.setNote(runId, { id, ds, status }, this.now())
    if (!r.ok) return
    const name = (this.lastGood?.schedules.find((s) => s.id === id)?.name ?? id) as string
    // A refused mark means noticesFor reports it on reconnect: posting now as well would say it twice.
    if (this.markAll(failKeys(id, runId, ds, status))) {
      await this.postFailure(id, name, status)
      this.pendingAlerts.push({ kind: 'job_failed', key: `${id}:${ds}`.slice(0, 80) })
    }
    await this.refresh()
  }

  // ---- the agent's run tools (S6.1) -----------------------------------------------------------------------------

  toolRunStart(runId: string): Promise<ToolOut> {
    return this.enqueue(async () => {
      const d = await this.ensure()
      if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
      const known = this.sidecar.offerByRun(runId) ?? this.sidecar.inflightOf(runId)
      const job = this.sidecar.jobOfRun(runId)
      if (!known || !job) return fail(`unknown run ${runId}: it was not offered by this bridge`)
      // A run id is good for ONE claim: replaying it (say, an hour after a Run now tap) must not re-run the job (review R5/R6)
      const used = this.sidecar.inflightOf(runId)
      if (used) return yes(used.closed ? 'SKIP: already done' : 'SKIP: running elsewhere')
      const offer = this.sidecar.offerByRun(runId)
      // Read the approved text AT START, not what the notification carried: if the owner approved new instructions since,
      // the notification's text is no longer approved. Refuse, and offer the job again with the current text (review R4).
      const sp = await d.adapter.sessionPrompt(job.id)
      if (!sp.ok) {
        if (sp.code === 'held') await this.noticeHeldById(job.id)
        return yes(sp.code === 'held' ? 'SKIP: on hold' : 'SKIP: not runnable in a session')
      }
      if (offer?.content_hash && sp.contentHash !== offer.content_hash) {
        await this.offer(job.id, offer.ds || null, offer.fire_at, offer.window_ends, offer.trigger, offer.again)
        return yes(
          'SKIP: its instructions changed since this was offered; a new run was offered with the approved text',
        )
      }
      const r = await d.adapter.claim(job.id, {
        runId,
        // Run now: Chronos picks the job's own date_key (ds: null); the offer's ds is only what the notification showed
        ds: offer && offer.trigger !== 'run_now' && offer.ds ? offer.ds : null,
        fireAt: offer?.fire_at ?? null,
        manual: offer?.trigger === 'run_now',
        again: offer?.again ?? false,
        bridgeInstance: this.deps.instance,
      })
      if (!r.ok) return yes(`SKIP: ${SKIP_WORDS[r.reason] ?? r.reason}`)
      // Past this point Chronos holds the claim and its owner file names this instance; the sidecar mirrors it (N11).
      this.sidecar.setInflight(runId, {
        id: job.id,
        ds: r.ds,
        fire_at: offer?.fire_at ?? null,
        instance: this.deps.instance,
        claimed_at: this.now(),
      })
      this.sidecar.setNote(
        runId,
        { id: job.id, ds: r.ds, status: 'running', trigger: offer?.trigger ?? 'clock', started_at: this.iso() },
        this.now(),
      )
      await this.refresh()
      return yes('GO')
    })
  }

  toolRunDone(a: { runId: string; ok: boolean; summary: string; report?: string }): Promise<ToolOut> {
    return this.enqueue(async () => {
      const d = await this.ensure()
      if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
      const job = this.sidecar.jobOfRun(a.runId)
      if (!job) return yes('not yours: no such run on this bridge')
      const status: 'ok' | 'failed' = a.ok ? 'ok' : 'failed'
      const report = (a.report ?? a.summary).slice(0, 64 * 1024)
      const r = await d.adapter.finish(job.id, { runId: a.runId, status, report })
      const excerpt = excerptOf(a.report ?? a.summary)
      if (!r.ok) {
        if (r.reason === 'late') {
          this.sidecar.setNote(
            a.runId,
            { id: job.id, ds: this.sidecar.note(a.runId)?.ds ?? job.ds, late_note: a.summary.slice(0, 280) },
            this.now(),
          )
          return yes('late: noted on the closed run')
        }
        return yes('not yours: this run belongs to another session or is not running')
      }
      const note = this.sidecar.note(a.runId)
      const started = note ? Date.parse(note.started_at) : this.now()
      this.sidecar.closeInflight(a.runId, status)
      this.sidecar.setNote(
        a.runId,
        {
          id: job.id,
          // the key Chronos answered the claim with (a Run now on a times job: an ad-hoc minute), never one rebuilt from the offer
          ds: note?.ds ?? job.ds,
          status,
          summary: a.summary.slice(0, 280),
          report: excerpt,
          finished_at: this.iso(),
          duration_s: Math.max(0, Math.round((this.now() - started) / 1000)),
        },
        this.now(),
      )
      if (!a.ok) {
        const name = this.lastGood?.schedules.find((s) => s.id === job.id)?.name ?? job.id
        if (this.markAll(failKeys(job.id, a.runId, job.ds, 'failed'))) {
          await this.postFailure(job.id, name, 'failed')
          this.pendingAlerts.push({ kind: 'job_failed', key: `${job.id}:${job.ds}`.slice(0, 80) })
        }
      }
      await this.refresh()
      return yes('recorded')
    })
  }

  // ---- the agent's list and propose tools ------------------------------------------------------------------------

  toolList(id?: string): Promise<ToolOut> {
    return this.enqueue(async () => {
      const d = await this.ensure()
      if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
      if (id) {
        const x = await d.adapter.detail(id, null)
        if (!x) return fail(`no scheduled job "${id}"`)
        return yes(detailText(this.withRuns(x.detail)))
      }
      return yes(listText(await this.safeSnapshot()))
    })
  }

  /** The agent's proposal: validate, then mint a card (S6.1). It never writes the registry. */
  toolPropose(args: Record<string, unknown>): Promise<ToolOut> {
    return this.enqueue(async () => {
      const d = await this.ensure()
      if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
      if (!this.relaySupports())
        return fail(
          "The relay doesn't support Schedules yet. Ask the owner to update the relay first; nothing was proposed.",
        )
      const snap = this.lastGood ?? (await this.safeSnapshot())
      if (!this.managed(snap))
        return fail(
          'Talos does not manage this scheduler yet. Tell the owner to run `talos-app schedules adopt` at the Mac.',
        )
      const now = this.now()
      this.proposalAt = this.proposalAt.filter((t) => now - t < 3600_000)
      if (this.proposalAt.length >= PROPOSALS_PER_HOUR)
        return fail(`At most ${PROPOSALS_PER_HOUR} proposals an hour. Ask the owner what they want and propose once.`)
      const pending = this.ctx.ledger
        .list('pending')
        .filter((r) => r.actor === 'bridge' && r.binding.kind === 'schedule')
      if (pending.length >= MAX_PENDING_SCHEDULE_CARDS)
        return fail(
          `There are already ${MAX_PENDING_SCHEDULE_CARDS} schedule cards waiting for the owner. Wait for them.`,
        )
      const built = await this.changeFromArgs(args)
      if (!built.ok) return fail(built.error)
      if (changeNeedsSchedulesV2(built.change) && !this.relaySupportsV2())
        return fail(
          "The relay doesn't support schedules/2 yet (several fire times, meta). Ask the owner to update the relay first; nothing was proposed.",
        )
      const origin = this.agentOrigin(built.threadId)
      const minted = await this.prepareCard(built.change, {
        proposedBy: 'agent',
        threadId: built.threadId,
        origin,
        clientRef: null,
        reason: built.reason,
        ...(built.supersedes ? { supersedes: built.supersedes } : {}),
      })
      if (!minted.ok) return fail(minted.error)
      this.proposalAt.push(now)
      await this.publishCard(minted.card)
      return yes(`card ${minted.card.id} pending, expires ${minted.card.expires_at}`)
    })
  }

  /**
   * 'chat' when the owner spoke in that thread a moment ago (the proposal answers them), else 'background' (S8.2).
   * Two kinds of owner row are NOT the owner speaking: a token share (via 'share') and a signed share sent with no note
   * (shared material only; docs/V2-FEATURES.md V4.7, "the only owner words are a typed note"). And the agent chooses the
   * thread it proposes into, so the owner's words in `general` must not vouch for a proposal an untrusted share in `inbox`
   * steered: if a share-only row arrived in ANOTHER thread after the owner's last words, the proposal is 'background'.
   */
  private agentOrigin(threadId: string): 'chat' | 'background' {
    const now = this.now()
    const rows = this.ctx.store.ownerRowsSince(new Date(now - OWNER_SPOKE_MS).toISOString(), 200)
    const shareOnly = (m: MessageT) => m.via === 'share' || (m.share_content !== undefined && !(m.text ?? '').trim())
    let spoke = -Infinity
    for (const m of rows) {
      if (m.thread_id !== threadId || shareOnly(m)) continue
      const t = Date.parse(m.created_at)
      if (now - t < OWNER_SPOKE_MS && t > spoke) spoke = t
    }
    if (spoke === -Infinity) return 'background'
    // A hand-off between sessions after the owner's words is not the owner speaking
    if (handoffSince(this.ctx.store.db, spoke, now)) return 'background'
    // Only a share in ANOTHER thread counts: the agent proposing into the thread where the owner spoke is answering them
    // (a share landing in that same thread was judged earlier, review-share-p1, and stays a chat card).
    return rows.some((m) => m.thread_id !== threadId && shareOnly(m) && Date.parse(m.created_at) > spoke)
      ? 'background'
      : 'chat'
  }

  private async changeFromArgs(
    a: Record<string, unknown>,
  ): Promise<
    | { ok: true; change: ScheduleChangeT; threadId: string; reason: string; supersedes?: string }
    | { ok: false; error: string }
  > {
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
    const op = str('op')
    const threadId = str('thread_id') ?? str('chat_id')
    if (!threadId || !this.ctx.config.thread(threadId))
      return {
        ok: false,
        error: `Unknown thread "${threadId ?? ''}". Valid thread ids: ${this.ctx.config.threadIds().join(', ')}`,
      }
    const reason = (str('reason') ?? '').slice(0, 280)
    if (!reason)
      return { ok: false, error: 'reason is required (up to 280 characters): say why you are proposing this' }
    const supersedes = str('supersedes')
    if (supersedes !== undefined) {
      const old = this.ctx.ledger.get(supersedes)
      const mine = ScheduleCardPayload.safeParse(old?.binding.payload)
      if (old?.actor !== 'bridge' || old.state !== 'pending' || !mine.success || mine.data.proposed_by !== 'agent')
        return { ok: false, error: 'supersedes can only replace one of your own pending schedule proposals' }
    }
    const resultThread = str('result_thread_id')
    if (resultThread !== undefined && !this.ctx.config.thread(resultThread))
      return {
        ok: false,
        error: `Unknown result_thread_id "${resultThread}". Valid thread ids: ${this.ctx.config.threadIds().join(', ')}`,
      }
    const extra = { threadId, reason, ...(supersedes ? { supersedes } : {}) }
    const slug = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
    if (op === 'create') {
      const name = str('name')
      const id = str('id') ?? (name ? slug(name) : undefined)
      const draft = {
        id,
        name,
        description: str('description') ?? '',
        when: a.when,
        catchup_min: typeof a.catchup_min === 'number' ? a.catchup_min : 180,
        enabled: typeof a.enabled === 'boolean' ? a.enabled : true,
        runner: str('runner') ?? 'session',
        permissions: str('permissions') ?? 'full',
        allowed_tools: Array.isArray(a.allowed_tools) ? a.allowed_tools : [],
        model: a.model === undefined ? null : a.model,
        notify: str('notify') ?? 'failure',
        thread_id: resultThread ?? null,
        prompt: str('prompt'),
        ...(a.meta !== undefined ? { meta: a.meta } : {}),
      }
      const parsed = ScheduleChange.safeParse({ op: 'create', draft })
      if (!parsed.success) return { ok: false, error: zodText(parsed.error) }
      return { ok: true, change: parsed.data, ...extra }
    }
    if (op === 'update' || op === 'delete') {
      const id = str('id')
      if (!id) return { ok: false, error: `id is required for ${op}` }
      const x = await this.adapter.detail(id, null)
      if (!x) return { ok: false, error: `schedule_not_found: no scheduled job "${id}"` }
      const etag = x.detail.schedule.etag
      if (op === 'delete') return { ok: true, change: { op: 'delete', id, base_etag: etag }, ...extra }
      const set: Record<string, unknown> = {}
      for (const k of [
        'name',
        'description',
        'when',
        'catchup_min',
        'enabled',
        'runner',
        'permissions',
        'allowed_tools',
        'model',
        'notify',
        'prompt',
        'meta',
      ])
        if (a[k] !== undefined) set[k] = a[k]
      if (resultThread !== undefined) set.thread_id = resultThread
      const parsed = ScheduleChange.safeParse({ op: 'update', id, base_etag: etag, set })
      if (!parsed.success) return { ok: false, error: zodText(parsed.error) }
      return { ok: true, change: parsed.data, ...extra }
    }
    return { ok: false, error: 'op must be create, update or delete' }
  }

  // ---- cards ------------------------------------------------------------------------------------------------------

  /** R1-8: what the installed Chronos said it can do (`version.features`). Null = fine, else the words for the owner. */
  private tooOldFor(change: ScheduleChangeT): string | null {
    const c = this.chronos()
    if (!c) return null
    const times =
      change.op === 'create'
        ? change.draft.when.type === 'times'
        : change.op === 'update' && change.set.when?.type === 'times'
    const meta =
      change.op === 'create' ? change.draft.meta !== undefined : change.op === 'update' && change.set.meta !== undefined
    if (times && !c.hasFeature('times')) return 'your Chronos is too old for several times a day; update Chronos'
    if (meta && !c.hasFeature('meta')) return 'your Chronos is too old for meta; update Chronos'
    return null
  }

  /** The current job as ONE `detail` call returns it: what a card must show and bind (review F4). */
  private async baseOf(id: string): Promise<{ base: ScheduleCardBase; detail: ScheduleDetailT } | null> {
    const x = await this.adapter.detail(id, null)
    if (!x) return null
    return { base: { schedule: x.detail.schedule, prompt: x.detail.prompt, guard: x.detail.guard }, detail: x.detail }
  }

  /**
   * validate -> compose -> ledger. Returns the card (not yet sent) or why not. The ledger row is `actor='bridge'`: only
   * those rows are ever applied by the bridge (S3.4).
   */
  async prepareCard(
    change: ScheduleChangeT,
    o: {
      proposedBy: 'agent' | 'owner_form'
      threadId: string
      origin: 'chat' | 'background'
      clientRef: string | null
      reason?: string
      supersedes?: string
    },
  ): Promise<
    | { ok: true; card: CardT }
    | { ok: false; error: string; code?: ErrorCodeT; fields?: Array<{ path: string; message: string }> }
  > {
    const old = this.tooOldFor(change)
    if (old)
      return {
        ok: false,
        error: old,
        code: 'schedule_invalid',
        fields: [{ path: old.includes('meta') ? 'meta' : 'when', message: old }],
      }
    const split = toChronosChange(change)
    if (change.op === 'create' && change.draft.thread_id && !this.ctx.config.thread(change.draft.thread_id))
      return {
        ok: false,
        error: 'unknown thread',
        code: 'schedule_invalid',
        fields: [{ path: 'draft.thread_id', message: `unknown thread ${change.draft.thread_id}` }],
      }
    let base: ScheduleCardBase | null = null
    let nextRuns: string[] = []
    let approved: ScheduleApproved | null = null
    if (change.op !== 'create') {
      const b = await this.baseOf(change.id)
      if (!b) return { ok: false, error: `no scheduled job "${change.id}"`, code: 'schedule_not_found' }
      base = b.base
      nextRuns = b.detail.next_runs
      if ((change.op === 'update' || change.op === 'delete') && base.schedule.etag !== change.base_etag)
        return { ok: false, error: 'The job changed on your Mac. Reload it and try again.', code: 'schedule_conflict' }
      if (change.op === 'adopt') {
        if (base.schedule.content_hash !== change.content_hash)
          return {
            ok: false,
            error: 'The job changed on your Mac again. Reload it and try again.',
            code: 'schedule_conflict',
          }
        const ap = await this.adapter.approved(change.id)
        approved = ap ? { prompt: ap.prompt, guard: ap.guard } : null
      }
    }
    // A heartbeat in the meta has to be one this Talos reads in full, on a job that fires at several times a day. This is the
    // one place the agent's propose tool, the owner's schedule.patch frame and an adopt all pass through, so no card ever
    // offers an unreadable or unknown-kind heartbeat for approval (HB1b).
    const hbProblem = heartbeatProblemOf(change, base)
    if (hbProblem)
      return { ok: false, error: hbProblem, code: 'schedule_invalid', fields: [{ path: 'meta', message: hbProblem }] }
    // Only the result thread changes (a Talos-only field): Chronos has nothing to validate or write, and refuses an empty change.
    const threadOnly = isThreadOnly(split)
    if (change.op === 'update' && change.set.thread_id && !this.ctx.config.thread(change.set.thread_id))
      return {
        ok: false,
        error: 'unknown thread',
        code: 'schedule_invalid',
        fields: [{ path: 'set.thread_id', message: `unknown thread ${change.set.thread_id}` }],
      }
    const v: ValidateResult =
      threadOnly && base
        ? {
            ok: true,
            normalized: split.chronos,
            preview: {
              when_text: base.schedule.when_text.slice(0, 120),
              next_runs: nextRuns,
              tz: this.lastGood?.health.tz ?? localZone(this.ctx.env),
            },
            expectedEtag: base.schedule.etag,
          }
        : await this.adapter.validate(split.chronos)
    if (!v.ok) {
      const text = v.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')
      return { ok: false, error: `${v.code}: ${text}`, code: v.code, fields: v.errors }
    }
    const final = fromChronosChange(v.normalized, split.threadId)
    const now = this.iso()
    let card: CardT
    try {
      card = composeScheduleCard(final, v.preview, approved, {
        cardId: `c_${newUlid()}`,
        threadId: o.threadId,
        now,
        origin: o.origin,
        proposedBy: o.proposedBy,
        agentName: this.ctx.config.config.agent.name,
        expectedEtag: v.expectedEtag,
        clientRef: o.clientRef,
        threadName: (t) =>
          t
            ? (this.ctx.config.thread(t)?.name ?? t)
            : (this.ctx.config.thread(this.ctx.config.config.default_thread)?.name ?? 'Default'),
        base,
        ...(trustOn(this.ctx.config.config) ? { trust: true } : {}),
        ...(o.reason ? { reason: o.reason } : {}),
        ...(o.supersedes ? { supersedes: o.supersedes } : {}),
      })
    } catch (e) {
      if (e instanceof ScheduleCardBindingError) return { ok: false, error: e.message, code: 'schedule_conflict' }
      throw e
    }
    try {
      assertFrameFits(cardCreateFrame(this.now(), card))
    } catch (e) {
      return { ok: false, error: (e as Error).message, code: 'too_large' }
    }
    this.ctx.ledger.create(card, 'bridge')
    return { ok: true, card }
  }

  /** Sends card.create (the ledger row exists first, so a resolve can never beat it). */
  async publishCard(card: CardT) {
    const { ctx } = this
    try {
      await ctx.transport.sendDurable(cardCreateFrame(this.now(), card))
    } catch (e) {
      if (e instanceof RelayRejectedError) {
        ctx.ledger.expire(card.id)
        ctx.expiry?.cancel(card.id)
      }
      throw e
    }
    if (card.supersedes && ctx.ledger.supersede(card.supersedes)) {
      ctx.expiry?.cancel(card.supersedes)
      ctx.transport
        .sendDurable(
          cardUpdateFrame(this.now(), { card_id: card.supersedes, state: 'superseded', reason: 'superseded' }),
        )
        .catch((e) => this.log('card.update not sent', { error: (e as Error).message }))
    }
    ctx.expiry?.sync()
  }

  /** The owner pressed a button on a bridge-owned card (inbound has run the SPEC 4.5 checks). */
  onCardResolved(
    row: LedgerRow,
    action: 'primary' | 'kill' | 'revise',
    approved: CardBinding,
    cardId: string,
    note?: string,
  ) {
    const payload = ScheduleCardPayload.safeParse(approved.payload)
    const byAgent = payload.success && payload.data.proposed_by === 'agent'
    if (action !== 'primary') {
      if (byAgent) {
        // KILL and REVISE reach the agent like any card, with the owner's note: REVISE is how they steer a proposal (S8.2)
        void this.ctx.emit(
          cardActionNotification({
            thread: threadRef(this.ctx, row.thread_id),
            card: { id: cardId, title: row.binding.title, primary_label: row.binding.primary_label },
            action,
            ts: this.iso(),
            note,
            clock: localClock(this.ctx, this.iso()),
          }),
        )
      }
      return
    }
    void this.enqueue(() => this.applyCard(row, approved, cardId)).catch((e) =>
      this.log('schedule apply failed', { card: cardId, error: (e as Error).message }),
    )
  }

  /** S3.4: split, write under Chronos's lock, check the etag, write the sidecar, report. */
  private async applyCard(row: LedgerRow, approved: CardBinding, cardId: string) {
    let ended = false
    const finish = async (ok: boolean, text: string) => {
      ended = true
      await this.endCard(row, cardId, ok, text)
    }
    try {
      await this.applyCardInner(approved, finish)
    } catch (e) {
      this.log('schedule apply failed', { card: cardId, error: (e as Error).message })
      // A slow, killed or unreadable Chronos write must still END the card. Chronos may have written before it was cut off,
      // so the text says "check it", not "nothing saved" (review R1).
      if (!ended)
        await finish(
          false,
          "The scheduler didn't answer in time, so this may or may not have been saved. Check it in Schedules, then ask again.",
        )
    }
  }

  /** The card's last word: ledger, card.update, a refresh, and the agent told. Only the bridge's own write path calls it. */
  private async endCard(row: LedgerRow, cardId: string, ok: boolean, text: string) {
    const { ctx } = this
    ctx.ledger.finish(cardId, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(this.now(), {
          card_id: cardId,
          state: ok ? 'done' : 'failed',
          result: { ok, text, at: this.iso() },
        }),
      )
      .catch((e) => this.log('card.update not sent', { error: (e as Error).message }))
    this.chronos()?.invalidate()
    await this.refresh().catch(() => {})
    await ctx
      .emit(
        systemNotification({
          thread: threadRef(ctx, row.thread_id),
          text: `Card ${cardId} → PRIMARY. The bridge applied it: ${text} Nothing for you to do.`,
          ts: this.iso(),
          id: `${cardId}-applied`,
        }),
      )
      .catch(() => {})
  }

  private async applyCardInner(approved: CardBinding, finish: (ok: boolean, text: string) => Promise<void>) {
    const { ctx } = this
    const cardId = approved.id
    const p = ScheduleCardPayload.safeParse(approved.payload)
    if (!p.success) return finish(false, 'The card could not be read. Nothing was saved. Ask again.')
    // Fail closed (S3.7): a card drawn while Talos managed the registry must not write once Chronos stopped enforcing approval
    this.chronos()?.invalidate()
    if (!this.managed(await this.safeSnapshot()))
      return finish(
        false,
        'Talos no longer manages this scheduler (approval is off at the Mac). Nothing was saved. Run `talos-app schedules adopt` at the Mac, then ask again.',
      )
    const { change, expected_etag: expected, preview } = p.data
    const split = toChronosChange(change)
    const d = await this.ensure()
    if (d.state !== 'ready') return finish(false, 'The scheduler is not available. Nothing was saved. Ask again.')
    let r: ApplyResult
    if (isThreadOnly(split) && change.op === 'update') {
      // nothing for Chronos to write: confirm the job is still the revision the card showed, then only the sidecar changes
      const x = await d.adapter.detail(change.id, null)
      r = !x
        ? { ok: false, code: 'schedule_not_found', message: 'gone' }
        : x.detail.schedule.etag !== change.base_etag
          ? { ok: false, code: 'schedule_conflict', message: 'moved' }
          : { ok: true, etag: x.detail.schedule.etag }
    } else r = await d.adapter.apply(split.chronos as ChronosChangeT, expected)
    if (!r.ok) {
      const text: Record<string, string> = {
        schedule_conflict: 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
        schedule_invalid: 'The scheduler no longer accepts this change as drawn. Nothing was saved. Ask again.',
        held: 'The job is on hold because its files changed outside the app. Nothing was saved. Review it in Schedules.',
        schedule_not_found: 'The job no longer exists. Nothing was saved.',
      }
      return finish(false, text[r.code] ?? 'Nothing was saved. Ask again.')
    }
    if (r.etag !== expected) {
      // Chronos wrote under its own lock, so the record is whatever it wrote: report it, never trust it.
      ctx.log.security('schedule apply produced an unexpected etag', {
        card_id: cardId,
        job: 'id' in change ? change.id : change.draft.id,
      })
      return finish(false, 'The job was written, but not as the card showed. Check it in Schedules.')
    }
    const id = change.op === 'create' ? change.draft.id : change.id
    let sideErr = ''
    try {
      if (change.op === 'delete') this.sidecar.forgetJob(id)
      else if (split.threadId.set) {
        if (!this.sidecar.setThread(id, split.threadId.value)) sideErr = 'the bridge was not live'
      }
    } catch (e) {
      sideErr = (e as Error).message
    }
    let text: string
    if (change.op === 'delete') text = 'Deleted.'
    else {
      const x = await d.adapter.detail(id, null).catch(() => null)
      const next = x?.detail.next_runs[0] ?? preview.next_runs[0]
      const tz = x ? (this.lastGood?.health.tz ?? preview.tz) : preview.tz
      text = change.op === 'adopt' ? 'Approved as it is on disk.' : 'Saved.'
      if (next) text += ` Next run ${shortWhen(next, tz)}.`
    }
    if (sideErr) text = `${text.replace(/\.$/, '')}. Result thread not set (${sideErr}).`
    return finish(true, text)
  }

  /** A restart can leave an approved card between "resolved" and "done"; it must not hang there. */
  private async failStuckCards() {
    if (this.stopped) return
    for (const row of this.ctx.ledger.list('resolved')) {
      if (row.actor !== 'bridge' || row.resolution?.action !== 'primary') continue
      if (this.ctx.apps?.isRunning(row.id)) continue // an app card whose tool this process is running right now
      if (row.binding.kind === 'config') continue // a settings card: ConfigProposals.recover() reads the config and says what is true
      if (!this.ctx.ledger.finish(row.id, false)) continue // closed by someone else meanwhile: say nothing more
      await this.ctx.transport
        .sendDurable(
          cardUpdateFrame(this.now(), {
            card_id: row.id,
            state: 'failed',
            result: {
              ok: false,
              text:
                row.binding.kind === 'app_action'
                  ? 'The bridge restarted before this finished. It may not have run. Check before asking again.'
                  : 'The bridge restarted before this was saved. Check it in Schedules, then ask again.',
              ...(row.binding.kind === 'app_action' ? { ran: 'unknown' as const } : {}),
              at: this.iso(),
            },
          }),
        )
        .catch(() => {})
    }
  }

  // ---- owner frames (S2.2) --------------------------------------------------------------------------------------

  /** One verified owner schedule frame. Never throws; every path answers ack{ref} or error{ref}. */
  handleOwnerFrame(f: Frame): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.dispatch(f)
      } catch (e) {
        this.log('schedule frame failed', { type: f.type, error: (e as Error).message })
        this.err('scheduler_unavailable', 'The scheduler could not do that.', f.id)
      }
    })
  }

  private err(code: ErrorCodeT, message: string, ref: string, fields?: Array<{ path: string; message: string }>) {
    this.ctx.transport.sendEphemeral(errorFrame(this.now(), code, message, ref, fields))
  }
  private ack(ref: string) {
    this.ctx.transport.sendEphemeral(scheduleAckFrame(this.now(), ref))
  }

  private stale(f: Frame): boolean {
    return Math.abs(this.now() - Date.parse(f.ts)) > STALE_MS
  }

  private async dispatch(f: Frame) {
    const d = await this.ensure()
    switch (f.type) {
      case 'schedules.list': {
        this.ack(f.id)
        const snap = this.forApp(await this.safeSnapshot(), f.app_features)
        this.ctx.transport.sendEphemeral(schedulesSnapshotFrame(this.now(), f.request_id, snap))
        return
      }
      case 'schedule.get':
        return this.onGet(f, d)
      case 'schedule.patch':
        return this.onPatch(f, d)
      case 'schedule.run_now':
        return this.onRunNow(f, d)
      case 'schedule.control':
        return this.onControl(f, d)
      default:
        return this.err('bad_frame', `unexpected ${f.type}`, f.id)
    }
  }

  private async onGet(f: Of<'schedule.get'>, d: Discovered) {
    const x = d.state === 'ready' ? await d.adapter.detail(f.schedule_id, f.report_run_id) : null
    if (!x) return this.err('schedule_not_found', `No scheduled job "${f.schedule_id}".`, f.id)
    if (needsSchedulesV2(x.detail.schedule) && !this.appCanRead(f.app_features))
      return this.err(
        'scheduler_unavailable',
        `${ScheduleService.NEEDS_V2} (the relay and the app both need schedules/2)`,
        f.id,
      )
    const detail = this.withRuns(x.detail)
    let report: { run_id: string; text: string } | null = null
    if (f.report_run_id) {
      const n = this.sidecar.note(f.report_run_id)
      if (n?.report && n.id === f.schedule_id) report = { run_id: f.report_run_id, text: n.report }
    }
    this.ack(f.id)
    this.ctx.transport.sendEphemeral(scheduleDetailFrame(this.now(), f.request_id, detail, report))
  }

  /** `detail.runs` (Chronos 0.3.0 leaves it empty): the session runs the bridge kept, newest first. */
  private withRuns(detail: ScheduleDetailT): ScheduleDetailT {
    const kept: ScheduleRunT[] = this.sidecar
      .runsOf(detail.schedule.id)
      .slice(0, 10)
      .flatMap(([run_id, n]): ScheduleRunT[] =>
        n.status === undefined
          ? []
          : [
              {
                run_id,
                ds: n.ds,
                started_at: n.started_at,
                runner: 'session',
                trigger: n.trigger,
                status: n.status,
                ...(n.duration_s !== undefined ? { duration_s: n.duration_s } : {}),
                ...(n.summary ? { summary: n.summary.slice(0, 280) } : {}),
                ...(n.late_note ? { late_note: n.late_note.slice(0, 280) } : {}),
                has_report: Boolean(n.report),
              },
            ],
      )
    const seen = new Set(kept.map((r) => r.run_id))
    const runs = [...kept, ...detail.runs.filter((r) => !r.run_id || !seen.has(r.run_id))]
      .filter((r): r is ScheduleRunT => Boolean(r.run_id && r.started_at && r.runner && r.trigger))
      .slice(0, 10)
    return { ...detail, runs: runs as ScheduleDetailT['runs'] }
  }

  private readOnly(d: Discovered, snap: ScheduleSnapshotT | null): string | null {
    if (d.state !== 'ready') return (d.adapter as ClosedAdapter).agentText()
    if (!this.managed(snap))
      return 'Talos does not manage this scheduler yet. At the Mac run `talos-app schedules adopt`, then restart your session.'
    return null
  }

  private async onPatch(f: Of<'schedule.patch'>, d: Discovered) {
    if (d.state !== 'ready') return this.err('scheduler_unavailable', (d.adapter as ClosedAdapter).agentText(), f.id)
    const snap = this.lastGood ?? (await this.safeSnapshot())
    const ro = this.readOnly(d, snap)
    if (ro) return this.err('schedule_read_only', ro, f.id)
    if (!this.relaySupports())
      return this.err('scheduler_unavailable', "The relay doesn't support Schedules yet; update the relay first.", f.id)
    if (!this.ctx.config.thread(f.thread_id)) return this.err('bad_frame', `unknown thread ${f.thread_id}`, f.id)
    if (changeNeedsSchedulesV2(f.change) && !this.relaySupportsV2())
      return this.err(
        'scheduler_unavailable',
        "The relay doesn't support schedules/2 yet; update the relay first.",
        f.id,
      )
    const minted = await this.prepareCard(f.change, {
      proposedBy: 'owner_form',
      threadId: f.thread_id,
      origin: 'chat',
      clientRef: f.id,
    })
    if (!minted.ok) return this.err(minted.code ?? 'schedule_invalid', minted.error, f.id, minted.fields)
    this.ack(f.id)
    await this.publishCard(minted.card)
  }

  /**
   * The date a Run now offer shows: the job's own `once` date, else today's date in the scheduler's zone. Display only: the
   * claim passes ds:null, so Chronos's date_key decides what is actually claimed (S3.3 N12).
   */
  private runNowDay(job: ScheduleT): string {
    if (job.when.type === 'once') return job.when.at.slice(0, 10)
    const tz = this.lastGood?.health.tz ?? localZone(this.ctx.env)
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(this.now()))
  }

  /** Run now (S3.3 "Run now in the session", S8.3): bounded by the claim, never a card. */
  private async onRunNow(f: Of<'schedule.run_now'>, d: Discovered) {
    if (this.stale(f)) return this.err('stale', 'That request is too old. Try again.', f.id)
    const snap = await this.safeSnapshot()
    const ro = this.readOnly(d, snap)
    if (ro) return this.err('schedule_read_only', ro, f.id)
    const job = snap.schedules.find((s) => s.id === f.schedule_id)
    if (!job) return this.err('schedule_not_found', `No scheduled job "${f.schedule_id}".`, f.id)
    const last = this.runNowAt.get(job.id)
    if (last !== undefined && this.now() - last < RUN_NOW_GAP_MS)
      return this.err('rate_limited', 'That job was just started. Give it a couple of minutes.', f.id)
    if (job.today === 'held')
      return this.err('held', 'The job is on hold because its files changed outside the app.', f.id)
    if (job.today === 'running') return this.err('already_running', 'That job is already running.', f.id)
    // A heartbeat is never an agent run: Run now always means "check now", in this bridge, whatever the job's runner says.
    const isHeartbeat = heartbeatConfigFromMeta(job.meta) !== null
    const sessionable = isHeartbeat || (job.permissions !== 'restricted' && job.kind === 'claude')
    if (!isHeartbeat && f.where === 'session' && (!sessionable || job.runner === 'both'))
      return this.err('schedule_read_only', "That job can't run in the live session (read-only or restricted).", f.id)
    const inSession = isHeartbeat || job.runner === 'session' || f.where === 'session'
    this.runNowAt.set(job.id, this.now())
    if (inSession) {
      if (!sessionable) return this.err('schedule_read_only', "That job can't run in the live session.", f.id)
      const ds = this.runNowDay(job)
      const r = await this.offer(job.id, ds, null, null, 'run_now', f.again)
      if (!r.ok) {
        this.runNowAt.delete(job.id)
        return this.err(
          r.code === 'held' ? 'held' : r.code,
          r.code === 'held' ? 'The job is on hold.' : 'The scheduler refused that job.',
          f.id,
        )
      }
      this.ack(f.id)
    } else {
      const r = await d.adapter.startHeadless(job.id, { again: f.again })
      if (!r.ok) {
        this.runNowAt.delete(job.id)
        return this.err(r.code, r.message, f.id)
      }
      this.ack(f.id)
    }
    await this.refresh()
  }

  private async onControl(f: Of<'schedule.control'>, d: Discovered) {
    if (this.stale(f)) return this.err('stale', 'That request is too old. Try again.', f.id)
    if (d.state !== 'ready') return this.err('scheduler_unavailable', (d.adapter as ClosedAdapter).agentText(), f.id)
    // S3.7: on a registry Talos does not manage, jobs are listed read-only: no pause, no turning off, no retry either
    const ro = this.readOnly(d, this.lastGood ?? (await this.safeSnapshot()))
    if (ro) return this.err('schedule_read_only', ro, f.id)
    const id = f.schedule_id
    try {
      switch (f.action) {
        case 'pause':
        case 'resume':
          await d.adapter.setPaused({ id: id as string }, f.action === 'pause')
          break
        case 'pause_all':
        case 'resume_all':
          await d.adapter.setPaused('all', f.action === 'pause_all')
          break
        case 'disable':
          await d.adapter.disable(id as string)
          break
        case 'retry_headless':
          // The probe can take as long as Chronos's probe_timeout_s (120 s by default). Never wait on it here and never cut it
          // at the 15 s adapter deadline: answer now, run it on its own clock, and let the next status show the result.
          this.startProbe(d.adapter)
          break
      }
    } catch (e) {
      const m = (e as Error).message
      return this.err(
        /not_found|no such/i.test(m) ? 'schedule_not_found' : 'scheduler_unavailable',
        m.slice(0, 300),
        f.id,
      )
    }
    this.ack(f.id)
    await this.refresh()
  }

  /** Retry background runs: one probe at a time, off the schedule queue; its result arrives through `health.headless`. */
  private startProbe(adapter: SchedulerAdapter) {
    if (this.probing) return
    this.probing = true
    void adapter
      .retryHeadless()
      .catch((e) => this.log('probe failed', { error: (e as Error).message }))
      .finally(() => {
        this.probing = false
        if (this.gate()) void this.enqueue(() => this.refresh(true)).catch(() => {})
      })
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

/** An update whose only change is Talos-only (the result thread): the Chronos part is empty. */
function isThreadOnly(split: ReturnType<typeof toChronosChange>): boolean {
  const c = split.chronos
  return c.op === 'update' && Object.keys(c.set).length === 0 && split.threadId.set
}

function zodText(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const parts = err.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  return `invalid schedule: ${parts.join('; ')}`
}

/** Plain text, controls stripped, at most 4 KiB (S2.4). */
function excerptOf(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
  const enc = new TextEncoder()
  let out = clean
  while (enc.encode(out).length > REPORT_MAX_BYTES) out = out.slice(0, Math.floor(out.length * 0.9))
  return out
}
