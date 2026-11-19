// Linked agents (P1): the shapes two Talos installs of the same owner share. The relay takes a `peer` connection on its signed
// webhook inbox (/hook/peer/:connId, Standard Webhooks); the Mac's bridge POSTs a PeerMessage to the other relay. This file
// is types and constants only; nothing sends or receives yet.
import { z } from 'zod'
import { wellFormed } from './fts-query.ts'
import { ConnId, HttpsUrl, IsoTs, newUlid, PeerMessageId } from './ids.ts'

/** The hello feature of a Mac that takes `peer.message`: the relay holds linked-agent frames for one that does not list it. */
export const PEER_FEATURE = 'peer/1'

export const PEER_LABELS = ['TASK', 'RESULT', 'BLOCK'] as const
export const PeerLabel = z.enum(PEER_LABELS)
export type PeerLabelT = z.infer<typeof PeerLabel>

/** UTF-8 bytes, not characters. */
export const PEER_TEXT_MAX_BYTES = 8192
/** A reply carries the incoming chain + 1; a message with chain above this is refused. */
export const PEER_CHAIN_MAX = 6
export const PEER_DAILY_CAP_DEFAULT = 50
export const PEER_DAILY_CAP_MAX = 500
/** Peers per install. */
export const PEER_MAX = 8
/** How long a sender keeps retrying one message. */
export const PEER_RETRY_HOURS = 24

/**
 * Names that read as a trust level, an author or an agent role (models.ts `author`, ChannelTrust, handoff_from, and the roles the
 * agent's own words use). A peer called `owner` would make "owner: <text>" look like the owner's word in a notice or a card.
 */
export const PEER_RESERVED_NAMES: readonly string[] = [
  'owner',
  'owner-voice',
  'system',
  'main',
  'agent',
  'talos',
  'lead',
  'worker',
  'admin',
  'root',
  'hook',
  'app',
  'me',
  'you',
  'user',
  'assistant',
  'external',
  'handoff',
  'wake',
  'share',
  'peer',
  'relay',
  'bridge',
]

/** A configured name for a peer (`work`), never a person or a company in code, and never a reserved word. */
export const PeerName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine((n) => !PEER_RESERVED_NAMES.some((w) => n === w || n.startsWith(`${w}-`) || n.endsWith(`-${w}`)), {
    message: 'reserved name', // the word itself, or it plus a hyphen at the start (owner-2) or end (the-owner)
  })
export const newPeerMessageId = (): string => `msg_${newUlid()}`

// Refused in text: C0 controls except \n \r \t, DEL, C1, and the bidi embeddings/overrides/isolates (U+202A-202E, U+2066-2069), which
// can make text read differently from what it is; the Unicode tag characters (U+E0000-E007F: invisible, yet a model reads them as ASCII,
// "ASCII smuggling") and the interlinear annotation marks (U+FFF9-FFFB). The direction MARKS U+200E, U+200F and U+061C are ALLOWED: right-to-left text
// legitimately carries them, and a mark alone cannot reorder anything. A lone surrogate is refused separately.
const BAD_TEXT_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}\ufff9-\ufffb]/u
// Text that shows nothing: whitespace plus zero-width and format characters.
// Also invisible fill: direction marks alone, Hangul/Mongolian fillers, combining grapheme joiner, soft hyphen, invisible operators, VS16.
const BLANK_TEXT = /^(?:[\s\u200b-\u200f\u061c\u2060-\u2064\ufeff\u3164\u180e\u00ad]|\u034f|\ufe0f)*$/

export const peerTextBytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * The webhook BODY. Unknown keys are refused. `chain` and `from_peer_task` are the SENDER's claims and nothing more: the receiver
 * computes its own. Its chain is at least the stored chain of the message `in_reply_to` names, plus 1, and "this came from a peer"
 * is set on receipt, never read from the flag. P2 (relay) and P3 (bridge) enforce that. Any later normalisation of `text` (NFC, NFKC)
 * must re-run the character and byte checks AFTER normalising: NFKC can turn an allowed character into a refused one and grow the byte count. `id` equals the webhook-id header (the relay checks they match).
 * `in_reply_to` equal to `id` is refused: a message cannot answer itself.
 */
export const PeerMessage = z
  .strictObject({
    v: z.literal(1),
    id: PeerMessageId,
    /** The sender's own name for itself. Shown only; the receiver trusts its configured connection name, not this. */
    from: PeerName,
    label: PeerLabel.optional(),
    text: z
      .string()
      .refine((t) => !BLANK_TEXT.test(t), { message: 'text is empty' })
      .refine((t) => !BAD_TEXT_CHARS.test(t), { message: 'text has a control or bidi character' })
      .refine((t) => wellFormed(t) === t, { message: 'text has a lone surrogate' })
      .refine((t) => peerTextBytes(t) <= PEER_TEXT_MAX_BYTES, { message: `text is over ${PEER_TEXT_MAX_BYTES} bytes` }),
    in_reply_to: PeerMessageId.optional(),
    chain: z.number().int().min(0).max(PEER_CHAIN_MAX),
    /** True when the send happened while working on something a peer asked for (the no-chaining rule). */
    from_peer_task: z.boolean(),
    sent_at: IsoTs,
  })
  .refine((m) => m.in_reply_to !== m.id, { path: ['in_reply_to'], message: 'a message cannot reply to itself' })
export type PeerMessageT = z.infer<typeof PeerMessage>

export const parsePeerMessage = (raw: unknown) => PeerMessage.safeParse(raw)

/**
 * One configured peer (AgentConfig.peers). The signing SECRET is never here: the bridge keeps it in its SecretStore. The URL may
 * carry a path token, so `peers` is device-hidden (stripDeviceHidden): phones and the web app never see it.
 */
export const PeerConfig = z.object({
  name: PeerName,
  url: HttpsUrl.refine((u) => u.startsWith('https:'), { message: 'a peer URL must be https' }),
  daily_cap: z.number().int().min(1).max(PEER_DAILY_CAP_MAX).default(PEER_DAILY_CAP_DEFAULT),
})
export type PeerConfigT = z.infer<typeof PeerConfig>

// ---- the Mac's setup of a peer inbox on its own relay (relay routes POST/GET /bridge/peers, DELETE /bridge/peers/:name,
// POST /bridge/peers/:name/rotate; bridge-signed only, the app API refuses `peer`) -------------------------------------

/** `daily_cap`: how many messages this peer may land per UTC day (default PEER_DAILY_CAP_DEFAULT). */
export const PeerCreate = z.strictObject({
  name: PeerName,
  daily_cap: z.number().int().min(1).max(PEER_DAILY_CAP_MAX).optional(),
})
export type PeerCreateT = z.infer<typeof PeerCreate>

/** The only time the secret is shown: the owner hands `inbox_url` and `secret` to the other install. The relay keeps an encrypted copy. */
export const PeerCreated = z.strictObject({ conn_id: ConnId, inbox_url: HttpsUrl, secret: z.string().min(1).max(200) })
export type PeerCreatedT = z.infer<typeof PeerCreated>

/** A peer inbox as listed. There is no secret field. `received_today` counts the UTC day. */
export const PeerRow = z.strictObject({
  conn_id: ConnId,
  name: PeerName,
  daily_cap: z.number().int().min(1).max(PEER_DAILY_CAP_MAX),
  created_at: IsoTs,
  received_today: z.number().int().min(0),
})
export const PeerList = z.array(PeerRow).max(PEER_MAX)

/** The new secret, shown once. The old one keeps working for 24 hours. */
export const PeerRotated = z.strictObject({ secret: z.string().min(1).max(200) })
export const PeerDeleted = z.strictObject({ ok: z.literal(true) })
