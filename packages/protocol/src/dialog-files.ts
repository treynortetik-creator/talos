// Needs-you prompts, the Mac side of the contract (docs/OPTION-C.md "Needs-you prompts"). The desktop supervisor reads a
// thread session's pane; when it shows a KNOWN Claude Code dialog it records it in workers.json (`WorkerDialog`). The bridge
// makes a card from it, and the files below carry the rest between the two, one set per thread under
// $TALOS_APP_HOME/workers/<thread>/. Every one is a small JSON file, mode 0600, written atomically (a temporary file, then a
// rename). Every one can be written by a program running as the same user, the agent included, so nothing in them is
// trusted to say who answered: the ANSWER carries the owner's own signature (`proof`), and the Mac presses a key only after
// checking it (steps below). Every other file only changes what a card says; none of them can press anything.
import { z } from 'zod'
import { CardId, IsoTs, ThreadId } from './ids.ts'

/**
 * The dialogs a card is made for. The bypass-permissions disclaimer and any dialog Talos does not know stay as they are.
 * `dev_channels` is Main's own warning about the development channel (its `subject` is the channels, comma separated);
 * the supervisor publishes it as `supervisor.main_dialog` in workers.json, because Main has no entry of its own, and the card
 * goes to the default thread.
 */
export const DIALOG_KINDS = ['trust', 'mcp_consent', 'login', 'dev_channels'] as const
export const DialogKind = z.enum(DIALOG_KINDS)
export type DialogKindT = z.infer<typeof DialogKind>

/** Most buttons a card shows. The trust dialog has two, the MCP one three; the rest is room, not a promise. */
export const DIALOG_MAX_OPTIONS = 6
export const DIALOG_LABEL_MAX = 120
export const DIALOG_SUBJECT_MAX = 500
/** How long a dialog can wait for a tap, counted from when the Mac first saw it. */
export const DIALOG_TTL_S = 900
/** A file bigger than this is not one of ours and is never read whole (every file except the answer). */
export const DIALOG_FILE_MAX_BYTES = 4096
/**
 * The answer file carries the signed frame and the card's binding (up to 6 options of 120 characters and a 500 character
 * subject, each possibly escaped twice), so it has its own, larger cap.
 */
export const DIALOG_ANSWER_MAX_BYTES = 16 * 1024
/** An answer older than this (by its own `at`) is ignored, or dated this far ahead. Same limits as agent-request.json. */
export const DIALOG_ANSWER_MAX_AGE_MS = 300_000
export const DIALOG_ANSWER_MAX_FUTURE_MS = 60_000
/**
 * The Mac writes `dialog-result.json` within this long of taking an answer. The bridge gives up on a report after this long,
 * ends the card as unconfirmed and DELETES the answer file, so a late Mac finds nothing to press (the answer's own window above
 * is the outer limit for a bridge that stopped).
 */
export const DIALOG_RESULT_WAIT_MS = 60_000
/** The signed frame's `ts` must be at most this old, and at most this far ahead of the Mac's clock, when the Mac checks it. */
export const DIALOG_PROOF_MAX_AGE_MS = 15 * 60_000
export const DIALOG_PROOF_MAX_FUTURE_MS = 2 * 60_000
/**
 * The Mac posts its old thread line for a dialog only when no card file (`dialog-card.json` naming this dialog) has appeared
 * this long after it first saw the dialog. The bridge makes the card within a second of workers.json changing (it watches the
 * folder) and at the latest at its next 10 second poll, so 15 seconds covers one whole poll and the write. An old bridge, a
 * relay without `needs-you/1` or a bridge that is down never writes the file, and the owner then gets the line as before.
 */
export const DIALOG_CARD_WAIT_MS = 15_000

/**
 * One sighting of a dialog. Unique per sighting: a dialog that goes away and comes back has a new id. The Mac makes it from at
 * least 128 bits of randomness (22 or more characters of base64url, or 32 hex), so no one can name a dialog before it is on
 * the pane. A schema cannot check randomness; it checks the length and the characters.
 */
export const DialogId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/)
/** Names one answer, so the reader acts on it at most once. */
export const DialogControlId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const Label = z.string().min(1).max(DIALOG_LABEL_MAX)

/**
 * With a `dev_channels` dialog the guard refused because Main's start command is not the one the owner last confirmed: what differs at
 * the level the launch fingerprint knows. Names only, never a value (an env value can be a secret). An empty list means the Mac cannot say
 * what changed (nothing was confirmed before, or the stored confirmation could not be checked).
 */
export const LAUNCH_CHANGED_PIECES = ['folder', 'program', 'flags', 'env'] as const
export const LaunchChanged = z.array(z.enum(LAUNCH_CHANGED_PIECES)).max(LAUNCH_CHANGED_PIECES.length)

/** A login dialog has nothing to choose; the others have at least one option. */
const optionsFitKind = (d: { dialog_kind?: string; kind?: string; options: string[] }) =>
  (d.dialog_kind ?? d.kind) === 'login' ? d.options.length === 0 : d.options.length >= 1

/**
 * The shared shape of a dialog on a card and in workers.json. `subject` is the folder or server the dialog is about, exactly
 * as read from the screen, or null when the Mac could not read it exactly. `options` are the labels as read, in screen order.
 */
export const DialogFacts = {
  subject: z.string().min(1).max(DIALOG_SUBJECT_MAX).nullable(),
  options: z.array(Label).max(DIALOG_MAX_OPTIONS),
}

/**
 * workers.json, `threads.<id>.dialog` (the supervisor writes it): present while the dialog is on the pane, absent when it is
 * gone. A new `id` means a new sighting. `cursor` is the index of the highlighted option, or null when the Mac could not
 * tell. `expires_at` is `seen_at` plus DIALOG_TTL_S. A value that does not fit is read as "no dialog", never as an error:
 * workers.json carries the state of every thread and one bad field must not hide the rest.
 */
export const WorkerDialog = z
  .object({
    id: DialogId,
    kind: DialogKind,
    ...DialogFacts,
    cursor: z
      .number()
      .int()
      .min(0)
      .max(DIALOG_MAX_OPTIONS - 1)
      .nullable(),
    launch_changed: LaunchChanged.optional(),
    seen_at: IsoTs,
    expires_at: IsoTs,
  })
  .refine(optionsFitKind, { path: ['options'], message: 'a login dialog has no options; the others have at least one' })
export type WorkerDialogT = z.infer<typeof WorkerDialog>

/** The choice an answer carries: an option index, or `open` (the login card's one button). Exactly one. */
const choiceOrOpen = (a: { choice?: number | undefined; action?: 'open' | undefined }) =>
  (a.choice === undefined) !== (a.action === undefined)

/**
 * The owner's own signature on the tap, so the answer file proves itself (see the steps below). `signed` is the exact text the
 * owner's device signed: `ownerSignedString(frame)`, the JCS form of the `card.resolve` frame without `osig`, `relay` and
 * `stepup_token`, built from the RAW frame as received. `binding` is `jcs(card binding)`, the text `payload_hash` commits to.
 */
export const DialogProof = z.strictObject({
  signed: z.string().min(1).max(4096),
  osig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  device_id: z.string().regex(/^d_[a-z2-7]{20}$/),
  binding: z.string().min(1).max(12288),
})
export type DialogProofT = z.infer<typeof DialogProof>

/**
 * `workers/<thread>/dialog-answer.json` (the bridge writes, the Mac reads, acts on and deletes): press this. Written only
 * after the card's answer was recorded first-wins. `v` is 2. At most DIALOG_ANSWER_MAX_BYTES.
 *
 * `choice`, `action`, `label` and `by` at the top are for DISPLAY and for the Mac's log only; the Mac presses from what the
 * signed text says. `by` is the device that answered ("Alex's iPhone").
 *
 * HOW THE MAC VERIFIES (every step must pass, in this order, or it presses NOTHING and writes `dialog-result.json` with
 * `nothing_pressed`, reason `unverified` for steps 1 to 4 and `screen_changed` for step 5, or `already_answered`):
 *
 *  1. `proof.device_id` is a **device paired and not revoked in devices.json** (`$TALOS_APP_HOME/devices.json`: an entry with that
 *     `id`, a `pubkey_jwk`, and no `revoked_at`), and its P-256 public key `K` satisfies `deviceIdFromSpki(K) == proof.device_id`,
 *     where `deviceIdFromSpki(spki)` is `"d_" + first 20 characters of the lowercase RFC 4648 base32 (no padding) of
 *     SHA-256(spki)`, `spki` being the DER SubjectPublicKeyInfo of `K`. The lookup is one function, `pinnedKey(device_id) -> K | nil`,
 *     so where the keys come from can change in one place. (devices.json can be written by any program running as the same user;
 *     the tripwire is what is meant to catch a device added that way. See docs/SECURITY.md.) A Mac whose devices.json is missing,
 *     unreadable or has no such device passes nothing here: the card says "Answer on the Mac".
 *  2. The owner signature checks. `proof.osig` is base64url (no padding) of 64 raw bytes (IEEE P1363, `r || s`, NOT DER). It
 *     is an ECDSA P-256 / SHA-256 signature by `K` over the UTF-8 bytes of the string
 *         "talos-owner/v1" + "\n" + proof.device_id + "\n" + sha256Hex(proof.signed)
 *     where `sha256Hex` is the lowercase hex of SHA-256 over the UTF-8 bytes of `proof.signed` exactly as stored in the file
 *     (do not parse and re-serialize it). The domain string is `OWNER_SIG_DOMAIN` in packages/protocol/src/owner-sig.ts.
 *  3. Parse `proof.signed` as JSON. It must be an object with `type == "card.resolve"`, `action == "primary"`, NO `edited`
 *     key, `device_id == proof.device_id`, and a `choice` that is an integer 0 to 5 (absent only for a login dialog, which is
 *     answered with `action:'open'`). Its `ts` (ISO 8601) must be no more than 15 minutes before the Mac's clock and no more
 *     than 2 minutes after it.
 *  4. `"sha256:" + sha256Hex(proof.binding) == signed.payload_hash`. Parse `proof.binding`: `kind == "dialog"`,
 *     `id == signed.card_id`, `thread_id` is THIS worker's thread, `payload.thread` is this thread, `payload.dialog_id` is the id
 *     of the dialog on the pane now, and `payload.dialog_kind`, `payload.subject` and `payload.options` are EXACTLY equal (same
 *     strings, same order, same count; `subject` null equals null) to the Mac's own in-memory record of that sighting, the one
 *     it wrote to workers.json. A login dialog has no options and no `choice`.
 *  5. `payload.options[signed.choice]` equals, character for character, the label the screen shows now at that place, and the
 *     Mac has not pressed anything for this `dialog_id` before (a press by a popup click, or by an earlier answer, counts).
 *     Then it presses at most once per `dialog_id`. For login nothing is typed: the Mac brings Terminals forward.
 *
 * The Mac may check cheaper things first (the file is regular, small, `dialog_id` is on the pane) but never skips one.
 */
export const DialogAnswer = z
  .strictObject({
    v: z.literal(2),
    dialog_id: DialogId,
    choice: z
      .number()
      .int()
      .min(0)
      .max(DIALOG_MAX_OPTIONS - 1)
      .optional(),
    action: z.literal('open').optional(),
    /** The label the owner saw on the button. Display only. */
    label: Label,
    by: z.string().min(1).max(60),
    at: IsoTs,
    control_id: DialogControlId,
    proof: DialogProof,
  })
  .refine(choiceOrOpen, { message: 'exactly one of choice and action' })
export type DialogAnswerT = z.infer<typeof DialogAnswer>

export const DIALOG_OUTCOMES = ['pressed', 'nothing_pressed', 'opened'] as const
export const DIALOG_NOTHING_REASONS = ['screen_changed', 'already_answered', 'unverified'] as const
export const DIALOG_RESULT_SOURCES = ['card', 'mac'] as const
/**
 * `workers/<thread>/dialog-result.json` (the Mac writes, the bridge reads and deletes): what happened. Strict.
 *  - `source: 'card'`: the report on a bridge answer. `control_id` is that answer's and is required. `pressed` carries the
 *    `choice` and the `label` the screen showed (both required); `opened` is the login card's one button; `nothing_pressed`
 *    says why in `reason`: `screen_changed` (the screen did not match, the default), `already_answered` (a popup click or an
 *    earlier answer got there first) or `unverified` (a proof check failed, or that device is not paired and not revoked in devices.json).
 *  - `source: 'mac'`: the owner pressed a button on the Mac popup. No `control_id`. `pressed` (with `choice` and `label`) or
 *    `opened`. The bridge only changes what the card SAYS ("Answered on this Mac") and only once a fresh workers.json shows the
 *    dialog gone, so the Mac writes this file BEFORE it drops the dialog from workers.json.
 * `at` is the Mac's clock when it wrote the file.
 */
export const DialogResult = z
  .strictObject({
    v: z.literal(1),
    dialog_id: DialogId,
    control_id: DialogControlId.optional(),
    source: z.enum(DIALOG_RESULT_SOURCES),
    outcome: z.enum(DIALOG_OUTCOMES),
    choice: z
      .number()
      .int()
      .min(0)
      .max(DIALOG_MAX_OPTIONS - 1)
      .optional(),
    label: Label.optional(),
    reason: z.enum(DIALOG_NOTHING_REASONS).optional(),
    at: IsoTs,
  })
  .refine((r) => r.source === 'mac' || r.control_id !== undefined, {
    path: ['control_id'],
    message: 'a card result names its answer',
  })
  .refine((r) => r.source === 'card' || r.outcome !== 'nothing_pressed', {
    path: ['outcome'],
    message: 'a popup press is a press',
  })
  .refine((r) => r.outcome !== 'pressed' || (r.choice !== undefined && r.label !== undefined), {
    path: ['label'],
    message: 'a press says which option',
  })
  .refine((r) => r.outcome === 'nothing_pressed' || r.reason === undefined, {
    path: ['reason'],
    message: 'only nothing_pressed has a reason',
  })
export type DialogResultT = z.infer<typeof DialogResult>

export const DIALOG_CARD_STATUSES = ['waiting', 'answered', 'closed', 'expired'] as const
/**
 * `workers/<thread>/dialog-card.json` (the bridge writes, the Mac reads): the card for a dialog exists. Written when the card
 * is made and rewritten when it changes. While a file naming a dialog is there, the Mac does not post its thread line for it.
 * `status`: waiting (nobody answered yet), answered (`by` and `label` say who and what), closed (the dialog went away
 * while waiting), expired (nobody answered in time; the bridge posts the one thread line). The Mac popup shows "Answered on
 * <by>" from it.
 */
export const DialogCardFile = z.object({
  v: z.literal(1),
  dialog_id: DialogId,
  card_id: CardId,
  thread_id: ThreadId.optional(),
  status: z.enum(DIALOG_CARD_STATUSES).default('waiting'),
  by: z.string().max(60).optional(),
  label: Label.optional(),
  at: IsoTs,
})
export type DialogCardFileT = z.infer<typeof DialogCardFile>

/** Parses a dialog file's text with one of the schemas above. Anything that does not fit is null; never throws. */
export function parseDialogFile<S extends z.ZodType>(schema: S, text: string): z.infer<S> | null {
  try {
    const r = schema.safeParse(JSON.parse(text))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** Is an answer fresh by its own `at`, on the reader's clock? */
export function dialogFileFresh(at: string, nowMs: number): boolean {
  const t = Date.parse(at)
  return Number.isFinite(t) && nowMs - t <= DIALOG_ANSWER_MAX_AGE_MS && t - nowMs <= DIALOG_ANSWER_MAX_FUTURE_MS
}
