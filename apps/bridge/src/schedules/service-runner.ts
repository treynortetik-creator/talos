// The session runner and its claims (docs/SCHEDULES.md S3.3): the tick, offers, heartbeat slots, orphans and time-outs.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import { heartbeatConfigFromMeta, isWakeJobId, newUlid, type SchedulerAdapter, safeLine } from '@talos-app/protocol'
import { postSystemNotice } from '../context.ts'
import { coldAfterMs } from '../heartbeat/cold.ts'
import { BUSY_SUMMARY } from '../heartbeat/run-parts.ts'
import type { RunOutput } from '../heartbeat/runner.ts'
import { runNowProblem } from '../heartbeat/tested.ts'
import { scheduleRunNotification } from '../notify.ts'
import { WorkerStore } from '../worker/store.ts'
import type { AdapterError } from './chronos-adapter.ts'
import { memoryForRun } from './job-memory-run.ts'
import { RUNNING_LONG_TEXT, readChronosLimits, runTimeoutMs, visiblyWorking } from './run-limits.ts'
import type { ScheduleService } from './service.ts'
import { excerptOf, failKeys } from './service-shared.ts'
import { MAX_SKIPS_PER_SLOT, type Offer } from './sidecar.ts'

/** Asks Chronos which jobs a live session may take now (this also refreshes its session heartbeat), and offers them. */
export async function runnerTick(this: ScheduleService): Promise<void> {
  if (!this.gate()) return
  this.sidecar.flush() // a write that failed or was refused earlier goes out now
  // First: it needs only the sidecar and the last snapshot, so a scheduler that is down cannot hold the owner's alert back.
  if ((await this.checkRepairs()) > 0)
    await this.refresh().catch((e) =>
      this.log('refresh after a repair deadline failed', { error: (e as Error).message }),
    )
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
    // An offer this bridge already sent stands, unless the session gave it back with SKIP before claiming anything (the
    // owner paused the job and resumed it, say): Chronos lists the job as due again, so it is offered again, a few times at most.
    if (prev && prev.instance === this.deps.instance && (!prev.released || (prev.skips ?? 0) >= MAX_SKIPS_PER_SLOT))
      continue
    const claimed = prev && this.sidecar.inflightOf(prev.run_id)
    if (claimed && !claimed.closed) continue
    await this.offer(j.id, j.ds, j.fire_at, j.window_ends, 'clock', false)
  }
  await this.expireRuns()
  // wakes a crash, a missed window or the owner's own delete left behind
  if (this.gate()) await this.wakeMe.sweep()
}

/**
 * Records the offer in the sidecar FIRST, then sends one `schedule_run` notification (S3.3). Returns the run id, or why
 * the job could not be offered.
 */
export async function offer(
  this: ScheduleService,
  id: string,
  ds: string | null,
  fireAt: string | null,
  windowEnds: string | null,
  trigger: 'clock' | 'run_now',
  again: boolean,
): Promise<
  | { ok: true; runId: string }
  | { ok: false; code: 'held' | 'schedule_invalid' | 'schedule_not_found'; testRequired?: string }
> {
  // A wake_me timer is never a schedule_run: the bridge delivers its note as the agent's own words (wake-me/service.ts).
  if (isWakeJobId(id)) return this.wakeMe.onDue(id)
  const d = this.adapter
  const sp = await d.sessionPrompt(id)
  if (!sp.ok) {
    if (sp.code === 'held') await this.noticeHeldById(id)
    return { ok: false, code: sp.code }
  }
  // A heartbeat job never reaches the agent through here: its slot is a check the bridge runs itself (docs/HEARTBEAT.md). This is
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
  // Run now is judged on the job as it is NOW (this fresh read), never on a snapshot that may be stale: every route to a manual
  // heartbeat run, the tool re-offer included, passes here (docs/HEARTBEAT.md "A test before turning on").
  if (hb && trigger === 'run_now') {
    const testRequired = runNowProblem(this.ctx.paths.home, this.now(), detail.detail.schedule)
    if (testRequired) return { ok: false, code: 'schedule_invalid', testRequired }
  }
  if (hb) return this.startHeartbeat({ id, ds, fireAt, windowEnds, trigger, again, hb, contentHash: sp.contentHash })
  const snap = this.lastGood ?? (await this.safeSnapshot())
  const job = snap.schedules.find((s) => s.id === id)
  const runId = `r_${newUlid()}`
  const before = this.sidecar.offerFor(id, ds ?? '')
  const memory = memoryForRun(this.jobMemory, this.sidecar, id, sp.prompt)
  const o: Offer = {
    id,
    ds: ds ?? '',
    run_id: runId,
    fire_at: fireAt,
    window_ends: windowEnds,
    trigger,
    again,
    content_hash: sp.contentHash,
    ...(memory ? { memory_binding: memory.binding, memory_epoch: memory.epoch } : {}),
    instance: this.deps.instance,
    at: this.now(),
    // a re-offer after a SKIP keeps the count of the offers before it
    ...(trigger === 'clock' && before?.skips ? { skips: before.skips } : {}),
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
      memory: memory?.block ?? null,
      ts,
    }),
  )
  return { ok: true, runId }
}

/**
 * A heartbeat slot: record the offer first (so the next tick does not start it again), then claim and run it in the
 * background. Returns at once; the run closes itself with `finish`, like a session run that reports done.
 */
export function startHeartbeat(
  this: ScheduleService,
  a: {
    id: string
    ds: string | null
    fireAt: string | null
    windowEnds: string | null
    trigger: 'clock' | 'run_now'
    again: boolean
    hb: NonNullable<ReturnType<typeof heartbeatConfigFromMeta>>
    contentHash: string
  },
): { ok: true; runId: string } | { ok: false; code: 'schedule_invalid' } {
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
  // a new try after a claim that threw keeps the count of the tries before it
  const before = a.trigger === 'clock' ? this.sidecar.offerFor(a.id, a.ds ?? '') : undefined
  if (before?.skips) o.skips = before.skips
  if (!this.sidecar.recordOffer(o)) return { ok: false, code: 'schedule_invalid' }
  this.hbRunning.add(a.id)
  void this.heartbeatRun(a, runId)
    .catch((e) => this.log('heartbeat run failed', { job: a.id, error: (e as Error).message }))
    .finally(() => this.hbRunning.delete(a.id))
  return { ok: true, runId }
}

export async function heartbeatRun(
  this: ScheduleService,
  a: Parameters<ScheduleService['startHeartbeat']>[0],
  runId: string,
): Promise<void> {
  const claimed = await this.enqueue(async () => {
    if (this.stopped) return null
    let r: Awaited<ReturnType<SchedulerAdapter['claim']>>
    try {
      r = await this.adapter.claim(a.id, {
        runId,
        ds: a.trigger === 'run_now' ? null : a.ds,
        fireAt: a.fireAt,
        manual: a.trigger === 'run_now',
        again: a.again,
        bridgeInstance: this.deps.instance,
      })
    } catch (e) {
      // The scheduler did not answer (a timeout, a crash): nothing was claimed, so the slot is given back and a later tick
      // tries it again while it is still due. When the tries run out the owner is told; it is never dropped in silence.
      this.log('heartbeat claim failed', { job: a.id, error: (e as Error).message })
      await this.heartbeatClaimFailed(a, runId)
      return null
    }
    if (!r.ok) {
      // Another run of this job still holds the claim (a wake the agent is working on): the sources did not run. Say so in the
      // run list, quietly: no row in the thread, no source read. Any other refusal means another runner has it or it is done.
      if (r.reason === 'running_elsewhere') {
        this.sidecar.setNote(
          runId,
          {
            id: a.id,
            ds: a.ds ?? this.iso().slice(0, 10),
            status: 'skipped',
            busy: true,
            trigger: a.trigger,
            started_at: this.iso(),
            finished_at: this.iso(),
            summary: BUSY_SUMMARY,
          },
          this.now(),
        )
        await this.refresh()
      }
      return null
    }
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
      coldAfterMs: coldAfterMs(this.lastGood?.schedules.find((s) => s.id === a.id)?.when),
      runId,
    })
  } catch (e) {
    this.log('heartbeat run threw', { job: a.id, error: (e as Error).message })
  }
  if (out?.aborted) return // stopped mid-run: Chronos's claim is for the next bridge's orphan sweep, not for this one to close
  if (out?.wakeOpen) {
    // The agent has the pack. The claim stays open until schedule_run_done (or the run times out), and the items are shown
    // only then. The sidecar keeps the outcome now so the row says "Checked in" while it works.
    await this.enqueue(async () => {
      this.sidecar.setNote(
        runId,
        {
          id: a.id,
          ds: claimed.ds,
          status: 'running',
          wake: true,
          summary: out.summary.slice(0, 280),
          heartbeat: out.result,
        },
        this.now(),
      )
      await this.refresh()
    })
    return
  }
  const status: 'ok' | 'failed' = out ? out.status : 'failed'
  const summary = out?.summary ?? 'Check failed'
  const report = out?.report ?? 'The heartbeat run stopped with an error before it could report.'
  await this.enqueue(async () => {
    if (this.stopped) return
    const r = await this.adapter.finish(a.id, { runId, status, report })
    if (!r.ok) return
    this.closeInflight(runId, status)
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

const CLAIM_FAILED_WHY = 'the scheduler did not answer'

/**
 * A heartbeat slot whose claim threw. The offer is released, so the runner tries the slot again on a later tick (at most
 * MAX_SKIPS_PER_SLOT tries in all). A Run now has no later tick, so it is reported at once. When the tries are used up:
 * one system row for the owner, a failed entry in the run list, and the failure alert, once per job and slot.
 */
export async function heartbeatClaimFailed(
  this: ScheduleService,
  a: Parameters<ScheduleService['startHeartbeat']>[0],
  runId: string,
): Promise<void> {
  const released = this.sidecar.releaseOffer(runId, CLAIM_FAILED_WHY, this.now())
  const tries = this.sidecar.offerByRun(runId)?.skips ?? 1
  // A release that could not be saved leaves the offer standing (no retry will come), so that is reported as well.
  if (released && a.trigger === 'clock' && tries < MAX_SKIPS_PER_SLOT) return
  const ds = a.ds ?? this.iso().slice(0, 10)
  const key = `hb-claim|${a.id}|${a.trigger === 'run_now' ? runId : ds}`
  if (this.sidecar.wasNotified(key) || !this.sidecar.markNotified(key, this.now())) return
  this.sidecar.setNote(
    runId,
    {
      id: a.id,
      ds,
      status: 'failed',
      trigger: a.trigger,
      started_at: this.iso(),
      finished_at: this.iso(),
      summary: `Could not start: ${CLAIM_FAILED_WHY}`,
    },
    this.now(),
  )
  const name = this.lastGood?.schedules.find((s) => s.id === a.id)?.name ?? a.id
  const count = tries > 1 ? ` (tried ${tries} times)` : ''
  await postSystemNotice(
    this.ctx,
    `Scheduled job "${safeLine(name)}" could not start at its time: ${CLAIM_FAILED_WHY}${count}. Open Schedules.`,
    { thread: this.threadOfJob(a.id) },
  )
  this.pendingAlerts.push({ kind: 'job_failed', key: `${a.id}:${ds}`.slice(0, 80) })
  await this.refresh()
}

/** One plain line per job and slot when the job could not be read at its slot (it is tried again on the next tick). */
export async function noticeUnreadableAtSlot(this: ScheduleService, id: string, ds: string | null) {
  const key = `unreadable|${id}|${ds ?? ''}`
  if (this.sidecar.wasNotified(key) || !this.sidecar.markNotified(key, this.now())) return
  const name = this.lastGood?.schedules.find((s) => s.id === id)?.name ?? id
  await postSystemNotice(
    this.ctx,
    `Scheduled job "${safeLine(name)}" couldn't be read at its time, so it was not started. It is tried again shortly.`,
    { thread: this.threadOfJob(id) },
  )
}

export async function noticeHeldById(this: ScheduleService, id: string) {
  const s = (this.lastGood ?? (await this.safeSnapshot())).schedules.find((x) => x.id === id)
  if (s) await this.noticeHeld(s)
}

export async function sweepOrphans(this: ScheduleService) {
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

/** `timeout_min` and `stale_claim_min` from Chronos's config file; null when unusable (logged once). */
export function chronosLimits(this: ScheduleService) {
  return readChronosLimits(this.ctx.env.chronosConfig, this.ctx.env.userHome, (msg) => {
    if (this.limitsProblemLogged) return
    this.limitsProblemLogged = true
    this.log(msg)
  })
}

/** No schedule_run_done within the time-out: finished as timed_out (S3.3). */
export async function expireRuns(this: ScheduleService) {
  const now = this.now()
  const limit = runTimeoutMs(this.chronosLimits())
  for (const [runId, f] of Object.entries(this.sidecar.all.inflight)) {
    if (f.closed || f.instance !== this.deps.instance || now - f.claimed_at < limit) continue
    // Past the time-out but the session is visibly working: running long, not failed. It ends as failed the moment that stops being
    // true (it finishes, reports, goes idle, parks, dies or is stopped); a finish that comes before then is a normal finish.
    // The report is MAIN's: a run a thread's own session claimed ('worker:<thread>') is not seen by it, so it ends as before.
    const byThread = new WorkerStore(this.ctx.store.db).claimedBy(runId)?.startsWith('worker:') === true
    if (!byThread && visiblyWorking(this.ctx.mod?.liveState())) {
      const note = this.sidecar.note(runId)
      if (note?.summary !== RUNNING_LONG_TEXT) {
        this.sidecar.setNote(runId, { id: f.id, ds: f.ds, summary: RUNNING_LONG_TEXT }, now)
        await this.refresh()
      }
      continue
    }
    await this.closeRun(f.id, f.ds, runId, 'timed_out', 'The agent never reported back.')
  }
}

export async function closeRun(
  this: ScheduleService,
  id: string,
  ds: string,
  runId: string,
  status: 'timed_out' | 'session_ended',
  report: string,
) {
  const r = await this.adapter.finish(id, { runId, status, report })
  this.closeInflight(runId, status)
  // a "running long" line must not outlive the run that said it
  const stale = this.sidecar.note(runId)?.summary === RUNNING_LONG_TEXT
  this.sidecar.setNote(runId, { id, ds, status, ...(stale ? { summary: undefined } : {}) }, this.now())
  // A heartbeat wake that never came back (timed out, or its session restarted): the items stay unshown, and any that have
  // now had two tries are posted as plain lines.
  this.wakeRuns.delete(runId)
  const ending = this.heartbeat
    .wakeEnded(id, runId, 'killed')
    .catch((e) => this.log('heartbeat wake close failed', { job: id, error: (e as Error).message }))
    .finally(() => this.wakeEnds.delete(ending))
  this.wakeEnds.add(ending)
  if (!r.ok) return
  const name = (this.lastGood?.schedules.find((s) => s.id === id)?.name ?? id) as string
  // A refused mark means noticesFor reports it on reconnect: posting now as well would say it twice.
  if (this.markAll(failKeys(id, runId, ds, status))) {
    await this.jobFailed({ id, name, status, ds, runId, row: true })
  }
  await this.refresh()
}
