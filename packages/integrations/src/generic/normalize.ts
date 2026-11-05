// `generic` normalizer (spec 7.3): use title/summary/url as-is, otherwise the JSON pointers the wizard's "map fields"
// step stored in the connection (`map_title`, `map_summary`, `map_url`).
import type { IntegrationIdT, NormalizedEventT } from '@talos-app/protocol'
import { sha256Hex } from '../standard-webhooks.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { clean, decodeText, getPointer, isRecord, makeEvent, parseJson, toIso } from './common.ts'

const PRIORITIES = new Set(['high', 'normal', 'low'])

function text(v: unknown, max: number): string {
  if (typeof v === 'string') return clean(v, max)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isRecord(v) || Array.isArray(v)) return clean(JSON.stringify(v), max)
  return ''
}

function pick(j: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (j[k] !== undefined && j[k] !== null && j[k] !== '') return j[k]
  return undefined
}

function actorOf(j: Record<string, unknown>): NormalizedEventT['actor'] {
  const a = pick(j, ['actor', 'from', 'sender', 'user'])
  if (typeof a === 'string') return { name: clean(a, 120) }
  if (isRecord(a)) {
    const out: NormalizedEventT['actor'] = {}
    if (typeof a.name === 'string') out.name = clean(a.name, 120)
    if (typeof a.id === 'string' || typeof a.id === 'number') out.id = clean(a.id, 120)
    if (typeof a.email === 'string') out.email = clean(a.email, 200)
    return out
  }
  return {}
}

export function genericDedupKey(raw: RawDelivery): string {
  const h = raw.headers
  const id = h['webhook-id'] ?? h['idempotency-key']
  return id ? `id:${id.slice(0, 200)}` : `body:${sha256Hex(raw.rawBody)}`
}

export function normalizeGeneric(
  source: IntegrationIdT,
  raw: RawDelivery,
  conn: NormalizeConnection,
): NormalizedEventT[] {
  const json = parseJson(raw)
  const ts = (v: unknown) => toIso(v, raw.receivedAt)
  const key = `${source}:${genericDedupKey(raw)}`
  if (!isRecord(json)) {
    const body = json === undefined ? decodeText(raw.rawBody) : text(json, 280)
    return [
      makeEvent(conn, source, {
        kind: 'generic.event',
        title: 'Webhook received',
        summary: clean(body, 280) || 'Empty webhook body',
        ts: ts(undefined),
        priority: 'low',
        dedup_key: key,
      }),
    ]
  }
  const ptr = (name: string): unknown => {
    const p = conn.extra[name]
    return p ? getPointer(json, p) : undefined
  }
  const rawTitle = ptr('map_title') ?? pick(json, ['title', 'subject', 'name', 'event'])
  const rawSummary = ptr('map_summary') ?? pick(json, ['summary', 'message', 'text', 'body', 'description'])
  const rawUrl = ptr('map_url') ?? pick(json, ['url', 'link', 'html_url'])
  const summary = text(rawSummary, 280)
  const title = text(rawTitle, 200) || clean(summary, 80) || 'Webhook received'
  const pr = typeof json.priority === 'string' ? json.priority.toLowerCase() : ''
  return [
    makeEvent(conn, source, {
      kind: 'generic.event',
      title,
      summary: summary || title,
      url: rawUrl,
      actor: actorOf(json),
      ts: ts(pick(json, ['ts', 'timestamp', 'time', 'created_at', 'date'])),
      priority: PRIORITIES.has(pr) ? (pr as NormalizedEventT['priority']) : 'low',
      dedup_key: key,
    }),
  ]
}
