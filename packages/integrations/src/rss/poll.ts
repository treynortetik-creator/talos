// RSS poller: conditional GET (ETag / Last-Modified), first poll marks everything seen (spec 7.5).
import { isBlockedHost, isBlockedHostname, normalizeHost } from '@talos-app/protocol'
import Parser from 'rss-parser'
import type { PollContext, PollResult, RawDelivery } from '../types.ts'
import { itemKey, type RssItem } from './normalize.ts'
import { assertPublicAddresses, guardedFetch } from './ssrf.ts'

const MAX_FEED_BYTES = 2_000_000
const MAX_REDIRECTS = 3
const MAX_SEEN = 1000
const EVERY_S = 1800

type Cursor = { etag?: string; lastModified?: string; seen: string[] }

/** The relay fetches a URL the owner typed. Refuse loopback, private and metadata hosts (literal IPs and obvious names). */
export function assertPublicFeedUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('feed address is not a URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('feed address must be http(s)')
  if (u.username || u.password) throw new Error('feed address must not contain credentials')
  // normalizeHost drops brackets and trailing dots, so `localhost.` and `127.0.0.1.` are judged as what they are
  const host = normalizeHost(u.hostname)
  if (isBlockedHostname(host) || isBlockedHost(host)) throw new Error('feed address points at a private host')
  return u
}

function parseCursor(c: string | null): Cursor | null {
  if (!c) return null
  try {
    const j = JSON.parse(c) as Cursor
    return Array.isArray(j.seen) ? j : null
  } catch {
    return null
  }
}

/** Production uses the guarded fetch (addresses checked at connect time). An injected fetch is a test double: resolve first. */
async function fetchFeed(ctx: PollContext, url: URL, cursor: Cursor | null): Promise<Response> {
  const doFetch = ctx.fetch === globalThis.fetch ? guardedFetch : ctx.fetch
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (ctx.resolve) {
      const host = target.hostname.replace(/^\[|\]$/g, '')
      assertPublicAddresses(await ctx.resolve(host))
    }
    const headers: Record<string, string> = {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      'user-agent': 'talos-app-rss/1',
    }
    if (cursor?.etag) headers['if-none-match'] = cursor.etag
    if (cursor?.lastModified) headers['if-modified-since'] = cursor.lastModified
    const res = await doFetch(target.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`feed redirected without a location (${res.status})`)
      target = assertPublicFeedUrl(new URL(loc, target).toString())
      continue
    }
    return res
  }
  throw new Error('feed redirected too many times')
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_FEED_BYTES) {
      await reader.cancel()
      throw new Error('feed is larger than 2 MB')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export async function pollRss(ctx: PollContext): Promise<PollResult> {
  const feedUrl = ctx.extra.feed_url
  if (!feedUrl) throw new Error('no feed address set')
  const url = assertPublicFeedUrl(feedUrl)
  const prev = parseCursor(ctx.cursor)
  const res = await fetchFeed(ctx, url, prev)
  if (res.status === 304 && prev) return { deliveries: [], cursor: ctx.cursor, nextInS: EVERY_S }
  if (!res.ok) throw new Error(`feed answered ${res.status}`)
  const xml = await readCapped(res)
  const feed = await new Parser().parseString(xml)
  const items: RssItem[] = (feed.items ?? []).slice(0, 200).map((i) => ({
    ...(i.guid ? { guid: i.guid } : {}),
    ...(i.title ? { title: i.title } : {}),
    ...(i.link ? { link: i.link } : {}),
    ...((i.contentSnippet ?? i.content) ? { summary: i.contentSnippet ?? i.content } : {}),
    ...(i.isoDate ? { isoDate: i.isoDate } : {}),
    ...((i.creator ?? i.author) ? { author: i.creator ?? i.author } : {}),
    ...(feed.title ? { feed: feed.title } : {}),
  }))
  const seen = new Set(prev?.seen ?? [])
  const keys = items.map(itemKey)
  const fresh = prev ? items.filter((_i, n) => !seen.has(keys[n] as string)) : [] // first poll marks everything seen
  const nextSeen = [...new Set([...keys, ...(prev?.seen ?? [])])].slice(0, MAX_SEEN)
  const cursor: Cursor = {
    seen: nextSeen,
    ...(res.headers.get('etag') ? { etag: res.headers.get('etag') as string } : {}),
    ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified') as string } : {}),
  }
  const enc = new TextEncoder()
  const deliveries: RawDelivery[] = fresh.reverse().map((i) => ({
    headers: { 'x-talos-poll': 'rss' },
    rawBody: enc.encode(JSON.stringify(i)),
    json: i,
    receivedAt: ctx.now,
  }))
  return { deliveries, cursor: JSON.stringify(cursor), nextInS: EVERY_S }
}
