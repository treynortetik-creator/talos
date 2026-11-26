// The workers.json fields that let `thread_session status` tell the truth (the Mac's WorkerStatusFields.swift, 2d18db28 and
// 25d5b557): `needs_you` (what the pane waits on the owner for, since when), `stopped_why` (why the session is parked or on its
// way out, recorded at every park and stop) and `turn_started_at` (the turn now running; `last_turn_at` is when the last one
// ENDED). A start clears all three: none of them describes the new session.
import type {
  PointerHoldReasonT,
  WorkerEntryT,
  WorkerNeedsYouT,
  WorkerStateT,
  WorkerStoppedWhyT,
} from '@talos-app/protocol'
import { holdReasonOf, persisted } from './owed-pointer.ts'
import { savedActivity } from './worker-idle.ts'
import type { NoticeRuntime } from './worker-notices.ts'
import type { WorkerRuntime } from './worker-types.ts'
import { type OwnFields, ownFields } from './workers-file.ts'

/** The states with a pane a dialog can be on (the Mac's offerStates): a parked session has none. */
const PANE_STATES: readonly WorkerStateT[] = ['starting', 'live', 'busy', 'stopping']

/**
 * `stopped_why` for an end asked for with `why` (this supervisor's own reasons), or for the restart it is the first half of.
 * The cap, the idle limit and the governor are their own; an unasked exit is a crash; a restart (asked for, or a launch setting
 * that changed) is a restart; everything else is the owner's (a tap or a control park, a stop, and the limit a tap set on the turn).
 */
export function stoppedWhy(why: string, restarting: boolean): WorkerStoppedWhyT {
  if (restarting || why === 'restart' || why === 'fresh' || why === 'config') return 'restart'
  switch (why) {
    case 'idle':
    case 'cap':
    case 'governor':
    case 'interrupted':
    case 'crash':
      return why
    case 'exited':
      return 'crash'
    default:
      return 'owner'
  }
}

/**
 * The entry with why the session is going. A stop already under way keeps the reason it was asked for (a tap's limit running out
 * is still the tap), except the idle limit, which is its own reason; a restart queued on top says restart.
 */
export function withStopped(
  e: WorkerEntryT,
  why: string,
  restarting: boolean,
  o: { overwrite?: boolean } = {},
): WorkerEntryT {
  if (e.stopped_why && !o.overwrite && why !== 'idle' && !restarting) return e
  return { ...e, stopped_why: stoppedWhy(why, restarting) }
}

/** The owner's stop: it overwrites whatever reason was there (a park under way, a parked session, a queued restart). */
export const ownerStopped = (e: WorkerEntryT): WorkerEntryT => withStopped(e, 'owner', false, { overwrite: true })

/**
 * A session the last supervisor left running, found gone: mid-turn or on its way out it was interrupted (the Mac's WorkerAdopt),
 * and its unfinished turn is not a finished one.
 */
export function adoptedGone(e: WorkerEntryT, was: WorkerEntryT): WorkerEntryT {
  const mid = was.state === 'busy' || was.state === 'stopping' || was.turn_started_at
  return withTurnLost(mid ? withStopped(e, 'interrupted', false, { overwrite: true }) : e)
}

/** A start: none of the three describes the new session. */
export function withoutStatus(e: WorkerEntryT): WorkerEntryT {
  const { needs_you: _n, stopped_why: _s, turn_started_at: _t, ...rest } = e
  return rest as WorkerEntryT
}

/** A message typed in: a turn begins (`last_turn_at` moves when it ends). */
export const withTurnStarted = (e: WorkerEntryT, at: string): WorkerEntryT => ({ ...e, turn_started_at: at })

/** The pointer's Enter went: the turn begins in this conversation (`Entry.hadTurn`), and a quiet pane is no end until it drew. */
export function pointerEntered(
  w: { entry: WorkerEntryT; turnSeenBusy?: boolean; turnTypedAtMs?: number },
  at: string,
  wallMs: number,
): void {
  w.entry = { ...withTurnStarted(w.entry, at), ...(w.entry.session_id ? { turn_session: w.entry.session_id } : {}) }
  ;[w.turnSeenBusy, w.turnTypedAtMs] = [false, wallMs]
}

/**
 * One look at a running turn: busy marks it seen, and only quiet AFTER that ends it (`last_turn_at` its end). A pane read quiet
 * between the line going in and the turn first drawing is not a finished turn (Pantheon's question on 61831732). True: the entry
 * changed.
 */
export function turnLook(
  w: { entry: WorkerEntryT; turnSeenBusy?: boolean; turnTypedAtMs?: number; busyWatch: { seen: number | null } },
  busy: boolean,
  at: string,
): boolean {
  if (!w.entry.turn_started_at) return false
  if (busy) {
    // the line's echo and its Enter draw on the pane too: only output in a later second than the Enter is the turn's (tmux gives
    // the pane's output time in whole seconds, so the compare is in whole seconds: Fable R2-5)
    const out = w.busyWatch.seen
    if (w.turnTypedAtMs === undefined || (out !== null && Math.floor(out / 1000) > Math.floor(w.turnTypedAtMs / 1000)))
      w.turnSeenBusy = true
    return false
  }
  const ended = w.turnSeenBusy ? withTurnEnded(w.entry, at) : null
  if (!ended) return false
  w.entry = ended
  w.turnSeenBusy = false
  return true
}

/** The pane has gone quiet after a turn began: it is over, and `last_turn_at` is its end. Null: no turn was running. */
export function withTurnEnded(e: WorkerEntryT, at: string): WorkerEntryT | null {
  if (!e.turn_started_at) return null
  const { turn_started_at: _t, ...rest } = e
  return { ...(rest as WorkerEntryT), last_turn_at: at }
}

/** The pane went away mid-turn: that turn did not finish, so `last_turn_at` stays the last one that did. */
export function withTurnLost(e: WorkerEntryT): WorkerEntryT {
  if (e.turn_started_at === undefined) return e
  const { turn_started_at: _t, ...rest } = e
  return rest as WorkerEntryT
}

/** `needs_you` as workers.json carries it: only while there is a pane, from the notices' flag and when it was raised. */
export function needsYouField(state: WorkerStateT, n: NoticeRuntime): WorkerNeedsYouT | undefined {
  if (!PANE_STATES.includes(state) || n.needsYou === null || n.needsYouAt === null) return undefined
  return { kind: n.needsYou, since: n.needsYouAt, ...(n.needsYouResetsAt ? { resets_at: n.needsYouResetsAt } : {}) }
}

/** The entry as published: `needs_you` from the notices, never a value read back from an earlier file. */
export function withNeedsYou(e: WorkerEntryT, n: NoticeRuntime): WorkerEntryT {
  const { needs_you: _old, ...rest } = e
  const needs = needsYouField(e.state, n)
  return needs ? { ...(rest as WorkerEntryT), needs_you: needs } : (rest as WorkerEntryT)
}

/**
 * The hold to keep after a look at the pane: undefined when nothing changed; a new one (its `since` the wall clock now) when the
 * reason changed; null when the hold is over or the pointer is no longer owed. The same reason keeps its `since`.
 */
export function nextHold(
  prev: { reason: PointerHoldReasonT; since: string } | null | undefined,
  r: {
    looked: boolean
    state: { pending: boolean }
    hold?: PointerHoldReasonT | null
    held: Parameters<typeof holdReasonOf>[0]
  },
  wallIso: string,
): { reason: PointerHoldReasonT; since: string } | null | undefined {
  if (!r.looked) return undefined
  const reason = r.state.pending ? (r.hold ?? holdReasonOf(r.held)) : null
  if (reason === (prev?.reason ?? null)) return undefined
  return reason ? { reason, since: wallIso } : null
}

/** `nextHold` applied to the worker's `hold`; `publish` runs when it changed, so the file says so at once. */
export function applyHold(
  w: { hold?: { reason: PointerHoldReasonT; since: string } | null },
  r: Parameters<typeof nextHold>[1],
  wallIso: string,
  publish: () => void,
): void {
  const hold = nextHold(w.hold, r, wallIso)
  if (hold === undefined) return
  w.hold = hold
  publish()
}

/**
 * `pointer_hold` as workers.json carries it: only while a pointer is owed AND the session has a pane, never a value read back
 * from an earlier file (protocol WorkerPointerHold has the rules the Mac keeps too).
 */
export function withPointerHold(
  e: WorkerEntryT,
  w: { owed: { pending: boolean }; hold?: { reason: string; since: string } | null },
): WorkerEntryT {
  const { pointer_hold: _old, ...rest } = e
  return w.hold && w.owed.pending && PANE_STATES.includes(e.state)
    ? { ...(rest as WorkerEntryT), pointer_hold: { reason: w.hold.reason, since: w.hold.since } }
    : (rest as WorkerEntryT)
}

/** What changes `needs_you` across all workers: published at the tick it changes, not at the next heartbeat. */
export const needsYouSignature = (ws: Iterable<{ id: string; entry: WorkerEntryT; notes: NoticeRuntime }>): string =>
  JSON.stringify([...ws].map((w) => [w.id, needsYouField(w.entry.state, w.notes) ?? null]))

/**
 * Every worker's entry as workers.json carries it, and this supervisor's own fields: the idle clock (never a value read back
 * from an earlier file) and `needs_you` from the notices.
 */
export function publishedThreads(
  ws: Iterable<WorkerRuntime>,
  o: { nowS: number; wallMs: number; adopting(id: string): boolean; before(id: string): Record<string, unknown> },
): { threads: Record<string, WorkerEntryT>; own: Record<string, OwnFields> } {
  const threads: Record<string, WorkerEntryT> = {}
  const own: Record<string, OwnFields> = {}
  for (const w of ws) {
    const { last_active_at: _old, ...entry } = w.entry
    const last = savedActivity(w.entry.state, w.idle.lastActiveMs)
    const withNeeds = withPointerHold(withNeedsYou(entry as WorkerEntryT, w.notes), w)
    threads[w.id] = last ? { ...withNeeds, last_active_at: last } : withNeeds
    const mine = ownFields({
      owed: persisted(w.owed),
      state: w.entry.state,
      turnWait: w.turnWait,
      endAs: w.endAs,
      afterPark: w.afterPark,
      nowS: o.nowS,
      wallMs: o.wallMs,
      adopting: o.adopting(w.id),
      before: o.before(w.id),
      cut: w.cut ?? null,
      planMode: w.planSeen === true,
      resumedTurn: w.resumedTurn !== undefined,
      turnFromBoot: w.turnFromBoot,
    })
    if (mine) own[w.id] = mine
  }
  return { threads, own }
}
