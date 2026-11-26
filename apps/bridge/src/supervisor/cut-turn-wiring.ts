// What the manager (workers.ts) does about a turn that was cut off: record it, bound it on the boot clock, guard against running it
// twice in a row, reap what it left running, and tell an owner's Esc from a crash. The rules are in cut-turn.ts (pure) and
// proc-reap.ts; this holds the state transitions on a WorkerRuntime. Moved out of workers.ts unchanged, to keep that file in budget.
import type { WorkerEntryT } from '@talos-app/protocol'
import { WORKER_TIMING } from '@talos-app/protocol'
import { argvInPlan, escHintShown, interruptCount, planModeOf, restoredCut, resumeTurnFor } from './cut-turn.ts'
import { bootMsNow, reapLaunch } from './proc-reap.ts'
import { stuck } from './worker-launch.ts'
import type { WorkerDeps, WorkerRuntime } from './worker-types.ts'
import { readNonce } from './workers-file.ts'

export class CutTurns {
  /** `changed`: workers.json must be written again. */
  constructor(
    private readonly d: WorkerDeps,
    private readonly changed: () => void,
  ) {}

  /** The record, the plan-mode flag, the re-run guard and the turn's bound, as the last supervisor's workers.json had them. */
  restore(w: WorkerRuntime, raw: Record<string, unknown>): void {
    // a turn cut off before the last supervisor went, and whether the pane last showed plan mode (cut-turn.ts)
    w.cut = restoredCut(raw)
    w.planSeen = raw.plan_mode === true
    if (raw.resumed_turn === true) w.resumedTurn = 'running'
    const turnFrom = raw.turn_from_boot
    if (typeof turnFrom === 'number' && Number.isFinite(turnFrom)) w.turnFromBoot = turnFrom
  }

  /** Does this start run the cut turn again? Only a resume of it, and only soon (cut-turn.ts). */
  resumeTurn(w: WorkerRuntime, sessionId: string, resume: boolean): boolean {
    return resume && resumeTurnFor(w.cut, sessionId, this.d.wallMs())
  }

  /** A start went ahead: it uses the cut turn up (asked for once, or never) and begins a new pane's watch. */
  started(w: WorkerRuntime, resumeTurn: boolean, argv: readonly string[]): void {
    if (w.cut) this.d.audit('worker_cut_turn_used', { thread: w.id, again: resumeTurn ? 'yes' : 'no' })
    w.cut = null
    w.planSeen = argvInPlan(argv)
    w.resumedTurn = resumeTurn ? 'running' : undefined
    w.resumedQuietSince = undefined
    ;[w.interruptsSeen, w.turnInterrupted, w.wasBusy, w.hintShown] = [undefined, false, undefined, undefined] // a new pane: nothing seen yet
    ;[w.quietAtBoot, w.turnFromBoot, w.quietSince] = [undefined, undefined, undefined]
  }

  /** A session the last supervisor left running, found gone: a turn cut mid-way is recorded, a cut it kept is reaped. */
  async gone(w: WorkerRuntime, e: WorkerEntryT, ownerStop: boolean, goneNonce: string | null): Promise<void> {
    // cut in the middle of a turn, by nobody's choice: the turn is as old as the session's last activity (not as this notice)
    if (!ownerStop && (e.state === 'busy' || Boolean(e.turn_started_at))) {
      const lastActive = Date.parse(e.last_active_at ?? '')
      const now = this.d.wallMs()
      this.noteCut(w, e.session_id, {
        atMs: Number.isFinite(lastActive) && lastActive <= now ? lastActive : now,
        nonce: goneNonce,
        turnStartBoot: this.wallToBoot(e.turn_started_at),
      })
    }
    // a cut the last supervisor kept (a restart that ran out of waiting for the turn, then the supervisor went too) is reaped
    // as well, whether or not this entry still says a turn was running (it may have been typed by the owner, and the state is
    // parking by now); the owner's own stop is no cut at all
    if (ownerStop) w.cut = null
    else if (w.cut) {
      if (!w.cut.nonce && goneNonce) w.cut = { ...w.cut, nonce: goneNonce }
      await this.reapCut(w)
    }
  }

  /**
   * A restart is going ahead from state `s`: one whose wait for the turn ran out on a turn that was really working is run again
   * after the restart. Never a restart to get a stuck session going again (its "turn" is a dialog), nor a direct restart()
   * (signin-wiring): those are not a turn that was cut, and re-running one would repeat what got the session stuck.
   */
  atRestart(w: WorkerRuntime, s: string, why: string, endAs: 'parked' | 'off'): void {
    // a turn is running now: the session is busy, a turn was typed in and not seen over, or a park waiting for it just ran out
    const midTurn =
      s === 'live' || s === 'busy'
        ? s === 'busy' || Boolean(w.entry.turn_started_at)
        : s === 'stopping' && why === 'stop_limit'
    if (midTurn && why === 'stop_limit' && w.afterPark !== null && endAs !== 'off')
      this.noteCut(w, w.entry.session_id, { turnStartBoot: this.wallToBoot(w.entry.turn_started_at) })
  }

  /** Read at the top of an exit, before the files go and withTurnLost forgets the turn: what the exit handler needs later. */
  exiting(w: WorkerRuntime): { midTurn: boolean; turnStartBoot: number | undefined; nonce: string | null } {
    return {
      midTurn: w.entry.state === 'busy' || Boolean(w.entry.turn_started_at),
      turnStartBoot: this.wallToBoot(w.entry.turn_started_at),
      nonce: w.nonce ?? readNonce(this.d.home, w.id),
    }
  }

  /** An exit nobody asked for, in the middle of a turn (the caller checked): that turn did not finish. */
  crashed(w: WorkerRuntime, x: ReturnType<CutTurns['exiting']>): void {
    this.noteCut(w, w.entry.session_id, { nonce: x.nonce, turnStartBoot: x.turnStartBoot })
  }

  /** The pointer's Enter went: a turn typed in began now, on the boot clock, no earlier than a bound already kept. */
  pointerEntered(w: WorkerRuntime): void {
    // not w.resumedTurn: a start is almost always for a pointer, typed on the first live tick while the cut turn is
    // re-running, so the pointer is part of the re-run. The guard ends on busy, then quiet, never on a pointer.
    w.turnInterrupted = false
    const b = this.boot()
    if (b !== undefined) w.turnFromBoot = Math.min(w.turnFromBoot ?? b, b)
  }

  /** What the pane's rows say: the permission mode, a fresh spinner, and one more Esc line than at the last look. */
  rowsSeen(w: WorkerRuntime, rows: string[]): void {
    const plan = planModeOf(rows) // the footer says the mode; a screen that says nothing keeps what was seen
    if (plan !== null && plan !== w.planSeen) {
      w.planSeen = plan
      this.changed()
    }
    // a fresh "esc to interrupt" (a spinner that was not there at the last look) is a new prompt: an Esc before it was the last
    // turn's, even inside the busy window. Checked before the Esc line, so both in one look still count as an Esc.
    const hint = escHintShown(rows)
    if (hint && w.hintShown !== true) w.turnInterrupted = false
    w.hintShown = hint
    // one more "Interrupted · What should Claude do instead?" than the last look: the owner pressed Esc on this turn (the first
    // look after a start only sets what is already there, and a line scrolled away is not a new one)
    const interrupts = interruptCount(rows)
    if (w.interruptsSeen !== undefined && interrupts > w.interruptsSeen) w.turnInterrupted = true
    w.interruptsSeen = interrupts
  }

  /** One tick's look at a live or busy pane: where the turn began, whether it is new, and the re-run guard. */
  lookedAt(w: WorkerRuntime, busy: boolean): void {
    // a turn begins when the pane goes from quiet to busy: an Esc seen before it was another turn's
    if (busy && w.wasBusy !== true) w.turnInterrupted = false
    this.noteTurnBound(w, busy)
    w.wasBusy = busy
    // the re-run of a cut turn is over once the pane has been busy and then quiet: from then on a turn is a new one
    if (w.resumedTurn === 'running' && busy) {
      ;[w.resumedTurn, w.resumedQuietSince] = ['ran', undefined]
      this.changed()
    } else if (w.resumedTurn === 'ran' && !busy) {
      w.resumedTurn = undefined
      this.changed()
    } else if (w.resumedTurn === 'running') {
      // a re-run that is never seen busy was nothing (the resume re-ran nothing, or it was over during the start): after a quiet
      // window the guard goes, or it would stand over the owner's next real turn. The window is the one busy itself uses, so a
      // re-run that has not drawn yet on the first looks is still guarded.
      w.resumedQuietSince ??= this.d.now()
      if (this.d.now() - w.resumedQuietSince >= WORKER_TIMING.busy_window_s) {
        w.resumedTurn = undefined
        this.changed()
      }
    }
  }

  /** Milliseconds since boot now, the clock the reap's bound is kept on (never the wall clock, which steps on WSL). */
  private boot(): number | undefined {
    return (this.d.bootMs ?? bootMsNow)() ?? undefined
  }

  /** A wall-clock time put on the boot clock as of now: only for a time the last supervisor kept in wall time (turn_started_at). */
  private wallToBoot(iso: string | null | undefined): number | undefined {
    const b = this.boot()
    const t = Date.parse(iso ?? '')
    return b === undefined || !Number.isFinite(t) ? undefined : b - (this.d.wallMs() - t)
  }

  /**
   * Where the running turn began, on the boot clock: the last quiet look before the pane went busy (no process of an earlier turn
   * started after it). Kept until the turn really ends, not on every quiet look: a turn that waits at a permission prompt is
   * quiet for as long as the owner takes, and moving the bound past the prompt would miss the tools started before it. It ends
   * when the owner pressed Esc, or the pane has been quiet for longer than a prompt takes to be noticed with nothing waiting on the
   * owner. (turnLook's end is no signal: it ends a typed-in turn at a prompt too.)
   */
  private noteTurnBound(w: WorkerRuntime, busy: boolean): void {
    const boot = this.boot()
    if (busy) {
      w.quietSince = undefined
      if (w.turnFromBoot === undefined && (w.quietAtBoot ?? boot) !== undefined) {
        w.turnFromBoot = w.quietAtBoot ?? boot
        this.changed()
      }
      return
    }
    if (boot !== undefined) w.quietAtBoot = boot
    w.quietSince ??= this.d.now()
    const quietFor = this.d.now() - w.quietSince
    if (
      w.turnFromBoot !== undefined &&
      (w.turnInterrupted || (!stuck(w) && quietFor >= WORKER_TIMING.dialog_settle_s + 1))
    ) {
      w.turnFromBoot = undefined
      this.changed()
    }
  }

  /** A turn of `session` was cut off at `atMs` (none: now). In plan mode it is kept as such: Claude Code will not run it again. */
  private noteCut(
    w: WorkerRuntime,
    session: string | null,
    o: { atMs?: number; nonce?: string | null; turnStartBoot?: number } = {},
  ): void {
    if (!session) return
    const atMs = o.atMs ?? this.d.wallMs()
    const nonce = o.nonce
    // a launch that ran a turn again and died before a new turn began: the turn that killed it is the one being re-run, and it is
    // not run a third time (at most one automatic re-run in a row)
    if (w.resumedTurn) {
      this.d.audit('worker_turn_cut_skipped', { thread: w.id, why: 'died in its re-run' })
      return
    }
    // the owner pressed Esc on this turn and the session died within the busy window: they ended it, it is not run again
    if (w.turnInterrupted) {
      this.d.audit('worker_turn_cut_skipped', { thread: w.id, why: 'the owner interrupted it' })
      return
    }
    const n = nonce ?? w.nonce ?? readNonce(this.d.home, w.id) // the dead launch's: what its children inherited
    // when the cut turn began: the typed-in start, or the last quiet look before the pane went busy, whichever is earlier. The reap
    // ends only what started at or after it, never a server an earlier turn of this launch left running.
    const starts = [o.turnStartBoot, w.turnFromBoot].filter((t): t is number => t !== undefined && Number.isFinite(t))
    const fromBoot = starts.length > 0 ? Math.min(...starts) : undefined
    w.cut = {
      session,
      at: new Date(atMs).toISOString(),
      plan: w.planSeen === true,
      ...(n ? { nonce: n } : {}),
      ...(fromBoot !== undefined ? { fromBoot } : {}),
    }
    this.changed()
    this.d.audit('worker_turn_cut', { thread: w.id, session, plan: w.cut.plan ? 'yes' : 'no' })
  }

  /**
   * Ends what a cut session left running before its turn runs again (proc-reap.ts: found by the launch's nonce, one TERM then one
   * KILL). Only for a turn that will be asked for again: in plan mode it is not, and a stop, a park or a quiet exit never come
   * here. Whatever it does, a failure is said and changes nothing else.
   */
  async reapCut(w: WorkerRuntime): Promise<void> {
    const cut = w.cut
    if (!cut || cut.plan || !cut.nonce) return
    // without the turn's start there is nothing to tell its tools from an earlier turn's: nothing is ended
    const from = cut.fromBoot
    if (from === undefined || !Number.isFinite(from)) {
      this.d.audit('worker_reap_skipped', { thread: w.id, why: 'the start of the cut turn is not known' })
      return
    }
    try {
      const r = await (this.d.reap ?? ((n: string, f?: number) => reapLaunch(n, undefined, f)))(cut.nonce, from)
      this.d.audit('worker_reaped', {
        thread: w.id,
        found: String(r?.found ?? 0),
        killed: String(r?.killed.length ?? 0),
      })
    } catch (e) {
      this.d.audit('worker_reap_failed', { thread: w.id, why: String((e as Error)?.message ?? e).slice(0, 120) })
    }
  }
}
