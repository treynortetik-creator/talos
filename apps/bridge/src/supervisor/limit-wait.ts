// Claude Code's own wait at a usage limit, as it shows on the pane. With `autoContinueAtUsageLimit` on, Claude Code arms a timer in its
// own process (it waits for the reset, then continues the task by itself) and draws a footer notice under its input box while the
// timer is armed. Parking, restarting or killing that process ends the timer, so the supervisor does not end such a session by
// itself while the notice shows (worker-slots.ts limitWaitActive). Reading it follows readUsageLimit's discipline: Claude Code's
// own row, in Claude Code's own place, in its exact words; a copy quoted in the conversation, typed in the box or reworded is not it.
//
// The words are Claude Code 2.1.322's footer strings (its bundle, read only, never run): the armed phase's `waiting` text
// "Continuing automatically {when} · Esc to cancel" with {when} "at <time>" or "when it resets", and "Continuing shortly · Esc to
// cancel" once the reset has passed. <time> is what its DP() draws in en-US: the hour (and minutes when not :00) with am or pm in
// lower case and no space, `4pm`, `3:10pm`, and, when the reset is more than a day away or on another day, `Dec 1, 4pm` (a year,
// `Dec 1, 2027, 4pm`, when it is in another year). No real capture of the row exists yet, so it is anchored on what is: Claude's input
// box drawn from column 0 (the after-esc capture's shape), and the row UNDER that box, where its footer is drawn. Claude Code can
// replace these words from a server setting; a replaced text reads as no wait here (the session is then parked as before).
import { boxAtColumn0 } from './box-frame.ts'
import { clean, inputBox } from './screen.ts'
import { type ResetParts, resetParts, resetsAt } from './usage-limit.ts'

/** The skip never holds longer than this after the notice first showed: a stale match cannot pin a session for ever. */
export const LIMIT_WAIT_MAX_MS = 6 * 3600_000
/** After the reset moment Claude Code needs a little time to continue by itself (its jitter): the skip holds this much longer. */
export const LIMIT_WAIT_GRACE_MS = 15 * 60_000
/** How many rows under the box are looked at: its status row, a spacer and the footer's own rows, never a long tail. */
const ROWS_UNDER_BOX = 6

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
const CLOCK = '(?:1[0-2]|[1-9])(?::[0-5]\\d)?(?:am|pm)'
/** The time as DP() draws it: `4pm`, `3:10pm`, `Dec 1, 4pm`, `Dec 1, 2027, 4pm`. */
const TIME = `(?:${MONTH} (?:[12]\\d|3[01]|[1-9])(?:, \\d{4})?, )?${CLOCK}`
const AT = new RegExp(`^Continuing automatically at (${TIME}) · Esc to cancel$`)
const WHEN_IT_RESETS = 'Continuing automatically when it resets · Esc to cancel'
const SHORTLY = 'Continuing shortly · Esc to cancel'

/** The wait on these rows, with the reset the row names (null: it names none), or null when Claude Code's notice is not there. */
export type LimitWait = { parts: ResetParts | null }

/** Claude Code's own wait notice on these rows (plain text, no escapes), or null. */
export function readLimitWait(rows: readonly string[]): LimitWait | null {
  const all = [...rows]
  while (all.length > 0 && (all[all.length - 1] as string).trim() === '') all.pop()
  const box = inputBox(all)
  // Claude's own live box, from column 0: a quoted frame (indented) is no box, and with none there is nowhere its footer is
  if (!box || !boxAtColumn0(all, box)) return null
  for (let i = box[1] + 1; i < Math.min(all.length, box[1] + 1 + ROWS_UNDER_BOX); i++) {
    const row = clean(all[i] as string)
    if (row === WHEN_IT_RESETS || row === SHORTLY) return { parts: null }
    const at = AT.exec(row)
    // the year, when DP draws one, is dropped: the reader's date is a month and a day
    if (at) return { parts: resetParts(`resets ${(at[1] as string).replace(/, \d{4},/, ',')}`) }
  }
  return null
}

/**
 * When the skip ends, in ms: the reset plus 15 minutes, or 6 hours after the notice first showed, whichever comes first. With no
 * reset that can be read (`resetMs` null or not a number) it is the 6 hours.
 */
export function limitWaitDeadlineMs(sinceMs: number, resetMs: number | null): number {
  const cap = sinceMs + LIMIT_WAIT_MAX_MS
  if (resetMs === null || !Number.isFinite(resetMs)) return cap
  return Math.min(cap, resetMs + LIMIT_WAIT_GRACE_MS)
}

/** The reset the notice named, as a moment (ISO), or null when it named none or it cannot be worked out. Kept with the wait, never acted on. */
export const limitWaitResetIso = (w: LimitWait, nowMs: number): string | null =>
  resetsAt(w.parts, nowMs, Intl.DateTimeFormat().resolvedOptions().timeZone)
