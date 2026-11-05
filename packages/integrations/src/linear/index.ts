// Linear (personal): `Linear-Signature` = hex HMAC-SHA256(secret, raw body); the body's `webhookTimestamp` (ms) must be
// within 60 s; dedup on `Linear-Delivery`. Webhook creation uses the owner's API key once (`webhookCreate`).
import type { NormalizedEventT } from '@talos-app/protocol'
import type { ModuleExtras } from '../generic/common.ts'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import { hmacSha256, safeEqual } from '../standard-webhooks.ts'
import type {
  IntegrationModule,
  NormalizeConnection,
  RawDelivery,
  VerifyConnection,
  VerifyRequest,
  VerifyResult,
} from '../types.ts'
import { linearSetup } from './setup.ts'

const LINEAR_WINDOW_MS = 60_000

function verify(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const sig = req.headers['linear-signature']
  const delivery = req.headers['linear-delivery']
  if (!sig || !delivery) return { ok: false, reason: 'missing_header' }
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'bad_signature_format' }
  if (conn.secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  let matched = false
  for (const s of conn.secrets) if (safeEqual(hmacSha256(s, req.rawBody).toString('hex'), sig)) matched = true
  if (!matched) return { ok: false, reason: 'signature_mismatch' }
  let ts: unknown
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(req.rawBody))
    ts = isRecord(j) ? j.webhookTimestamp : undefined
  } catch {
    /* handled below */
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'missing_timestamp' }
  if (Math.abs(req.now - ts) > LINEAR_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' }
  return { ok: true, deliveryKey: `linear:${delivery.slice(0, 128)}` }
}

function normalize(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j) || !isRecord(j.data)) return []
  const d = j.data
  const type = j.type
  const action = typeof j.action === 'string' ? j.action : 'update'
  const actor = isRecord(j.actor) && typeof j.actor.name === 'string' ? { name: j.actor.name } : {}
  const delivery = raw.headers['linear-delivery'] ?? ''
  const key = `linear:${delivery || `${type}:${clean(d.id, 60)}:${j.createdAt}`}`
  if (type === 'Issue') {
    const me = (conn.extra.user_id ?? '').trim()
    const mine = Boolean(me) && d.assigneeId === me
    const ident = clean(d.identifier, 30)
    const title = clean(d.title, 160)
    return [
      makeEvent(conn, 'linear', {
        kind: 'linear.issue',
        title: ident ? `${ident} ${title}` : title,
        summary: `${action === 'create' ? 'Issue created' : action === 'remove' ? 'Issue removed' : 'Issue updated'}: ${title}${mine ? ' (assigned to you)' : ''}`,
        url: j.url ?? d.url,
        actor,
        ts: toIso(j.createdAt, raw.receivedAt),
        priority: mine ? 'high' : 'low',
        dedup_key: key,
      }),
    ]
  }
  if (type === 'Comment' && action !== 'remove') {
    const issue = isRecord(d.issue) ? d.issue : {}
    const title = clean(issue.title, 120)
    return [
      makeEvent(conn, 'linear', {
        kind: 'linear.comment',
        title: title ? `Comment on ${title}` : 'New comment',
        summary: `${typeof actor.name === 'string' ? actor.name : 'Someone'}: ${clean(d.body, 240)}`,
        url: j.url ?? d.url,
        actor,
        ts: toIso(j.createdAt, raw.receivedAt),
        priority: 'normal',
        dedup_key: key,
      }),
    ]
  }
  return []
}

export const integration: IntegrationModule & ModuleExtras = {
  id: 'linear',
  setup: linearSetup,
  async provision({ fetch, hookUrl, secret, secrets, extra }) {
    const apiKey = secrets.api_key
    if (!apiKey) return { ok: false, error: 'api_key is missing', forget: [] }
    const r = await createLinearWebhook({
      fetch,
      apiKey,
      url: hookUrl,
      secret,
      ...(extra.team_id ? { teamId: extra.team_id } : {}),
    })
    return { ...r, forget: r.ok ? ['api_key'] : [] }
  },
  verify,
  normalize,
  toggle(key, enabled, event) {
    if (key === 'comments') return event.kind === 'linear.comment' ? enabled : true
    if (key === 'other') return event.kind === 'linear.issue' && event.priority !== 'high' ? enabled : true
    return true
  },
}

/** Creates the webhook with the owner's API key (`Authorization: <key>`, no Bearer). Never throws; no key text in errors. */
export async function createLinearWebhook(args: {
  fetch: typeof fetch
  apiKey: string
  url: string
  secret: string
  teamId?: string
}): Promise<{ ok: boolean; error?: string }> {
  const input: Record<string, unknown> = { url: args.url, resourceTypes: ['Issue', 'Comment'], secret: args.secret }
  if (args.teamId) input.teamId = args.teamId
  else input.allPublicTeams = true
  try {
    const res = await args.fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: args.apiKey },
      body: JSON.stringify({
        query: 'mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success } }',
        variables: { input },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, error: `linear_${res.status}` }
    const j: unknown = await res.json().catch(() => undefined)
    const ok =
      isRecord(j) && isRecord(j.data) && isRecord(j.data.webhookCreate) && j.data.webhookCreate.success === true
    return ok ? { ok: true } : { ok: false, error: 'linear_rejected' }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}
