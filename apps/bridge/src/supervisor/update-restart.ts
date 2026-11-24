// Restart on update (Linux), Delphi's behaviour list and Pantheon's trigger: right after the supervisor starts, and whenever the
// release it runs (its own commit and the kit's: releaseId) differs from the one recorded at the last check, each running
// thread session whose launch spec changed (launch-spec.ts; the hash a dry plan gives now against WorkerLaunched.spec_hash: a
// release, or the thread's own instruction files) is restarted ONCE for that spec, resuming its conversation, one at a time,
// and never by cutting into the owner: only while it is quiet as an idle park reads it (no turn, nothing owed or held for it,
// nothing on the pane asking the owner, no draft in its box, no key in an attached client lately), so one that is always busy
// simply waits. The spec it was tried for is written BEFORE the try (update_tried_hash, kept across the start it gives), so no
// spec is tried twice. It holds while the usage governor is not ok, off or unknown (no usage reading yet) in a live bridge's fresh status.json, and does
// nothing while dedicated.restart_on_update is off. A dry plan refused, a start that fails or a restart that never comes back
// leaves the session alone (never retried; the last is said as not restarted, not as failed). The owner gets one line in the
// default thread (updateRestartLine), and a line of its own for what happens after that one was said. None of these restarts
// count as crashes or toward an hourly cap.
import { join } from 'node:path'
import { updateRestartLine, WORKER_TIMING } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { draftPresent } from './screen.ts'
import { onScreenAsk } from './worker-cap.ts'
import { readSmallFile } from './worker-dialogs.ts'
import { stuck } from './worker-launch.ts'
import type { WorkerRuntime } from './worker-types.ts'
import type { WorkerManager } from './workers.ts'

/** How often the release is compared with the last check's (a kit or hook release can land without a supervisor restart). */
export const UPDATE_RELEASE_POLL_S = 60
/** A key in an attached client this recently: the owner may be typing, so no restart (the screen may not show it). */
export const UPDATE_KEYS_QUIET_S = 120
/** A restart that has not come back by then is given up (never retried): the queue moves on (Fable R1-4). */
export const UPDATE_RESTART_GIVE_UP_S = WORKER_TIMING.park_grace_s + WORKER_TIMING.ready_s + 60
/** The queue's own record (0600): the release seen at the last check that ran. */
export const UPDATE_STATE_FILE = 'update-restart.json'
/** Any value for the dry plan's nonce: the spec never holds it. */
const DRY_NONCE = '0'.repeat(32)

type Current = { id: string; startedAt: string | null; since: number }

export class UpdateRestarts {
  private started = false
  private lastPoll: number | null = null
  private queue: Array<{ id: string; hash: string }> = []
  private current: Current | null = null
  /** Results not yet said, and the waiting ones already named (a result after a line gets its own: Fable R1-1). */
  private restarted: string[] = []
  private failed: string[] = []
  private notRestarted: string[] = []
  private waitingNow = new Set<string>()
  private waitingSaid = new Set<string>()
  private offSaid = false
  private heldSaid: string | null = null
  /** The release this process last recorded, kept here too: an unwritable state file never makes a check repeat. */
  private recorded: string | null = null
  private stateWarned = false

  constructor(private readonly m: WorkerManager) {}

  /** One tick, inside the manager's own (after its sessions have advanced). `pending`: a session still being adopted. */
  async tick(pending: (id: string) => boolean): Promise<void> {
    const d = this.m.d
    const on = d.restartOnUpdate?.() ?? null
    if (on === null) return // config.json cannot be read: nothing this round
    if (!on) {
      if (!this.offSaid) d.audit('update_restart_off')
      this.offSaid = true
      this.queue = []
      this.waitingNow = new Set() // none of them restarts now: never named after it is on again
      return
    }
    this.offSaid = false
    this.settleCurrent()
    this.maybeCheck(pending)
    if (this.current || this.queue.length === 0) return this.sayIfDone()
    // the governor: only while a live bridge says ok, off or unknown (no usage reading yet: a start is allowed then, so a restart is
    // too); a paused governor must not have sessions started into it, and no live status at all (null) is no reading
    const g = d.updateGovernor?.() ?? null
    if (g !== 'ok' && g !== 'off' && g !== 'unknown') {
      if (this.heldSaid !== String(g)) d.audit('update_restart_held', { governor: String(g) })
      this.heldSaid = String(g)
      return
    }
    this.heldSaid = null
    await this.next(pending)
  }

  /** Right after a start, then whenever the release differs from the last check's: a check (Pantheon's trigger). */
  private maybeCheck(pending: (id: string) => boolean): void {
    const d = this.m.d
    const now = d.now()
    if (!this.started) {
      // the first check, at each tick until one can run (cheap while there is no thread or no login environment); the release,
      // which reads the kit's files, only once it ran
      if (!this.check(pending)) return
      this.started = true
      this.lastPoll = now
      const release = d.releaseId?.() ?? null
      if (release !== null) this.recordRelease(release)
      return
    }
    if (this.lastPoll !== null && now - this.lastPoll < UPDATE_RELEASE_POLL_S) return
    this.lastPoll = now
    const release = d.releaseId?.() ?? null
    if (release === null || release === this.lastRelease()) return
    // recorded only once a check really ran (Fable R1-5): one that could not run is tried again at the next poll
    if (!this.check(pending)) return
    this.recordRelease(release)
  }

  /** Which running sessions run an older spec than the one a start would give them now. False: it could not look yet. */
  private check(pending: (id: string) => boolean): boolean {
    const d = this.m.d
    const baseEnv = d.loginEnv.current()
    if (!baseEnv || this.m.known.length === 0 || [...this.m.workers.keys()].some(pending)) return false
    // a check that finds work with nothing under way starts a new round
    if (this.queue.length === 0 && !this.current) this.waitingSaid = new Set()
    for (const w of this.m.workers.values()) {
      if (w.entry.state !== 'live' && w.entry.state !== 'busy') continue
      if (this.queue.some((q) => q.id === w.id) || this.current?.id === w.id) continue
      const t = this.m.known.find((x) => x.id === w.id)
      if (!t || w.entry.session_id === null) continue
      const plan = d.plan({
        thread: t,
        sessionId: w.entry.session_id,
        resume: true,
        nonce: DRY_NONCE,
        baseEnv,
        dry: true,
      })
      // refused now, or no hash: what a start would do is not known, so the session is left as it is
      if ('refused' in plan || plan.specHash === undefined) continue
      const launched = w.entry.launched
      if (launched?.spec_hash === plan.specHash || launched?.update_tried_hash === plan.specHash) continue
      this.queue.push({ id: w.id, hash: plan.specHash })
      d.audit('update_restart_queued', { thread: w.id })
    }
    return true
  }

  /** The head of the queue, restarted once it is quiet; a busy one waits (and is named) without holding the others. */
  private async next(pending: (id: string) => boolean): Promise<void> {
    const head = this.queue[0] as { id: string; hash: string }
    const w = this.m.workers.get(head.id)
    if (!w || pending(head.id) || (w.entry.state !== 'live' && w.entry.state !== 'busy')) {
      this.queue.shift() // gone, parked or stopped meanwhile: its next start takes the new spec anyway
      this.waitingNow.delete(this.name(head.id))
      return
    }
    if (!(await this.quiet(w))) {
      this.waitingNow.add(this.name(w.id))
      if (this.queue.length > 1) this.queue.push(this.queue.shift() as { id: string; hash: string })
      return this.sayIfDone()
    }
    this.queue.shift()
    this.waitingNow.delete(this.name(w.id))
    // the spec this restart is for, written down BEFORE the try: never a second try for the same spec (an entry with no launch
    // record, from a build before one, has nowhere to keep it: its restart writes one with the new spec, which then matches)
    const launched = w.entry.launched
    if (launched) {
      w.entry = { ...w.entry, launched: { ...launched, update_tried_hash: head.hash } }
      this.m.dirty = true
      this.m.publish()
    }
    this.current = { id: w.id, startedAt: w.entry.started_at ?? null, since: this.m.d.now() }
    this.m.d.audit('update_restart', { thread: w.id })
    // as restart() does, inside this tick: parked, then started again on the same conversation (a resume)
    w.afterPark = { fresh: false }
    this.m.beginEnd(w.id, 'parked', 'restart')
  }

  /**
   * Quiet as an idle park reads it, and more (Fable R1-2): live and not in a turn, no park waiting, nothing on the pane or in
   * its notes asking the owner, no pointer owed or held, no draft in its box, no key in an attached client lately, and the pane
   * readable, and no background work under it (a restart would cut it). Anything that cannot be read, the process table included,
   * is not quiet.
   */
  private async quiet(w: WorkerRuntime): Promise<boolean> {
    if (w.entry.state !== 'live' || w.turnWait || stuck(w) || w.owed.pending || w.heldFor) return false
    if (w.notes.needsYou !== null || w.notes.promptWatch.current !== null || w.entry.dialog !== undefined) return false
    const host = w.host
    if (!host || (await this.m.slots.isBusy(w))) return false
    if ((this.m.slots.background(w)?.count ?? 1) > 0) return false // work running, or a table that could not be read
    const rows = await host.visibleRows()
    if (!rows || onScreenAsk(rows)) return false
    const escaped = await host.visibleRowsEscaped()
    if (!escaped || draftPresent(escaped) !== false) return false
    const clients = await host.clientActivities()
    if (clients === null) return false
    const nowMs = this.m.d.wallMs()
    return !clients.some((k) => nowMs - k < UPDATE_KEYS_QUIET_S * 1000)
  }

  /** The restart under way: done once the session started again; failed once its start failed, or it never came back. */
  private settleCurrent(): void {
    const c = this.current
    if (!c) return
    const w = this.m.workers.get(c.id)
    const s = w?.entry.state ?? 'off'
    if (s === 'failed' || s === 'off') {
      this.failed.push(this.name(c.id))
      this.m.d.audit('update_restart_failed', { thread: c.id, state: s })
    } else if ((s === 'live' || s === 'busy') && (w?.entry.started_at ?? null) !== c.startedAt) {
      this.restarted.push(this.name(c.id))
    } else if (this.m.d.now() - c.since >= UPDATE_RESTART_GIVE_UP_S) {
      // parked and never started again (no login environment, a start held): given up, never retried (Fable R1-4), and said
      // as not restarted, not as failed (nothing failed: it is parked, and its next start takes the new spec)
      this.notRestarted.push(this.name(c.id))
      this.m.d.audit('update_restart_given_up', { thread: c.id, state: s, after_s: String(UPDATE_RESTART_GIVE_UP_S) })
    } else return // still on its way down or up
    this.current = null
  }

  /**
   * Once every queued session is restarted, failed or waiting for its turn: one line with what is new since the last one (the
   * restarted, the failed, and the waiting not named yet); nothing when nothing is new.
   */
  private sayIfDone(): void {
    if (this.current) return
    if (this.queue.some((q) => !this.waitingNow.has(this.name(q.id)))) return
    const waiting = [...this.waitingNow].filter((n) => !this.waitingSaid.has(n))
    const line = updateRestartLine({
      restarted: this.restarted,
      waiting,
      failed: this.failed,
      notRestarted: this.notRestarted,
    })
    if (!line) return
    const thread = this.m.d.defaultThread?.() ?? null
    if (thread) void this.m.d.post?.(thread, line)
    this.m.d.audit('update_restart_said', {
      restarted: String(this.restarted.length),
      waiting: String(waiting.length),
      failed: String(this.failed.length),
      not_restarted: String(this.notRestarted.length),
    })
    for (const n of waiting) this.waitingSaid.add(n)
    this.restarted = []
    this.failed = []
    this.notRestarted = []
  }

  private lastRelease(): string | null {
    if (this.recorded !== null) return this.recorded
    const f = readSmallFile(join(this.m.d.home, UPDATE_STATE_FILE), 4096)
    if (f.kind !== 'data') return null
    try {
      const j = JSON.parse(f.text) as { v?: unknown; release?: unknown }
      return j.v === 1 && typeof j.release === 'string' ? j.release : null
    } catch {
      return null
    }
  }

  private recordRelease(release: string): void {
    this.recorded = release
    try {
      writeFileAtomic(join(this.m.d.home, UPDATE_STATE_FILE), JSON.stringify({ v: 1, release }), 0o600)
      this.stateWarned = false
    } catch (e) {
      // once: the release is kept in memory, so this process does not check again for it (a restart of the supervisor does)
      if (!this.stateWarned)
        this.m.d.audit('update_restart_state_not_written', { error: String((e as Error)?.message ?? e) })
      this.stateWarned = true
    }
  }

  private name(id: string): string {
    return this.m.known.find((t) => t.id === id)?.name ?? id
  }
}
