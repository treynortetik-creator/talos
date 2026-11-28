// The owner frames (S3.4): list, get, patch, run now and control.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import {
  type CardT,
  changeNeedsSchedulesV2,
  type ErrorCodeT,
  type Frame,
  heartbeatConfigFromMeta,
  needsSchedulesV2,
  type ScheduleDetailT,
  type ScheduleRunT,
  type SchedulerAdapter,
  type ScheduleSnapshotT,
  type ScheduleT,
} from '@talos-app/protocol'
import { MAX_RESOLVE_AGE_MS } from '../cards-ledger.ts'
import { errorFrame, scheduleAckFrame, scheduleDetailFrame, schedulesSnapshotFrame } from '../frames-out.ts'
import { runNowProblem, TEST_REQUIRED_FIELD } from '../heartbeat/tested.ts'
import { say } from '../owner-words.ts'
import type { ClosedAdapter } from './closed-adapter.ts'
import { type Discovered, localZone } from './discovery.ts'
import { proposerKey } from './kv-prune.ts'
import type { ScheduleService } from './service.ts'
import { MAIN_PROPOSER, NEEDS_V2, type Of, STALE_MS } from './service-shared.ts'
import { withMainMark } from './sidecar.ts'

/** One verified owner schedule frame. Never throws; every path answers ack{ref} or error{ref}. */
export function handleOwnerFrame(this: ScheduleService, f: Frame): Promise<void> {
  // A heartbeat test is acked at once, outside the schedule queue: it can take 150 s and must not wait behind (or hold up) a
  // Chronos call. Its sources run on the tester's own runner.
  if (f.type === 'heartbeat.test') {
    if (this.stale(f)) this.err('stale', 'That request is too old. Try again.', f.id)
    else if (this.stopped)
      this.err(
        'scheduler_unavailable',
        say({
          mac: 'This Mac is not running schedules right now.',
          linux: 'This computer is not running schedules right now.',
        }),
        f.id,
      )
    else this.tester.handle(f)
    return Promise.resolve()
  }
  return this.enqueue(async () => {
    try {
      await this.dispatch(f)
    } catch (e) {
      this.log('schedule frame failed', { type: f.type, error: (e as Error).message })
      this.err('scheduler_unavailable', 'The scheduler could not do that.', f.id)
    }
  })
}

export function err(
  this: ScheduleService,
  code: ErrorCodeT,
  message: string,
  ref: string,
  fields?: Array<{ path: string; message: string }>,
) {
  this.ctx.transport.sendEphemeral(errorFrame(this.now(), code, message, ref, fields))
}

export function ack(this: ScheduleService, ref: string) {
  this.ctx.transport.sendEphemeral(scheduleAckFrame(this.now(), ref))
}

export function stale(this: ScheduleService, f: Frame): boolean {
  return Math.abs(this.now() - Date.parse(f.ts)) > STALE_MS
}

export async function dispatch(this: ScheduleService, f: Frame) {
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

export async function onGet(this: ScheduleService, f: Of<'schedule.get'>, d: Discovered) {
  const x = d.state === 'ready' ? await d.adapter.detail(f.schedule_id, f.report_run_id) : null
  if (!x) return this.err('schedule_not_found', `No scheduled job "${f.schedule_id}".`, f.id)
  if (needsSchedulesV2(x.detail.schedule) && !this.appCanRead(f.app_features))
    return this.err('scheduler_unavailable', `${NEEDS_V2} (the relay and the app both need schedules/2)`, f.id)
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
export function withRuns(this: ScheduleService, detail: ScheduleDetailT): ScheduleDetailT {
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
              ...(withMainMark(n) ? { summary: (withMainMark(n) as string).slice(0, 280) } : {}),
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

export function readOnly(this: ScheduleService, d: Discovered, snap: ScheduleSnapshotT | null): string | null {
  if (d.state !== 'ready') return (d.adapter as ClosedAdapter).agentText()
  if (!this.managed(snap))
    return say({
      mac: 'Talos does not manage this scheduler yet. At the Mac run `talos-app schedules adopt`, then restart your session.',
      linux:
        'Talos does not manage this scheduler yet. On this computer run `talos-app schedules adopt`, then restart your session.',
      windows: "Talos does not manage this scheduler yet, and it can't take it over on a Windows PC yet.",
    })
  return null
}

export async function onPatch(this: ScheduleService, f: Of<'schedule.patch'>, d: Discovered) {
  if (d.state !== 'ready') return this.err('scheduler_unavailable', (d.adapter as ClosedAdapter).agentText(), f.id)
  const snap = this.lastGood ?? (await this.safeSnapshot())
  const ro = this.readOnly(d, snap)
  if (ro) return this.err('schedule_read_only', ro, f.id)
  if (!this.relaySupports())
    return this.err('scheduler_unavailable', "The relay doesn't support Schedules yet; update the relay first.", f.id)
  if (!this.ctx.config.thread(f.thread_id)) return this.err('bad_frame', `unknown thread ${f.thread_id}`, f.id)
  if (changeNeedsSchedulesV2(f.change) && !this.relaySupportsV2())
    return this.err('scheduler_unavailable', "The relay doesn't support schedules/2 yet; update the relay first.", f.id)
  const minted = await this.prepareCard(f.change, {
    proposedBy: 'owner_form',
    threadId: f.thread_id,
    origin: 'chat',
    clientRef: f.id,
  })
  if (!minted.ok) return this.err(minted.code ?? 'schedule_invalid', minted.error, f.id, minted.fields)
  this.ctx.store.kvSet(proposerKey(minted.card.id), MAIN_PROPOSER) // the owner's own form: recorded, so a missing row always means "unknown"
  // "Save in my own schedule form" (`form_save`, a field the owner's device signed: nothing else can set it). A create or an
  // update from that form, no older than the 10 minutes a tap on a card may wait (MAX_RESOLVE_AGE_MS, the ledger's rule on the
  // owner's signed time; the 2 minutes of `stale()` belong to run now and control), is applied here without ever making a card
  // the apps could show: no Approve button and no "needs you" for something he just chose to save. An older one, a delete, an
  // adopt and the Turn on sheet keep the card, exactly as before.
  const direct =
    f.form_save === true &&
    (f.change.op === 'create' || f.change.op === 'update') &&
    this.now() - Date.parse(f.ts) <= MAX_RESOLVE_AGE_MS
  if (!direct) {
    this.ack(f.id)
    await this.publishCard(minted.card)
    return
  }
  await saveFromForm.call(this, f, minted.card)
}

/**
 * The direct Save. The change is written first, then the ledger row (made by prepareCard, never sent to the relay) is resolved
 * and finished, then the owner is told: `ack{applied}` or an error in words. Every check of the card path still ran (prepareCard),
 * and the write still compares the job's revision with the one drawn (applyCardInner). A restart in the middle leaves the change
 * written or not written, and no card either way; an unwritten one is the owner pressing Save again (a create on an existing
 * id and an update on a moved revision are refused, so it can never be applied twice).
 */
export async function saveFromForm(this: ScheduleService, f: Of<'schedule.patch'>, card: CardT) {
  const row = this.ctx.ledger.get(card.id)
  if (!row) return this.err('scheduler_unavailable', 'The scheduler could not do that.', f.id)
  let outcome: { ok: boolean; text: string } | null = null
  const finish = async (ok: boolean, text: string) => {
    outcome = { ok, text }
    const nowMs = this.ctx.clock.now()
    const r = this.ctx.ledger.resolve(
      { card_id: card.id, action: 'primary', payload_hash: card.payload_hash, ts: new Date(nowMs).toISOString() },
      nowMs,
      { by: 'owner_form' },
    )
    this.ctx.expiry?.cancel(card.id)
    this.log('schedule saved from the form', { card: card.id, ok })
    await this.endCard(r.ok ? r.row : row, card.id, ok, text)
  }
  try {
    await this.applyCardInner(row.binding, finish)
  } catch (e) {
    this.log('schedule apply failed', { card: card.id, error: (e as Error).message })
    if (!outcome)
      await finish(
        false,
        "The scheduler didn't answer in time, so this may or may not have been saved. Check it in Schedules, then try again.",
      )
  }
  const done = outcome as { ok: boolean; text: string } | null
  if (done?.ok) return this.ctx.transport.sendEphemeral({ ...scheduleAckFrame(this.now(), f.id), applied: true })
  const conflict = /changed on your/i.test(done?.text ?? '')
  this.err(
    conflict ? 'schedule_conflict' : 'scheduler_unavailable',
    done?.text ?? 'The scheduler could not do that.',
    f.id,
  )
}

/**
 * The date a Run now offer shows: the job's own `once` date, else today's date in the scheduler's zone. Display only: the
 * claim passes ds:null, so Chronos's date_key decides what is actually claimed (S3.3 N12).
 */
export function runNowDay(this: ScheduleService, job: ScheduleT): string {
  if (job.when.type === 'once') return job.when.at.slice(0, 10)
  const tz = this.lastGood?.health.tz ?? localZone(this.ctx.env)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(this.now()))
}

/** Why a job could not be started now: the owner's Run now shows it as an error frame, Main's `schedule_rerun` as the tool's answer. */
export type RunNowOutcome =
  | { ok: true }
  | { ok: false; code: ErrorCodeT; message: string; fields?: Array<{ path: string; message: string }> }

/**
 * The rules of "run this job now", shared by the owner's Run now and Main's `schedule_rerun`: bounded by the claim, never a card.
 * Held, already running, the heartbeat test gate, and where it may run.
 */
export async function startRunNow(
  this: ScheduleService,
  job: ScheduleT,
  d: Discovered,
  o: { where: Of<'schedule.run_now'>['where']; again: boolean },
): Promise<RunNowOutcome> {
  const refuse = (
    code: ErrorCodeT,
    message: string,
    fields?: Array<{ path: string; message: string }>,
  ): RunNowOutcome => ({ ok: false, code, message, ...(fields ? { fields } : {}) })
  if (job.today === 'held') return refuse('held', 'The job is on hold because its files changed outside the app.')
  if (job.today === 'running') return refuse('already_running', 'That job is already running.')
  // A heartbeat is never an agent run: Run now always means "check now", in this bridge, whatever the job's runner says.
  const isHeartbeat = heartbeatConfigFromMeta(job.meta) !== null
  // ...and Run now is not a way round the test gate: a heartbeat that is OFF needs the same fresh pass that turning it on needs.
  if (isHeartbeat) {
    const needTest = runNowProblem(this.ctx.paths.home, this.now(), job)
    if (needTest) return refuse('schedule_invalid', needTest, [{ path: TEST_REQUIRED_FIELD, message: needTest }])
  }
  const sessionable = isHeartbeat || (job.permissions !== 'restricted' && job.kind === 'claude')
  if (!isHeartbeat && o.where === 'session' && (!sessionable || job.runner === 'both'))
    return refuse('schedule_read_only', "That job can't run in the live session (read-only or restricted).")
  const inSession = isHeartbeat || job.runner === 'session' || o.where === 'session'
  if (inSession) {
    if (!sessionable) return refuse('schedule_read_only', "That job can't run in the live session.")
    const ds = this.runNowDay(job)
    const r = await this.offer(job.id, ds, null, null, 'run_now', o.again)
    if (!r.ok) {
      if (r.testRequired)
        return refuse('schedule_invalid', r.testRequired, [{ path: TEST_REQUIRED_FIELD, message: r.testRequired }])
      return refuse(
        r.code === 'held' ? 'held' : r.code,
        r.code === 'held' ? 'The job is on hold.' : 'The scheduler refused that job.',
      )
    }
  } else {
    const r = await d.adapter.startHeadless(job.id, { again: o.again })
    if (!r.ok) {
      return refuse(r.code, r.message)
    }
  }
  return { ok: true }
}

/** Run now (S3.3 "Run now in the session", S8.3): bounded by the claim, never a card. */
export async function onRunNow(this: ScheduleService, f: Of<'schedule.run_now'>, d: Discovered) {
  if (this.stale(f)) return this.err('stale', 'That request is too old. Try again.', f.id)
  const snap = await this.safeSnapshot()
  const ro = this.readOnly(d, snap)
  if (ro) return this.err('schedule_read_only', ro, f.id)
  const job = snap.schedules.find((s) => s.id === f.schedule_id)
  if (!job) return this.err('schedule_not_found', `No scheduled job "${f.schedule_id}".`, f.id)
  const r = await this.startRunNow(job, d, { where: f.where, again: f.again })
  if (!r.ok) return this.err(r.code, r.message, f.id, r.fields)
  this.ack(f.id)
  await this.refresh()
}

export async function onControl(this: ScheduleService, f: Of<'schedule.control'>, d: Discovered) {
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
export function startProbe(this: ScheduleService, adapter: SchedulerAdapter) {
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
