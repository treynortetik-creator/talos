// Permission prompts on the phone (docs/CLAUDE-CODE.md C3). Claude Code relays a tool approval prompt to every channel
// that declares `claude/channel/permission`; the bridge turns it into a `kind:'permission'` card and answers with a
// verdict only after a signed PRIMARY/KILL passes the ledger checks.
//
// Binding: the four request fields, verbatim, are the card's payload, so payload_hash covers all of them. The card shows
// input_preview first, as plain text, never cut; "Claude's summary" (the model's own words) comes after it. If any part
// of the call is hidden (elided middle, unserializable value, legacy cut, too long to show whole) or the id repeated,
// the card has no Allow: only Deny, and "Approve at the Mac". permissionCardAllowsPrimary() re-derives that from the
// card itself, so the app and the bridge reach the same answer and a tampered card never shows Allow.
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

export const PERMISSION_HIDDEN_WARNING = 'Part of this call is hidden. Approve at the Mac.'
export const PERMISSION_REPEAT_WARNING = 'This prompt can only be answered at the Mac.'
export const PERMISSION_TOO_LONG_BODY = 'This call is too long to show here whole. Approve or deny it at the Mac.'
export const PERMISSION_MAYBE_ANSWERED = 'May already be answered at the Mac'

/** Longest input_preview / description a card shows whole (Card.body and CardField.value caps). */
const MAX_SHOWN = 20_000
const TITLE_MAX = 120

export type PermissionHiddenReason =
  | 'elided'
  | 'unserializable'
  | 'truncated'
  | 'too_long'
  | 'bidi_or_invisible'
  | 'redacted'

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
const OTHER_CHANNEL_NOTE = /^[A-Za-z0-9][A-Za-z0-9 ,/_-]{0,78} can also approve this\.$/
export const permissionOtherChannelNote = (names: readonly string[]): string =>
  `${
    names
      .map((n) => n.replace(/[^A-Za-z0-9 _/-]/g, ''))
      .filter(Boolean)
      .join(', ') || 'Another channel'
  } can also approve this.`
export const PERMISSION_OLD_CLIENT_WARNING = "This Claude Code can't show the call safely. Approve at the Mac."

/**
 * Characters that make text render differently from its bytes: C0/C1 controls (the relay folds whitespace, so even a
 * newline means unsanitized text), bidi embeddings, overrides and isolates, zero-width and other invisible format
 * characters, variation selectors, and Unicode tag characters. `tool_name` is not sanitized by Claude Code at all.
 */
export const INVISIBLE_OR_BIDI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: single code points on purpose, combining marks included
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0334-\u0338\u0600-\u0604\u061c\u070f\u0890\u0891\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]/u
const INVISIBLE_OR_BIDI_ALL = new RegExp(INVISIBLE_OR_BIDI.source, 'gu')

/**
 * Control characters that would otherwise fold into a plain space or vanish, shown as a visible glyph so a multi-line
 * command cannot hide its dangerous part (CC-C1-REVIEW F9).
 */
const CONTROL_GLYPHS: Record<string, string> = { '\n': '⏎', '\r': '␍', '\t': '⇥', '\u2028': '⏎', '\u2029': '⏎' }

/**
 * Shows each such character as a visible glyph (newline `⏎`, return `␍`, tab `⇥`) or `[U+XXXX]` so the owner sees it is
 * there. Identity on clean text.
 */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE_OR_BIDI_ALL, (ch) => {
    const glyph = CONTROL_GLYPHS[ch]
    if (glyph) return glyph
    const cp = ch.codePointAt(0) ?? 0
    return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`
  })
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
  if ([r.tool_name, r.description, r.input_preview].some((t) => INVISIBLE_OR_BIDI.test(t)))
    out.push('bidi_or_invisible')
  if (
    visibleText(r.input_preview).length > MAX_SHOWN ||
    visibleText(r.description).length > MAX_SHOWN ||
    permissionTitle(visibleText(r.tool_name)).length > TITLE_MAX ||
    new TextEncoder().encode(jcs(bindFields(r))).length > MAX_CARD_PAYLOAD_BYTES
  )
    out.push('too_long')
  return out
}

const LOW_RISK_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
/** `low` only for a short read-only list; Bash, Write, Edit, NotebookEdit, MCP tools and anything unknown are `high`. */
export function permissionRisk(toolName: string): 'low' | 'high' {
  return LOW_RISK_TOOLS.has(toolName) ? 'low' : 'high'
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
   * PERMISSION_MIN_CLIENT_VERSION: the card is deny-only.
   */
  client_version?: string
  /** Names of other loaded channels that can also answer a permission prompt; adds a one-line note, keeps Allow. */
  other_channels?: readonly string[]
}

/** Builds the pending card. Pure: the caller writes it to the ledger before sending `card.create`. */
export function composePermissionCard(input: ComposePermissionCardInput): CardT {
  const r = PermissionRequestParams.parse(input.request)
  const hidden = permissionHiddenReasons(r)
  const tooLong = hidden.includes('too_long')
  const title = permissionTitle(visibleText(r.tool_name))
  const card: CardT = {
    id: input.card_id,
    thread_id: input.thread_id,
    kind: 'permission',
    title: title.length <= TITLE_MAX ? title : 'Allow a tool call?',
    destination: [],
    // Invisible and bidi characters are shown as [U+XXXX]; such a card is deny-only anyway (bidi_or_invisible).
    body: tooLong ? PERMISSION_TOO_LONG_BODY : visibleText(r.input_preview),
    body_format: 'plain',
    fields: tooLong
      ? []
      : [
          {
            key: 'summary',
            label: "Claude's summary",
            value: visibleText(r.description),
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
    // Too long to show whole: the payload carries the id only (deny-only), so nothing can bind to a call nobody saw.
    payload: tooLong ? { request_id: r.request_id, oversize: true } : bindFields(r),
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: new Date(input.now).toISOString(),
    expires_at: new Date(input.now + PERMISSION_CARD_TTL_S * 1000).toISOString(),
  }
  if (hidden.length > 0) card.warning = PERMISSION_HIDDEN_WARNING
  else if (!permissionClientVerified(input.client_version)) card.warning = PERMISSION_OLD_CLIENT_WARNING
  else if (input.repeated) card.warning = PERMISSION_REPEAT_WARNING
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
 * True only when the card shows the whole bound call exactly as composePermissionCard() renders it, nothing is hidden
 * and nothing warns. The app shows Allow iff this is true; the bridge sends `allow` iff this is true for its ledger copy.
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

export function permissionCardAllowsPrimary(card: PermissionAllowView): boolean {
  try {
    if (card.state !== 'pending') return false
    const r = permissionRequestOf(card)
    if (!r) return false
    if (permissionHiddenReasons(r).length > 0) return false
    const f = card.fields
    return (
      card.title === permissionTitle(r.tool_name) &&
      card.summary === undefined &&
      card.risk === permissionRisk(r.tool_name) &&
      card.body === r.input_preview &&
      card.body_format === 'plain' &&
      f.length === 1 &&
      f[0]?.key === 'summary' &&
      f[0]?.label === "Claude's summary" &&
      f[0]?.value === r.description &&
      f[0]?.editable === false &&
      card.allow_edit === false &&
      card.allow_revise === false &&
      (card.warning === undefined || OTHER_CHANNEL_NOTE.test(card.warning)) &&
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
  close(requestId: string): void {
    this.open.delete(requestId)
  }
  get size(): number {
    return this.open.size
  }
}
