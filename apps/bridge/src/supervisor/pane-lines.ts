// The last lines of a thread session's pane, for the "has been quiet" notice (router/quiet-watch.ts; protocol quiet-lines.ts has the rules).
//   - `paneLines(rows)`: the rows just ABOVE Claude's input box (never the box, its draft, its rules or the status line under it), cleaned and
//     passed through the shared redact() with an email mask, at most 3 of 100 characters. A screen with no input box (a dialog, a blank pane)
//     gives none: nothing is guessed.
//   - The idle clock keeps the latest tail (worker-idle.ts `noteScreen`).
//   - `quietLinesFor`: what workers.json carries as `quiet_lines`: only for a live pane that has been quiet for QUIET_LINES_AFTER_MS, so the
//     text is on disk for as short a time as the bridge needs it, and gone the moment the pane changes. The file is a snapshot, rewritten each
//     publish, never a history.
import { sanitizePaneLines, type WorkerStateT } from '@talos-app/protocol'
import { inputBox, isFrameRule } from './screen.ts'

/** A minute before the bridge's five (quiet-watch.ts QUIET_MS), so the lines are in the file when it decides. */
export const QUIET_LINES_AFTER_MS = 4 * 60_000

/** How many rows above the box are looked at (the last few non-blank ones are wanted; a long screen is not walked). */
const LOOK_BACK = 24

export function paneLines(rows: string[]): string[] {
  const box = inputBox(rows)
  if (!box) return []
  // box[0] is the row under the upper rule: everything above that rule is the conversation
  const above = rows.slice(Math.max(0, box[0] - 1 - LOOK_BACK), Math.max(0, box[0] - 1))
  return sanitizePaneLines(above.filter((r) => !isFrameRule(r)).map(unframe))
}

/** A row without the border characters and padding a box draws around it (screen.ts `clean`'s rule, kept here so this file has one import). */
function unframe(row: string): string {
  return row.replace(/^[\s│┃║╭╮╰╯─━┌┐└┘]+/u, '').replace(/[\s│┃║╭╮╰╯─━┌┐└┘]+$/u, '')
}

export function quietLinesFor(
  state: WorkerStateT,
  idle: { lastActiveMs: number; tail?: string[] | undefined },
  nowMs: number,
): string[] | undefined {
  if (state !== 'live' || !idle.tail || idle.tail.length === 0) return undefined
  if (nowMs - idle.lastActiveMs < QUIET_LINES_AFTER_MS) return undefined
  return idle.tail
}
