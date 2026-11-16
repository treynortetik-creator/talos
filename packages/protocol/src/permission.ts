// Permission prompts on the phone (docs/CLAUDE-CODE.md C3). Claude Code relays a tool approval prompt to every channel
// that declares `claude/channel/permission`; the bridge turns it into a `kind:'permission'` card and answers with a
// verdict only after a signed PRIMARY/KILL passes the ledger checks.
//
// Binding: the four request fields, verbatim, are the card's payload, so payload_hash covers all of them. The card shows
// input_preview first, as plain text, never cut; "Claude's summary" (the model's own words) comes after it. A tap approves
// (the owner's rule, 2026-11-13): no step-up, whatever the tool. If part of the call is hidden (elided middle,
// unserializable value, a cut, masked values, too long to show whole) or Claude Code is older than the floor, the card keeps
// Allow and says what is not shown. The one card with no Allow is a repeated request id: an answer could reach the wrong
// prompt. permissionCardAllowsPrimary() re-derives all of that from the card itself, so the app and the bridge reach the
// same answer and a card changed on the way never shows Allow for something it does not show.
import { z } from 'zod'
import { jcs, payloadHash } from './canonical.ts'
import { MAX_CARD_PAYLOAD_BYTES } from './card-edits.ts'
import type { ErrorCodeT } from './errors.ts'
import { bindingFrom, type CardT } from './models.ts'

export const PERMISSION_REQUEST_METHOD = 'notifications/claude/channel/permission_request' as const
export const PERMISSION_VERDICT_METHOD = 'notifications/claude/channel/permission' as const
export const PERMISSION_CAPABILITY = 'claude/channel/permission' as const

/** Five lowercase letters a-z without `l` (channels reference). */
export const PermissionRequestId = z.string().regex(/^[a-km-z]{5}$/)

/** Inbound from Claude Code. Unknown params are dropped; only these four are ever bound or shown. */
export const PermissionRequestParams = z.object({
  request_id: PermissionRequestId,
  tool_name: z.string().min(1).max(4096),
  description: z.string().max(262_144),
  input_preview: z.string().max(262_144),
})
export type PermissionRequestT = z.infer<typeof PermissionRequestParams>

export const PermissionVerdictParams = z.strictObject({
  request_id: PermissionRequestId,
  behavior: z.enum(['allow', 'deny']),
})
export type PermissionVerdictT = z.infer<typeof PermissionVerdictParams>

/** A permission card lives as long as its request; Claude Code ignores a verdict for a closed id (C3.2). */
export const PERMISSION_CARD_TTL_S = 604_800
/** Without the mod, a card this old adds "May already be answered at the Mac" (C3.4). */
export const PERMISSION_MAYBE_ANSWERED_MS = 60_000

/** The start of the note on a card that does not show all of its call (the parts that are not shown follow). */
export const PERMISSION_HIDDEN_PREFIX = 'Not all of this call is shown: '
/** Kept for older imports: the prefix is the start of every hidden note (permissionHiddenWarning). */
export const PERMISSION_HIDDEN_WARNING = PERMISSION_HIDDEN_PREFIX
/**
 * The one refusal left on a permission card (the owner's rule, 2026-11-13: a tap approves, from anywhere): Claude Code sent
 * an id it had used before, so a verdict from here could answer the wrong prompt.
 */
export const PERMISSION_REPEAT_WARNING =
  "Claude Code used this prompt's id before, so an answer from here could reach the wrong prompt. The prompt is still open at the Mac."
/** The pinned "ends with:" line under every permission card's call. */
export const PERMISSION_TAIL_CHARS = 120
/**
 * A notification can offer Approve only for a call it can show whole: one short visible line. Anything longer (or with a visible
 * line-break glyph) shows Open, which goes to the full-screen approval sheet where the owner scrolls through all of it.
 */
export const PERMISSION_NOTICE_MAX_CHARS = 150
/** Kept for older imports; a too-long card now shows the start of its call, with the hidden note saying so. */
export const PERMISSION_TOO_LONG_BODY = 'This call is too long to show here whole; the start is shown.'
export const PERMISSION_MAYBE_ANSWERED = 'May already be answered at the Mac'

/** Longest input_preview / description a card shows whole (Card.body and CardField.value caps). */
const MAX_SHOWN = 20_000
const TITLE_MAX = 120

export type PermissionHiddenReason = 'elided' | 'unserializable' | 'truncated' | 'too_long' | 'redacted'

/**
 * The oldest Claude Code whose permission relay is safe to approve from (CC-C1-REVIEW F1, channels reference fetched
 * 2026-10-29). Three facts start at 2.1.234: (a) `(value unserializable)` is relayed, and before it no marker is documented,
 * so a hidden value can arrive unflagged; (b) prompts go only to servers registered as channels, while earlier any MCP server
 * that declared the capability received them and could answer; (c) `false` stops counting as a declared capability. Direction
 * overrides and invisible characters are neutralized from 2.1.211, which this floor includes. Below it, or when the bridge
 * can't read the client version, a card never shows Allow.
 */
export const PERMISSION_MIN_CLIENT_VERSION = '2.1.234'
/**
 * One line on the card when another channel loaded in the same session (another channel plugin, say) can also answer the
 * prompt. A note, not a refusal: Allow stays (the owner chose this setup). Only this exact shape is accepted beside Allow.
 */
export const PERMISSION_OTHER_CHANNEL_NOTE = /^[A-Za-z0-9][A-Za-z0-9 ,/_-]{0,78} can also approve this\.$/
export const permissionOtherChannelNote = (names: readonly string[]): string =>
  `${
    names
      .map((n) => n.replace(/[^A-Za-z0-9 _/-]/g, ''))
      .filter(Boolean)
      .join(', ') || 'Another channel'
  } can also approve this.`
export const PERMISSION_OLD_CLIENT_WARNING =
  'This Claude Code is older than 2.1.234, so a hidden part of the call may not be marked. Check it before you allow.'

const HIDDEN_WORDS: Record<PermissionHiddenReason, string> = {
  elided: 'Claude Code shortened part of it (⋯)',
  unserializable: "a value Claude Code couldn't turn into text",
  truncated: 'its end is cut off (…)',
  redacted: 'values Claude Code masked ([REDACTED])',
  too_long: 'it is too long to show whole, so the start is shown',
}
/** The note on a card whose call is not shown whole: what is missing, and that Allow still approves the call itself. */
export const permissionHiddenWarning = (reasons: readonly PermissionHiddenReason[]): string =>
  `${PERMISSION_HIDDEN_PREFIX}${reasons.map((r) => HIDDEN_WORDS[r]).join('; ')}. Allow approves the call as Claude Code holds it.`

/**
 * Characters that make text render differently from its bytes: C0/C1 controls (the relay folds whitespace, so even a
 * newline means unsanitized text), bidi embeddings, overrides and isolates, zero-width and other invisible format
 * characters, variation selectors, and Unicode tag characters. `tool_name` is not sanitized by Claude Code at all.
 * Beyond the listed ones it takes every Default_Ignorable_Code_Point, every format (Cf), unassigned (Cn), private-use (Co) and
 * surrogate (Cs) code point, the object replacement character, and any run of more than three combining marks: an unlisted
 * invisible code point is exactly what a padded command hides behind. The app's `revealHidden` is built from this source.
 */
export const INVISIBLE_OR_BIDI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: single code points on purpose, combining marks included
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0334-\u0338\u0600-\u0604\u061c\u070f\u0890\u0891\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]|[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cn}\p{Co}\p{Cs}\uFFFC]|\p{M}{4,}/u
const INVISIBLE_OR_BIDI_ALL = new RegExp(INVISIBLE_OR_BIDI.source, 'gu')

/**
 * Blanks that draw as a gap and so can pad a command: no-break space, U+1680, U+2000 to U+200A, U+202F, U+205F, U+3000. They are
 * marked as `[U+XXXX]` on a PERMISSION card only (`permissionVisibleText`); every other card, and every card push, keeps the
 * shared class above, so an email draft with a no-break space reads as it always did.
 */
export const PERMISSION_EXTRA_MARKED = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u
const PERMISSION_MARKED_ALL = new RegExp(`${INVISIBLE_OR_BIDI.source}|${PERMISSION_EXTRA_MARKED.source}`, 'gu')

/**
 * Control characters that would otherwise fold into a plain space or vanish, shown as a visible glyph so a multi-line
 * command cannot hide its dangerous part (CC-C1-REVIEW F9).
 */
const CONTROL_GLYPHS: Record<string, string> = { '\n': '⏎', '\r': '␍', '\t': '⇥', '\u2028': '⏎', '\u2029': '⏎' }

/**
 * Shows each such character as a visible glyph (newline `⏎`, return `␍`, tab `⇥`) or `[U+XXXX]` so the owner sees it is
 * there. Identity on clean text.
 */
function markHidden(text: string, re: RegExp): string {
  return text.replace(re, (run) =>
    [...run]
      .map((ch) => {
        const glyph = CONTROL_GLYPHS[ch]
        if (glyph) return glyph
        const cp = ch.codePointAt(0) ?? 0
        return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`
      })
      .join(''),
  )
}

export function visibleText(text: string): string {
  return markHidden(text, INVISIBLE_OR_BIDI_ALL)
}

/** `visibleText` plus the exotic spaces: what a permission card shows (the hook render leaves them to this). */
export function permissionVisibleText(text: string): string {
  return markHidden(text, PERMISSION_MARKED_ALL)
}

/**
 * The last PERMISSION_TAIL_CHARS visible characters of a call, behind an ellipsis when cut, for the line pinned under the call
 * box: even a long call cannot hide its end. `visibleText` makes any hidden character show as [U+XXXX].
 */
export function permissionCallTail(body: string): string {
  const chars = [...permissionVisibleText(body)]
  return chars.length <= PERMISSION_TAIL_CHARS
    ? chars.join('')
    : `\u2026${chars.slice(-PERMISSION_TAIL_CHARS).join('')}`
}

function versionAtLeast(v: string | undefined, floor: string): boolean {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:$|[-+ ])/.exec(v.trim()) : null
  const f = /^(\d+)\.(\d+)\.(\d+)$/.exec(floor)
  if (!m || !f) return false
  for (let i = 1; i <= 3; i++) {
    const a = Number(m[i])
    const b = Number(f[i])
    if (a !== b) return a > b
  }
  return true
}
/** True only for a readable Claude Code version at or above PERMISSION_MIN_CLIENT_VERSION. */
export function permissionClientVerified(clientVersion: string | undefined): boolean {
  return versionAtLeast(clientVersion, PERMISSION_MIN_CLIENT_VERSION)
}

/**
 * Why part of the call is not on the card. Fails closed: any `⋯` counts as an elision marker and any trailing `…` on
 * input_preview as the pre-2.1.211 200-unit cut, even if the command really contains one.
 */
export function permissionHiddenReasons(r: PermissionRequestT): PermissionHiddenReason[] {
  const out: PermissionHiddenReason[] = []
  const both = `${r.description}\n${r.input_preview}`
  if (both.includes('⋯')) out.push('elided')
  if (both.includes('(value unserializable)')) out.push('unserializable')
  if (/…\s*$/.test(r.input_preview)) out.push('truncated')
  // The mask also hits key names, so a displayed key may not be the real one (channels reference): a hidden part.
  if (r.description.includes('[REDACTED]') || r.input_preview.includes('[REDACTED]')) out.push('redacted')
  if (
    permissionVisibleText(r.input_preview).length > MAX_SHOWN ||
    permissionVisibleText(r.description).length > MAX_SHOWN ||
    permissionTitle(permissionVisibleText(r.tool_name)).length > TITLE_MAX ||
    new TextEncoder().encode(jcs(bindFields(r))).length > MAX_CARD_PAYLOAD_BYTES
  )
    out.push('too_long')
  return out
}

/**
 * Always `low`, whatever the tool (the owner's rule, 2026-11-13): a tap approves a permission prompt, in the app and from the
 * notification, with no passkey or Face ID. `high` is what asks for a step-up everywhere (relay, app, notification), so a
 * permission card never carries it. Cards that send as him, spend or delete keep their own risk; this is tool permission only.
 */
export function permissionRisk(_toolName: string): 'low' | 'high' {
  return 'low'
}

export function permissionTitle(toolName: string): string {
  return `Allow ${toolName}?`
}

function bindFields(r: PermissionRequestT): PermissionRequestT {
  return {
    request_id: r.request_id,
    tool_name: r.tool_name,
    description: r.description,
    input_preview: r.input_preview,
  }
}

export type ComposePermissionCardInput = {
  request: PermissionRequestT
  card_id: string
  thread_id: string
  now: number
  /** The bridge already saw this request id in this session (Claude Code drops channel verdicts for it). */
  repeated?: boolean
  /**
   * Claude Code's version from the MCP handshake (`initialize` clientInfo.version). Missing, unreadable or below
   * PERMISSION_MIN_CLIENT_VERSION: the card keeps Allow with a note (PERMISSION_OLD_CLIENT_WARNING).
   */
  client_version?: string
  /** Names of other loaded channels that can also answer a permission prompt; adds a one-line note, keeps Allow. */
  other_channels?: readonly string[]
  /** An explainer is on: the card starts with `explain: pending` and the explanation follows as a card.update. */
  explain?: boolean
}

/** The title the composer writes for a tool name (hidden characters shown as markers; a very long name gets a fixed title). */
function shownTitle(toolName: string): string {
  const t = permissionTitle(permissionVisibleText(toolName))
  return t.length <= TITLE_MAX ? t : 'Allow a tool call?'
}

/** Builds the pending card. Pure: the caller writes it to the ledger before sending `card.create`. */
export function composePermissionCard(input: ComposePermissionCardInput): CardT {
  const r = PermissionRequestParams.parse(input.request)
  const hidden = permissionHiddenReasons(r)
  const tooLong = hidden.includes('too_long')
  const card: CardT = {
    id: input.card_id,
    thread_id: input.thread_id,
    kind: 'permission',
    title: shownTitle(r.tool_name),
    destination: [],
    // Invisible and bidi characters are shown as [U+XXXX] and the card stays Allow-able: the owner sees every character.
    // Too long to show whole: the start of it, with the hidden note saying so.
    // (cut by code point: a cut inside a surrogate pair would leave a lone surrogate, which the canonical JSON refuses)
    body: tooLong
      ? [...permissionVisibleText(r.input_preview)].slice(0, MAX_SHOWN).join('')
      : permissionVisibleText(r.input_preview),
    body_format: 'plain',
    fields: tooLong
      ? []
      : [
          {
            key: 'summary',
            label: "Claude's summary",
            value: permissionVisibleText(r.description),
            editable: false,
            multiline: true,
          },
        ],
    attachments: [],
    primary_label: 'Allow',
    kill_label: 'Deny',
    allow_edit: false,
    allow_revise: false,
    risk: permissionRisk(r.tool_name),
    origin: 'background',
    // Too long to bind whole: the payload carries the id; the bridge keeps its own copy of the call and answers that one.
    payload: tooLong ? { request_id: r.request_id, oversize: true } : bindFields(r),
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: new Date(input.now).toISOString(),
    expires_at: new Date(input.now + PERMISSION_CARD_TTL_S * 1000).toISOString(),
  }
  // Beside the card, outside the binding: bindingFrom() does not pick it, so the hash below is the same with or without it.
  if (input.explain) card.explain = { status: 'pending' }
  // the one refusal first; then what is not shown, or an older Claude Code: notes, Allow stays
  if (input.repeated) card.warning = PERMISSION_REPEAT_WARNING
  else if (hidden.length > 0) card.warning = permissionHiddenWarning(hidden)
  else if (!permissionClientVerified(input.client_version)) card.warning = PERMISSION_OLD_CLIENT_WARNING
  else if (input.other_channels && input.other_channels.length > 0)
    card.warning = permissionOtherChannelNote(input.other_channels)
  card.payload_hash = payloadHash(bindingFrom(card))
  return card
}

const BOUND_KEYS = ['description', 'input_preview', 'request_id', 'tool_name']

/** The bound request, if the payload is exactly the four fields in the documented format. */
export function permissionRequestOf(card: Pick<CardT, 'kind' | 'payload'>): PermissionRequestT | null {
  if (card.kind !== 'permission') return null
  const p = card.payload
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null
  if (Object.keys(p).sort().join(',') !== BOUND_KEYS.join(',')) return null
  const r = PermissionRequestParams.safeParse(p)
  return r.success ? r.data : null
}

/**
 * True when the card is exactly what composePermissionCard() renders for its bound call (or, too long to bind, its id with
 * the too-long note), with only a note that keeps Allow: another channel, an older Claude Code, or what part is not shown.
 * False for a repeated id. The app shows Allow iff this is true; the bridge sends `allow` iff this is true for its ledger copy.
 */
export type PermissionAllowView = Pick<
  CardT,
  | 'kind'
  | 'payload'
  | 'state'
  | 'title'
  | 'summary'
  | 'risk'
  | 'body'
  | 'body_format'
  | 'fields'
  | 'allow_edit'
  | 'allow_revise'
  | 'warning'
  | 'destination'
  | 'primary_label'
> & {
  /** Only the count matters here, so a ledger binding (which keeps fewer attachment keys) fits. */
  attachments: readonly unknown[]
}

/** A note that keeps Allow: another channel, an older Claude Code, or what part of the call is not shown. */
const noteKeepsAllow = (w: string | undefined, hidden: readonly PermissionHiddenReason[]): boolean =>
  w === undefined
    ? hidden.length === 0
    : hidden.length > 0
      ? w === permissionHiddenWarning(hidden)
      : PERMISSION_OTHER_CHANNEL_NOTE.test(w) || w === PERMISSION_OLD_CLIENT_WARNING

export function permissionCardAllowsPrimary(card: PermissionAllowView): boolean {
  try {
    if (card.state !== 'pending') return false
    if (card.warning === PERMISSION_REPEAT_WARNING) return false
    // too long to bind whole: the payload is the id; the note must say what is not shown, and nothing else may be on it
    const p = card.payload as Record<string, unknown> | null
    if (card.kind === 'permission' && p && typeof p === 'object' && p.oversize === true) {
      return (
        Object.keys(p).sort().join(',') === 'oversize,request_id' &&
        PermissionRequestId.safeParse(p.request_id).success &&
        typeof card.warning === 'string' &&
        card.warning.startsWith(PERMISSION_HIDDEN_PREFIX) &&
        card.warning.includes(HIDDEN_WORDS.too_long) &&
        (card.risk === 'low' || card.risk === 'high') &&
        card.summary === undefined &&
        card.body_format === 'plain' &&
        card.fields.length === 0 &&
        card.allow_edit === false &&
        card.allow_revise === false &&
        card.attachments.length === 0 &&
        card.destination.length === 0 &&
        card.primary_label === 'Allow'
      )
    }
    const r = permissionRequestOf(card)
    if (!r) return false
    const hidden = permissionHiddenReasons(r)
    const f = card.fields
    return (
      card.title === shownTitle(r.tool_name) &&
      card.summary === undefined &&
      // either risk: it never changes what the card shows, and an older bridge's cards still say `high` (they then ask for a step-up)
      (card.risk === 'low' || card.risk === 'high') &&
      card.body === permissionVisibleText(r.input_preview) &&
      card.body_format === 'plain' &&
      f.length === 1 &&
      f[0]?.key === 'summary' &&
      f[0]?.label === "Claude's summary" &&
      f[0]?.value === permissionVisibleText(r.description) &&
      f[0]?.editable === false &&
      card.allow_edit === false &&
      card.allow_revise === false &&
      noteKeepsAllow(card.warning, hidden) &&
      card.attachments.length === 0 &&
      card.destination.length === 0 &&
      card.primary_label === 'Allow'
    )
  } catch {
    return false
  }
}

export type PermissionVerdictResult = { ok: true; verdict: PermissionVerdictT } | { ok: false; code: ErrorCodeT }

/**
 * The verdict for a resolved permission card, after the SPEC 4.5 ledger checks passed. Pass the card as it was
 * composed (state `pending`, the full CardT kept beside the ledger binding), not the row after resolve marked it
 * `resolved`: permissionCardAllowsPrimary() only accepts a pending card. `isOpen` is the bridge's set of
 * open request ids (OpenPermissionIds); the caller closes the id after sending. KILL is always a deny; PRIMARY is an
 * allow only on a card that permissionCardAllowsPrimary() accepts.
 */
export function permissionVerdictFor(
  card: CardT,
  action: 'primary' | 'kill' | 'revise',
  isOpen: (requestId: string) => boolean,
): PermissionVerdictResult {
  if (card.kind !== 'permission') return { ok: false, code: 'bad_frame' }
  const p = card.payload as { request_id?: unknown } | undefined
  const id = PermissionRequestId.safeParse(p?.request_id)
  if (!id.success) return { ok: false, code: 'bad_frame' }
  if (action === 'revise') return { ok: false, code: 'card_edit_forbidden' }
  if (!isOpen(id.data)) return { ok: false, code: 'permission_closed' }
  if (action === 'kill') return { ok: true, verdict: { request_id: id.data, behavior: 'deny' } }
  if (!permissionCardAllowsPrimary(card)) return { ok: false, code: 'permission_hidden' }
  return { ok: true, verdict: { request_id: id.data, behavior: 'allow' } }
}

/**
 * The bridge's set of open request ids (C3.3). An id opens once; a repeat poisons it for the rest of the session
 * (Claude Code drops every channel verdict for a repeated id). One verdict closes it.
 */
export class OpenPermissionIds {
  private open = new Set<string>()
  private seen = new Set<string>()
  /** Returns whether the id was already seen in this session (the card then gets no Allow). */
  add(requestId: string): { repeated: boolean } {
    if (this.seen.has(requestId)) {
      this.open.delete(requestId)
      return { repeated: true }
    }
    this.seen.add(requestId)
    this.open.add(requestId)
    return { repeated: false }
  }
  isOpen = (requestId: string): boolean => this.open.has(requestId)
  /** True once the id was opened in this session, open or not (a minted id must never reuse one Claude Code could send). */
  hasSeen(requestId: string): boolean {
    return this.seen.has(requestId)
  }
  close(requestId: string): void {
    this.open.delete(requestId)
  }
  get size(): number {
    return this.open.size
  }
}
