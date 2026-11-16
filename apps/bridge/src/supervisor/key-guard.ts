// The one check every key Talos sends to a pane makes first (tmux-host.ts keysRefused): an ALLOWLIST in both directions, decided
// from what Claude Code draws now (Fable's rounds 1 to 3 on the usage-limit port). The sender states what it means to press,
// and the live screen must be exactly that; anything else gets no key, and the next look decides again.
//
// - {type:'box'}: typing Talos's line into Claude's own input box, or the Enter or Backspaces for that line. Allowed only when the
//   box is positively live: Claude's exact frame (a solid rule, the cursor row, a solid rule) is the last frame on the pane, it is
//   EMPTY (`holds:'empty'`, no draft and no placeholder taken for one: the coloured capture decides, draftPresent) or holds exactly
//   Talos's line drawn as Claude Code draws typed text (`holds:'ours'`, exactBoxText), and every row under it is one of the status
//   rows Claude Code draws there (box-frame.ts, from the real captures). A menu, under the box or between rules that look like it, is never one of those rows, so it is never typed into,
//   whatever its shape. Rows in the transcript above never count. (Whether Claude Code keeps the box under a menu is not known;
//   it does not matter: an Enter goes only when the box holds exactly Talos's line, which text sent to a focused menu never does.)
// - {type:'dialog', kind}: a key for one of the screens Talos answers. Allowed only when THAT kind's own exact reader matches the
//   live region (below the last solid rule, or the whole pane when there is none, as the start screens are drawn): the exact option
//   reader (readDialog, the one first-start answers by) for folder trust and MCP consent, first-start's reader for the theme, the
//   security notes and the dev-channels warning. A phrase on screen never names anything by itself.
// - And, independently, never a key while Claude Code's usage-limit menu is anywhere on the pane (usage-limit.ts), nor when the
//   pane cannot be read, nor with no intent stated.
import { type DialogKeyKind, WORKER_POINTER_TEXT } from '@talos-app/protocol'
import { boxAtColumn0, exactBoxText, strangeRowUnder } from './box-frame.ts'
import { detectPrompt, readDialog } from './dialog-reader.ts'
import { firstStartScreen } from './first-start.ts'
import { draftPresent, inputBox, isFrameRule, liveDialog, stripEscapes } from './screen.ts'
import { isUsageLimit } from './usage-limit.ts'

/** What the sender means to press: the screen must be exactly this. */
export type KeyIntent = { type: 'box'; holds: 'empty' | 'ours' } | { type: 'dialog'; kind: DialogKeyKind }

/** Why a key was refused, for the audit: a short code, and the row under the box that is not a status row when that was it. */
export type KeyRefusal = { why: string; row?: string }

/** Pane text as the audit keeps it: no control or format characters (bidi marks, zero-width), at most 120 code points. */
export function auditRow(row: string): string {
  // control and format characters, lone surrogates (\p{Cs} matches only an unpaired one here), and the line and paragraph
  // separators, which would break the audit's one line per event (Fable R6-3)
  return [...row.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, 120).join('')
}

/** The first row of the live region: the last solid rule, or the top when there is none. */
function regionStart(rows: string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (isFrameRule(rows[i] as string)) return i
  return 0
}

/**
 * Status-row parts not yet known, by shape, each said once per supervisor run: `status_part_unknown` for one a key was allowed
 * under, `status_part_refused` for one whose shape refused the key (capture it and add it).
 */
export type ShapeNote = { event: 'status_part_unknown' | 'status_part_refused'; shape: string }
const shapesSaid = new Set<string>()
const shapesToSay: ShapeNote[] = []
/** The shapes not yet audited, taken once. */
export const takeUnknownShapes = (): ShapeNote[] => shapesToSay.splice(0)
function note(event: ShapeNote['event'], shapes: readonly string[]): void {
  for (const shape of shapes)
    if (!shapesSaid.has(`${event} ${shape}`)) {
      shapesSaid.add(`${event} ${shape}`)
      shapesToSay.push({ event, shape })
    }
}
/** A key allowed: the unknown parts it was allowed under are noted (only then: a refused key says its own why). */
function allowed(notes: { unknown: string[] }): null {
  note('status_part_unknown', notes.unknown)
  return null
}

/** Claude's input box is what is live, empty or holding exactly Talos's line, with only status rows under it. */
function boxRefusal(escaped: string[], rows: string[], holds: 'empty' | 'ours'): KeyRefusal | null {
  const box = inputBox(rows)
  if (box === null) return { why: 'no_input_box' }
  // drawn from column 0, as Claude Code draws it: a frame a status line prints is indented (Fable R2-4 on the pair)
  if (!boxAtColumn0(rows, box)) return { why: 'box_not_at_column_0' }
  // under the box only Claude Code's own status rows (a rule, a second frame, a menu: none of them is one)
  const shapes = { unknown: [] as string[], refused: [] as string[] }
  const strange = strangeRowUnder(rows, box[1], shapes)
  if (strange !== null) {
    note('status_part_refused', shapes.refused)
    return { why: 'row_under_box', row: auditRow(strange) }
  }
  const draft = draftPresent(escaped)
  if (holds === 'empty') return draft === false ? allowed(shapes) : { why: 'box_not_empty' }
  if (draft !== true || exactBoxText(rows, box) !== WORKER_POINTER_TEXT) return { why: 'box_not_our_line' }
  // the Enter (and Backspaces with it): also no select or dialog anywhere on the pane, read in this same capture, nothing awaited
  // between this verdict and the key (tmux-host.ts unlessInMode). A select drawn after this capture is the residual (SECURITY.md);
  // enter-check.ts detects it after the Enter.
  // (`login_expired` is the sign-in hint under a live box, not a select an Enter could answer)
  const dialog = liveDialog(rows).kind
  if ((dialog !== 'none' && dialog !== 'login_expired') || detectPrompt(rows) !== null) return { why: 'prompt_on_pane' }
  return allowed(shapes)
}

/** The live region is exactly the screen `kind`, read by that kind's own exact reader. */
function dialogLive(rows: string[], kind: DialogKeyKind): boolean {
  const region = rows.slice(regionStart(rows))
  // the same exact reader first-start answers by (without the colour check: the two must agree, or a start stalls)
  if (kind === 'trust' || kind === 'mcp_consent') return readDialog(region)?.kind === kind
  return firstStartScreen(region).kind === kind
}

/** Why a key meant as `intent` may not go to a pane showing `escaped` (its coloured rows; null: unread), or null: it may. */
export function keyRefusal(escaped: readonly string[] | null, intent?: KeyIntent): KeyRefusal | null {
  if (escaped === null) return { why: 'unreadable' }
  if (intent === undefined) return { why: 'no_intent' }
  const all = [...escaped]
  while (all.length > 0 && stripEscapes(all[all.length - 1] as string).trim() === '') all.pop()
  const rows = all.map(stripEscapes)
  if (isUsageLimit(rows)) return { why: 'usage_limit' }
  if (intent.type === 'box') return boxRefusal(all, rows, intent.holds)
  return dialogLive(rows, intent.kind) ? null : { why: `not_${intent.kind}` }
}

/** Whether a key meant as `intent` may go to a pane showing `escaped`. */
export function keysAllowed(escaped: readonly string[] | null, intent?: KeyIntent): boolean {
  return keyRefusal(escaped, intent) === null
}
