// The manager's side of the idle park, the live cap and the park after the turn (P3d3, parts 5 and 6; the Mac's WorkerIdle.swift,
// WorkerManager.liveList, requestStart, retryHeld, enforceCap, requestPark and armStopLimit). The rules are the pure functions of
// worker-idle.ts and worker-cap.ts; this applies them to the manager's workers through the few moves it is handed. It runs on
// the manager's serial queue (workers.ts), like everything else there.

import { DEFAULT_IDLE_PARK_MIN, DEFAULT_MAX_LIVE, WORKER_LIVE_STATES, WORKER_TIMING } from '@talos-app/protocol'
import { type BgFound, cutLine, found, NO_BG, type Proc, procArgv, procTable } from './bg-work.ts'
import { NOTHING_OWED } from './owed-pointer.ts'
import {
  capVictims,
  holdExpired,
  type Live,
  onScreenAsk,
  parkAfterTurn,
  planStart,
  SLOT_STATES,
  type TurnWait,
  waitsOnOwner,
} from './worker-cap.ts'
import { activeNow, idleLimitPassed, idleParkDue, noteScreen, readsBusy, wallJump } from './worker-idle.ts'
import { turnLook, withStopped } from './worker-status.ts'
import type { WorkerRuntime } from './workers.ts'

/** What WorkerSlots needs of the manager. */
export type SlotDeps = {
  workers(): Iterable<WorkerRuntime>
  get(id: string): WorkerRuntime | undefined
  /** Still a dedicated thread, and its idle time (minutes; none: the default). */
  thread(id: string): { idleParkMin?: number } | undefined
  /** Its old session is still being looked for (adoption): hands off. */
  pending(id: string): boolean
  now(): number
  wallMs(): number
  audit(event: string, fields?: Record<string, string>): void
  beginEnd(id: string, endAs: 'parked' | 'off', why: string): void
  startNow(id: string, opts: { fresh?: boolean; forPointer?: boolean }): Promise<void>
  move(w: WorkerRuntime, to: 'stopping'): boolean
  /** One look at the pane for what it says to the owner (it leaves the rows in `w.rows`). */
  lookAt(w: WorkerRuntime): Promise<unknown>
  changed(): void
  /** The turn ran past its limit and is being cut: one line to the thread. */
  turnCut(w: WorkerRuntime, why: string): void
  /** A park cut background work: one line to the thread (bg-work.ts cutLine). */
  backgroundCut(w: WorkerRuntime, text: string): void
  /** The process table and one process's argv (bg-work.ts reads /proc when none is given). */
  procs?: { procTable?(): Proc[] | null; procArgv?(pid: number): string[] | null }
}

export class WorkerSlots {
  /** dedicated.max_live, as last read. */
  maxLive = DEFAULT_MAX_LIVE
  /** The wall clock against the monotonic one at the last tick (worker-idle.ts wallJump). */
  private wallOffset: number | null = null

  constructor(private readonly m: SlotDeps) {}

  /** Unknown is busy: only a pane read as quiet may be parked (or be the cap's choice). */
  async isBusy(w: WorkerRuntime): Promise<boolean> {
    if (!w.host) return true
    const r = readsBusy(w.busyWatch, await w.host.lastOutputAt(), this.m.wallMs(), this.m.now())
    w.busyWatch = r.watch
    return r.busy
  }

  /**
   * Each tick: idle time is measured on the monotonic clock, so a wall clock that is set or jumps changes nothing by itself. Only
   * the tmux clients' key times are wall times: after a jump, every session counts as active now. Busy is already read against
   * the monotonic clock (readsBusy).
   */
  noteClock(wallMs: number, monoS: number): boolean {
    const j = wallJump(this.wallOffset, wallMs, monoS)
    this.wallOffset = j.offset
    if (j.jumpMs === 0) return false
    // a key a tmux client reported before the jump is in the old wall clock and would read as older (or newer) than it is: every
    // session counts as active now, so none is parked within a full idle window of a jump
    for (const w of this.m.workers()) if (w.idle.lastActiveMs > 0) w.idle = activeNow(w.idle, wallMs, monoS)
    this.m.changed()
    this.m.audit('wall_clock_jump', { ms: String(Math.round(j.jumpMs)) })
    return true
  }

  /**
   * Main now runs in a mode a thread session cannot be held to: every running one is parked after its turn (the capped wait),
   * never restarted; its next start is refused, with the thread's line. One already going down is left as it is.
   */
  parkRunning(why: string): void {
    for (const w of this.m.workers()) {
      const s = w.entry.state
      if ((s !== 'live' && s !== 'busy') || w.turnWait || this.m.pending(w.id)) continue
      w.afterPark = null
      this.requestPark(w, why, false)
    }
  }

  /** A quiet session with nothing owed and nothing asking the owner, idle for its thread's idle_park_min, is parked. */
  async idleCheck(w: WorkerRuntime, busy: boolean): Promise<void> {
    const idleParkMin = this.m.thread(w.id)?.idleParkMin ?? DEFAULT_IDLE_PARK_MIN
    const needsYou = w.notes.needsYou !== null || w.notes.promptWatch.current !== null || w.entry.dialog !== undefined
    const nowMono = this.m.now()
    const activeMono = w.idle.activeMono
    if (!w.host || !idleParkDue({ busy, owed: w.owed.pending, needsYou, activeMono, nowMono, idleParkMin })) return
    // a dialog or prompt on the screen now that has not held still for dialog_settle_s yet is not flagged, but it waits on the
    // owner all the same (as waitsOnOwner reads it; the Mac's guardShape, 62df2342). A screen that cannot be read never parks
    const rows = await w.host.visibleRows()
    if (!rows || onScreenAsk(rows)) return
    // only when a park is due: a key in an attached client may change nothing on the screen
    const clients = await w.host.clientActivities()
    // the client keys are tmux's wall times: a jump since this tick's look (a resume during the awaits) is caught here, where they
    // are read, and every session counts as active instead of a key reading older than it is
    if (this.noteClock(this.m.wallMs(), this.m.now())) return
    const r = idleLimitPassed(w.idle, clients, this.m.wallMs(), this.m.now(), idleParkMin * 60)
    w.idle = r.clock
    // never while background work runs under it (a Bash tool command, a waiter): the park would kill it
    if (r.passed && this.freeOfBackground(w)) this.m.beginEnd(w.id, 'parked', 'idle')
  }

  /** The background work under the session's pane now; null when the process table could not be read (never "none"). */
  background(w: WorkerRuntime): BgFound | null {
    const pid = w.host?.childPid() ?? (w.entry.pane_pid > 0 ? w.entry.pane_pid : null)
    if (pid === null) return NO_BG
    const table = (this.m.procs?.procTable ?? procTable)()
    if (!table) return null
    return found(table, pid, (p) => (this.m.procs?.procArgv ?? procArgv)(p))
  }

  /** The idle park's last check; held by background work (or an unreadable table), it says so in the log once per hold. */
  private freeOfBackground(w: WorkerRuntime): boolean {
    const f = this.background(w)
    const held = (f?.count ?? 1) > 0
    if (held && !w.bgHeld) this.m.audit('worker_idle_held', { thread: w.id, bg: f ? String(f.count) : 'unknown' })
    w.bgHeld = held
    return !held
  }

  /**
   * One log line for every end, when it is decided (before any signal): `worker_parked` (or `worker_stop`) with why, the idle time
   * (monotonic s since the last activity) and the background work then running (`unknown`: unreadable, or after a crash, when the
   * CLI's detached Bash shells can no longer be tied to it). Work it cuts gets one line in the thread.
   */
  notePark(w: WorkerRuntime, endAs: 'parked' | 'off', why: string, bg: BgFound | null = this.background(w)): void {
    const idle = w.idle.activeMono > 0 ? Math.max(0, Math.floor(this.m.now() - w.idle.activeMono)) : 0
    const fields = { thread: w.id, why, idle_s: String(idle), bg: bg ? String(bg.count) : 'unknown' }
    this.m.audit(endAs === 'off' ? 'worker_stop' : 'worker_parked', fields)
    w.bgHeld = false
    if (bg && bg.count > 0) this.m.backgroundCut(w, cutLine(bg))
  }

  /**
   * Every worker holding a slot (the Mac's liveList), `except` one. On its way in or out, or unread, it counts as busy; one waiting
   * on the owner too, looked at only when every slot is taken (the look costs tmux calls).
   */
  async holders(except: string | null): Promise<Live[]> {
    const holders = [...this.m.workers()].filter((w) => w.id !== except && SLOT_STATES.includes(w.entry.state))
    const full = holders.length >= this.maxLive
    const out: Live[] = []
    for (const w of holders) {
      const running = (w.entry.state === 'live' || w.entry.state === 'busy') && !this.m.pending(w.id)
      const n = w.notes
      const flagged =
        n.needsYou !== null ||
        n.promptWatch.current !== null ||
        !!w.entry.dialog ||
        w.owed.pending ||
        w.owed.leftover ||
        n.draftSince !== null
      const busy =
        !running || (await this.isBusy(w)) || (full && (await waitsOnOwner(flagged, w.host, this.m.wallMs())))
      // background work is looked for only when a choice is to be made, and only on a quiet one (the look reads the process table)
      const background = full && !busy && (this.background(w)?.count ?? 1) > 0
      // ranked on the monotonic clock: after a clock set back the wall times stand still and would rank the session in use first
      out.push({ threadId: w.id, busy, lastActive: w.idle.activeMono, background })
    }
    return out
  }

  /**
   * The cap's say on a start (the Mac's requestStart): true when a slot is free. Else the quietest worker is parked first and the
   * start waits for it to go, or, every slot busy, the start is held; either way retryHeld asks again each tick.
   */
  async mayStart(w: WorkerRuntime, fresh: boolean, forPointer = false): Promise<boolean> {
    // the worker parked to make room for this start is still on its way out: the room is coming, so nothing is planned again
    // (planned again, that victim still holds its slot and the next quiet worker would be parked too, and the next)
    const v = w.held?.victim ? this.m.get(w.held.victim) : undefined
    if (v && (v.entry.state === 'parking' || v.entry.state === 'stopping')) {
      // what this ask wants is still recorded on the hold: a fresh start asked for meanwhile stays fresh (Fable R5-1 on the wake
      // reader: lost here, the held start resumed instead), and a start anyone but the pointer asked for outlives the pointer
      // (T2-1: a pointer-only hold that a fresh start joined still dropped with its pointer)
      const h = w.held
      if (h && ((fresh && !h.fresh) || (!forPointer && h.forPointer)))
        w.held = { ...h, fresh: h.fresh || fresh, forPointer: h.forPointer && forPointer }
      return false
    }
    const cap = planStart(await this.holders(w.id), this.maxLive)
    if (cap.kind === 'start') {
      w.held = null
      return true
    }
    if (!w.held) this.m.audit('worker_start_held', { thread: w.id, why: 'cap' })
    // held for the pointer only while nothing else asked for this start: the owner's start, once held, outlives the pointer
    w.held = {
      since: w.held?.since ?? this.m.now(),
      // a fresh start someone asked for stays fresh: a later ask (the pointer's, each tick) never makes it a resume
      fresh: fresh || w.held?.fresh === true,
      victim: cap.kind === 'parkThenStart' ? cap.victim : null,
      forPointer: (w.held?.forPointer ?? true) && forPointer,
    }
    if (cap.kind === 'parkThenStart') this.m.beginEnd(cap.victim, 'parked', 'cap')
    return false
  }

  /** Each held start, asked again: dropped after CAP_HOLD_MS with its owed pointer; waiting while the worker parked for it goes. */
  async retryHeld(): Promise<void> {
    for (const w of [...this.m.workers()]) {
      const h = w.held
      if (!h) continue
      const s = w.entry.state
      if (this.m.pending(w.id) || !this.m.thread(w.id) || (s !== 'off' && s !== 'parked' && s !== 'failed')) {
        w.held = null
      } else if (holdExpired(h.since, this.m.now())) {
        // every slot stayed busy: the hub's deadline hands the message to Main (worker_cap), so nothing is owed here any more
        w.held = null
        w.owed = NOTHING_OWED
        this.m.changed()
        this.m.audit('worker_cap_dropped', { thread: w.id })
      } else {
        const v = h.victim ? this.m.get(h.victim)?.entry.state : null
        if (v !== 'parking' && v !== 'stopping')
          await this.m.startNow(w.id, { fresh: h.fresh, forPointer: h.forPointer })
      }
    }
  }

  /**
   * A lowered max_live, or more adopted workers than the cap: the longest idle go first; busy ones wait. A worker on its way out
   * has already made its room: counted, each tick would pick one more.
   */
  async enforceCap(): Promise<void> {
    const live = (w: WorkerRuntime | undefined) =>
      w !== undefined && WORKER_LIVE_STATES.includes(w.entry.state) && !this.m.pending(w.id)
    if ([...this.m.workers()].filter(live).length <= this.maxLive) return
    const staying = (await this.holders(null)).filter((l) => live(this.m.get(l.threadId)))
    for (const id of capVictims(staying, this.maxLive)) this.m.beginEnd(id, 'parked', 'cap')
  }

  /** Park after the current turn: `stopping` until the pane is quiet. A tap's (byOwner) gives up on the turn at owner_stop_s. */
  requestPark(w: WorkerRuntime, why: string, byOwner: boolean, endAs: 'parked' | 'off' = 'parked'): void {
    if (!this.m.move(w, 'stopping')) return
    // never without a limit: the governor's and the control's waits end at turn_wait_cap_s, a tap's at the owner's stop limit
    w.turnWait = { why, deadline: this.m.now() + WORKER_TIMING.turn_wait_cap_s }
    w.endAs = endAs
    w.entry = withStopped(w.entry, why, w.afterPark !== null)
    this.m.changed()
    if (byOwner) this.armStopLimit(w)
    this.m.audit('worker_park_requested', { thread: w.id, why })
  }

  /** From the first tap: a second one does not buy the turn more time. */
  armStopLimit(w: WorkerRuntime): void {
    if (!w.turnWait) return
    const owner = this.m.now() + WORKER_TIMING.owner_stop_s
    if (w.turnWait.deadline === null || owner < w.turnWait.deadline) {
      w.turnWait = { ...w.turnWait, deadline: owner }
      this.m.changed() // the file says when it ends: a supervisor started from here on must know
    }
  }

  /** A restart or resume asked for while the session is on its way out: run once it is parked. A tap arms the stop limit. */
  queueAfterPark(w: WorkerRuntime, fresh: boolean): void {
    // a fresh start already queued stays fresh (a folder change cannot resume: the transcript is the old folder's)
    w.afterPark = { fresh: fresh || w.afterPark?.fresh === true }
    if (w.entry.state === 'parking' || w.entry.state === 'stopping') w.entry = withStopped(w.entry, 'restart', true)
    this.m.changed()
    if (w.entry.state === 'stopping') this.armStopLimit(w)
  }

  /** One tick of a park that waits for the turn: the pane is still watched; quiet (or past the owner's limit), it is parked. */
  async waitTurn(w: WorkerRuntime, t: TurnWait): Promise<void> {
    await this.m.lookAt(w)
    if (w.rows) w.idle = noteScreen(w.idle, w.rows, this.m.wallMs(), this.m.now())
    const busy = await this.isBusy(w)
    // a turn that finished while the park waited for it is a finished turn: last_turn_at moves (Fable R1-1)
    if (turnLook(w, busy, new Date(this.m.wallMs()).toISOString())) this.m.changed()
    const why = parkAfterTurn(t, busy, this.m.now())
    if (!why) return
    // the limit ran out with the turn still going: it is cut, and the thread is told why its session went
    if (why === 'stop_limit') this.m.turnCut(w, t.why)
    this.m.beginEnd(w.id, w.endAs === 'off' ? 'off' : 'parked', why)
  }
}
