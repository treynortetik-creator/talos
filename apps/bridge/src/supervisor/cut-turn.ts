// A turn that was cut off (the session died, or a restart had to stop it mid-turn), kept so the next start of that same
// conversation can ask Claude Code to run the turn again (CLAUDE_CODE_RESUME_INTERRUPTED_TURN, worker-spec.ts). The record is the
// supervisor's own field in workers.json, never part of the shared schema. Used once: any start clears it.

/** The turn is run again only when the start comes this soon after the cut. A turn re-running hours later, after the owner moved on, is a surprise. */
export const RESUME_TURN_MAX_AGE_MS = 30 * 60 * 1000

export type CutTurn = {
  /** The conversation the turn was cut in: only a resume of this id may run it again. */
  session: string
  /** When it was cut (ISO). */
  at: string
  /** The session was in plan mode: Claude Code will not run it again, and the owner should look first. */
  plan: boolean
  /** The dead launch's nonce, to find what it left running (proc-reap.ts). */
  nonce?: string
  /** When the cut turn began, in ms since boot (never the wall clock): the reap ends only what started at or after it. */
  fromBoot?: number
}

/** The footer of Claude's box says the permission mode: true for plan, false for any other; null when it says nothing. */
export function planModeOf(rows: readonly string[] | null): boolean | null {
  if (!rows) return null
  for (const row of rows.slice(-8)) {
    if (/⏸ plan mode on/.test(row)) return true
    if (/⏸ manual mode on|⏵⏵ (?:accept edits|auto mode|bypass permissions) on|^\s*\? for shortcuts/.test(row))
      return false
  }
  return null
}

/** Did the launch put the session in plan mode itself? */
export function argvInPlan(argv: readonly string[]): boolean {
  return argv.some((a, i) => a === '--permission-mode=plan' || (a === '--permission-mode' && argv[i + 1] === 'plan'))
}

/** Set the resume-turn variables on this start? Only a resume of the cut conversation, soon enough, not cut in plan mode. */
export function resumeTurnFor(cut: CutTurn | null | undefined, sessionId: string, nowMs: number): boolean {
  if (!cut || cut.plan || cut.session !== sessionId) return false
  const at = Date.parse(cut.at)
  if (!Number.isFinite(at)) return false
  const age = nowMs - at
  // not older than the limit, and not from the future either: a clock that stepped back far makes the time worthless
  return age <= RESUME_TURN_MAX_AGE_MS && age >= -RESUME_TURN_CLOCK_SKEW_MS
}

/** How far a cut time may be ahead of the clock (a small step back, a second source of time) and still count. */
export const RESUME_TURN_CLOCK_SKEW_MS = 60 * 1000

/**
 * What Claude Code draws under a turn the owner stopped with Esc (real-2.1.318/after-esc.txt: a corner, a no-break space, then the
 * words). Whitespace after the corner is matched loosely (the capture has a no-break space that a retyped line would not), but the
 * row must start with Claude's own two-space indent and end with the words: a tool's output that prints the line is indented deeper,
 * prefixed or followed by more text, and is not an Esc.
 */
const INTERRUPT_LINE = /^ {2}⎿\s+Interrupted · What should Claude do instead\?\s*$/

/** How many such lines the pane shows now: a turn that ends in one more than before was stopped by the owner. */
export function interruptCount(rows: readonly string[] | null): number {
  return rows ? rows.filter((r) => INTERRUPT_LINE.test(r)).length : 0
}

/** The record as workers.json carries it (flat strings, like the other own fields). */
export type CutFields = {
  cut_turn_session?: string
  cut_turn_at?: string
  cut_turn_plan?: true
  cut_turn_nonce?: string
  cut_turn_from_boot?: number
}

export function cutFields(cut: CutTurn | null | undefined): CutFields {
  if (!cut) return {}
  return {
    cut_turn_session: cut.session,
    cut_turn_at: cut.at,
    ...(cut.plan ? { cut_turn_plan: true as const } : {}),
    ...(cut.nonce ? { cut_turn_nonce: cut.nonce } : {}),
    ...(cut.fromBoot !== undefined ? { cut_turn_from_boot: cut.fromBoot } : {}),
  }
}

/** The record from the last supervisor's own fields (null: none, or not whole). */
export function restoredCut(raw: Record<string, unknown>): CutTurn | null {
  const { cut_turn_session: s, cut_turn_at: at, cut_turn_nonce: n, cut_turn_from_boot: from } = raw
  if (typeof s !== 'string' || typeof at !== 'string') return null
  return {
    session: s,
    at,
    plan: raw.cut_turn_plan === true,
    ...(typeof n === 'string' && n ? { nonce: n } : {}),
    ...(typeof from === 'number' && Number.isFinite(from) ? { fromBoot: from } : {}),
  }
}

/** Claude's footer shows "esc to interrupt" while a turn runs: true when it is on the pane now. */
export function escHintShown(rows: readonly string[] | null): boolean {
  return rows ? rows.slice(-8).some((r) => /esc to interrupt/.test(r)) : false
}
