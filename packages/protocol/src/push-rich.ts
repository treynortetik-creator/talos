// Rich iPhone notifications: message text that reaches the phone but not Apple (the relay builds the seal from the plain text,
// so while text is on the relay can read it),
// and two buttons (Reply, Approve) that the phone can press without opening the app.
//
// STATUS: all three halves are in this tree. The relay and the Mac implement the protocol here; the phone half is the Swift in
// apps/mobile/ios (TalosPushCore RichPush, TalosPushShared NativeKeyStore, TalosPushExtension NotificationService,
// App/Plugins TalosQuickAct) and the grant call in apps/web/src/features/pwa/nativePush.ts. The Swift is checked against bytes
// this side generates (fixtures/push-rich, scripts/gen-push-rich-vectors.ts). What has NOT run is the phone itself: the
// extension, the shared Keychain and the background buttons need a signed TestFlight build (docs/IOS-PUSH.md says what to try).
//
// Three pieces, all inert until a phone has registered a grant:
//
//   1. GRANT   `native.grant`: the device key (the one the Mac pinned at enrollment, non-extractable, in the web view)
//              signs two NEW public keys that live in the shared iOS Keychain: an encryption key (the relay seals text to
//              it; the notification extension and the app on this phone can read that key, nothing else can) and an action key (signs
//              Reply / Approve when the web view is not running). The device key signs only the public halves; no
//              private key ever leaves where it was made. Enrollment is untouched.
//   2. SEAL    `talos.enc` in the APNs body: ECDH P-256 + HKDF-SHA256 + AES-256-GCM, one fresh ephemeral key per push.
//              The alert stays the fixed template (the fallback when the extension cannot open the seal).
//   3. ACT     `native.act`: a Reply or an Approve signed by the action key and carrying the grant. The relay checks it
//              before it queues anything; the Mac checks it again with the pinned device key (the relay is not trusted).
//
// Signing here is over exact strings, never re-serialized JSON, so a phone-side signer has one definition to match
// (RichPushTests signs one in Swift and swift-act.json is verified here by push-rich-vectors.test.ts):
//   act input   = "talos-act/v1\n" + device_id + "\n" + id + "\n" + ts + "\n" + grant.osig + "\n" + body
//   seal AAD    = "talos-push/v1|" + device_id + "|" + kind + "|" + (card_id ?? "") + "|" + push_id
import { z } from 'zod'
import { b64urlDecode, b64urlEncode, utf8 } from './encoding.ts'
import { sha256Hex } from './hash.ts'
import { CardId, DeviceId, IsoTs, Sha256Ref, ThreadId, Ulid } from './ids.ts'
import { CARD_KIND_TABLE, CARD_KINDS, type JwkP256T } from './models.ts'
import { signOwnerFrame, verifyOwnerFrame } from './owner-sig.ts'
import {
  PERMISSION_NOTICE_MAX_CHARS,
  type PermissionAllowView,
  permissionCardAllowsPrimary,
  visibleText,
} from './permission.ts'

const subtle = () => globalThis.crypto.subtle

/** `hello.client.features` entry: this Mac understands `native.act`. A relay refuses a tap for a Mac that lacks it. */
export const NATIVE_ACT_FEATURE = 'native_act/1'

/**
 * The two notification categories only the phone's notification extension can choose, after it has opened the seal: the
 * relay never sends them. They carry the buttons that act without opening the app. The app registers both
 * (TalosPushCore.categories); the extension picks one with RichPush.category.
 */
export const RICH_CATEGORIES = { reply: 'TALOS_REPLY', cardLow: 'TALOS_CARD_LOW' } as const

// ---- limits ----------------------------------------------------------------------------------------------------------

/** Longest a grant may live. A phone that stops renewing goes quiet by itself when this runs out. */
export const GRANT_MAX_LIFETIME_MS = 30 * 86_400_000
/** The page renews the grant on open when less than this is left (nativePush.ts renewNativeGrant). */
export const GRANT_RENEW_BEFORE_MS = 20 * 86_400_000
/** A grant or an action may be this far from the verifier's clock in either direction. */
export const NATIVE_SKEW_MS = 120_000
/** An action the phone signed is good for this long (a retry after a bad signal still works inside it). */
export const ACT_MAX_AGE_MS = 10 * 60_000
/** APNs allows 4096 bytes in all; the sealed text stays well inside it. */
export const SEAL_TEXT_MAX_BYTES = 1500
export const NATIVE_REPLY_MAX_CHARS = 4000

/** An uncompressed P-256 point (0x04 || X || Y), 65 bytes, as 87 base64url characters. */
export const RawP256 = z.string().regex(/^[A-Za-z0-9_-]{87}$/)

export const GRANT_SCOPES = ['reply', 'approve_low'] as const
export type GrantScope = (typeof GRANT_SCOPES)[number]

// ---- 1. grant --------------------------------------------------------------------------------------------------------

/**
 * Signed by the device key, exactly like an owner frame (`signOwnerFrame`). `scopes` is read tolerantly: a scope this
 * build does not know is ignored, it does not void the grant.
 */
export const NativeGrant = z.strictObject({
  v: z.literal(1),
  type: z.literal('native.grant'),
  device_id: DeviceId,
  enc_pub: RawP256,
  act_pub: RawP256,
  scopes: z.array(z.string().max(32)).max(8),
  ts: IsoTs,
  exp: IsoTs,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  osig: z.string().length(86),
})
export type NativeGrantT = z.infer<typeof NativeGrant>

/** Takes the grant away (Turn off, sign out). Signed by the device key. */
export const NativeGrantRevoke = z.strictObject({
  v: z.literal(1),
  type: z.literal('native.grant.revoke'),
  device_id: DeviceId,
  ts: IsoTs,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  osig: z.string().length(86),
})
export type NativeGrantRevokeT = z.infer<typeof NativeGrantRevoke>

export function grantScopes(g: Pick<NativeGrantT, 'scopes'>): GrantScope[] {
  return GRANT_SCOPES.filter((s) => g.scopes.includes(s))
}

/** Reasons a grant is refused, in the order they are checked. */
export type GrantProblem = 'bad_grant' | 'wrong_device' | 'bad_signature' | 'stale' | 'expired' | 'too_long'

export async function checkGrant(
  raw: unknown,
  devicePub: JwkP256T,
  nowMs: number,
): Promise<{ ok: true; grant: NativeGrantT } | { ok: false; reason: GrantProblem }> {
  const parsed = NativeGrant.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'bad_grant' }
  const g = parsed.data
  if (!(await verifyOwnerFrame(raw as Record<string, unknown>, devicePub)))
    return { ok: false, reason: 'bad_signature' }
  const ts = Date.parse(g.ts)
  const exp = Date.parse(g.exp)
  if (exp <= ts || exp - ts > GRANT_MAX_LIFETIME_MS) return { ok: false, reason: 'too_long' }
  if (ts > nowMs + NATIVE_SKEW_MS) return { ok: false, reason: 'stale' }
  if (exp <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, grant: g }
}

// ---- 3. act ----------------------------------------------------------------------------------------------------------

export const ActBody = z.discriminatedUnion('a', [
  z.strictObject({
    a: z.literal('reply'),
    thread_id: ThreadId,
    text: z.string().min(1).max(NATIVE_REPLY_MAX_CHARS),
  }),
  z.strictObject({
    a: z.literal('approve'),
    card_id: CardId,
    /** The card's hash from the sealed push. The Mac refuses the approval if the card has changed since. */
    payload_hash: Sha256Ref,
    /**
     * `shownHash` of the exact text the notification displayed. The Mac rebuilds that text from its own copy of the card
     * and refuses anything else, so the relay cannot have the phone show one thing and sign another.
     */
    shown: Sha256Ref,
  }),
])
export type ActBodyT = z.infer<typeof ActBody>

/**
 * relay -> bridge, durable and consumable. Never accepted from an app socket (`DIRECTION_TYPES.app_to_relay` does not list
 * it): it enters the relay only through `POST /api/native/act`. `grant` and `body` are strings on purpose, so what was
 * signed is byte for byte what is verified.
 */
export const NATIVE_ACT_TYPE = 'native.act'
export const NativeActWire = z.strictObject({
  v: z.literal(1),
  id: Ulid,
  ts: IsoTs,
  relay: z.object({ seq: z.number().int(), received_at: IsoTs }).optional(),
  type: z.literal(NATIVE_ACT_TYPE),
  device_id: DeviceId,
  grant: z.string().max(2048),
  body: z.string().max(NATIVE_REPLY_MAX_CHARS * 4 + 200),
  asig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
export type NativeActWireT = z.infer<typeof NativeActWire>

export const ACT_DOMAIN = 'talos-act/v1'

export function actSigningInput(f: {
  device_id: string
  id: string
  ts: string
  grant_osig: string
  body: string
}): string {
  return `${ACT_DOMAIN}\n${f.device_id}\n${f.id}\n${f.ts}\n${f.grant_osig}\n${f.body}`
}

/** An uncompressed point as a verify-only WebCrypto key. */
export async function importRawP256(raw: string, usage: 'verify' | 'ecdh'): Promise<CryptoKey> {
  const bytes = b64urlDecode(raw)
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('not an uncompressed P-256 point')
  return subtle().importKey(
    'raw',
    bytes,
    { name: usage === 'verify' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    usage === 'verify' ? ['verify'] : [],
  )
}

/**
 * The longest an Approve may wait, on the Mac's OWN clock, from the time the phone signed it. The relay's `received_at` stamp
 * is unsigned, so it cannot be trusted to extend this: past 12 hours the card stays pending and the owner is told. A Reply
 * keeps the 8-day queue rule above.
 */
export const NATIVE_APPROVE_MAX_AGE_MS = 12 * 3_600_000
/** The longest a signed action may wait in the relay's queue and still be taken (the same eight days as an app frame). */
export const ACT_QUEUE_MAX_MS = 8 * 86_400_000

export type ActProblem =
  | GrantProblem
  | 'bad_frame'
  | 'bad_body'
  | 'bad_act_signature'
  | 'act_stale'
  | 'act_future'
  | 'scope'
  | 'grant_mismatch'

export type ActCheck =
  | { ok: true; frame: NativeActWireT; grant: NativeGrantT; act: ActBodyT; grantRaw: Record<string, unknown> }
  | { ok: false; reason: ActProblem }

/**
 * The whole chain, for the relay and again for the Mac: frame shape, grant (signed by the pinned device key, current),
 * action signature under the key that grant names, a fresh `ts`, a body this build understands, and a scope that allows it.
 * It never throws. The caller still owns what it cannot know here: that the device is pinned and not revoked, that the
 * action id is new, and what state the card or thread is in.
 */
export async function checkNativeAct(
  raw: unknown,
  devicePub: JwkP256T,
  nowMs: number,
  opts: { receivedAtMs?: number } = {},
): Promise<ActCheck> {
  // The relay stamps when it took the action. A Mac that was asleep judges freshness and the grant's life at that moment,
  // not at its own wake-up time, or every queued tap would fail as stale. The stamp itself may be at most eight days old
  // and not in the future, so a replayed old frame still dies.
  const at = opts.receivedAtMs ?? nowMs
  if (!Number.isFinite(at) || at > nowMs + NATIVE_SKEW_MS || at < nowMs - ACT_QUEUE_MAX_MS)
    return { ok: false, reason: 'act_stale' }
  const wire = NativeActWire.safeParse(raw)
  if (!wire.success) return { ok: false, reason: 'bad_frame' }
  const f = wire.data
  let grantRaw: unknown
  try {
    grantRaw = JSON.parse(f.grant)
  } catch {
    return { ok: false, reason: 'bad_grant' }
  }
  if (typeof grantRaw !== 'object' || grantRaw === null || Array.isArray(grantRaw))
    return { ok: false, reason: 'bad_grant' }
  const ts = Date.parse(f.ts)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'act_stale' }
  // The grant's life is judged at the time the phone SIGNED the action (never later than the relay's stamp), so an unsigned
  // stamp cannot stretch a grant past the moment the phone really used it.
  const g = await checkGrant(grantRaw, devicePub, Math.min(at, ts))
  if (!g.ok) return g
  if (g.grant.device_id !== f.device_id) return { ok: false, reason: 'grant_mismatch' }
  if (ts > at + NATIVE_SKEW_MS) return { ok: false, reason: 'act_future' }
  if (ts < at - ACT_MAX_AGE_MS) return { ok: false, reason: 'act_stale' }
  // The grant must have been in force when the action was signed.
  if (ts < Date.parse(g.grant.ts) - NATIVE_SKEW_MS || ts > Date.parse(g.grant.exp))
    return { ok: false, reason: 'expired' }
  let ok = false
  try {
    const key = await importRawP256(g.grant.act_pub, 'verify')
    const sig = b64urlDecode(f.asig)
    ok =
      sig.length === 64 &&
      (await subtle().verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        sig,
        utf8(actSigningInput({ device_id: f.device_id, id: f.id, ts: f.ts, grant_osig: g.grant.osig, body: f.body })),
      ))
  } catch {
    ok = false
  }
  if (!ok) return { ok: false, reason: 'bad_act_signature' }
  let bodyRaw: unknown
  try {
    bodyRaw = JSON.parse(f.body)
  } catch {
    return { ok: false, reason: 'bad_body' }
  }
  const body = ActBody.safeParse(bodyRaw)
  if (!body.success || (body.data.a === 'reply' && body.data.text.trim() === ''))
    return { ok: false, reason: 'bad_body' }
  const need: GrantScope = body.data.a === 'reply' ? 'reply' : 'approve_low'
  if (!grantScopes(g.grant).includes(need)) return { ok: false, reason: 'scope' }
  return { ok: true, frame: f, grant: g.grant, act: body.data, grantRaw: grantRaw as Record<string, unknown> }
}

/** The message id a native reply is stored under: stable per action, so a retry cannot post it twice. */
export function nativeReplyMessageId(actId: string): string {
  return `m_${actId}`
}

/** Test and reference signer (a phone does this in Swift). */
export async function signNativeAct(args: {
  deviceId: string
  id: string
  ts: string
  grant: Record<string, unknown> & { osig: string }
  body: ActBodyT
  actPrivateKey: CryptoKey
}): Promise<NativeActWireT> {
  const body = JSON.stringify(args.body)
  const sig = new Uint8Array(
    await subtle().sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      args.actPrivateKey,
      utf8(actSigningInput({ device_id: args.deviceId, id: args.id, ts: args.ts, grant_osig: args.grant.osig, body })),
    ),
  )
  return {
    v: 1,
    id: args.id,
    ts: args.ts,
    type: NATIVE_ACT_TYPE,
    device_id: args.deviceId,
    grant: JSON.stringify(args.grant),
    body,
    asig: b64urlEncode(sig),
  }
}

// ---- 2. seal ---------------------------------------------------------------------------------------------------------

/** What the phone shows. Only ever inside a seal. */
export const RichContent = z.object({
  v: z.literal(1),
  /** Subtitle: the thread's real name, or absent. */
  s: z.string().max(60).optional(),
  /** Body text. */
  b: z.string().max(1200),
  /** Which kind of push this seal belongs to (also in the AAD, so Apple cannot move a seal onto another kind). */
  k: z.enum(['reply', 'card', 'digest', 'voice_result', 'system']),
  /** The thread a Reply goes to. */
  t: ThreadId.optional(),
  /** The card an Approve is for, with its risk and the hash of what the owner is shown. */
  c: CardId.optional(),
  r: z.enum(['low', 'high']).optional(),
  h: Sha256Ref.optional(),
})
export type RichContentT = z.infer<typeof RichContent>

export const SealEnvelope = z.strictObject({
  v: z.literal(1),
  /** Random per push; part of the AAD, so a seal cannot be lifted onto another push. */
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  epk: RawP256,
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ct: z.string().regex(/^[A-Za-z0-9_-]{22,4000}$/),
})
export type SealEnvelopeT = z.infer<typeof SealEnvelope>

export const SEAL_INFO = 'talos-push/v1 aes-256-gcm'

export function sealAad(a: { deviceId: string; kind: string; cardId?: string | undefined; pushId: string }): string {
  return `talos-push/v1|${a.deviceId}|${a.kind}|${a.cardId ?? ''}|${a.pushId}`
}

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function clipUtf8(s: string, maxBytes: number): string {
  if (utf8(s).length <= maxBytes) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = utf8(ch).length
    if (used + n > maxBytes - 3) break
    out += ch
    used += n
  }
  return `${out.trimEnd()}...`
}

async function sealKey(secret: ArrayBuffer, epkRaw: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: epkRaw as BufferSource, info: utf8(SEAL_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Seals `content` to a phone's encryption key. `ephemeral` and `iv` exist for fixed test vectors; production passes
 * neither. Throws on a bad key (the caller then sends the fixed template alone).
 */
export async function sealPush(args: {
  encPub: string
  deviceId: string
  kind: string
  cardId?: string | undefined
  content: RichContentT
  ephemeral?: CryptoKeyPair
  iv?: Uint8Array
  pushId?: string
}): Promise<SealEnvelopeT> {
  const peer = await importRawP256(args.encPub, 'ecdh')
  const eph =
    args.ephemeral ?? (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const epkRaw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey))
  const secret = await subtle().deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256)
  const key = await sealKey(secret, epkRaw)
  const iv = args.iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12))
  const pushId = args.pushId ?? b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  const aad = utf8(sealAad({ deviceId: args.deviceId, kind: args.kind, cardId: args.cardId, pushId }))
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad, tagLength: 128 },
      key,
      utf8(JSON.stringify(args.content)),
    ),
  )
  return { v: 1, id: pushId, epk: b64urlEncode(epkRaw), iv: b64urlEncode(iv), ct: b64urlEncode(ct) }
}

/** Reference opener (the phone does this in Swift; tests use this one to read what the relay sealed). */
export async function openPush(args: {
  envelope: unknown
  encPrivate: CryptoKey
  deviceId: string
  kind: string
  cardId?: string | undefined
}): Promise<RichContentT | null> {
  try {
    const env = SealEnvelope.parse(args.envelope)
    const epk = await importRawP256(env.epk, 'ecdh')
    const secret = await subtle().deriveBits({ name: 'ECDH', public: epk }, args.encPrivate, 256)
    const key = await sealKey(secret, b64urlDecode(env.epk))
    const aad = utf8(sealAad({ deviceId: args.deviceId, kind: args.kind, cardId: args.cardId, pushId: env.id }))
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(env.iv) as BufferSource, additionalData: aad, tagLength: 128 },
      key,
      b64urlDecode(env.ct) as BufferSource,
    )
    return RichContent.parse(JSON.parse(new TextDecoder().decode(pt)))
  } catch {
    return null
  }
}

/**
 * Builds the sealed content for one push, from what the relay already has. Text is cut to fit APNs; nothing here is
 * ever used for the alert Apple sees.
 */
export function normalizeNoticeText(text: string): string {
  return text.replace(/\s+\n/g, '\n').trim()
}

/** Card kinds a notification may approve. Everything that leaves the app (email, message, deploy, publish, purchase) or
 *  changes the Mac's own settings (schedule, app_action) is open-in-the-app only, whatever risk the agent put on it. */
export const NATIVE_APPROVABLE_KINDS: readonly string[] = CARD_KINDS.filter((k) => CARD_KIND_TABLE[k].nativeApprovable)

const seeLines = (t: string) => t.split('\n').map(visibleText).join('\n')

/**
 * The words a card push shows, built from the card alone so the relay (to seal it) and the Mac (to check what the phone
 * signed) get the same bytes. Invisible and direction-changing characters are made visible. `complete` is true only when
 * the whole card is in the text: nothing clipped, no attachment, no hidden payload (a permission card's payload is its
 * own visible fields), a kind a notification may approve, and no destination (a card that names a recipient sends something
 * out). Only a complete card is offered an Approve button.
 */
export function cardNotice(card: Omit<PermissionAllowView, 'state'>): { text: string; complete: boolean } {
  const lines: string[] = [seeLines(card.title)]
  if (card.summary) lines.push(seeLines(card.summary))
  for (const d of card.destination) lines.push(seeLines(`${d.label}: ${d.value}`))
  if (card.body) lines.push(seeLines(card.body))
  for (const f of card.fields) lines.push(seeLines(`${f.label}: ${f.value}`))
  if (card.warning) lines.push(seeLines(card.warning))
  lines.push(seeLines(`Button: ${card.primary_label}`))
  const full = normalizeNoticeText(lines.join('\n'))
  const budget = SEAL_TEXT_MAX_BYTES - 300
  const fits = utf8(full).length <= budget && full.length <= 1200
  const whole =
    fits &&
    NATIVE_APPROVABLE_KINDS.includes(card.kind) &&
    card.attachments.length === 0 &&
    // A card that names where something goes ("To: someone@...") sends something out, whatever `kind` the agent gave it.
    // `kind` is the agent's word; the destination list is what the owner is shown, so it decides here, for the relay and
    // the Mac alike (both call this function).
    card.destination.length === 0 &&
    // A permission card is offered Approve only where the app would show Allow: the same rule, so the notification, the app
    // and the bridge agree. The Mac's binding has no state field, and a card in the ledger is pending, so it is judged as such.
    (card.kind === 'permission'
      ? // ...and only a call the notification can show whole: one short visible line. A longer one shows Open, which goes to the
        // full-screen approval sheet where the owner scrolls through every character.
        permissionCardAllowsPrimary({ ...card, state: 'pending' }) &&
        (card.body ?? '').length <= PERMISSION_NOTICE_MAX_CHARS &&
        !/[\n\u23CE]/.test(card.body ?? '')
      : card.payload === undefined)
  return { text: whole ? full : clipUtf8(full, budget), complete: whole }
}

/**
 * What the phone signs as `shown`: a hash of everything the notification displayed, the subtitle (the thread name, or
 * nothing) and the body. The subtitle's byte length goes first so no subtitle can run into the body.
 *   input = "talos-shown/v2\n" + utf8_length(subtitle) + "\n" + subtitle + "\n" + body
 */
export function shownHash(displayed: string, subtitle = ''): string {
  return `sha256:${sha256Hex(`talos-shown/v2\n${utf8(subtitle).length}\n${subtitle}\n${displayed}`)}`
}

/**
 * The subtitle a card or reply push shows: the thread's real name, as far as "Show thread names" allows, else nothing. The
 * relay seals it and the Mac rebuilds it from its own config, so both sides get the same bytes for `shownHash`.
 */
export function noticeSubtitle(
  threadId: string | undefined,
  cfg: {
    notifications: { show_thread_names: 'fixed_only' | 'all' | 'none' }
    threads: ReadonlyArray<{ id: string; name: string; kind: 'fixed' | 'agent' | 'system' }>
  },
): string {
  const t = threadId ? cfg.threads.find((x) => x.id === threadId) : undefined
  const mode = cfg.notifications.show_thread_names
  return t && (mode === 'all' || (mode === 'fixed_only' && t.kind !== 'agent')) ? clipUtf8(t.name, 60) : ''
}

export function richContentFor(a: {
  kind: RichContentT['k']
  text: string
  subtitle?: string
  threadId?: string
  card?: { id: string; risk: 'low' | 'high'; payload_hash: string }
}): RichContentT {
  const body = clipUtf8(normalizeNoticeText(a.text), SEAL_TEXT_MAX_BYTES - 300)
  const out: RichContentT = { v: 1, b: body || ' ', k: a.kind }
  if (a.subtitle) out.s = clipUtf8(a.subtitle, 60)
  if (a.threadId && ThreadId.safeParse(a.threadId).success) out.t = a.threadId
  if (a.card) {
    out.c = a.card.id
    out.r = a.card.risk
    out.h = a.card.payload_hash
  }
  return RichContent.parse(out)
}

// ---- reference phone (tests and fixtures only; the real one is Swift) ---------------------------------------------------------------

/** The two key pairs a phone makes. In the app these are CryptoKit keys in the shared Keychain; here WebCrypto stands in. */
export async function createPhoneKeys(): Promise<{
  enc: CryptoKeyPair
  act: CryptoKeyPair
  encPub: string
  actPub: string
}> {
  const enc = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const act = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const raw = async (k: CryptoKey) => b64urlEncode(new Uint8Array(await subtle().exportKey('raw', k)))
  return { enc, act, encPub: await raw(enc.publicKey), actPub: await raw(act.publicKey) }
}

/** Builds and signs a grant with the device key (the page is meant to do this with its non-extractable key). */
export async function signNativeGrant(args: {
  deviceId: string
  devicePrivateKey: CryptoKey
  encPub: string
  actPub: string
  nowMs: number
  ttlMs?: number
  scopes?: string[]
  nonce?: string
}): Promise<NativeGrantT> {
  const nonce = args.nonce ?? b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(18)))
  return signOwnerFrame(
    {
      v: 1 as const,
      type: 'native.grant' as const,
      device_id: args.deviceId,
      enc_pub: args.encPub,
      act_pub: args.actPub,
      scopes: args.scopes ?? [...GRANT_SCOPES],
      ts: new Date(args.nowMs).toISOString(),
      exp: new Date(args.nowMs + (args.ttlMs ?? GRANT_MAX_LIFETIME_MS)).toISOString(),
      nonce,
    },
    args.devicePrivateKey,
  )
}

/** Takes a grant away. */
export async function signNativeGrantRevoke(args: {
  deviceId: string
  devicePrivateKey: CryptoKey
  nowMs: number
  nonce?: string
}): Promise<NativeGrantRevokeT> {
  return signOwnerFrame(
    {
      v: 1 as const,
      type: 'native.grant.revoke' as const,
      device_id: args.deviceId,
      ts: new Date(args.nowMs).toISOString(),
      nonce: args.nonce ?? b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(18))),
    },
    args.devicePrivateKey,
  )
}

/** What a sealed APNs body adds to the fixed one: the extension flag and the seal. Nothing readable. */
export function attachSeal<B extends { aps: Record<string, unknown>; talos: Record<string, unknown> }>(
  body: B,
  seal: SealEnvelopeT,
): B & { aps: { 'mutable-content': 1 }; talos: { enc: SealEnvelopeT } } {
  return {
    ...body,
    aps: { ...body.aps, 'mutable-content': 1 },
    talos: { ...body.talos, enc: seal },
  } as never
}
