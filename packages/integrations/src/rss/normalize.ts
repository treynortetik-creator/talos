import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import { sha256Hex } from '../standard-webhooks.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

export type RssItem = {
  guid?: string
  title?: string
  link?: string
  summary?: string
  isoDate?: string
  author?: string
  feed?: string
}

/** guid, falling back to sha256(link + title) (spec 7.5). */
export function itemKey(i: Pick<RssItem, 'guid' | 'link' | 'title'>): string {
  return i.guid ? `rss:${i.guid.slice(0, 250)}` : `rss:${sha256Hex(`${i.link ?? ''}${i.title ?? ''}`)}`
}

export function normalizeRss(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j)) return []
  const i = j as RssItem
  const title = clean(i.title, 200) || '(untitled post)'
  return [
    makeEvent(conn, 'rss', {
      kind: 'rss.item',
      title,
      summary: clean(i.summary, 280) || title,
      url: i.link,
      actor: { name: clean(i.author || i.feed, 120) || undefined } as NormalizedEventT['actor'],
      ts: toIso(i.isoDate, raw.receivedAt),
      priority: 'low',
      dedup_key: itemKey(i),
    }),
  ]
}
