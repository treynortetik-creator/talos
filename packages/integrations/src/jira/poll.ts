// Jira poller (spec 7.5): the owner's own API token, no admin needed. `GET https://<site>/_edge/tenant_info` -> cloudId,
// then the API gateway `https://api.atlassian.com/ex/jira/<cloudId>` with Basic auth `email:token`:
//   GET  /rest/api/3/myself
//   POST /rest/api/3/search/jql   (enhanced search; `nextPageToken` paging, `expand: "changelog"`)
// The JQL window is relative (`updated >= -Nm`), so no timezone is involved. The first poll only records the cursor.
import type { PollContext, PollResult, RawDelivery } from '../types.ts'

const GATEWAY = 'https://api.atlassian.com/ex/jira'
export const POLL_EVERY_S = 180
const OVERLAP_MS = 5 * 60_000
const PAGE = 50
const MAX_PAGES = 3
const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'issuetype', 'priority', 'updated', 'created', 'comment']

type Cursor = { since: number; cloudId: string; me: string }

export function validSite(site: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,60}\.atlassian\.net$/.test(site)
}

function parseCursor(c: string | null): Cursor | null {
  if (!c) return null
  try {
    const j = JSON.parse(c) as Partial<Cursor>
    return typeof j.since === 'number' && typeof j.cloudId === 'string' && typeof j.me === 'string'
      ? (j as Cursor)
      : null
  } catch {
    return null
  }
}

export function jqlFor(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((nowMs - sinceMs + OVERLAP_MS) / 60_000))
  return `(assignee = currentUser() OR watcher = currentUser()) AND updated >= -${minutes}m ORDER BY updated ASC`
}

export async function pollJira(ctx: PollContext): Promise<PollResult> {
  const site = (ctx.extra.site ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
  const email = (ctx.extra.email ?? '').trim()
  const token = ctx.secrets.token
  if (!validSite(site)) throw new Error('site must look like yourteam.atlassian.net')
  if (!email || !token) throw new Error('email or token missing')
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
  const headers = { authorization: auth, accept: 'application/json', 'user-agent': 'talos-app-jira/1' }
  const get = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    if (res.status === 401 || res.status === 403) throw new Error(`Jira answered ${res.status}`)
    if (!res.ok) throw new Error(`Jira answered ${res.status}`)
    return (await res.json()) as T
  }

  let cur = parseCursor(ctx.cursor)
  if (!cur) {
    // First poll: prove the credentials, learn the ids, and start from now (no backlog).
    const t = await get<{ cloudId?: string }>(`https://${site}/_edge/tenant_info`, {
      headers: { accept: 'application/json' },
    })
    if (typeof t.cloudId !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(t.cloudId))
      throw new Error('could not find the Jira site')
    const me = await get<{ accountId?: string }>(`${GATEWAY}/${t.cloudId}/rest/api/3/myself`, { headers })
    if (typeof me.accountId !== 'string') throw new Error('could not read your Jira account')
    cur = { since: ctx.now, cloudId: t.cloudId, me: me.accountId }
    return { deliveries: [], cursor: JSON.stringify(cur), nextInS: POLL_EVERY_S }
  }

  const deliveries: RawDelivery[] = []
  const enc = new TextEncoder()
  let newest = cur.since
  let pageToken: string | undefined
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      jql: jqlFor(cur.since, ctx.now),
      fields: FIELDS,
      expand: 'changelog',
      maxResults: PAGE,
    }
    if (pageToken) body.nextPageToken = pageToken
    const r = await get<{ issues?: unknown[]; nextPageToken?: string }>(
      `${GATEWAY}/${cur.cloudId}/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    for (const issue of r.issues ?? []) {
      const payload = { talos: { source: 'poll', site, me: cur.me, since: cur.since - OVERLAP_MS }, issue }
      const upd = Date.parse((issue as { fields?: { updated?: string } }).fields?.updated ?? '')
      if (Number.isFinite(upd) && upd > newest) newest = Math.min(upd, ctx.now)
      deliveries.push({
        headers: { 'x-talos-poll': 'jira' },
        rawBody: enc.encode(JSON.stringify(payload)),
        json: payload,
        receivedAt: ctx.now,
      })
    }
    pageToken = r.nextPageToken
    if (!pageToken) break
    if (page === MAX_PAGES - 1) truncated = true
  }
  // The window keeps a 5 minute overlap (event dedup absorbs it); the cursor never moves backward.
  return {
    deliveries,
    cursor: JSON.stringify({ ...cur, since: Math.max(cur.since, newest) } satisfies Cursor),
    nextInS: POLL_EVERY_S,
    ...(truncated ? { truncated } : {}),
  }
}
