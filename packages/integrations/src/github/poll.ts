// GitHub notifications poller (spec 7.5): classic PAT with `notifications`, honours X-Poll-Interval, sends
// If-Modified-Since so an unchanged poll is a free 304.
import type { PollContext, PollResult, RawDelivery } from '../types.ts'

const API = 'https://api.github.com/notifications'
const MIN_INTERVAL_S = 60
const SINCE_OVERLAP_MS = 5 * 60_000 // event dedup (id:updated_at) absorbs the overlap

/** `before`/`top` while a backlog longer than MAX_PAGES is read back, poll by poll: `before` is where the next poll goes on
 * from (the oldest time read so far, plus a second), `top` the newest time of the first of those polls (epoch ms). */
type Cursor = { lastModified?: string; since: string; before?: string; top?: number }

function intervalOf(res: Response): number {
  const n = Number(res.headers.get('x-poll-interval'))
  return Number.isFinite(n) && n >= MIN_INTERVAL_S ? Math.floor(n) : MIN_INTERVAL_S
}

function parseCursor(c: string | null): Cursor | null {
  if (!c) return null
  try {
    const j = JSON.parse(c) as Cursor
    return typeof j.since === 'string' ? j : null
  } catch {
    return null
  }
}

export async function pollGithub(ctx: PollContext): Promise<PollResult> {
  const token = ctx.secrets.token
  if (!token) throw new Error('no token set')
  const prev = parseCursor(ctx.cursor)
  // First poll: only the last hour, so connecting does not replay a backlog of old unread notifications.
  const since = prev?.since ?? new Date(ctx.now - 3_600_000).toISOString()
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'talos-app-github/1',
  }
  const backlog = prev?.before !== undefined && Number.isFinite(Date.parse(prev.before)) ? prev.before : null
  if (prev?.lastModified && !backlog) headers['if-modified-since'] = prev.lastModified
  const url = `${API}?per_page=50&since=${encodeURIComponent(since)}${backlog ? `&before=${encodeURIComponent(backlog)}` : ''}`
  const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  const nextInS = intervalOf(res)
  if (res.status === 304) return { deliveries: [], cursor: ctx.cursor, nextInS }
  if (res.status === 401 || res.status === 403) throw new Error(`GitHub answered ${res.status}`)
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const first: unknown = await res.json()
  if (!Array.isArray(first)) throw new Error('GitHub answered with something unexpected')
  // More than one page since the last poll (RELAY-7): every page is read before the cursor moves, or the older ones would be
  // skipped for good. At most MAX_PAGES; a longer backlog keeps the cursor (and drops Last-Modified, so the next poll is no
  // free 304) and says it was cut short. A next link is followed only to GitHub's own notifications endpoint.
  const body: unknown[] = [...first]
  const pageHeaders: Record<string, string> = { ...headers }
  delete pageHeaders['if-modified-since']
  let next = nextLink(res)
  let pages = 1
  let capped = false
  while (next) {
    if (pages >= MAX_PAGES) {
      capped = true
      break
    }
    const r = await ctx.fetch(next, { headers: pageHeaders, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
    const more: unknown = await r.json()
    if (!Array.isArray(more)) throw new Error('GitHub answered with something unexpected')
    body.push(...more)
    pages++
    next = nextLink(r)
  }
  const enc = new TextEncoder()
  const deliveries: RawDelivery[] = body.map((n) => ({
    headers: { 'x-talos-poll': 'github' },
    rawBody: enc.encode(JSON.stringify(n)),
    json: n,
    receivedAt: ctx.now,
  }))
  const times = body
    .map((n) => Date.parse((n as { updated_at?: string }).updated_at ?? ''))
    .filter((t) => Number.isFinite(t))
  // newest updated_at read (or the request time), never in the future
  let newest = times.length > 0 ? Math.min(Math.max(...times), ctx.now) : ctx.now
  if (backlog && prev?.top !== undefined && Number.isFinite(prev.top)) newest = Math.max(newest, prev.top)
  if (capped) {
    // More than MAX_PAGES (Opus review on 924d204f): the next poll reads on from the oldest time read (a second later, so a
    // notification on the boundary is read twice, never skipped; event dedup absorbs it), until it reaches `since`. A poll
    // that got no further back (all one second, or a page that repeats) gives up the rest and says so.
    const oldest = times.length > 0 ? Math.min(...times) : Number.NaN
    const before = oldest + 1000
    if (Number.isFinite(oldest) && (!backlog || before < Date.parse(backlog)))
      return {
        deliveries,
        cursor: JSON.stringify({ since, before: new Date(before).toISOString(), top: newest } satisfies Cursor),
        nextInS,
        truncated: false,
      }
    const gaveUp: Cursor = { since: new Date(Math.max(newest - SINCE_OVERLAP_MS, Date.parse(since))).toISOString() }
    return { deliveries, cursor: JSON.stringify(gaveUp), nextInS, truncated: true }
  }
  // Every page read: the cursor moves forward to the newest over all of them (and over a backlog's first poll), minus a small
  // overlap; never backward. After a backlog no Last-Modified is kept: the next poll is a full one.
  const lastModified = backlog ? undefined : (res.headers.get('last-modified') ?? prev?.lastModified)
  const nextSince = new Date(Math.max(newest - SINCE_OVERLAP_MS, Date.parse(since))).toISOString()
  const cursor: Cursor = { since: nextSince, ...(lastModified ? { lastModified } : {}) }
  return { deliveries, cursor: JSON.stringify(cursor), nextInS, truncated: false }
}

const MAX_PAGES = 10

/** The rel="next" URL of a Link header, only when it is GitHub's own notifications endpoint over https; else null. */
function nextLink(res: Response): string | null {
  const link = res.headers.get('link') ?? ''
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  if (!m?.[1]) return null
  try {
    const u = new URL(m[1])
    return u.protocol === 'https:' && u.host === 'api.github.com' && u.pathname === '/notifications' && !u.username
      ? u.toString()
      : null
  } catch {
    return null
  }
}
