// The owed pointer (P3d3; the Mac's WorkerOwedPointer.swift and PointerTyper): typing WORKER_POINTER_TEXT into a thread's session
// so it calls read_inbound for the message the hub woke it for. Owed until the hub's claim deadline, counted from the wake; past
// it the hub has given the message to Main, so nothing is typed. The box tells the truth about the Enter: Enter goes ONLY onto a
// capture, with its colours, taken right before the send, that shows exactly our line at normal intensity. Our line nobody read is
// removed with Backspace only while no tmux client is attached (nobody can then type into the pane, so a Backspace can only delete
// our own characters), at most WORKER_POINTER.late_clears times; any other leftover is held and the thread told.
import {
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  keyNotSent,
  POINTER_CLIENT_QUIET_MS,
  type PtySendResult,
  WORKER_POINTER,
  WORKER_POINTER_TEXT,
} from '@talos-app/protocol'
import { checkEnter, ENTER_CHECK_SLOW_MS, type EnterCheck, enterNeedsSlowLook } from './enter-check.ts'
import { boxText, draftPresent, inputBox, liveDialog, stripEscapes } from './screen.ts'

export type OwedState = {
  /** A pointer is owed. */
  pending: boolean
  /** Our line is in the box without its Enter. */
  enterOwed: boolean
  /** The claim deadline (wall ms) of the oldest wake this pointer answers. */
  until: number | null
  /** Read back from workers.json by this supervisor and not yet typed or dropped. */
  restored: boolean
  /** A start for a restored pointer on a resting worker was asked for. */
  revived: boolean
  /** When our line was typed (monotonic s), until a look shows text in the box: the screen may not have caught up yet. */
  unseenSince: number | null
  /**
   * An Enter that may have answered a prompt (enter-check.ts): the pointer stays owed but is never sent again, held and said
   * once, until it drops at its deadline (Main has the message).
   */
  enterUncertain?: boolean
  /** Past its deadline, and the box holds something that may include our line: held, not cleared. */
  leftover: boolean
  /** Backspace rounds sent to clear our own line. */
  clears: number
}

/** The second look after the pointer's Enter (enter-check.ts). */
export const ENTER_CHECK_LATER_MS = 300

export const NOTHING_OWED: OwedState = {
  pending: false,
  enterOwed: false,
  until: null,
  restored: false,
  revived: false,
  unseenSince: null,
  leftover: false,
  clears: 0,
}

/**
 * A wake (or a restart that keeps a pointer) makes one owed. The deadline counts from when the wake was taken or, if earlier, when
 * the hub wrote it; `cold` when the wake had to start the worker. Without a wake a pointer already owed keeps its deadline; a newer
 * wake may move it later (that message has a later one).
 */
export function owe(s: OwedState, o: { cold: boolean; nowMs: number; wakeAtMs: number | null }): OwedState {
  const until = Math.min(o.nowMs, o.wakeAtMs ?? o.nowMs) + (o.cold ? CLAIM_DEADLINE_COLD_MS : CLAIM_DEADLINE_MS)
  if (!s.pending) return { ...NOTHING_OWED, pending: true, until }
  // a new wake starts a fresh pointer: one Enter that may have answered a prompt holds only its own message (Fable R2-1), never
  // every later one; the next pointer is decided on its own looks (the guard re-checks the box and the pane before any key)
  if (s.enterUncertain && o.wakeAtMs !== null) return { ...NOTHING_OWED, pending: true, until }
  if (o.wakeAtMs !== null && until > (s.until ?? 0)) return { ...s, until, leftover: false }
  return s
}

/** A wake older than the longest claim names only messages the hub has given back to Main: nothing is owed for it. */
export const wakeTooOld = (wakeAtMs: number, nowMs: number): boolean =>
  nowMs - wakeAtMs > WORKER_POINTER.longest_claim_s * 1000

/** What workers.json keeps of it: a supervisor that restarts types what is still wanted, once. */
export function persisted(s: OwedState): {
  pointer_owed_until?: string
  enter_owed?: true
  pointer_unseen?: true
  enter_uncertain?: true
} {
  if (!s.pending || s.until === null) return {}
  return {
    pointer_owed_until: new Date(s.until).toISOString(),
    ...(s.enterOwed ? { enter_owed: true as const } : {}),
    // typed and not yet seen in the box: kept, so a supervisor started meanwhile never types it a second time (Fable R6-4)
    ...(s.enterOwed && s.unseenSince !== null ? { pointer_unseen: true as const } : {}),
    ...(s.enterUncertain ? { enter_uncertain: true as const } : {}),
  }
}

/** Read back from this supervisor's own workers.json entry (a time that cannot be read is a deadline long past). */
export function restored(raw: {
  pointer_owed_until?: unknown
  enter_owed?: unknown
  pointer_unseen?: unknown
  enter_uncertain?: unknown
}): OwedState {
  if (typeof raw.pointer_owed_until !== 'string') return NOTHING_OWED
  const t = Date.parse(raw.pointer_owed_until)
  return {
    ...NOTHING_OWED,
    pending: true,
    enterOwed: raw.enter_owed === true,
    // typed by the last supervisor and never seen: its screen lag is long over (this clock is not that one's)
    unseenSince: raw.enter_owed === true && raw.pointer_unseen === true ? Number.NEGATIVE_INFINITY : null,
    ...(raw.enter_uncertain === true ? { enterUncertain: true } : {}),
    until: Number.isFinite(t) ? t : 0,
    restored: true,
  }
}

/** Type only at the normal prompt, onto a visible box that holds no draft, and when no attached client typed in the last 10 s. */
export function mayType(o: {
  dialog: boolean
  box: boolean
  draft: boolean
  lastClientMs: number | null
  nowMs: number
}): boolean {
  if (o.dialog || !o.box || o.draft) return false
  return o.lastClientMs === null || o.lastClientMs <= 0 || o.nowMs - o.lastClientMs >= POINTER_CLIENT_QUIET_MS
}

/** The pane as the pointer needs it (TmuxPtyHost has all of it). */
export interface PointerPane {
  clientActivities(): Promise<number[] | null>
  /** Copy mode (the owner scrolled back): keys would be mode commands and an Enter would only leave the mode. */
  inCopyMode(): Promise<boolean | null>
  visibleRowsEscaped(): Promise<string[] | null>
  sendText(text: string): Promise<PtySendResult>
  sendEnterKey(): Promise<PtySendResult>
  sendBackspaces(n: number): Promise<PtySendResult>
}

export type PointerStep = {
  state: OwedState
  /** The tick is used up (no idle check after it). */
  used: boolean
  /** The pointer was submitted: the session had a turn. */
  delivered: boolean
  /** Why it waits, for the thread's notice: the owner's draft, or no input box on the pane. */
  held: 'draft' | 'no_box' | 'copy_mode' | 'refused' | 'unseen' | 'enter_uncertain' | null
  /** The Enter just sent may have answered a prompt: the three captures' classes and why (for the audit). */
  enterCheck?: EnterCheck
  /** The line was written into the box just now: workers.json must say so before anything else happens. */
  wroteLine: boolean
  /** The pane was read this tick (false: a read failed or copy mode was on, and `held` says nothing). */
  looked: boolean
}

/** A dialog the guard must not type into: what liveDialog sees, plus `extraDialog` (a prompt nobody named, P3d3 part 4). */
type Look = { escaped: string[]; rows: string[]; box: boolean; typed: boolean; ours: boolean; dialog: boolean }

function look(escaped: string[], extraDialog: (rows: string[]) => boolean): Look {
  const rows = escaped.map(stripEscapes)
  const box = inputBox(rows) !== null
  const typed = draftPresent(escaped) === true
  const ours = typed && boxText(rows) === WORKER_POINTER_TEXT
  return { escaped, rows, box, typed, ours, dialog: liveDialog(rows).kind !== 'none' || extraDialog(rows) }
}

/**
 * One tick for an owed pointer on a worker with a pane. `nowMs` is the wall clock (the deadline), `awake` monotonic seconds
 * (the screen lag). Reads that fail use the tick up and type nothing.
 */
export async function typeOwedPointer(o: {
  pane: PointerPane
  state: OwedState
  nowMs: number
  awake: number
  sleep?: (ms: number) => Promise<void>
  extraDialog?: (rows: string[]) => boolean
}): Promise<PointerStep> {
  const extra = o.extraDialog ?? (() => false)
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let s = { ...o.state }
  const step = (used: boolean, more: Partial<PointerStep> = {}): PointerStep => ({
    state: s,
    used,
    delivered: false,
    held: null,
    wroteLine: false,
    looked: true,
    ...more,
  })
  // the typing guard, like the screen: a client list that cannot be read is not "nobody is typing"
  const clients = await o.pane.clientActivities()
  const escaped = await o.pane.visibleRowsEscaped()
  if (clients === null || escaped === null) return step(true, { looked: false })
  // in copy mode nothing typed is typing; a mode that cannot be read is not "no mode"
  const mode = await o.pane.inCopyMode()
  // scrolled back: held, and said so (its own notice); a mode that cannot be read says nothing yet
  if (mode === true) return step(true, { held: 'copy_mode' })
  if (mode !== false) return step(true, { looked: false })
  const l = look(escaped, extra)
  const draft = l.typed && !l.ours
  // The box is up and holds nothing after our text was seen in it: the owner held us off and cleared it, so it is typed again.
  if (s.enterOwed && l.box && !l.typed && s.unseenSince === null) s.enterOwed = false
  if (l.typed) s.unseenSince = null
  // Typed, and screen_lag_s later still never seen in the box: it went somewhere else (a menu that kept the focus with an empty
  // box drawn under it, or keys lost). Never typed a second time on top: held, and said once (Fable R5-1).
  const unseen = s.enterOwed && s.unseenSince !== null && o.awake - s.unseenSince > WORKER_POINTER.screen_lag_s
  if (l.ours) s.enterOwed = true
  // a pointer restored from workers.json is never typed past its deadline, however long it was held back
  if (s.restored && o.nowMs > (s.until ?? 0)) return settleLate(o.pane, s, l, clients.length > 0, extra)
  if (unseen && !l.typed) return step(true, { held: 'unseen' })
  // an Enter that may have answered a prompt is never followed by another: held until the pointer drops
  if (s.enterUncertain) return step(true, { held: 'enter_uncertain' })
  const held = draft ? ('draft' as const) : l.box ? null : ('no_box' as const)
  const lastClient = clients.length > 0 ? Math.max(...clients) : null
  if (!mayType({ dialog: l.dialog, box: l.box, draft, lastClientMs: lastClient, nowMs: o.nowMs }))
    return step(false, { held })
  let justTyped = false
  let wroteLine = false
  if (!s.enterOwed) {
    // a send that timed out may have landed: it counts as typed (the looks decide), never typed a second time on top
    const typed = await o.pane.sendText(WORKER_POINTER_TEXT)
    // the host's key guard refused it (the pane shows a menu Talos does not press keys into): held, and said so once
    if (typed === 'refused') return step(true, { held: 'refused' })
    if (typed === 'failed') return step(true, { held })
    s.enterOwed = true
    s.unseenSince = o.awake
    justTyped = true
    wroteLine = true
  }
  // never an Enter on a look that does not show exactly our line; right after typing the screen is given ten short looks
  if (!(await boxHoldsOnlyOurLine(o.pane, justTyped ? WORKER_POINTER.looks_after_typing : 1, sleep, extra)))
    return step(true, { wroteLine })
  // an Enter whose send timed out may have landed: counted as sent, never followed by a second copy of the line
  if ((await o.pane.inCopyMode()) !== false) return step(true, { wroteLine })
  const pre = await o.pane.visibleRowsEscaped()
  const enter = await o.pane.sendEnterKey()
  if (keyNotSent(enter)) return step(true, { wroteLine, ...(enter === 'refused' ? { held: 'refused' as const } : {}) })
  // did it land on a prompt that opened just then? Captured at once and ENTER_CHECK_LATER_MS later (enter-check.ts). Only an
  // Enter known to be sent: one whose send timed out may not have gone, and is counted as sent as before (never a second)
  const after = enter === 'sent' ? await o.pane.visibleRowsEscaped() : null
  if (enter === 'sent') await sleep(ENTER_CHECK_LATER_MS)
  const later = enter === 'sent' ? await o.pane.visibleRowsEscaped() : null
  // our line still there 300 ms later: once more at about 1000 ms before it counts (a slow redraw is not a lost Enter)
  let latest: readonly string[] | null | undefined
  if (enter === 'sent' && enterNeedsSlowLook(later)) {
    await sleep(ENTER_CHECK_SLOW_MS - ENTER_CHECK_LATER_MS)
    latest = await o.pane.visibleRowsEscaped()
  }
  const check = checkEnter(pre, after, later, latest)
  if (enter === 'sent' && check.flagged) {
    s = { ...s, enterUncertain: true }
    return step(true, { wroteLine, held: 'enter_uncertain', enterCheck: check })
  }
  s = { ...NOTHING_OWED }
  return { state: s, used: true, delivered: true, held: null, wroteLine, looked: true }
}

async function settleLate(
  pane: PointerPane,
  s: OwedState,
  l: Look,
  attached: boolean,
  extra: (rows: string[]) => boolean,
): Promise<PointerStep> {
  const out = (st: OwedState, used: boolean, held: PointerStep['held'] = null): PointerStep => ({
    state: st,
    used,
    delivered: false,
    held,
    wroteLine: false,
    looked: true,
  })
  // only with no client attached: then nothing the owner types can be in the way of the Backspaces
  if (l.ours && s.clears < WORKER_POINTER.late_clears && !attached) {
    const mayAct = !l.dialog && l.box
    if (mayAct && (await clearOurLine(pane, extra))) s.clears++
    return out(s, true)
  }
  // typed by us and not alone in a box we can read: it may be mixed with the owner's text
  if ((s.enterOwed || l.ours) && (l.ours || l.typed || !l.box)) {
    s.leftover = true
    return out(s, true, l.ours || l.typed ? 'draft' : 'no_box')
  }
  return out({ ...NOTHING_OWED }, false)
}

async function boxHoldsOnlyOurLine(
  pane: PointerPane,
  looks: number,
  sleep: (ms: number) => Promise<void>,
  extra: (rows: string[]) => boolean,
): Promise<boolean> {
  for (let k = 0; k < looks; k++) {
    if (k > 0) await sleep(WORKER_POINTER.look_pause_ms)
    const escaped = await pane.visibleRowsEscaped()
    if (escaped === null) return false // a read that fails ends the looks
    const l = look(escaped, extra)
    if (l.ours && !l.dialog) return true
  }
  return false
}

/** Backspace for exactly our line, after one more look, and still no client attached. */
async function clearOurLine(pane: PointerPane, extra: (rows: string[]) => boolean): Promise<boolean> {
  if (!(await boxHoldsOnlyOurLine(pane, 1, async () => {}, extra))) return false
  const clients = await pane.clientActivities()
  if (clients === null || clients.length > 0) return false
  if ((await pane.inCopyMode()) !== false) return false
  return (await pane.sendBackspaces([...WORKER_POINTER_TEXT].length)) === 'sent'
}
