// `wake_me` (docs/OPTION-C.md "Wake me"): an agent sets a one-shot timer with a note to itself, can then be parked, and at the
// time the bridge wakes it with the note. The timer is a one-shot (`once`) job in the scheduler, written by the bridge without a
// card: it only ever wakes the session that set it, in its own thread, and carries nothing but its note. The bridge's own row
// (store.ts) is what makes a job a wake. When it is due, the runner hands it here instead of offering a `schedule_run`: the
// note goes out as `kind=wake`, `trust=agent` (its own earlier words, never the owner's), then the job and the row are deleted.
//
// Everything that writes runs in the schedule service's serial queue, so a fire, a cancel and a set never overlap; each state
// change is also one conditional row update, so a second process or a retry can't deliver a wake twice or lose one.
import { randomBytes } from 'node:crypto'
import {
  isWakeJobId,
  MAX_SCHEDULES_PER_SNAPSHOT,
  newUlid,
  type PendingWakeT,
  ScheduleChange,
  toChronosChange,
  visibleMetaText,
  WAKE_FIRES_PER_DAY,
  WAKE_FIRES_PER_HOUR,
  WAKE_ID_PREFIX,
  WAKE_JOB_NAME,
  WAKE_JOB_PROMPT,
  WAKE_MAX_DAYS,
  WAKE_MAX_PENDING,
  WAKE_NOTE_MAX,
  WAKE_STATUS_MAX,
  WAKE_WARN_DAYS,
  WAKE_WARN_PENDING,
  WakeId,
} from '@talos-app/protocol'
import { postSystemNotice, threadRef } from '../context.ts'
import { wakeNotification } from '../notify.ts'
import type { ClosedAdapter } from '../schedules/closed-adapter.ts'
import type { ScheduleService } from '../schedules/service.ts'
import { fail, type ToolOut, yes } from '../schedules/service-shared.ts'
import { OPEN_WAKE_STATES, WakeMeStore, type WakeRow } from './store.ts'
import { askedInstant, wallOf } from './time.ts'

/** Whose wake: the main session's own, or the thread session of `thread` (proven by the hub, never named by the caller). */
export type WakeLane = { kind: 'main' } | { kind: 'thread'; thread: string }
export const laneKey = (l: WakeLane): string => (l.kind === 'main' ? 'main' : l.thread)

const MIN = 60_000
const DAY = 24 * 3600_000
/** The scheduler may still start a one-shot this long after its time (the most it allows): a Mac that slept still wakes. */
export const WAKE_CATCHUP_MIN = 1440
/** A wake still pending this long past its time was missed by the scheduler (asleep past the window, Talos off): sent late. */
const LATE_AFTER_MS = WAKE_CATCHUP_MIN * MIN + 3 * MIN
/** A row left in `creating` this long (a crash mid-set) is settled against the scheduler. */
const CREATING_STALE_MS = 5 * MIN
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function newWakeId(): string {
  const b = randomBytes(12)
  let s = ''
  for (const x of b) s += ID_ALPHABET[x % ID_ALPHABET.length]
  return `${WAKE_ID_PREFIX}${s}`
}

/**
 * The note as it is kept, shown and delivered: one line (newlines and tabs become spaces), every hidden, control or bidi
 * character escaped visibly. Refused when empty or over WAKE_NOTE_MAX characters once shown that way.
 */
export function cleanNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (typeof raw !== 'string')
    return { ok: false, error: '`note` is required: a short line to yourself (what to do on waking). Nothing was set.' }
  const one = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (!one) return { ok: false, error: '`note` is empty. Say what you mean to do when you wake. Nothing was set.' }
  const shown = visibleMetaText(one)
  const n = [...shown].length
  if (n > WAKE_NOTE_MAX)
    return {
      ok: false,
      error: `\`note\` is ${n} characters once hidden characters are shown; ${WAKE_NOTE_MAX} at most. Nothing was set.`,
    }
  return { ok: true, note: shown }
}

export class WakeMe {
  readonly store: WakeMeStore

  constructor(private readonly svc: ScheduleService) {
    this.store = new WakeMeStore(svc.ctx.store.db)
  }

  private get ctx() {
    return this.svc.ctx
  }

  private zone(): string {
    return this.svc.lastGood?.health.tz ?? this.ctx.config.config.timezone ?? 'UTC'
  }

  /** "Thu 9:00 AM (2026-12-24T09:00, Europe/Berlin)" */
  private when(ms: number): string {
    const zone = this.zone()
    let short = new Date(ms).toISOString()
    try {
      short = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: zone,
      }).format(new Date(ms))
    } catch {
      // an unknown zone: the ISO instant alone
    }
    return `${short} (${wallOf(ms, zone)}, ${zone})`
  }

  // ---- set -------------------------------------------------------------------------------------------------------

  /** The agent's `wake_me`: set a one-shot wake for `lane`. Limits past the soft ceilings are warnings, not refusals. */
  async set(lane: WakeLane, args: Record<string, unknown>): Promise<ToolOut> {
    const note = cleanNote(args.note)
    if (!note.ok) return fail(note.error)
    if (lane.kind === 'thread' && !this.ctx.config.thread(lane.thread))
      return fail(`Thread "${lane.thread}" no longer exists. Nothing was set.`)
    return this.svc.enqueue(async () => {
      const d = await this.svc.ensure()
      if (d.state !== 'ready')
        return fail(
          `${(d.adapter as ClosedAdapter).agentText()} wake_me needs the scheduler. Nothing was set; tell the owner if you must wait.`,
        )
      const snap = this.svc.lastGood ?? (await this.svc.safeSnapshot())
      if (!this.svc.managed(snap))
        return fail(
          'Talos does not manage this scheduler yet, so it cannot set a wake. Nothing was set; tell the owner if you must wait.',
        )
      const now = this.svc.now()
      const zone = this.zone()
      const asked = askedInstant({ at: args.at, inMinutes: args.in_minutes }, now, zone)
      if (!asked.ok) return fail(`${asked.error} Nothing was set.`)
      const ms = asked.ms
      if (ms <= now) return fail(`${this.when(ms)} has already passed. Nothing was set.`)
      if (ms - now > WAKE_MAX_DAYS * DAY) return fail(`That is more than ${WAKE_MAX_DAYS} days ahead. Nothing was set.`)
      const key = laneKey(lane)
      const paused = this.pausedUntil(key, now)
      if (paused !== null)
        return fail(
          `Warning: this session has woken itself ${WAKE_FIRES_PER_HOUR} times in an hour or ${WAKE_FIRES_PER_DAY} in a day, so its wakes are paused until ${this.when(paused)}. Nothing was set. Wait longer between wakes, or tell the owner.`,
        )
      const thread = lane.kind === 'thread' ? lane.thread : this.ctx.config.config.default_thread
      const id = newWakeId()
      const before = this.store.reserve(
        { id, lane: key, thread_id: thread, at: ms, note: note.note, set_at: now },
        WAKE_MAX_PENDING,
      )
      if (before === null)
        return fail(
          `There are already ${WAKE_MAX_PENDING} wakes pending across all sessions, the most there can be. Cancel some of yours (wake_me with \`cancel\`) first. Nothing was set.`,
        )
      const written = await this.writeJob(id, lane, ms, zone)
      if (!written.ok) {
        this.store.remove(id, ['creating'])
        return fail(`${written.error} Nothing was set.`)
      }
      const at = written.at ?? ms
      this.store.move(id, ['creating'], 'pending', now, at)
      const warnings: string[] = []
      if (asked.note) warnings.push(asked.note)
      if (written.at !== undefined && Math.abs(written.at - ms) >= MIN)
        warnings.push(`the scheduler will fire it at ${this.when(written.at)}, not ${this.when(ms)}.`)
      if (at - now > WAKE_WARN_DAYS * DAY)
        warnings.push(
          `that is more than ${WAKE_WARN_DAYS} days ahead. It is set; check the owner still wants you then, or cancel it.`,
        )
      if (before + 1 > WAKE_WARN_PENDING)
        warnings.push(
          `this session now has ${before + 1} wakes pending (more than ${WAKE_WARN_PENDING}). It is set; cancel the ones you no longer need.`,
        )
      const mins = Math.max(1, Math.round((at - now) / MIN))
      const lines = [
        `Set: wake ${id} at ${this.when(at)}, in about ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`}.`,
        'One-shot: it wakes this session (starting it if parked) with your note as a kind=wake line, then it is gone. You can stop working or be parked meanwhile.',
        `Cancel: wake_me with {"cancel":"${id}"}.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ]
      return yes(lines.join('\n'))
    })
  }

  /** Writes the scheduler's one-shot job for a wake (no card: the bridge writes it), and binds it to its thread. */
  private async writeJob(
    id: string,
    lane: WakeLane,
    ms: number,
    zone: string,
  ): Promise<{ ok: true; at?: number } | { ok: false; error: string }> {
    const adapter = this.svc.adapter
    // a fixed name and prompt: nothing of the note reaches the scheduler, where an older bridge could read it as the owner's job
    const name = WAKE_JOB_NAME
    const parsed = ScheduleChange.safeParse({
      op: 'create',
      draft: {
        id,
        name,
        description: `A one-shot wake_me timer ${lane.kind === 'main' ? 'the main session' : 'this thread’s session'} set for itself. The bridge delivers it and deletes it.`,
        when: { type: 'once', at: wallOf(ms, zone) },
        catchup_min: WAKE_CATCHUP_MIN,
        enabled: true,
        runner: 'session',
        permissions: 'full',
        allowed_tools: [],
        model: null,
        notify: 'never',
        thread_id: lane.kind === 'thread' ? lane.thread : null,
        prompt: WAKE_JOB_PROMPT,
      },
    })
    if (!parsed.success) return { ok: false, error: 'The wake could not be written as a scheduler job.' }
    const split = toChronosChange(parsed.data)
    try {
      const v = await adapter.validate(split.chronos)
      if (!v.ok)
        return {
          ok: false,
          error: `The scheduler refused it: ${v.errors
            .map((e) => e.message)
            .join('; ')
            .slice(0, 300)}.`,
        }
      const r = await adapter.apply(v.normalized, v.expectedEtag)
      if (!r.ok) return { ok: false, error: `The scheduler refused it: ${r.message.slice(0, 300)}.` }
    } catch (e) {
      return { ok: false, error: `The scheduler did not answer (${(e as Error).message.slice(0, 200)}).` }
    }
    // The thread the job shows under in Schedules; the wake itself is delivered by its row, so a refused write costs only that.
    if (lane.kind === 'thread' && !this.svc.sidecar.setThread(id, lane.thread))
      this.svc.log('wake job thread not recorded', { job: id })
    this.svc.chronos()?.invalidate()
    let at: number | undefined
    try {
      const x = await adapter.detail(id, null)
      const next = x?.detail.next_runs[0]
      if (next) at = Date.parse(next)
    } catch {
      // the time asked for stands
    }
    return { ok: true, ...(at !== undefined && Number.isFinite(at) ? { at } : {}) }
  }

  // ---- cancel ----------------------------------------------------------------------------------------------------

  /** Cancels one pending wake. `by` is the lane asking (it may cancel only its own) or the owner (any). */
  cancel(id: unknown, by: WakeLane | 'owner'): Promise<ToolOut> {
    if (typeof id !== 'string' || !WakeId.safeParse(id).success)
      return Promise.resolve(fail(`"${String(id).slice(0, 40)}" is not a wake id (they look like ${WAKE_ID_PREFIX}…).`))
    return this.svc.enqueue(async () => {
      const row = this.store.get(id)
      if (!row) return fail(`No pending wake ${id}. It may have fired or been cancelled already.`)
      if (by !== 'owner' && row.lane !== laneKey(by))
        return fail(`Wake ${id} is not this session's. A session can cancel only its own wakes. Nothing was cancelled.`)
      if (row.state === 'firing' || row.state === 'fired') return fail(`Wake ${id} has already fired.`)
      const gone = await this.deleteJob(id)
      if (!gone.ok) return fail(`Wake ${id} was not cancelled: ${gone.error}`)
      if (!this.store.remove(id, OPEN_WAKE_STATES)) return fail(`Wake ${id} fired before it could be cancelled.`)
      return yes(`Cancelled wake ${id} (it was due ${this.when(row.at)}).`)
    })
  }

  /** Deletes the scheduler's job for a wake; a job that is already gone counts as deleted. */
  private async deleteJob(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const adapter = this.svc.adapter
    try {
      const x = await adapter.detail(id, null)
      if (x) {
        const v = await adapter.validate({ op: 'delete', id, base_etag: x.detail.schedule.etag })
        if (!v.ok && v.code !== 'schedule_not_found')
          return {
            ok: false,
            error: `the scheduler refused to delete it (${v.errors
              .map((e) => e.message)
              .join('; ')
              .slice(0, 200)}).`,
          }
        if (v.ok) {
          const r = await adapter.apply(v.normalized, v.expectedEtag)
          if (!r.ok && r.code !== 'schedule_not_found')
            return { ok: false, error: `the scheduler refused to delete it (${r.message.slice(0, 200)}).` }
        }
      }
    } catch (e) {
      return { ok: false, error: `the scheduler did not answer (${(e as Error).message.slice(0, 200)}).` }
    }
    this.svc.sidecar.forgetJob(id)
    this.svc.chronos()?.invalidate()
    return { ok: true }
  }

  // ---- firing (inside the schedule queue) ---------------------------------------------------------------------------

  /**
   * The runner found a wake job due (or the owner pressed Run now). Never offered as a `schedule_run`: a job in the wake range
   * that this bridge has no row for is not a wake it set, so it is not delivered at all, and it is deleted.
   */
  async onDue(
    id: string,
  ): Promise<{ ok: true; runId: string } | { ok: false; code: 'schedule_not_found' | 'schedule_invalid' }> {
    const row = this.store.get(id)
    if (!row) {
      this.ctx.log.security('a scheduler job in the wake range has no wake record; not delivered, deleted', { job: id })
      await this.deleteJob(id)
      return { ok: false, code: 'schedule_not_found' }
    }
    if (row.state === 'fired') {
      await this.finish(row)
      return { ok: false, code: 'schedule_not_found' }
    }
    if (row.state === 'creating') return { ok: false, code: 'schedule_invalid' }
    return (await this.deliver(row, false))
      ? { ok: true, runId: `r_${newUlid()}` }
      : { ok: false, code: 'schedule_invalid' }
  }

  /** Sends the note once: pending -> firing -> (sent) -> fired, then the job and the row go. A send that throws goes back to pending. */
  private async deliver(row: WakeRow, late: boolean): Promise<boolean> {
    const now = this.svc.now()
    if (row.state === 'pending' && !this.store.move(row.id, ['pending'], 'firing', now)) return false
    const forMain = row.lane === 'main'
    // a thread session's wake keeps its own thread whatever became of it: the router drops one that session can't take
    const thread =
      !forMain || this.ctx.config.thread(row.thread_id) ? row.thread_id : this.ctx.config.config.default_thread
    const paused = this.pausedUntil(row.lane, now)
    if (paused !== null) {
      // waking itself too often: dropped, not sent, and the owner is told once per pause
      this.store.move(row.id, ['firing'], 'fired', now)
      await this.tellPaused(row, paused)
      await this.finish({ ...row, state: 'fired' })
      return false
    }
    try {
      await this.ctx.emit(
        wakeNotification({
          thread: threadRef(this.ctx, thread),
          messageId: `wk_${newUlid()}`,
          wakeId: row.id,
          note: row.note,
          setAt: new Date(row.set_at).toISOString(),
          due: new Date(row.at).toISOString(),
          late,
          forMain,
          ts: new Date(now).toISOString(),
        }),
      )
    } catch (e) {
      this.store.move(row.id, ['firing'], 'pending', now)
      this.svc.log('wake not delivered; trying again next tick', { wake: row.id, error: (e as Error).message })
      return false
    }
    this.store.move(row.id, ['firing'], 'fired', now)
    this.store.recordFire(row.lane, now)
    await this.finish({ ...row, state: 'fired' })
    return true
  }

  /**
   * When a lane that has fired WAKE_FIRES_PER_HOUR wakes in the last hour, or WAKE_FIRES_PER_DAY in the last day, may fire
   * again (its oldest fire in that window leaves it), or null when it may now.
   */
  pausedUntil(lane: string, now: number): number | null {
    const hour = this.store.firesSince(lane, now - 3600_000)
    const day = this.store.firesSince(lane, now - DAY)
    let until: number | null = null
    if (hour.length >= WAKE_FIRES_PER_HOUR) until = (hour[hour.length - WAKE_FIRES_PER_HOUR] as number) + 3600_000
    if (day.length >= WAKE_FIRES_PER_DAY)
      until = Math.max(until ?? 0, (day[day.length - WAKE_FIRES_PER_DAY] as number) + DAY)
    return until
  }

  /** One line in the session's thread per pause: "<thread> keeps waking itself; wakes paused until <time>". */
  private async tellPaused(row: WakeRow, until: number) {
    const key = `wake_paused_told:${row.lane}`
    if (Number(this.ctx.store.kvGet(key)) >= until) return
    this.ctx.store.kvSet(key, String(until))
    const where = row.lane === 'main' ? this.ctx.config.config.default_thread : row.thread_id
    const who =
      row.lane === 'main' ? 'The main session' : `The "${threadRef(this.ctx, row.thread_id).name}" thread's session`
    try {
      await postSystemNotice(
        this.ctx,
        `${who} keeps waking itself; its wakes are paused until ${this.when(until)}. One was dropped.`,
        { thread: threadRef(this.ctx, this.ctx.config.thread(where) ? where : this.ctx.config.config.default_thread) },
      )
    } catch (e) {
      this.svc.log('wake pause notice not posted', { error: (e as Error).message })
    }
  }

  /** A fired wake: its job is deleted, then its row. A job that won't delete is tried again on the next tick. */
  private async finish(row: WakeRow) {
    const gone = await this.deleteJob(row.id)
    if (!gone.ok) {
      this.svc.log('fired wake job not deleted; trying again next tick', { wake: row.id, error: gone.error })
      return
    }
    this.store.remove(row.id, ['fired'])
  }

  /**
   * Each runner tick, after the due jobs: settles what a crash or a missed window left. A row stuck in `creating` is kept when
   * its job exists, else dropped; one stuck in `firing` is sent again (a crash after the send can repeat a wake, never lose
   * one); a fired one has its job deleted; one the scheduler missed (asleep past its window) is sent late; one whose job the
   * owner deleted in Schedules is dropped.
   */
  async sweep(): Promise<void> {
    const now = this.svc.now()
    for (const row of this.store.inState('creating')) {
      if (now - row.changed_at < CREATING_STALE_MS) continue
      const x = await this.svc.adapter.detail(row.id, null).catch(() => undefined)
      if (x === undefined) continue // the scheduler did not answer: next tick
      if (x) this.store.move(row.id, ['creating'], 'pending', now)
      else this.store.remove(row.id, ['creating'])
    }
    for (const row of this.store.inState('firing')) await this.deliver(row, false)
    for (const row of this.store.inState('fired')) await this.finish(row)
    const snap = this.svc.lastGood
    for (const row of this.store.inState('pending')) {
      if (now - row.at > LATE_AFTER_MS) {
        await this.deliver(row, true)
        continue
      }
      // gone from a whole snapshot taken after it was set: the owner deleted it in Schedules
      if (
        snap &&
        snap.schedules.length < MAX_SCHEDULES_PER_SNAPSHOT &&
        Date.parse(snap.as_of) > row.changed_at + MIN &&
        !snap.schedules.some((j) => j.id === row.id) &&
        !snap.unreadable.some((u) => u.id === row.id)
      )
        this.store.remove(row.id, ['pending'])
    }
  }

  // ---- lists -----------------------------------------------------------------------------------------------------

  /** A lane's pending wakes for `workers.status`: soonest first, at most WAKE_STATUS_MAX, and the total. */
  pendingFor(lane: string): { wakes: PendingWakeT[]; total: number } {
    return pendingOf(this.store, lane)
  }

  /** Lines for `schedules_list`: the asking lane's own wakes (main: its own and those of threads that went back to it). */
  listText(lane: WakeLane): string {
    const rows = this.store.open(laneKey(lane))
    if (rows.length === 0) return 'Pending wakes (wake_me): none.'
    return [
      `Pending wakes (wake_me), ${rows.length}:`,
      ...rows.map((r) => `- ${r.id} at ${this.when(r.at)}: ${r.note}`),
    ].join('\n')
  }
}

/** Shared by the service and the router's status (which reads the table directly). */
export function pendingOf(store: WakeMeStore, lane: string): { wakes: PendingWakeT[]; total: number } {
  const rows = store.open(lane)
  return {
    wakes: rows.slice(0, WAKE_STATUS_MAX).map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      note: r.note,
      set_at: new Date(r.set_at).toISOString(),
    })),
    total: rows.length,
  }
}

export { isWakeJobId }
