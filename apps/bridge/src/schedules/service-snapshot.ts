// The snapshot, status and notices of the Schedules service (S2.2, S3.6, S6.1, S6.3): the last good snapshot with its overlay,
// what the app is told moved, and the failures and holds reported once per cause.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import {
  dateOfRunKey,
  type HealthIssueT,
  type SchedulerHealthT,
  type ScheduleSnapshotT,
  type ScheduleT,
  safeLine,
} from '@talos-app/protocol'
import { postSystemNotice } from '../context.ts'
import { scheduleStatusFrame } from '../frames-out.ts'
import { scheduleHeldNotification } from '../notify.ts'
import { type AdapterError, healthState, issueFor } from './chronos-adapter.ts'
import { hostLabel, localZone } from './discovery.ts'
import { syncBackgroundMemory } from './job-memory-background.ts'
import type { ScheduleService } from './service.ts'
import { FAILURE_STATUSES, FAILURE_WORDS, failKeys, NOTICE_MAX_AGE_MS } from './service-shared.ts'

/** Never throws: a hung or unreadable scheduler is a snapshot with a health issue, from the last good one when we have it. */
export async function safeSnapshot(this: ScheduleService): Promise<ScheduleSnapshotT> {
  const d = await this.ensure()
  try {
    const snap = this.overlay(await d.adapter.snapshot())
    if (this.problem && (this.problem.code === 'adapter_timeout' || this.problem.code === 'registry_unreadable'))
      this.problem = null
    if (d.state === 'ready') {
      this.lastGood = snap
      this.saveThreadMap(snap)
    }
    return snap
  } catch (e) {
    const err = e as AdapterError
    this.onProblem(err)
    return this.degraded(err)
  }
}

export function degraded(this: ScheduleService, err: AdapterError): ScheduleSnapshotT {
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
export function overlay(this: ScheduleService, snap: ScheduleSnapshotT): ScheduleSnapshotT {
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

export function noteByDay(this: ScheduleService, id: string, ds: string) {
  return this.sidecar.runsOf(id).find(([, n]) => n.ds === ds)?.[1]
}

/** Packs and finished runs of background jobs with memory (job-memory-background.ts). A failure here never stops a refresh. */
export async function syncJobMemory(this: ScheduleService, snap: ScheduleSnapshotT) {
  try {
    await syncBackgroundMemory({
      chronos: this.chronos(),
      mem: this.jobMemory,
      sidecar: this.sidecar,
      snap,
      state: this.bgMemory,
      now: () => this.now(),
      memoryDirNow: () => {
        const dir = this.chronosLimits()?.memory_dir
        return typeof dir === 'string' ? dir : undefined
      },
    })
  } catch (e) {
    this.log('job memory sync failed', { error: (e as Error).message })
  }
}

export function sendStatus(this: ScheduleService, snap: ScheduleSnapshotT) {
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
export async function noticesFor(this: ScheduleService, snap: ScheduleSnapshotT) {
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
export function markAll(this: ScheduleService, keys: string[]): boolean {
  for (const k of keys) if (!this.sidecar.markNotified(k, this.now())) return false
  return true
}

export async function reportFailure(this: ScheduleService, s: ScheduleT, status: string, ds: string, keys: string[]) {
  if (!this.markAll(keys)) return
  await this.postFailure(s.id, s.name, status)
  this.pendingAlerts.push({ kind: 'job_failed', key: `${s.id}:${ds}`.slice(0, 80) })
}

/** A `system` row in the job's own thread (pin-notice path). */
export async function postFailure(this: ScheduleService, jobId: string, name: string, status: string) {
  const why = FAILURE_WORDS[status] ?? status
  const text =
    status === 'missed'
      ? `Scheduled job "${safeLine(name)}" was missed: no session was running in its window. Open Schedules.`
      : `Scheduled job "${safeLine(name)}" didn't finish: ${why}. Open Schedules.`
  await postSystemNotice(this.ctx, text, { thread: this.threadOfJob(jobId) })
}

/** The job's files changed outside the app: Chronos holds it. Tell the session once per version (S6.3). */
export async function noticeHeld(this: ScheduleService, s: ScheduleT) {
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
