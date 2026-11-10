// The agent's run tools and heartbeat thread lookup (S6.1, HB4): schedule_run_start, schedule_run_done, the list tool, and the
// answer to which thread is a heartbeat's.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  heartbeatConfigFromMeta,
  runsInSession,
  type ScheduleSnapshotT,
  type ScheduleT,
  visibleMetaText,
} from '@talos-app/protocol'
import { defaultThreadRef } from '../context.ts'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'
import { WAKE_ENDED_TEXT } from '../heartbeat/prompt.ts'
import { storeFile } from '../heartbeat/store.ts'
import type { ClosedAdapter } from './closed-adapter.ts'
import { detailText, listText } from './format.ts'
import { rememberRun } from './job-memory-run.ts'
import type { ScheduleService } from './service.ts'
import {
  excerptOf,
  fail,
  failKeys,
  HB_THREAD_LOOKUP_MS,
  SKIP_WORDS,
  THREAD_MAP_SCHEMA,
  type ToolOut,
  yes,
} from './service-shared.ts'
import { hasHeartbeatMeta, scopedSnapshot, type WorkerScope } from './worker-scope.ts'

export function toolRunStart(this: ScheduleService, runId: string): Promise<ToolOut> {
  return this.enqueue(async () => {
    const d = await this.ensure()
    if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
    const known = this.sidecar.offerByRun(runId) ?? this.sidecar.inflightOf(runId)
    const job = this.sidecar.jobOfRun(runId)
    if (!known || !job) return fail(`unknown run ${runId}: it was not offered by this bridge`)
    // A run id is good for ONE claim: replaying it (say, an hour after a Run now tap) must not re-run the job (review R5/R6)
    const used = this.sidecar.inflightOf(runId)
    const wake = this.wakeRuns.get(runId)
    // A heartbeat wake is already claimed by the bridge for the agent: its first start says GO (once), so an agent that
    // calls it out of habit goes on instead of stopping with the pack unread.
    if (used && !used.closed && wake && !wake.started) {
      wake.started = true
      return yes('GO')
    }
    if (used?.closed && this.heartbeatRunEnded(runId)) return yes(WAKE_ENDED_TEXT)
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
      return yes('SKIP: its instructions changed since this was offered; a new run was offered with the approved text')
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

export async function toolRunDone(
  this: ScheduleService,
  a: {
    runId: string
    ok: boolean
    summary: string
    report?: string
    notepad?: string
  },
): Promise<ToolOut> {
  let wakeDone: { jobId: string } | null = null
  const out = await this.toolRunDoneQueued(a, (j) => {
    wakeDone = j
  })
  // Outside the schedule queue: the heartbeat runner may be busy with a slow source, and nothing else should wait on it.
  const w = wakeDone as { jobId: string } | null
  if (w)
    await this.heartbeat
      .wakeEnded(w.jobId, a.runId, a.ok ? 'ok' : 'failed')
      .catch((e) => this.log('heartbeat wake close failed', { job: w.jobId, error: (e as Error).message }))
  return out
}

export function toolRunDoneQueued(
  this: ScheduleService,
  a: { runId: string; ok: boolean; summary: string; report?: string; notepad?: string },
  onClosed: (j: { jobId: string }) => void,
): Promise<ToolOut> {
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
      if (r.reason === 'late' && this.heartbeatRunEnded(a.runId)) return yes(WAKE_ENDED_TEXT)
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
    this.closeInflight(a.runId, status)
    // A heartbeat wake: ONLY a done that Chronos accepted for this run, with ok:true, marks its items shown.
    this.wakeRuns.delete(a.runId)
    onClosed({ jobId: job.id })
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
    const remembered = rememberRun(this.jobMemory, this.sidecar, {
      jobId: job.id,
      runId: a.runId,
      ds: note?.ds ?? job.ds,
      ok: a.ok,
      summary: a.summary,
      notepad: a.notepad,
    })
    await this.refresh()
    return yes(`recorded${remembered}`)
  })
}

export function isHeartbeatJob(this: ScheduleService, id: string): boolean {
  const j = this.lastGood?.schedules.find((x) => x.id === id)
  return j ? heartbeatConfigFromMeta(j.meta) !== null : existsSync(storeFile(this.ctx.paths.home, false, id))
}

/**
 * The heartbeat job whose own thread this is, or null. The default thread is never a heartbeat's.
 *
 * A card must not wait on Chronos, and must not fail open when Chronos cannot be read (HB4 R2-5). The order is: the last good
 * snapshot in memory; else a read of Chronos bounded by HB_THREAD_LOOKUP_MS; else the thread map saved on disk from the last
 * good snapshot; and with neither, any thread whose job has a heartbeat store file is taken to be a heartbeat's (limited).
 */
export async function heartbeatJobOfThread(this: ScheduleService, threadId: string): Promise<string | null> {
  if (threadId === defaultThreadRef(this.ctx).id) return null
  if (!this.lastGood) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.lookupSnapshot(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, HB_THREAD_LOOKUP_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const live = this.lastGood
  if (live)
    return live.schedules.find((s) => s.thread_id === threadId && heartbeatConfigFromMeta(s.meta) !== null)?.id ?? null
  return this.savedThreadMap().get(threadId) ?? this.threadFromStores(threadId)
}

export function lookupSnapshot(this: ScheduleService): Promise<ScheduleSnapshotT> {
  this.lookupRead ??= this.safeSnapshot().finally(() => {
    this.lookupRead = null
  })
  return this.lookupRead
}

export function threadMapFile(this: ScheduleService): string {
  return join(this.ctx.paths.home, 'heartbeat-threads.json')
}

/** Remembers which thread belongs to which heartbeat job, from a snapshot Chronos answered. Only written when it changed. */
export function saveThreadMap(this: ScheduleService, snap: ScheduleSnapshotT): void {
  const threads: Record<string, string> = {}
  for (const j of snap.schedules)
    if (j.thread_id && heartbeatConfigFromMeta(j.meta) !== null) threads[j.thread_id] = j.id
  const json = JSON.stringify({ schema: THREAD_MAP_SCHEMA, threads })
  if (json === this.savedMapJson) return
  try {
    writeJsonAtomic(this.threadMapFile(), { schema: THREAD_MAP_SCHEMA, threads })
    this.savedMapJson = json
  } catch (e) {
    this.log('could not save the heartbeat thread map', { error: (e as Error).message })
  }
}

/** Never throws; a missing or damaged file is an empty map. */
export function savedThreadMap(this: ScheduleService): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const raw = readJsonFile<{ schema?: unknown; threads?: unknown }>(this.threadMapFile())
    if (raw?.schema === THREAD_MAP_SCHEMA && raw.threads && typeof raw.threads === 'object')
      for (const [t, id] of Object.entries(raw.threads)) if (typeof id === 'string') out.set(t, id)
  } catch {
    // damaged: treated as no map
  }
  return out
}

/** The last resort: a job whose thread (in the sidecar) is this one and which has ever kept a heartbeat store. */
export function threadFromStores(this: ScheduleService, threadId: string): string | null {
  for (const id of Object.keys(this.sidecar.jobThreads()))
    if (
      this.sidecar.threadOf(id) === threadId &&
      (existsSync(storeFile(this.ctx.paths.home, false, id)) || existsSync(storeFile(this.ctx.paths.home, true, id)))
    )
      return id
  return null
}

/** A run id that belonged to a heartbeat wake that is over: a card or a done carrying it must do nothing. */
export function heartbeatRunEnded(this: ScheduleService, runId: string): boolean {
  const job = this.sidecar.jobOfRun(runId)
  return Boolean(
    job &&
      this.sidecar.inflightOf(runId)?.closed !== undefined &&
      this.sidecar.note(runId)?.wake === true &&
      this.isHeartbeatJob(job.id),
  )
}

/** The 4th pending card becomes this: one plain row in the job's thread. Throws if it cannot be posted. */
export function heartbeatPlainLine(this: ScheduleService, jobId: string, title: string): Promise<void> {
  const t = visibleMetaText(title).slice(0, 120)
  return this.heartbeat.postLine(
    jobId,
    `${t}\nThree Heartbeat cards are already waiting for you, so this one is a line. Reply here and I'll take it.`,
  )
}

/** With `scope` (a thread's own session, via the hub): only that thread's jobs, never a heartbeat, and no issues about other jobs. */
export function toolList(this: ScheduleService, id?: string, scope?: WorkerScope): Promise<ToolOut> {
  return this.enqueue(async () => {
    const d = await this.ensure()
    if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
    if (id) {
      const x = await d.adapter.detail(id, null)
      // the same words for "no such job" and "someone else's job": a thread session learns nothing about other lanes
      if (!x || (scope && !this.inScope(scope, x.detail.schedule))) return fail(`no scheduled job "${id}"`)
      return yes(detailText(this.withRuns(x.detail)))
    }
    const snap = await this.safeSnapshot()
    return yes(listText(scope ? scopedSnapshot(snap, scope, (j) => this.inScope(scope, j)) : snap))
  })
}

/**
 * Is this job one the thread's own session may see or change: it runs in that thread, only in a session (a headless or
 * "both" job or a command runs outside it), and it is not a heartbeat.
 */
export function inScope(
  this: ScheduleService,
  scope: WorkerScope,
  j: Pick<ScheduleT, 'id' | 'meta' | 'runner' | 'kind' | 'permissions'>,
): boolean {
  return (
    this.threadOfJob(j.id).id === scope.thread && runsInSession(j) && j.kind !== 'command' && !hasHeartbeatMeta(j.meta)
  )
}
