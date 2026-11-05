// Calendar batch -> events. Kinds: invite, changed, cancelled, starting. A cancelled item carries only its `event_key`
// (the script keeps no titles), so it reads "An event was cancelled"; the relay may enrich it from the last event it saw
// with the same key (spec 7.6), which a pure normalizer cannot do.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

const KEY = /^[A-Za-z0-9+/=_-]{4,40}$/

function when(iso: unknown): string {
  return typeof iso === 'string' && !Number.isNaN(Date.parse(iso))
    ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`
    : ''
}

export function normalizeGcal(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j) || !Array.isArray(j.items)) return []
  const out: NormalizedEventT[] = []
  for (const it of j.items) {
    if (!isRecord(it) || typeof it.event_key !== 'string' || !KEY.test(it.event_key)) continue
    const key = it.event_key
    const title = clean(it.title, 160) || '(no title)'
    const at = when(it.start)
    const where = clean(it.location, 100)
    const detail = `${at}${where ? ` · ${where}` : ''}`
    const base = {
      actor: typeof it.organizer === 'string' && it.organizer ? { email: it.organizer } : {},
      ts: toIso(undefined, raw.receivedAt),
    }
    const ver = typeof it.version === 'string' && /^[A-Za-z0-9+/=_-]{1,20}$/.test(it.version) ? it.version : ''
    switch (it.change) {
      case 'invite':
        out.push(
          makeEvent(conn, 'gcal', {
            ...base,
            kind: 'gcal.invite',
            title: `Invite: ${title}`,
            summary: `You were invited to "${title}"${detail ? ` (${detail})` : ''}.`,
            priority: 'high',
            dedup_key: `gcal:${key}:invite`,
          }),
        )
        break
      case 'changed':
        out.push(
          makeEvent(conn, 'gcal', {
            ...base,
            kind: 'gcal.changed',
            title: `Changed: ${title}`,
            summary: `"${title}" changed${detail ? `: now ${detail}` : ''}.`,
            priority: 'normal',
            dedup_key: `gcal:${key}:changed:${ver || raw.receivedAt}`,
          }),
        )
        break
      case 'starting':
        out.push(
          makeEvent(conn, 'gcal', {
            ...base,
            kind: 'gcal.starting',
            title: `Starting soon: ${title}`,
            summary: `"${title}" starts soon${detail ? ` (${detail})` : ''}.`,
            priority: 'high',
            dedup_key: `gcal:${key}:starting`,
          }),
        )
        break
      case 'cancelled':
        out.push(
          makeEvent(conn, 'gcal', {
            ...base,
            kind: 'gcal.cancelled',
            title: it.title ? `Cancelled: ${title}` : 'An event was cancelled',
            summary: it.title ? `"${title}" was cancelled.` : 'An event on your calendar was cancelled.',
            priority: 'low',
            dedup_key: `gcal:${key}:cancelled`,
          }),
        )
        break
    }
  }
  return out
}

const KIND: Record<string, string> = {
  invites: 'gcal.invite',
  changes: 'gcal.changed',
  cancellations: 'gcal.cancelled',
  starting: 'gcal.starting',
}
export function gcalToggle(key: string, enabled: boolean, event: NormalizedEventT): boolean {
  return KIND[key] === event.kind ? enabled : true
}
