// A scheduled job that fails wakes Main (wake bundle part c). The first failure of a job in a day wakes Main with the error and the
// end of the run's report, and holds the owner's alert: Main fixes the cause first, then calls `schedule_rerun`. That is the day's one
// repair. A second failure the same day, a wake that cannot be sent, or REPAIR_WAIT_MS without a good run sends the normal
// `job_failed` alert instead, so a failure is never lost and the owner is never asked to wait for ever.
//
// The count and the deadline are one sidecar entry (`repairs`, schedules-meta.json: it outlives a restart). The deadline is looked at on
// the schedules runner tick, not on a timer of its own.
import { homedir } from 'node:os'
import { safeLine } from '@talos-app/protocol'
import { postSystemNotice } from '../context.ts'
import { jobFailedNotification } from '../notify.ts'
import { redact } from '../redact.ts'
import type { ScheduleService } from './service.ts'
import { FAILURE_WORDS, fail, type ToolOut, yes } from './service-shared.ts'
import type { Repair } from './sidecar.ts'

/** How long Main has to get the job running again before the owner is told. */
export const REPAIR_WAIT_MS = 2 * 3600_000
/** The statuses Main can do something about. A missed window, a run macOS never let start, or a restart that cut a run short is not a bug in the job: those keep the owner's alert. */
const REPAIRABLE = new Set(['failed', 'timed_out'])
/** How much of the run's report goes to Main: the end of it. */
const LOG_END_CHARS = 1500

/** The owner's local date, which is what "a day" means for the one repair. */
export function repairDay(this: ScheduleService): string {
  const zone = this.ctx.config.config.timezone || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.now()))
  } catch {
    return new Date(this.now()).toISOString().slice(0, 10)
  }
}

/** The end of what the run left (its report, else its summary): Main reads it as data. */
async function logEndOf(this: ScheduleService, id: string, runId: string | undefined): Promise<string> {
  let text = ''
  if (runId) {
    const note = this.sidecar.note(runId)
    text = note?.report ?? ''
    if (!text) {
      // a background run's report is Chronos's, not the sidecar's
      const a = this.adapter as { runResult?: (id: string, runId: string) => Promise<{ report: string | null } | null> }
      try {
        text = (await a.runResult?.(id, runId))?.report ?? ''
      } catch (e) {
        this.log('job report not read for the wake', { job: id, error: (e as Error).message })
      }
    }
    if (!text) text = note?.summary ?? ''
  }
  const clean = redact(text, { userHome: homedir(), appHome: this.ctx.paths.home })
  return clean.length > LOG_END_CHARS ? clean.slice(clean.length - LOG_END_CHARS) : clean
}

export type JobFailure = {
  id: string
  name: string
  status: string
  ds: string
  runId?: string | undefined
  /** Post the "didn't finish" row in the job's thread (the heartbeat paths post their own line). */
  row: boolean
}

/**
 * The one place a failed job ends up. Posts the thread row when asked, then either wakes Main (the day's one repair) or pushes the
 * owner's `job_failed` alert, as every failure did before.
 */
export async function jobFailed(this: ScheduleService, a: JobFailure): Promise<'woke' | 'alert'> {
  const alert = (): 'alert' => {
    this.pendingAlerts.push({ kind: 'job_failed', key: `${a.id}:${a.ds}`.slice(0, 80) })
    return 'alert'
  }
  const wake = this.ctx.mainWake
  const eligible = wake && REPAIRABLE.has(a.status) && !this.isHeartbeatJob(a.id)
  const day = this.repairDay()
  const key = `repair|${a.id}|${day}`
  const used = this.sidecar.repairOf(key)
  // a repair still waiting counts as used whatever day it began on: a failed rerun after midnight is not a new failure
  const open = this.sidecar.waitingRepairOf(a.id)
  if (!eligible || used || open) {
    // the repair is spent: a failure that follows it is the owner's now (one alert), and the deadline has nothing left to say
    if (open) this.sidecar.setRepair(open[0], { ...open[1], state: 'alerted' })
    if (a.row) await this.postFailure(a.id, a.name, a.status, a.ds)
    return alert()
  }
  const now = this.now()
  const entry: Repair = {
    job: a.id,
    name: a.name,
    day,
    ds: a.ds,
    status: a.status,
    woke_at: now,
    deadline_at: now + REPAIR_WAIT_MS,
    state: 'waiting',
  }
  // the count is written before anything is sent; a write that is refused (not the live writer, a full disk) means the owner is told
  if (!this.sidecar.setRepair(key, entry)) {
    if (a.row) await this.postFailure(a.id, a.name, a.status, a.ds)
    return alert()
  }
  if (a.row) await this.postFailure(a.id, a.name, a.status, a.ds, true)
  try {
    await wake.fire(
      `job:${a.id}:${a.runId ?? a.ds}:${a.status}`,
      jobFailedNotification({
        thread: this.threadOfJob(a.id),
        jobId: a.id,
        name: a.name,
        status: a.status,
        ds: a.ds,
        runId: a.runId,
        why: FAILURE_WORDS[a.status] ?? a.status,
        logEnd: await logEndOf.call(this, a.id, a.runId),
        ts: this.iso(),
        id: `jf-${a.id}-${a.runId ?? a.ds}`.slice(0, 80),
      }),
    )
  } catch (e) {
    // not written down, not sent: give the day's repair back and tell the owner now
    this.log('job failure wake not made', { job: a.id, error: (e as Error).message })
    this.sidecar.clearRepair(key)
    return alert()
  }
  return 'woke'
}

/**
 * On the runner tick: a repair whose deadline has passed with no good run since Main was woken goes to the owner (a row, and the normal
 * alert, once). One with a good run since is done. Returns how many alerts it raised, so the caller can send them.
 */
export async function checkRepairs(this: ScheduleService): Promise<number> {
  const now = this.now()
  let raised = 0
  for (const [key, r] of Object.entries(this.sidecar.all.repairs)) {
    if (r.state !== 'waiting') continue
    // a job that was deleted while Main was fixing it has nothing left to fix
    if (this.lastGood && !this.lastGood.schedules.some((s) => s.id === r.job)) {
      this.sidecar.setRepair(key, { ...r, state: 'repaired' })
      continue
    }
    if (now < r.deadline_at) continue
    if (this.repairedSince(r)) {
      this.sidecar.setRepair(key, { ...r, state: 'repaired' })
      continue
    }
    // marked first: a write that is refused is tried again on the next tick, and the owner is never told twice
    if (!this.sidecar.setRepair(key, { ...r, state: 'alerted' })) continue
    try {
      await postSystemNotice(this.ctx, `Scheduled job "${safeLine(r.name)}" is still not fixed. Open Schedules.`, {
        thread: this.threadOfJob(r.job),
      })
    } catch (e) {
      this.log('repair deadline row not posted', { job: r.job, error: (e as Error).message })
    }
    this.pendingAlerts.push({ kind: 'job_failed', key: `${r.job}:${r.ds}`.slice(0, 80) })
    raised++
  }
  return raised
}

/** Has the job had a good run since Main was woken? From the runs the bridge kept, and Chronos's last run. */
export function repairedSince(this: ScheduleService, r: Repair): boolean {
  if (
    this.sidecar
      .runsOf(r.job)
      .some(([, n]) => n.status === 'ok' && Date.parse(n.finished_at ?? n.started_at) >= r.woke_at)
  )
    return true
  const last = this.lastGood?.schedules.find((s) => s.id === r.job)?.last_run
  return last?.status === 'ok' && Date.parse(last.ended_at ?? last.started_at ?? '') >= r.woke_at
}

/** Main's tool: run the job again, after it has fixed the cause. Same rules as the owner's Run now. */
export async function toolRerun(this: ScheduleService, jobId: string): Promise<ToolOut> {
  const d = await this.ensure()
  const snap = await this.safeSnapshot()
  const ro = this.readOnly(d, snap)
  if (ro) return fail(ro)
  const job = snap.schedules.find((s) => s.id === jobId)
  if (!job) return fail(`No scheduled job "${jobId}". Use schedules_list to see the ids.`)
  // Only a repair that is waiting can be rerun, and only once: `again: true` would otherwise let Main rerun any job every two minutes.
  const open = this.sidecar.waitingRepairOf(jobId)
  if (!open)
    return fail(
      `${job.name} is not waiting for a repair, so it can't be rerun. A rerun is only for a job you were woken about (kind=job_failed) and have fixed, once per repair.`,
    )
  if (open[1].rerun_at !== undefined)
    return fail(
      `${job.name} was already rerun for this repair. If it failed again the owner has been told; if it is still running, wait for it.`,
    )
  // written before it starts: a crash between the two must not give Main a second rerun
  if (!this.sidecar.setRepair(open[0], { ...open[1], rerun_at: this.now() }))
    return fail('The rerun could not be recorded, so it was not started. Try again in a moment.')
  const r = await this.startRunNow(job, d, { where: 'default', again: true })
  if (!r.ok) {
    this.sidecar.setRepair(open[0], open[1]) // refused: the repair's one rerun is still unused
    return fail(r.message)
  }
  await this.refresh()
  return yes(
    `${job.name} was offered to run again. Watch for its kind=schedule_run notification, then run it as usual. If it fails again, or no good run follows within two hours, the owner is told.`,
  )
}
