// Stripe (personal): `Stripe-Signature: t=…,v1=…[,v1=…]`, hex HMAC-SHA256(whsec, `{t}.{raw body}`), any v1 may match,
// other schemes ignored, 5 minute window. Dedup on `event.id`.
import type { NormalizedEventT } from '@talos-app/protocol'
import type { ModuleExtras } from '../generic/common.ts'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import { hmacSha256, REPLAY_WINDOW_MS, safeEqual } from '../standard-webhooks.ts'
import type {
  IntegrationModule,
  NormalizeConnection,
  RawDelivery,
  VerifyConnection,
  VerifyRequest,
  VerifyResult,
} from '../types.ts'
import { stripeSetup } from './setup.ts'

export const STRIPE_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'charge.dispute.created',
  'customer.subscription.deleted',
]

/** Version header shown in Stripe's v2 event destinations docs (docs.stripe.com/api/v2/core/event-destinations/create, checked 2026-10-28). */
export const STRIPE_V2_VERSION = '2026-09-30.endive'

/** Parses `t=…,v1=…,v1=…`; unknown schemes (v0 and the like) are ignored. */
export function parseSigHeader(h: string): { t: string; v1: string[] } | null {
  let t = ''
  const v1: string[] = []
  for (const part of h.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') t = v
    else if (k === 'v1') v1.push(v)
  }
  return /^\d{1,12}$/.test(t) && v1.length > 0 ? { t, v1 } : null
}

/** Shared by Stripe and Calendly: `t=…,v1=…`, HMAC over `{t}.{body}`. Secrets are used as raw strings. */
export function verifyTimestampedHex(
  header: string | undefined,
  req: VerifyRequest,
  secrets: string[],
  windowMs: number,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' }
  const p = parseSigHeader(header)
  if (!p) return { ok: false, reason: 'bad_signature_format' }
  if (Math.abs(req.now - Number(p.t) * 1000) > windowMs) return { ok: false, reason: 'stale_timestamp' }
  if (secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  for (const s of secrets) {
    const expected = hmacSha256(s, `${p.t}.`, req.rawBody).toString('hex')
    for (const given of p.v1) if (safeEqual(expected, given)) return { ok: true }
  }
  return { ok: false, reason: 'signature_mismatch' }
}

function verify(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const r = verifyTimestampedHex(req.headers['stripe-signature'], req, conn.secrets, REPLAY_WINDOW_MS)
  if (!r.ok) return r
  let id = ''
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(req.rawBody))
    if (isRecord(j) && typeof j.id === 'string') id = j.id
  } catch {
    /* no key */
  }
  return { ok: true, ...(id ? { deliveryKey: `stripe:${id.slice(0, 100)}` } : {}) }
}

function money(minor: unknown, currency: unknown): string {
  if (typeof minor !== 'number' || typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return ''
  const zero = new Set(['jpy', 'krw', 'vnd', 'clp'])
  const c = currency.toLowerCase()
  const v = zero.has(c) ? minor : minor / 100
  return `${v.toFixed(zero.has(c) ? 0 : 2)} ${c.toUpperCase()}`
}

function normalize(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j) || typeof j.type !== 'string') return []
  const obj = isRecord(j.data) && isRecord(j.data.object) ? j.data.object : {}
  const base = {
    ts: toIso(j.created, raw.receivedAt),
    dedup_key: `stripe:${clean(j.id, 100) || `${j.type}:${raw.receivedAt}`}`,
  }
  const email =
    typeof obj.customer_email === 'string'
      ? obj.customer_email
      : isRecord(obj.customer_details) && typeof obj.customer_details.email === 'string'
        ? obj.customer_details.email
        : undefined
  const actor = email ? { email } : {}
  if (j.type === 'checkout.session.completed' || j.type === 'invoice.paid') {
    const amt = j.type === 'invoice.paid' ? money(obj.amount_paid, obj.currency) : money(obj.amount_total, obj.currency)
    return [
      makeEvent(conn, 'stripe', {
        kind: 'stripe.payment',
        title: amt ? `Payment received: ${amt}` : 'Payment received',
        summary: `${j.type === 'invoice.paid' ? 'Invoice paid' : 'Checkout completed'}${amt ? `: ${amt}` : ''}`,
        url: obj.hosted_invoice_url,
        actor,
        priority: 'normal',
        ...base,
      }),
    ]
  }
  if (j.type === 'charge.dispute.created') {
    const amt = money(obj.amount, obj.currency)
    return [
      makeEvent(conn, 'stripe', {
        kind: 'stripe.dispute',
        title: amt ? `Dispute opened: ${amt}` : 'Dispute opened',
        summary: `A customer disputed a charge${amt ? ` of ${amt}` : ''}${typeof obj.reason === 'string' ? ` (reason: ${clean(obj.reason, 60)})` : ''}. Evidence deadlines are short.`,
        actor,
        priority: 'high',
        ...base,
      }),
    ]
  }
  return [
    makeEvent(conn, 'stripe', {
      kind: 'stripe.event',
      title: clean(j.type, 100),
      summary: `Stripe event: ${clean(j.type, 100)}`,
      actor,
      priority: 'low',
      ...base,
    }),
  ]
}

export const integration: IntegrationModule & ModuleExtras = {
  id: 'stripe',
  setup: stripeSetup,
  verify,
  normalize,
  verifySecretField: 'signing_secret',
  toggle(key, enabled, event) {
    if (key === 'payments') return event.kind === 'stripe.payment' ? enabled : true
    if (key === 'disputes') return event.kind === 'stripe.dispute' ? enabled : true
    if (key === 'other') return event.kind === 'stripe.event' ? enabled : true
    return true
  },
}

/**
 * Creates the endpoint through the v2 event destinations API with a restricted key (spec 7.5). `events_from: ["@self"]` and the `Stripe-Version` header follow Stripe's docs (2026-10-28); a snapshot
 * destination may also want `snapshot_api_version`, which must be checked against a real account (scripts/smoke/wp3b.md). Never throws.
 */
export async function createStripeDestination(args: {
  fetch: typeof fetch
  restrictedKey: string
  url: string
}): Promise<{ ok: boolean; signingSecret?: string; error?: string }> {
  try {
    const res = await args.fetch('https://api.stripe.com/v2/core/event_destinations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.restrictedKey}`,
        'content-type': 'application/json',
        'stripe-version': STRIPE_V2_VERSION,
      },
      body: JSON.stringify({
        name: 'Talos',
        type: 'webhook_endpoint',
        event_payload: 'snapshot',
        events_from: ['@self'],
        enabled_events: STRIPE_EVENTS,
        webhook_endpoint: { url: args.url },
        include: ['webhook_endpoint.signing_secret'],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, error: `stripe_${res.status}` }
    const j: unknown = await res.json().catch(() => undefined)
    const we = isRecord(j) && isRecord(j.webhook_endpoint) ? j.webhook_endpoint : undefined
    const secret = we && typeof we.signing_secret === 'string' ? we.signing_secret : undefined
    return secret ? { ok: true, signingSecret: secret } : { ok: false, error: 'no_signing_secret' }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}
