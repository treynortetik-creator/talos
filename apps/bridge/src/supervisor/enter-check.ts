// After the pointer's Enter: did it land on a prompt? (Pantheon's decision on Fable R1-2 of the key-guard pair.) The guard sends
// the Enter only when the box shows exactly Talos's line and no select or dialog is anywhere on the pane, re-captured with nothing
// awaited before the send; a select Claude Code draws inside that window (measured on Linux: median 4.5 ms, worst 15.3 ms on 2
// idle cores) would take the Enter as its default. Prevention cannot be complete, so this detects: the pane is captured right after
// the Enter and again about 300 ms later, and the Enter is flagged when Talos's line is still in the box later (it did not submit
// the line), or a select or dialog that the pre-send capture did not have shows after it. A line still there at 300 ms is looked
// at once more about 1000 ms after the Enter (a slow redraw is not a lost Enter), and that look decides (Fable R2-2b). A select
// that shows only once the box was seen empty right after the Enter is the turn's own (the line was submitted): not flagged (R2-2a). Shared with the Mac
// (apps/desktop/Tests/Fixtures/enter-detection-vectors.json); classes are words, never screen text.
import { WORKER_POINTER_TEXT } from '@talos-app/protocol'
import { exactBoxText } from './box-frame.ts'
import { detectPrompt } from './dialog-reader.ts'
import { draftPresent, inputBox, liveDialog, stripEscapes } from './screen.ts'

export type EnterClass =
  | 'box_empty'
  | 'box_ours'
  | 'box_other'
  | 'prompt'
  | 'dialog'
  | 'usage_limit'
  | 'none'
  | 'unreadable'
export type EnterCheck = {
  flagged: boolean
  why: 'line_still_in_box' | 'prompt_appeared' | null
  /** `latest`: the look about ENTER_CHECK_SLOW_MS after the Enter, taken only when `later` still shows our line. */
  classes: { pre: EnterClass; after: EnterClass; later: EnterClass; latest?: EnterClass }
}

/** The third look after the Enter, only when the second still shows our line (enterNeedsSlowLook). */
export const ENTER_CHECK_SLOW_MS = 1000

/** Whether the look at ENTER_CHECK_SLOW_MS is needed: `later` still shows our line in the box. */
export const enterNeedsSlowLook = (later: readonly string[] | null): boolean => enterClass(later) === 'box_ours'

/** One capture as one word (precedence: the usage-limit menu, a dialog, a prompt, then the box). */
export function enterClass(escaped: readonly string[] | null): EnterClass {
  if (escaped === null) return 'unreadable'
  const all = [...escaped]
  while (all.length > 0 && stripEscapes(all[all.length - 1] as string).trim() === '') all.pop()
  const rows = all.map(stripEscapes)
  const dialog = liveDialog(rows)
  if (dialog.kind === 'usage_limit') return 'usage_limit'
  if (dialog.kind !== 'none' && dialog.kind !== 'login_expired') return 'dialog'
  if (detectPrompt(rows) !== null) return 'prompt'
  const box = inputBox(rows)
  if (box === null) return 'none'
  const draft = draftPresent(all)
  if (draft === false) return 'box_empty'
  return exactBoxText(rows, box) === WORKER_POINTER_TEXT ? 'box_ours' : 'box_other'
}

const isPrompt = (c: EnterClass) => c === 'prompt' || c === 'dialog' || c === 'usage_limit'

/**
 * The verdict on one Enter from its captures (null: could not be read; `latest` undefined: not taken). Our line still in the box
 * at the last look taken: line_still_in_box. Else a select or dialog the pre-send capture did not have: at once after the Enter, or
 * later unless the box was seen empty at once after it (then the line went in and the select is its turn's own).
 */
export function checkEnter(
  pre: readonly string[] | null,
  after: readonly string[] | null,
  later: readonly string[] | null,
  latest?: readonly string[] | null,
): EnterCheck {
  const classes = {
    pre: enterClass(pre),
    after: enterClass(after),
    later: enterClass(later),
    ...(latest !== undefined ? { latest: enterClass(latest) } : {}),
  }
  const last = classes.latest ?? classes.later
  const afterwards = isPrompt(classes.later) || (classes.latest !== undefined && isPrompt(classes.latest))
  const why =
    last === 'box_ours'
      ? ('line_still_in_box' as const)
      : !isPrompt(classes.pre) && (isPrompt(classes.after) || (afterwards && classes.after !== 'box_empty'))
        ? ('prompt_appeared' as const)
        : null
  return { flagged: why !== null, why, classes }
}

/**
 * After a pointer's look: a flagged Enter's audit row (`enterAudit`) and the status-part shapes the key guard noted on the pane (each
 * event with its shape), never any screen text. Kept here so workers.ts stays within its size.
 */
export function auditPointerLook(
  audit: (event: string, fields?: Record<string, string>) => void,
  thread: string,
  check: EnterCheck | undefined,
  shapes: ReadonlyArray<{ event: string; shape: string }>,
): void {
  if (check) audit('enter_may_have_answered', enterAudit(thread, check)) // classes, never text
  for (const n of shapes) audit(n.event, { shape: n.shape }) // its shape, never its text
}

/** The audit row for a flagged Enter: the thread and the three captures' classes, never their text. */
export const enterAudit = (thread: string, c: EnterCheck): Record<string, string> => ({
  thread,
  pre: c.classes.pre,
  after: c.classes.after,
  later: c.classes.later,
  latest: c.classes.latest ?? 'not_taken',
  why: c.why ?? '',
})
