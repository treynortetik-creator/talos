// Gmail batch normalizer: one POST from the Apps Script yields one event per message (spec 7.3, 7.6).
import type { IntegrationIdT, NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseAddress, parseJson, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

const LOW_LABELS = /^(CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)|Promotions|Social|Updates|Forums|SPAM)$/i

export function vipSet(extra: Record<string, string>): Set<string> {
  return new Set(
    (extra.vips ?? '')
      .split(/[,\s;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Whether an event came from a VIP (set from the connection's `vips` list); used by the toggle and the priority. */
export function isVip(event: NormalizedEventT, extra: Record<string, string>): boolean {
  const email = event.actor.email?.toLowerCase()
  return Boolean(email && vipSet(extra).has(email))
}

export function normalizeGmail(
  source: IntegrationIdT,
  raw: RawDelivery,
  conn: NormalizeConnection,
): NormalizedEventT[] {
  const json = parseJson(raw)
  if (!isRecord(json) || !Array.isArray(json.items)) return []
  const out: NormalizedEventT[] = []
  for (const it of json.items) {
    if (!isRecord(it) || typeof it.message_id !== 'string' || !it.message_id) continue
    const forwarded = it.forwarded === true
    const labels = Array.isArray(it.labels) ? it.labels.filter((l): l is string => typeof l === 'string') : []
    const from = parseAddress(typeof it.from === 'string' ? it.from : '')
    const subject = clean(it.subject, 200) || '(no subject)'
    const text = clean(it.text, 4000)
    const who = from.name ?? from.email ?? 'Someone'
    const probe = { actor: from } as NormalizedEventT
    const vip = isVip(probe, conn.extra)
    const low = labels.some((l) => LOW_LABELS.test(l))
    out.push(
      makeEvent(conn, source, {
        kind: forwarded ? 'email.forwarded' : 'gmail.message',
        title: subject,
        summary: text ? `${who}: ${text}` : `${who} sent a message`,
        url: it.link,
        actor: from,
        ts: toIso(it.date, raw.receivedAt),
        priority: forwarded || vip ? 'high' : low ? 'low' : 'normal',
        dedup_key: `gmail:${it.message_id}`,
      }),
    )
  }
  if (json.truncated === true) {
    const hour = Math.floor(raw.receivedAt / 3_600_000)
    out.push(
      makeEvent(conn, source, {
        kind: 'generic.event',
        title: 'Some mail was skipped',
        summary: 'More than 200 threads arrived at once. The newest were kept; older ones were skipped.',
        ts: new Date(raw.receivedAt).toISOString(),
        priority: 'low',
        dedup_key: `gmail:truncated:${hour}`,
      }),
    )
  }
  return out
}

/**
 * Toggle semantics for the three Gmail filters (spec 7.3 defaults). The relay puts every toggle's state into
 * `conn.extra['filter:<key>']` ('1' or '0'), so one key can look at another.
 */
export function gmailToggle(
  key: string,
  enabled: boolean,
  event: NormalizedEventT,
  conn: NormalizeConnection,
): boolean {
  if (event.kind === 'generic.event') return true // system notices are never filtered
  const forwarded = event.kind === 'email.forwarded'
  if (key === 'forwarded') return forwarded ? enabled : true
  if (forwarded) return true
  if (key === 'primary') {
    const vipsOn = conn.extra['filter:vips'] !== '0'
    return enabled || (vipsOn && isVip(event, conn.extra))
  }
  return true
}
