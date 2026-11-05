// Calendly (personal): `Calendly-Webhook-Signature: t=…,v1=…`, hex HMAC-SHA256(signing key, `{t}.{raw body}`), 3 minute
// window. Dedup on `payload.uri + event`. We generate the signing key and register it with a personal access token.
import type { NormalizedEventT } from '@talos-app/protocol'
import type { ModuleExtras } from '../generic/common.ts'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import { sha256Hex } from '../standard-webhooks.ts'
import { verifyTimestampedHex } from '../stripe/index.ts'
import type {
  IntegrationModule,
  NormalizeConnection,
  RawDelivery,
  VerifyConnection,
  VerifyRequest,
  VerifyResult,
} from '../types.ts'
import { calendlySetup } from './setup.ts'

const WINDOW_MS = 3 * 60_000

function verify(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const r = verifyTimestampedHex(req.headers['calendly-webhook-signature'], req, conn.secrets, WINDOW_MS)
  if (!r.ok) return r
  let key = ''
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(req.rawBody))
    if (isRecord(j) && isRecord(j.payload) && typeof j.payload.uri === 'string' && typeof j.event === 'string')
      key = `calendly:${j.event}:${j.payload.uri}`.slice(0, 250)
  } catch {
    /* no key */
  }
  return { ok: true, ...(key ? { deliveryKey: key } : {}) }
}

function normalize(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j) || !isRecord(j.payload)) return []
  const p = j.payload
  const booked = j.event === 'invitee.created'
  if (!booked && j.event !== 'invitee.canceled') return []
  const who = clean(p.name, 100) || 'Someone'
  const ev = isRecord(p.scheduled_event) ? p.scheduled_event : {}
  const what = clean(ev.name, 120) || 'a meeting'
  const when = typeof ev.start_time === 'string' ? ` at ${clean(ev.start_time, 40)}` : ''
  return [
    makeEvent(conn, 'calendly', {
      kind: booked ? 'calendly.booked' : 'calendly.canceled',
      title: booked ? `${who} booked ${what}` : `${who} canceled ${what}`,
      summary: `${who} ${booked ? 'booked' : 'canceled'} ${what}${when}.`,
      actor: { name: who, ...(typeof p.email === 'string' ? { email: p.email } : {}) },
      ts: toIso(j.created_at, raw.receivedAt),
      priority: booked ? 'normal' : 'low',
      dedup_key: `calendly:${clean(j.event, 40)}:${typeof p.uri === 'string' ? sha256Hex(p.uri).slice(0, 32) : raw.receivedAt}`,
    }),
  ]
}

export const integration: IntegrationModule & ModuleExtras = {
  id: 'calendly',
  setup: calendlySetup,
  async provision({ fetch, hookUrl, secret, secrets }) {
    const token = secrets.token
    if (!token) return { ok: false, error: 'token is missing', forget: [] }
    const r = await createCalendlyWebhook({ fetch, token, url: hookUrl, signingKey: secret })
    return { ...r, forget: r.ok ? ['token'] : [] }
  },
  verify,
  normalize,
  toggle(key, enabled, event) {
    if (key === 'booked') return event.kind === 'calendly.booked' ? enabled : true
    if (key === 'canceled') return event.kind === 'calendly.canceled' ? enabled : true
    return true
  },
}

/** `GET /users/me` then `POST /webhook_subscriptions` (scope user) with a signing key we generated. Never throws. */
export async function createCalendlyWebhook(args: {
  fetch: typeof fetch
  token: string
  url: string
  signingKey: string
}): Promise<{ ok: boolean; error?: string }> {
  const headers = { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' }
  try {
    const me = await args.fetch('https://api.calendly.com/users/me', { headers, signal: AbortSignal.timeout(15_000) })
    if (!me.ok) return { ok: false, error: `calendly_${me.status}` }
    const mj: unknown = await me.json().catch(() => undefined)
    const r = isRecord(mj) && isRecord(mj.resource) ? mj.resource : undefined
    if (!r || typeof r.uri !== 'string' || typeof r.current_organization !== 'string')
      return { ok: false, error: 'bad_profile' }
    const res = await args.fetch('https://api.calendly.com/webhook_subscriptions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: args.url,
        events: ['invitee.created', 'invitee.canceled'],
        organization: r.current_organization,
        user: r.uri,
        scope: 'user',
        signing_key: args.signingKey,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    return res.status === 201 ? { ok: true } : { ok: false, error: `calendly_${res.status}` }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}
