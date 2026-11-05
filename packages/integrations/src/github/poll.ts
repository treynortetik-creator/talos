// GitHub notifications poller (spec 7.5): classic PAT with `notifications`, honours X-Poll-Interval, sends
// If-Modified-Since so an unchanged poll is a free 304.
import type { PollContext, PollResult, RawDelivery } from '../types.ts'

const API = 'https://api.github.com/notifications'
const MIN_INTERVAL_S = 60
const SINCE_OVERLAP_MS = 5 * 60_000 // event dedup (id:updated_at) absorbs the overlap

type Cursor = { lastModified?: string; since: string }

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
  if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified
  const url = `${API}?per_page=50&since=${encodeURIComponent(since)}`
  const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  const nextInS = intervalOf(res)
  if (res.status === 304) return { deliveries: [], cursor: ctx.cursor, nextInS }
  if (res.status === 401 || res.status === 403) throw new Error(`GitHub answered ${res.status}`)
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body: unknown = await res.json()
  if (!Array.isArray(body)) throw new Error('GitHub answered with something unexpected')
  const enc = new TextEncoder()
  const deliveries: RawDelivery[] = body.map((n) => ({
    headers: { 'x-talos-poll': 'github' },
    rawBody: enc.encode(JSON.stringify(n)),
    json: n,
    receivedAt: ctx.now,
  }))
  const lastModified = res.headers.get('last-modified') ?? prev?.lastModified
  // Move the cursor forward: newest updated_at in this page (or the request time), minus a small overlap. Never backward.
  let newest = ctx.now
  if (body.length > 0) {
    const times = body
      .map((n) => Date.parse((n as { updated_at?: string }).updated_at ?? ''))
      .filter((t) => Number.isFinite(t))
    if (times.length > 0) newest = Math.min(Math.max(...times), ctx.now)
  }
  const nextSince = new Date(Math.max(newest - SINCE_OVERLAP_MS, Date.parse(since))).toISOString()
  const cursor: Cursor = { since: nextSince, ...(lastModified ? { lastModified } : {}) }
  return {
    deliveries,
    cursor: JSON.stringify(cursor),
    nextInS,
    truncated: /rel="next"/.test(res.headers.get('link') ?? ''),
  }
}
