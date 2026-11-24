// The live cap (`dedicated.max_live`) and the park that waits for the turn (P3d3, part 6; the Mac's WorkerPolicy.planStart,
// WorkerManager.liveList, retryHeld, enforceCap and requestPark/armStopLimit). Pure: the manager (workers.ts) builds the list of
// slot holders and acts on the answer. Pure apart from waitsOnOwner, which reads the pane it is handed.
//
// Every worker with a running process holds a slot: starting, live, busy, and parking or stopping too. Only a live worker that is
// not busy (and, when every slot is taken, not waiting on the owner) may be the cap's choice: one on its way in or out, or whose
// output could not be read, counts as busy.
import { CAP_HOLD_MS, WORKER_POINTER_TEXT, WORKER_TIMING, type WorkerStateT } from '@talos-app/protocol'
import { detectPrompt } from './dialog-reader.ts'
import { boxText, draftPresent, liveDialog, stripEscapes } from './screen.ts'

/** States whose process still runs: each holds a slot under max_live. */
export const SLOT_STATES: readonly WorkerStateT[] = ['starting', 'live', 'busy', 'parking', 'stopping']

/**
 * One slot holder: busy (never the cap's choice), its last activity (worker-idle.ts), and whether background work runs under it
 * (bg-work.ts; a table that could not be read counts): never the cap's choice.
 */
export type Live = { threadId: string; busy: boolean; lastActive: number; background?: boolean }

export type StartPlan =
  | { kind: 'start' }
  | { kind: 'parkThenStart'; victim: string }
  | { kind: 'hold' }
  /** Every slot is taken by a quiet session with background work: stop none, start over the limit and say the computer is busy. */
  | { kind: 'startOverLimit' }

/**
 * The quiet holders with no background work, longest idle first (a tie goes by thread id). One with background work (or a table
 * that could not be read) is never a choice: a park would cut that work.
 */
export function quietest(live: Live[]): Live[] {
  return live
    .filter((l) => !l.busy && !l.background)
    .sort((a, b) => a.lastActive - b.lastActive || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
}

/**
 * Room for one more worker? When full, park the longest-idle worker that is not busy and has no background work first. When the only
 * quiet ones have background work, start over the limit (enforceCap brings the count down once that work ends); when every slot is
 * busy, hold.
 */
export function planStart(live: Live[], maxLive: number): StartPlan {
  if (live.length < maxLive) return { kind: 'start' }
  const victim = quietest(live)[0]
  if (victim) return { kind: 'parkThenStart', victim: victim.threadId }
  return live.some((l) => !l.busy) ? { kind: 'startOverLimit' } : { kind: 'hold' }
}

/**
 * A lowered max_live, or more adopted workers than the cap: the longest idle of the extras go; busy ones wait. `staying` is the
 * live-state holders only: one on its way out has already made its room (counted, each tick would pick one more). A quiet one with
 * background work (or a table that could not be read) is never parked and is not counted against the rest, so a session started over
 * the limit stays while that work runs; when it ends, the longest idle goes.
 */
export function capVictims(staying: Live[], maxLive: number): string[] {
  const excess = staying.length - maxLive - staying.filter((l) => !l.busy && l.background === true).length
  return excess > 0
    ? quietest(staying)
        .slice(0, excess)
        .map((l) => l.threadId)
    : []
}

/**
 * Waiting on the owner, so never the cap's choice (the Mac's waitsOnOwner): something flagged already (a dialog or prompt, an
 * owed pointer or its draft), or on the screen as it is now (a dialog just drawn), or an attached client typed a moment ago. A
 * read that fails says yes.
 */
/** A dialog or a prompt on the screen as it is now, flagged yet or not (the Mac's `guardShape(rows) != .none`). */
export const onScreenAsk = (rows: string[]): boolean => liveDialog(rows).kind !== 'none' || detectPrompt(rows) !== null

export async function waitsOnOwner(
  flagged: boolean,
  pane: {
    visibleRows(): Promise<string[] | null>
    visibleRowsEscaped?(): Promise<string[] | null>
    clientActivities(): Promise<number[] | null>
  } | null,
  nowMs: number,
): Promise<boolean> {
  if (flagged || !pane) return true
  const rows = await pane.visibleRows()
  if (!rows || onScreenAsk(rows)) return true
  // the owner's unsent text in the box (by its colours: the dim placeholder is none, our own pointer line is not theirs): a park
  // would lose it. A read that fails, or a pane that cannot show colours, says yes.
  if (!pane.visibleRowsEscaped) return true
  const escaped = await pane.visibleRowsEscaped()
  if (!escaped) return true
  if (draftPresent(escaped) === true && boxText(escaped.map(stripEscapes)) !== WORKER_POINTER_TEXT) return true
  const c = await pane.clientActivities()
  return !c || c.some((t) => nowMs - t < WORKER_TIMING.dialog_client_quiet_s * 1000)
}

/** A start held this long (monotonic s) is dropped: the hub's own deadline hands the message to Main (`worker_cap`). */
export const holdExpired = (sinceS: number, nowS: number): boolean => nowS - sinceS > CAP_HOLD_MS / 1000

/**
 * A park that waits for the current turn to end (the governor's, a tap's, a message's). `deadline` (monotonic s) is the owner's
 * stop limit, armed by a tap, else turn_wait_cap_s: past it a turn that has still not ended is cut (and the thread told). Never none.
 */
export type TurnWait = { why: string; deadline: number | null }

/** Why the waiting worker is parked now, or null while it waits. */
export function parkAfterTurn(w: TurnWait, busy: boolean, nowS: number): string | null {
  if (!busy) return w.why
  return w.deadline !== null && nowS >= w.deadline ? 'stop_limit' : null
}
