// Needs-you prompts on the phone (docs/OPTION-C.md "Needs-you prompts"). A thread session's Claude Code pane shows a known
// dialog (trust this folder, allow an MCP server, sign in); the bridge turns what the Mac read from the screen into a
// `kind:'dialog'` card, and the owner answers with a tap on any device. The bridge, never the agent, handles the answer: it
// records it first-wins, hands it to the Mac in a file, and the Mac presses the key.
//
// The card mirrors the dialog. `options` are the labels exactly as read from the screen, in screen order, and the bound
// payload carries them, so payload_hash covers every button. Subject and labels come from a repository the owner may not
// control: they are plain text everywhere, with hidden characters shown (`dialogVisibleText`), never markdown or HTML.
import { z } from 'zod'
import { payloadHash } from './canonical.ts'
import {
  DIALOG_TTL_S,
  DialogFacts,
  DialogId,
  DialogKind,
  type DialogKindT,
  type WorkerDialogT,
} from './dialog-files.ts'
import { IsoTs, ThreadId } from './ids.ts'
import { bindingFrom, type CardT } from './models.ts'
import { INVISIBLE_OR_BIDI } from './permission.ts'

/** The relay feature that says it knows `kind:'dialog'` and the app it ships can draw one. The bridge makes none without it. */
export const NEEDS_YOU_FEATURE = 'needs-you/1'

export const DIALOG_OPEN_LABEL = 'Open on the Mac'
export const DIALOG_FOOTNOTE = 'Your Mac presses the key for you. The session answers your message once it is in.'
export const DIALOG_PRESSING_TEXT = 'Pressing the key on your Mac…'
export const DIALOG_NOTHING_PRESSED_TITLE = 'Nothing pressed'
export const DIALOG_CLOSED_TEXT = "The session isn't waiting on this any more."
export const DIALOG_OPENED_TEXT = 'Opened on the Mac'
/** The Mac pressed nothing because it could not check the answer is the owner's (no pin for the device, or a proof check failed). */
export const DIALOG_UNVERIFIED_TEXT = 'Answer on the Mac'
/** A popup click or an earlier answer got there first, so the Mac pressed nothing for this one. */
export const DIALOG_ALREADY_ANSWERED_TEXT = 'Already answered at the Mac first.'
/** The Mac pressed something other than what was answered, or did not report. Nothing is claimed. */
export const DIALOG_MISMATCH_TEXT = 'Your Mac reported pressing something different. Check the session in Terminals.'
export const DIALOG_UNCONFIRMED_TEXT =
  "Your Mac didn't confirm that it pressed the key. Check the session in Terminals."

/**
 * The words every surface says for a dialog, in one table: the phone and web card (`composeDialogCard`) and the Mac popup read it. The
 * heading and the one-line explanation are per kind; `{thread}` is the thread's name (its hidden characters shown). The footers belong to
 * the surface (the card's footnote, the popup's footer). The table is committed as fixtures/needs-you/wording.json and the Mac app's tests
 * assert the popup's text equals it, so the two cannot drift. "Sign in", never "log in".
 */
export const DIALOG_WORDING = {
  title: {
    trust: 'Trust this folder?',
    mcp_consent: 'Allow this MCP server?',
    login: '{thread} needs you to sign in',
  },
  sentence: {
    trust:
      "{thread}'s session wants to work in this folder. Claude will be able to read, change and run files in it, and in folders inside it.",
    mcp_consent: "{thread}'s session wants to turn on this server's tools for its folder.",
    login: "{thread}'s session needs you to sign in to Claude on the Mac.",
  },
  footer: { card: DIALOG_FOOTNOTE, popup: 'Also on your phone. Answer either one.' },
} as const

/** The same words the Mac's own thread line uses for the prompt (SessionSwitcher.promptName). */
const DIALOG_PROMPT: Record<DialogKindT, string> = {
  trust: 'trust this folder',
  mcp_consent: 'approve a project MCP server',
  login: 'log in',
}

/** What a dialog card binds: the dialog, nothing else. */
export const DialogCardPayload = z
  .strictObject({
    dialog_id: DialogId,
    thread: ThreadId,
    dialog_kind: DialogKind,
    ...DialogFacts,
    expires_at: IsoTs,
  })
  .refine((d) => (d.dialog_kind === 'login' ? d.options.length === 0 : d.options.length >= 1), {
    path: ['options'],
    message: 'a login dialog has no options; the others have at least one',
  })
export type DialogCardPayloadT = z.infer<typeof DialogCardPayload>

/**
 * Text from the screen or a repository, made safe to show on one line: every invisible, direction-changing or control
 * character becomes `⟦U+XXXX⟧`, and so do the marker brackets themselves, so no label can print a marker of its own. The app
 * draws the same style (`revealHidden`), so a card reads the same wherever the text was made.
 */
const MARKED = new RegExp(`${INVISIBLE_OR_BIDI.source}|[\u27e6\u27e7]`, 'gu')
export function dialogVisibleText(text: string): string {
  return text.replace(MARKED, (run) =>
    [...run]
      .map((ch) => `\u27e6U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}\u27e7`)
      .join(''),
  )
}

const name = (threadName: string): string => dialogVisibleText(threadName).trim() || 'A thread'

const fill = (text: string, thread: string): string => text.replaceAll('{thread}', () => thread)

/** The heading of the card (a card title is at most 120 characters, so a long thread name is cut). */
export function dialogTitle(kind: DialogKindT, threadName: string): string {
  const n = [...name(threadName)]
  return fill(DIALOG_WORDING.title[kind], n.length > 60 ? `${n.slice(0, 60).join('')}\u2026` : n.join(''))
}

/** The body under the title. Plain text. */
export function dialogBody(kind: DialogKindT, threadName: string): string {
  return fill(DIALOG_WORDING.sentence[kind], name(threadName))
}

/** The card the screen did not match when the Mac went to answer it. */
export function dialogNothingPressedText(threadName: string): string {
  return `${name(threadName)}'s screen showed something different when Talos went to answer, so it left it alone. A new card comes if it still needs you.`
}

/** The one thread line when a dialog waits out its 15 minutes: the Mac's own wording, so the owner reads one meaning. */
export function dialogFallbackLine(kind: DialogKindT, threadName: string): string {
  const n = name(threadName)
  return `${n}'s session is waiting on a '${DIALOG_PROMPT[kind]}' prompt; open Terminals → ${n} on the Mac to answer.`
}

/**
 * What the answered card says about the choice. A natural past tense where there is one ("Trusted ~/Documents/x"), else the
 * option's own label. Always visible text: a hidden character in the folder or label shows as [U+XXXX].
 */
export function dialogAnswerText(kind: DialogKindT, subject: string | null, label: string): string {
  if (kind === 'trust' && /^yes\b/i.test(label.trim())) return `Trusted ${dialogVisibleText(subject ?? 'this folder')}`
  return dialogVisibleText(label)
}

/** The option the owner chose, if the index is one of the card's. */
export function dialogChoiceLabel(
  d: Pick<DialogCardPayloadT, 'dialog_kind' | 'options'>,
  choice: number,
): string | null {
  return d.dialog_kind === 'login' ? null : (d.options[choice] ?? null)
}

export type ComposeDialogCardInput = {
  card_id: string
  dialog: WorkerDialogT
  thread_id: string
  thread_name: string
  now: number
}

/**
 * The pending card for a dialog, or null when it cannot be one (already past its time). Pure: the caller writes it to the
 * ledger before sending `card.create`. The card never lives longer than DIALOG_TTL_S from now, whatever the file says.
 */
export function composeDialogCard(input: ComposeDialogCardInput): CardT | null {
  const d = input.dialog
  const expiresMs = Math.min(Date.parse(d.expires_at), input.now + DIALOG_TTL_S * 1000)
  if (!Number.isFinite(expiresMs) || expiresMs <= input.now) return null
  const payload: DialogCardPayloadT = {
    dialog_id: d.id,
    thread: input.thread_id,
    dialog_kind: d.kind,
    subject: d.subject,
    options: d.options,
    expires_at: new Date(expiresMs).toISOString(),
  }
  if (!DialogCardPayload.safeParse(payload).success) return null
  const card: CardT = {
    id: input.card_id,
    thread_id: input.thread_id,
    kind: 'dialog',
    title: dialogTitle(d.kind, input.thread_name),
    // one line for lists and notifications; nothing from the screen goes in it
    summary: `${name(input.thread_name)}'s session is waiting for you.`,
    destination: [],
    body: dialogBody(d.kind, input.thread_name),
    body_format: 'plain',
    fields: [],
    attachments: [],
    primary_label: d.kind === 'login' ? DIALOG_OPEN_LABEL : 'Answer',
    kill_label: '',
    allow_edit: false,
    allow_revise: false,
    risk: 'low',
    origin: 'background',
    payload,
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: new Date(input.now).toISOString(),
    expires_at: payload.expires_at,
  }
  card.payload_hash = payloadHash(bindingFrom(card))
  return card
}

/** The bound dialog, if the card is a dialog card whose payload fits. */
export function dialogOf(card: Pick<CardT, 'kind' | 'payload'>): DialogCardPayloadT | null {
  if (card.kind !== 'dialog') return null
  const r = DialogCardPayload.safeParse(card.payload)
  return r.success ? r.data : null
}
