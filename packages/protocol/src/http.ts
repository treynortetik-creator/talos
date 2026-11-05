// Request/response schemas for every HTTP route in spec 3.8, plus a machine-readable route table.
// WebAuthn JSON (SimpleWebAuthn) is typed as opaque objects: the relay hands it straight to @simplewebauthn/server.
import { z } from 'zod'
import {
  AppUpdateFrame,
  CardCreateFrame,
  HookDigestFrame,
  InboxUpdateFrame,
  ReplyFrame,
  ThreadUpsertFrame,
} from './frames.ts'
import { HealthStatus } from './health.ts'
import { ConnId, DeviceId, HttpsUrl, IntegrationId, IsoTs, MediaId, ThreadId, VoiceId } from './ids.ts'
import { AttachmentRef, Device, InboxItem, isAgentCardKind, isAppMessage, JwkP256 } from './models.ts'
import { Problem } from './problems.ts'
import { ApnsRegistration, ApnsStatus } from './push.ts'
import { NativeActWire, NativeGrant, NativeGrantRevoke } from './push-rich.ts'
import { SetupSpec } from './setup.ts'
import { SharePostBody, ShareScope, ShareToken } from './share.ts'

const Opaque = z.record(z.string(), z.unknown())
const Empty = z.object({})
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

export type RouteAuth =
  | 'none'
  | 'code_auth'
  | 'session'
  | 'session+code_auth'
  | 'bridge-sig'
  | 'verifier'
  | 'claim'
  // docs/V2-FEATURES.md V1.4: `Authorization: Bearer talos_share_<43 base64url>` (one route, Inbox only)
  | 'share-token'
  // docs/IOS-PUSH.md "Message text and quick actions": no cookie; the signature chain device key -> grant -> action key
  // is the credential, checked by the relay and again by the Mac. One route.
  | 'native-act'
export type RouteOwner = 'WP-N0' | 'WP1' | 'WP2' | 'WP3' | 'WP4' | 'WP8' | 'WP-V1' | 'WP-V4'

// ---- shared pieces ----------------------------------------------------------------------------------------------

export const StepupPurpose = z
  .string()
  .regex(/^(card:c_[0-9A-HJKMNP-TV-Z]{26}|config:work|config:session|device:revoke|session:control|permission:allow)$/)
export const StepupToken = z.object({ stepup_token: z.string() })

export const PushSubscriptionJson = z.object({
  endpoint: HttpsUrl,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export const ConnectionStatus = z.enum(['active', 'paused', 'error'])
export const Connection = z.object({
  id: ConnId,
  integration: IntegrationId,
  name: z.string().max(80),
  thread: ThreadId,
  status: ConnectionStatus,
  filters: z.record(z.string(), z.boolean()),
  created_at: IsoTs,
  last_event_at: IsoTs.nullable(),
  kept_24h: z.number().int(),
  received_24h: z.number().int(),
})
export const Delivery = z.object({
  at: IsoTs,
  status: z.number().int(),
  reason: z.string().max(200).optional(),
})
export const ConnectionCreate = z.object({
  integration: IntegrationId,
  name: z.string().min(1).max(80),
  thread: ThreadId.optional(),
  filters: z.record(z.string(), z.boolean()).optional(),
  fields: z.record(z.string(), z.string()).optional(),
})
export const ConnectionCreated = Connection.extend({
  /** Shown once. */
  hook_url: HttpsUrl,
  secret: z.string().optional(),
  /**
   * Apps Script connections (Gmail, Calendar, Forward) get a one-time claim code instead of a secret; the pasted script
   * trades it for the secret at `/claim`. Shown once.
   */
  claim_code: z.string().optional(),
})

// ---- route table ------------------------------------------------------------------------------------------------

type RouteDef = {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Hono-style pattern. */
  path: string
  auth: RouteAuth
  owner: RouteOwner
  /** JSON request body schema; absent = no JSON body (GET, raw bytes, or empty). */
  req?: z.ZodType
  /** JSON response body schema; absent = 204 / raw bytes. */
  res?: z.ZodType
  note?: string
}

/**
 * The relay stores the raw body it validated a parsed copy of, and a bad `app` view parses to absent. So the raw body
 * itself must carry no app field: a headless post never has an `app`, `app_view_id`, author `app` or kind `app`.
 */
function noAppFieldsOnRawPost(raw: unknown): boolean {
  const m = (raw as { message?: unknown } | null)?.message
  if (m === null || typeof m !== 'object') return true
  const r = m as Record<string, unknown>
  return !('app' in r) && !('app_view_id' in r) && r.author !== 'app' && r.kind !== 'app'
}

export const routes = {
  healthz: {
    id: 'healthz',
    method: 'GET',
    path: '/healthz',
    auth: 'none',
    owner: 'WP1',
    res: z.object({ ok: z.literal(true), version: z.string() }),
  },
  enrollOptions: {
    id: 'enrollOptions',
    method: 'POST',
    path: '/api/auth/enroll/options',
    auth: 'code_auth',
    owner: 'WP2',
    req: z.object({ code_auth: z.string() }),
    res: Opaque,
  },
  enrollVerify: {
    id: 'enrollVerify',
    method: 'POST',
    path: '/api/auth/enroll/verify',
    auth: 'code_auth',
    owner: 'WP2',
    req: z.object({ code_auth: z.string(), response: Opaque, device_name: z.string().max(80).optional() }),
    res: z.object({ ok: z.literal(true) }),
    note: 'sets the session cookie',
  },
  enrollSession: {
    id: 'enrollSession',
    method: 'POST',
    path: '/api/auth/enroll/session',
    auth: 'code_auth',
    owner: 'WP-N0',
    req: z.object({ code_auth: z.string() }),
    res: z.object({ ok: z.literal(true) }),
    note: 'native shells: a live, unused code with no passkey yields an UNPINNED session (credential_id null) and sets the cookie; the code is not burned (device/verify burns it); one session per code',
  },
  loginOptions: {
    id: 'loginOptions',
    method: 'POST',
    path: '/api/auth/login/options',
    auth: 'none',
    owner: 'WP2',
    req: Empty,
    res: Opaque,
  },
  loginVerify: {
    id: 'loginVerify',
    method: 'POST',
    path: '/api/auth/login/verify',
    auth: 'none',
    owner: 'WP2',
    req: z.object({ response: Opaque }),
    res: z.object({ ok: z.literal(true) }),
    note: 'sets the session cookie',
  },
  deviceVerify: {
    id: 'deviceVerify',
    method: 'POST',
    path: '/api/auth/device/verify',
    auth: 'session+code_auth',
    owner: 'WP2',
    req: z.object({
      device: z.object({ id: DeviceId, name: z.string().min(1).max(80), pubkey_jwk: JwkP256 }),
      binding: z.string().min(1).max(200),
      code_auth: z.string(),
      /** The passkey's COSE public key (base64url); the binding HMAC covers it (docs/CLAUDE-CODE.md C3.6). */
      credential_public_key: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,2048}$/)
        .optional(),
      /**
       * WP-N0: proof of possession of the device's private key (packages/protocol/src/device-proof.ts). Required when the
       * device is already pinned: without it the relay answers 409 `device_proof_required` with a fresh `challenge` (the
       * nonce to sign); sign it and send the same request again with `proof`.
       */
      proof: z
        .object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
        .optional(),
    }),
    res: z.object({ accepted: z.literal(true) }),
    note: '202 (enrollment half 2); 409 device_proof_required {challenge} for an already-pinned device',
  },
  deviceProveOptions: {
    id: 'deviceProveOptions',
    method: 'POST',
    path: '/api/auth/device/prove/options',
    auth: 'session',
    owner: 'WP2',
    req: Empty,
    // `proven: true` (no challenge) when this session's device already proved its key.
    res: z.object({ challenge: z.string().optional(), proven: z.boolean().optional() }),
    note: 'a challenge for the session device to sign (SESSION_PROOF_CODE_ID in device-proof.ts); lets an open browser upgrade without signing out',
  },
  deviceProve: {
    id: 'deviceProve',
    method: 'POST',
    path: '/api/auth/device/prove',
    auth: 'session',
    owner: 'WP2',
    req: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }),
    res: z.object({ ok: z.literal(true) }),
    note: '401 device_proof_invalid on a wrong or reused proof; the first proof also ends sessions attached to the device without one',
  },
  stepupOptions: {
    id: 'stepupOptions',
    method: 'POST',
    path: '/api/auth/stepup/options',
    auth: 'session',
    owner: 'WP2',
    req: z.object({ purpose: StepupPurpose }),
    res: Opaque,
  },
  stepupVerify: {
    id: 'stepupVerify',
    method: 'POST',
    path: '/api/auth/stepup/verify',
    auth: 'session',
    owner: 'WP2',
    req: z.object({ purpose: StepupPurpose, response: Opaque }),
    res: StepupToken,
  },
  logout: { id: 'logout', method: 'POST', path: '/api/auth/logout', auth: 'session', owner: 'WP2', note: '204' },
  logoutAll: {
    id: 'logoutAll',
    method: 'POST',
    path: '/api/auth/logout-all',
    auth: 'session',
    owner: 'WP2',
    note: '204',
  },
  me: {
    id: 'me',
    method: 'GET',
    path: '/api/me',
    auth: 'session',
    owner: 'WP2',
    res: z.object({
      device_id: DeviceId.optional(),
      device_pinned: z.boolean(),
      has_passkey: z.boolean(),
      rp_id: z.string(),
      version: z.string(),
      bridge_online: z.boolean(),
      /** Web Push application server key (base64url). Absent when the relay has no VAPID keys. */
      vapid_public_key: z.string().optional(),
      /** Live voice status; `reason` says why it is off. Absent on older relays. */
      voice: z
        .object({ available: z.boolean(), reason: z.enum(['no_key', 'unsupported_provider']).optional() })
        .optional(),
      /** Dictation (record, transcribe, text into the message box) status. Absent on older relays. */
      dictate: z.object({ available: z.boolean() }).optional(),
    }),
  },
  devicesList: {
    id: 'devicesList',
    method: 'GET',
    path: '/api/devices',
    auth: 'session',
    owner: 'WP2',
    res: z.array(Device),
  },
  deviceRevoke: {
    id: 'deviceRevoke',
    method: 'POST',
    path: '/api/devices/:id/revoke',
    auth: 'session',
    owner: 'WP2',
    req: StepupToken,
    note: '204; step-up purpose device:revoke',
  },
  pushSubscribe: {
    id: 'pushSubscribe',
    method: 'POST',
    path: '/api/push/subscribe',
    auth: 'session',
    owner: 'WP1',
    req: PushSubscriptionJson,
    note: '204',
  },
  pushUnsubscribe: {
    id: 'pushUnsubscribe',
    method: 'DELETE',
    path: '/api/push/subscribe',
    auth: 'session',
    owner: 'WP1',
    req: z.object({ endpoint: HttpsUrl }),
    note: '204',
  },
  pushApnsStatus: {
    id: 'pushApnsStatus',
    method: 'GET',
    path: '/api/push/apns',
    auth: 'session',
    owner: 'WP1',
    res: ApnsStatus,
    note: "native push state for this session's device (WP-I5)",
  },
  pushRef: {
    id: 'pushRef',
    method: 'GET',
    path: '/api/push/ref/:ref',
    auth: 'session',
    owner: 'WP1',
    res: z.object({ thread_id: ThreadId }),
    note: "what an iPhone notification's opaque thread reference means (WP-I5); 404 unknown, 400 malformed",
  },
  pushThreadRef: {
    id: 'pushThreadRef',
    method: 'GET',
    path: '/api/push/thread-ref/:thread',
    auth: 'session',
    owner: 'WP1',
    res: z.object({ ref: z.string().regex(/^r_[A-Za-z0-9_-]{16}$/) }),
    note: 'the opaque reference iPhone notifications use for a thread, so the app can clear or silence them (the reverse of pushRef); minted on first ask; 404 for a thread that does not exist, 400 malformed',
  },
  pushApnsRegister: {
    id: 'pushApnsRegister',
    method: 'POST',
    path: '/api/push/apns',
    auth: 'session',
    owner: 'WP1',
    req: ApnsRegistration,
    note: "204; a registration signed by the session's pinned device; 409 not_configured, 401 bad_signature, 409 replay (WP-I5)",
  },
  pushGrantStatus: {
    id: 'pushGrantStatus',
    method: 'GET',
    path: '/api/push/grant',
    auth: 'session',
    owner: 'WP1',
    res: z.union([z.object({ registered: z.literal(true), exp: IsoTs }), z.object({ registered: z.literal(false) })]),
    note: "does the relay hold a current notification grant for this session's device (never the keys)",
  },
  pushGrantPut: {
    id: 'pushGrantPut',
    method: 'POST',
    path: '/api/push/grant',
    auth: 'session',
    owner: 'WP1',
    req: z.union([NativeGrant, NativeGrantRevoke]),
    note: "204; a native.grant (or native.grant.revoke) signed by the session's pinned device; 401 bad_signature, 409 replay, 403 wrong_device",
  },
  nativeAct: {
    id: 'nativeAct',
    method: 'POST',
    path: '/api/native/act',
    auth: 'native-act',
    owner: 'WP1',
    req: NativeActWire,
    res: z.object({ ok: z.literal(true), duplicate: z.boolean() }),
    note: 'Reply or Approve from a notification; no cookie. 401 bad_signature (also for an unknown or revoked device and for a grant the relay no longer holds), 403 stepup_required, 409 replay | card_*, 409 mac_update_needed',
  },
  pushTest: {
    id: 'pushTest',
    method: 'POST',
    path: '/api/push/test',
    auth: 'session',
    owner: 'WP1',
    req: Empty,
    note: '204',
  },
  mediaUpload: {
    id: 'mediaUpload',
    method: 'POST',
    path: '/api/media',
    auth: 'session',
    owner: 'WP1',
    res: AttachmentRef,
    note: 'raw body; headers Content-Type, X-Talos-Name, X-Talos-Sha256, X-Talos-Duration-Ms, X-Talos-CSRF: 1',
  },
  mediaGet: {
    id: 'mediaGet',
    method: 'GET',
    path: '/media/:id',
    auth: 'session',
    owner: 'WP1',
    note: 'raw bytes, Accept-Ranges, sandbox CSP (5.4)',
  },
  mediaPage: {
    id: 'mediaPage',
    method: 'GET',
    path: '/media/:id/page',
    auth: 'session',
    owner: 'WP1',
    note: 'sandboxed HTML attachment page (5.4)',
  },
  mediaApp: {
    id: 'mediaApp',
    method: 'GET',
    path: '/media/:id/app',
    auth: 'session',
    owner: 'WP1',
    note: 'MCP app page (M3.5): 404 unless text/html with an approved app_csp; sandbox allow-scripts + buildAppCsp; 410 + rehydrate',
  },
  dictate: {
    id: 'dictate',
    method: 'POST',
    path: '/api/dictate',
    auth: 'session',
    owner: 'WP4',
    res: z.object({ text: z.string() }),
    note: 'raw audio body (m4a, mp4, wav, webm, mp3; 25 MB); header X-Talos-CSRF: 1. Held in memory only and sent to OpenAI. 413 too_large, 415 unsupported_type, 429 rate_limited | daily_cap, 502 upstream_refused | upstream_unreachable, 503 dictate_disabled, 504 upstream_timeout',
  },
  voiceSession: {
    id: 'voiceSession',
    method: 'POST',
    path: '/api/voice/session',
    auth: 'session',
    owner: 'WP4',
    // spec 6.2 step 2 and 3. `ephemeral_key` and `expires_at` are the optional realtime fallback.
    req: z.object({ thread_id: ThreadId, sdp: z.string().min(1).max(100_000) }),
    res: z.object({
      voice_session_id: VoiceId,
      sdp_answer: z.string(),
      max_minutes: z.number().int().positive(),
      ephemeral_key: z.string().optional(),
      expires_at: IsoTs.optional(),
    }),
  },
  voiceSessionClose: {
    id: 'voiceSessionClose',
    method: 'POST',
    path: '/api/voice/session/:id/close',
    auth: 'session',
    owner: 'WP4',
    req: Empty,
    note: '204',
  },
  catalog: {
    id: 'catalog',
    method: 'GET',
    path: '/api/integrations/catalog',
    auth: 'session',
    owner: 'WP3',
    res: z.array(SetupSpec),
  },
  connectionsList: {
    id: 'connectionsList',
    method: 'GET',
    path: '/api/connections',
    auth: 'session',
    owner: 'WP3',
    res: z.array(Connection),
  },
  connectionCreate: {
    id: 'connectionCreate',
    method: 'POST',
    path: '/api/connections',
    auth: 'session',
    owner: 'WP3',
    req: ConnectionCreate,
    res: ConnectionCreated,
  },
  connectionGet: {
    id: 'connectionGet',
    method: 'GET',
    path: '/api/connections/:id',
    auth: 'session',
    owner: 'WP3',
    res: Connection,
  },
  connectionPatch: {
    id: 'connectionPatch',
    method: 'PATCH',
    path: '/api/connections/:id',
    auth: 'session',
    owner: 'WP3',
    req: z.object({
      name: z.string().min(1).max(80).optional(),
      thread: ThreadId.optional(),
      status: z.enum(['active', 'paused']).optional(),
      filters: z.record(z.string(), z.boolean()).optional(),
    }),
    res: Connection,
  },
  connectionDelete: {
    id: 'connectionDelete',
    method: 'DELETE',
    path: '/api/connections/:id',
    auth: 'session',
    owner: 'WP3',
    note: '204',
  },
  connectionRotate: {
    id: 'connectionRotate',
    method: 'POST',
    path: '/api/connections/:id/rotate',
    auth: 'session',
    owner: 'WP3',
    req: Empty,
    res: z.object({ secret: z.string(), claim_code: z.string().optional() }),
  },
  connectionTest: {
    id: 'connectionTest',
    method: 'POST',
    path: '/api/connections/:id/test',
    auth: 'session',
    owner: 'WP3',
    req: Empty,
    res: z.object({ ok: z.boolean(), detail: z.string().max(500).optional() }),
  },
  connectionCredentials: {
    id: 'connectionCredentials',
    method: 'POST',
    path: '/api/connections/:id/credentials',
    auth: 'session',
    owner: 'WP3',
    req: z.object({ fields: z.record(z.string(), z.string()) }),
    res: z.object({ ok: z.boolean(), detail: z.string().max(500).optional() }),
  },
  connectionDeliveries: {
    id: 'connectionDeliveries',
    method: 'GET',
    path: '/api/connections/:id/deliveries',
    auth: 'session',
    owner: 'WP3',
    res: z.array(Delivery),
  },
  inboxList: {
    id: 'inboxList',
    method: 'GET',
    path: '/api/inbox',
    auth: 'session',
    owner: 'WP3',
    res: z.object({
      items: z.array(InboxItem),
      counts: z.object({ priority: z.number().int(), other: z.number().int() }),
      truncated: z.boolean().optional(),
      unreadable: z.number().int().optional(), // rows this list left out because they no longer open; absent when none
    }),
    note: 'query: tab=priority|other; state=done lists finished items of both tabs instead (the default lists exclude done)',
  },
  hook: {
    id: 'hook',
    method: 'POST',
    path: '/hook/:integration/:connection_id',
    auth: 'verifier',
    owner: 'WP3',
    note: 'raw body; per-integration verifier (7.2); GET is 405',
  },
  hookClaim: {
    id: 'hookClaim',
    method: 'POST',
    path: '/hook/:integration/:connection_id/claim',
    auth: 'claim',
    owner: 'WP3',
    req: z.object({ claim_code: z.string() }),
    res: z.object({ secret: z.string() }),
    note: 'gmail, gmail_work, gcal only (7.6)',
  },
  bridgePost: {
    id: 'bridgePost',
    method: 'POST',
    path: '/bridge/post',
    auth: 'bridge-sig',
    owner: 'WP1',
    // kind:'schedule' and kind:'permission' cards are minted only by the live bridge (docs/SCHEDULES.md S2.5, S6.1;
    // docs/CLAUDE-CODE.md C3.2): headless posts take AGENT_CARD_KINDS only
    req: z
      .any()
      .refine(noAppFieldsOnRawPost, { message: 'app rows come from the live bridge only' })
      .pipe(
        z.union([
          // app views and their echo rows are minted by the live bridge only (MCP apps); a headless post never is
          ReplyFrame.refine((f) => !isAppMessage(f.message), {
            path: ['message'],
            message: 'app rows come from the live bridge only',
          }),
          CardCreateFrame.refine((f) => isAgentCardKind(f.card.kind), {
            path: ['card', 'kind'],
            message: "kind 'schedule' and 'permission' cards come from the live bridge only",
          }),
          ThreadUpsertFrame,
          InboxUpdateFrame,
          AppUpdateFrame,
        ]),
      ),
    res: z.object({ ack: z.object({ ref: z.string(), seq: z.number().int().optional() }) }),
  },
  bridgeMediaPut: {
    id: 'bridgeMediaPut',
    method: 'PUT',
    path: '/bridge/media/:id',
    auth: 'bridge-sig',
    owner: 'WP1',
    note: 'raw bytes + X-Talos-Sha256; optional X-Talos-App-Csp (base64url JCS AppCsp, html only, AP2) marks an MCP app page',
    res: z.object({ ok: z.literal(true), media_id: MediaId }),
  },
  bridgeMediaGet: {
    id: 'bridgeMediaGet',
    method: 'GET',
    path: '/bridge/media/:id',
    auth: 'bridge-sig',
    owner: 'WP1',
    note: 'raw bytes (owner uploads, for the bridge to download)',
  },
  bridgeRaw: {
    id: 'bridgeRaw',
    method: 'GET',
    path: '/bridge/raw/:event_id',
    auth: 'bridge-sig',
    owner: 'WP3',
    note: 'raw payload bytes, decrypted; param is an EventId',
  },
  bridgeDigest: {
    id: 'bridgeDigest',
    method: 'GET',
    path: '/bridge/digest',
    auth: 'bridge-sig',
    owner: 'WP3',
    res: HookDigestFrame,
    note: 'query: since=<ISO>',
  },
  bridgeEnroll: {
    id: 'bridgeEnroll',
    method: 'POST',
    path: '/bridge/enroll',
    auth: 'bridge-sig',
    owner: 'WP2',
    req: z.object({
      // code_id = enrollCodeId(code_auth_hash); the relay checks it. `label` is optional like the CLI's --label.
      code_id: z.string().regex(/^[0-9a-f]{16}$/),
      code_auth_hash: Sha256Hex,
      expires_at: IsoTs,
      label: z.string().max(80).optional(),
    }),
    res: z.object({ ok: z.literal(true) }),
  },
  bridgeRotate: {
    id: 'bridgeRotate',
    method: 'POST',
    path: '/bridge/rotate',
    auth: 'bridge-sig',
    owner: 'WP2',
    req: z.object({
      new_pubkey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      sig_new: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      ts: z.number().int(),
    }),
    res: z.object({ ok: z.literal(true), key_id: z.string() }),
    note: 'sig_new signs "talos-rotate/v1\\n" + new_pubkey + "\\n" + ts with the NEW key; ts is carried in the body',
  },
  bridgeDeviceRevoke: {
    id: 'bridgeDeviceRevoke',
    method: 'POST',
    path: '/bridge/devices/:id/revoke',
    auth: 'bridge-sig',
    owner: 'WP2',
    req: Empty,
    // shared_passkey is absent from a relay older than this field: treat absent as unknown, not false.
    res: z.object({ ok: z.literal(true), shared_passkey: z.boolean().optional() }),
  },
  appSocket: {
    id: 'appSocket',
    method: 'GET',
    path: '/ws',
    auth: 'session',
    owner: 'WP1',
    note: 'WebSocket upgrade; cookie and Origin are checked before the upgrade',
  },
  bridgeSocket: {
    id: 'bridgeSocket',
    method: 'GET',
    path: '/bridge',
    auth: 'bridge-sig',
    owner: 'WP1',
    note: 'WebSocket upgrade; the first frame must be a signed hello (4401 otherwise)',
  },
  // ---- v2 features (docs/V2-FEATURES.md V1.4) ----------------------------------------------------------------------
  status: {
    id: 'status',
    method: 'GET',
    path: '/api/status',
    auth: 'session',
    owner: 'WP-V1',
    res: HealthStatus,
  },
  healthTest: {
    id: 'healthTest',
    method: 'POST',
    path: '/api/health/test',
    auth: 'session',
    owner: 'WP-V1',
    note: '200 with what was sent (one test alert down every configured path); 409 no_alert_path when nobody can be alerted',
  },
  problemsPost: {
    id: 'problemsPost',
    method: 'POST',
    path: '/api/problems',
    auth: 'session',
    owner: 'WP-V1',
    req: Problem,
    res: z.object({ ok: z.literal(true), id: z.string() }),
    note: 'one problem report (docs/ERRORS.md): session + CSRF, bucket `problems` 30/hour, body cap 64 KiB; 202 once queued for the Mac, 429 with retry_after_s',
  },
  shareTokensList: {
    id: 'shareTokensList',
    method: 'GET',
    path: '/api/share/tokens',
    auth: 'session',
    owner: 'WP-V4',
    res: z.array(ShareToken),
  },
  shareTokenCreate: {
    id: 'shareTokenCreate',
    method: 'POST',
    path: '/api/share/tokens',
    auth: 'session',
    owner: 'WP-V4',
    req: z.object({ label: z.string().min(1).max(40), scopes: z.array(ShareScope).min(1).max(2) }).strict(),
    res: z.object({ token: ShareToken, secret: z.string() }),
    note: "binds the session's pinned device_id (none -> 403); the secret is shown once; 10 active at most",
  },
  shareTokenRevoke: {
    id: 'shareTokenRevoke',
    method: 'DELETE',
    path: '/api/share/tokens/:id',
    auth: 'session',
    owner: 'WP-V4',
    note: '204',
  },
  share: {
    id: 'share',
    method: 'POST',
    path: '/api/share',
    auth: 'share-token',
    owner: 'WP-V4',
    req: SharePostBody,
    res: z.object({ share_id: z.string() }),
    note: '202; JSON or multipart (same names plus <= 4 `file` parts, files scope only); 404 when SHARE_ENABLED=0',
  },
  bridgeShareTokens: {
    id: 'bridgeShareTokens',
    method: 'POST',
    path: '/bridge/share/tokens',
    auth: 'bridge-sig',
    owner: 'WP-V4',
    req: z
      .object({ label: z.string().min(1).max(40), device_id: DeviceId, scopes: z.array(ShareScope).min(1).max(2) })
      .strict(),
    res: z.object({ token: ShareToken, secret: z.string() }),
    note: 'P1 `talos-app share shortcut`: a fresh token per export',
  },
  bridgeShareTokenRevoke: {
    id: 'bridgeShareTokenRevoke',
    method: 'DELETE',
    path: '/bridge/share/tokens/:id',
    auth: 'bridge-sig',
    owner: 'WP-V4',
    note: 'P1 `talos-app share revoke <id>`: 204, and 204 again when already revoked; an id that never existed is 404; no body',
  },
  shareTarget: {
    id: 'shareTarget',
    method: 'POST',
    path: '/share-target',
    auth: 'none',
    owner: 'WP-V4',
    note: 'the service worker normally answers; if a POST reaches the relay -> 303 /share?retry=1',
  },
  aasa: {
    id: 'aasa',
    method: 'GET',
    path: '/.well-known/apple-app-site-association',
    auth: 'none',
    owner: 'WP8',
    note: 'webcredentials JSON from APNS_TEAM_ID + APNS_BUNDLE_ID (WP-I6); 404 JSON when either is unset',
  },
} as const satisfies Record<string, RouteDef>

export type RouteId = keyof typeof routes
export const ROUTE_LIST: readonly RouteDef[] = Object.values(routes)
export type RouteReq<K extends RouteId> = (typeof routes)[K] extends { req: infer R extends z.ZodType }
  ? z.infer<R>
  : never
export type RouteRes<K extends RouteId> = (typeof routes)[K] extends { res: infer R extends z.ZodType }
  ? z.infer<R>
  : never
