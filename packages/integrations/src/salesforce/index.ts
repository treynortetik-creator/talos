// Salesforce (work): Flow outbound message (SOAP) to /hook/salesforce/<id>. An outbound message cannot carry a signature
// or a header, so the checks are the unguessable connection id in the URL plus `OrganizationId` equal to the configured org.
import type { ModuleExtras } from '../generic/common.ts'
import { clean, makeEvent, toIso } from '../generic/common.ts'
import { safeEqual } from '../standard-webhooks.ts'
import type {
  IntegrationModule,
  NormalizeConnection,
  RawDelivery,
  VerifyConnection,
  VerifyRequest,
  VerifyResult,
} from '../types.ts'
import { salesforceSetup } from './setup.ts'
import { parseSoap, SOAP_ACK } from './soap.ts'

const same15 = (a: string, b: string) => a.length >= 15 && b.length >= 15 && safeEqual(a.slice(0, 15), b.slice(0, 15))

function verify(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const want = (conn.extra.org_id ?? '').trim()
  if (!want) return { ok: false, reason: 'org_id_not_configured' }
  const msg = parseSoap(req.rawBody)
  if (!msg) return { ok: false, reason: 'bad_soap' }
  if (!same15(msg.organizationId, want)) return { ok: false, reason: 'org_mismatch' }
  const ids = msg.notifications.map((n) => n.id).filter(Boolean)
  return { ok: true, ...(ids.length ? { deliveryKey: `sf:${ids.join(',').slice(0, 200)}` } : {}) }
}

const TITLE_FIELDS = ['Name', 'Subject', 'Title', 'CaseNumber']
const SUMMARY_FIELDS = ['StageName', 'Status', 'Priority', 'Amount', 'Description']

function normalize(raw: RawDelivery, conn: NormalizeConnection): ReturnType<IntegrationModule['normalize']> {
  const msg = parseSoap(raw.rawBody)
  if (!msg) return []
  return msg.notifications.map((n) => {
    const name = TITLE_FIELDS.map((k) => n.fields[k]).find(Boolean) ?? ''
    const bits = SUMMARY_FIELDS.filter((k) => n.fields[k]).map((k) => `${k}: ${clean(n.fields[k], 80)}`)
    const type = clean(n.objectType, 60) || 'Record'
    return makeEvent(conn, 'salesforce', {
      kind: 'salesforce.notification',
      title: name ? `${type}: ${name}` : `${type} update`,
      summary: bits.length ? bits.join(' · ') : `${type} notification`,
      ts: toIso(undefined, raw.receivedAt),
      priority: 'low',
      dedup_key: `salesforce:${n.id || `${type}:${name}:${raw.receivedAt}`}`,
    })
  })
}

export const integration: IntegrationModule & ModuleExtras = {
  id: 'salesforce',
  setup: salesforceSetup,
  verify,
  normalize,
  // Spec 7.1 step 2: the right org and at least one notification.
  prefilter: (raw, conn) => {
    const msg = parseSoap(raw.rawBody)
    const want = (conn.extra.org_id ?? '').trim()
    return !!msg && msg.notifications.length > 0 && !!want && same15(msg.organizationId, want)
  },
  ack: () => ({ contentType: 'text/xml; charset=utf-8', body: SOAP_ACK }),
  toggle: (key, enabled, event) =>
    key === 'notifications' && event.kind === 'salesforce.notification' ? enabled : true,
}
