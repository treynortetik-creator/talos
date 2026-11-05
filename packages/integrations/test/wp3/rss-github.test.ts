import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { assertPublicFeedUrl, getIntegration, moduleExtras } from '../../src/index.ts'
import type { PollContext } from '../../src/types.ts'
import { conn, fixture, NOW, raw, stable } from './helpers.ts'

type Reply = { status?: number; body?: string; headers?: Record<string, string> }
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    const r = replies.shift() ?? { status: 500 }
    return new Response(r.status === 304 ? null : (r.body ?? ''), { status: r.status ?? 200, headers: r.headers ?? {} })
  }) as typeof fetch
  return { f, calls }
}
const ctx = (over: Partial<PollContext>): PollContext => ({
  cursor: null,
  secrets: {},
  extra: {},
  now: NOW,
  fetch,
  ...over,
})

describe('rss poller', () => {
  const rss = getIntegration('rss')
  const feed = fixture('rss/fixtures/feed.xml')
  const feedNew = fixture('rss/fixtures/feed-new.xml')
  const extra = { feed_url: 'https://example.com/feed.xml' }

  it('the first poll marks everything seen and delivers nothing', async () => {
    const { f } = fakeFetch([{ body: feed, headers: { etag: '"v1"' } }])
    const res = await rss.poll?.(ctx({ extra, fetch: f }))
    expect(res?.deliveries).toEqual([])
    expect(res?.nextInS).toBe(1800)
    expect(JSON.parse(res?.cursor ?? '{}').seen).toHaveLength(2)
  })

  it('later polls deliver only new items, oldest first, using the guid or link+title hash', async () => {
    const first = fakeFetch([
      { body: feed, headers: { etag: '"v1"', 'last-modified': 'Wed, 28 Oct 2026 12:00:00 GMT' } },
    ])
    const c1 = (await rss.poll?.(ctx({ extra, fetch: first.f })))?.cursor ?? null
    const second = fakeFetch([{ body: feedNew }])
    const res = await rss.poll?.(ctx({ extra, cursor: c1, fetch: second.f }))
    expect(second.calls[0]?.headers['if-none-match']).toBe('"v1"')
    expect(second.calls[0]?.headers['if-modified-since']).toBe('Wed, 28 Oct 2026 12:00:00 GMT')
    expect(res?.deliveries).toHaveLength(1)
    const events = await rss.normalize(res?.deliveries[0] ?? raw('{}'), conn({ integration: 'rss' }))
    expect(stable(events)).toMatchSnapshot()
    expect(NormalizedEvent.safeParse(events[0]).success).toBe(true)
    expect(events[0]?.dedup_key).toMatch(/^rss:[0-9a-f]{64}$/) // no guid -> sha256(link + title)
  })

  it('a 304 changes nothing', async () => {
    const first = fakeFetch([{ body: feed }])
    const c1 = (await rss.poll?.(ctx({ extra, fetch: first.f })))?.cursor ?? null
    const res = await rss.poll?.(ctx({ extra, cursor: c1, fetch: fakeFetch([{ status: 304 }]).f }))
    expect(res).toMatchObject({ deliveries: [], cursor: c1 })
  })

  it('fails loudly on HTTP errors, junk and oversized feeds', async () => {
    await expect(rss.poll?.(ctx({ extra, fetch: fakeFetch([{ status: 503 }]).f }))).rejects.toThrow(/503/)
    await expect(rss.poll?.(ctx({ extra, fetch: fakeFetch([{ body: 'not xml' }]).f }))).rejects.toThrow()
    await expect(rss.poll?.(ctx({ extra, fetch: fakeFetch([{ body: 'x'.repeat(2_100_000) }]).f }))).rejects.toThrow(
      /2 MB/,
    )
    await expect(rss.poll?.(ctx({ extra: {}, fetch: fakeFetch([]).f }))).rejects.toThrow(/no feed/)
  })

  it('will not fetch private or loopback addresses, directly or through a redirect', async () => {
    for (const u of [
      'http://localhost/feed',
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest',
      'http://10.0.0.5/f',
      'http://[::1]/f',
      'http://intranet/f',
      'ftp://example.com/f',
      'https://user:pw@example.com/f',
    ])
      expect(() => assertPublicFeedUrl(u), u).toThrow()
    expect(assertPublicFeedUrl('https://example.com/feed.xml').hostname).toBe('example.com')
    const { f } = fakeFetch([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }])
    await expect(rss.poll?.(ctx({ extra, fetch: f }))).rejects.toThrow(/private/)
  })

  it('never accepts a POST', async () => {
    expect(
      await rss.verify({ headers: {}, rawBody: new Uint8Array(), url: 'x', now: NOW }, { secrets: [], extra: {} }),
    ).toEqual({ ok: false, reason: 'poll_only' })
  })
})

describe('github notifications poller', () => {
  const gh = getIntegration('github')
  const list = fixture('github/fixtures/notifications.json')
  const secrets = { token: 'ghp_exampletoken0000000000000000000000' }

  it('sends the token and conditional headers, and keeps Last-Modified', async () => {
    const { f, calls } = fakeFetch([
      { body: list, headers: { 'last-modified': 'Wed, 28 Oct 2026 14:53:00 GMT', 'x-poll-interval': '60' } },
      { status: 304, headers: { 'x-poll-interval': '120' } },
    ])
    const a = await gh.poll?.(ctx({ secrets, fetch: f }))
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${secrets.token}`)
    expect(a?.deliveries).toHaveLength(4)
    expect(calls[0]?.url).toContain('since=2026-10-28T14%3A00%3A00.000Z') // first poll: last hour only
    const b = await gh.poll?.(ctx({ secrets, cursor: a?.cursor ?? null, fetch: f }))
    expect(calls[1]?.headers['if-modified-since']).toBe('Wed, 28 Oct 2026 14:53:00 GMT')
    expect(b?.deliveries).toEqual([])
    expect(b?.cursor).toBe(a?.cursor)
  })

  it('a 304 is free and X-Poll-Interval is honoured (never below 60 s)', async () => {
    const hi = await gh.poll?.(
      ctx({ secrets, fetch: fakeFetch([{ status: 304, headers: { 'x-poll-interval': '300' } }]).f }),
    )
    const lo = await gh.poll?.(
      ctx({ secrets, fetch: fakeFetch([{ status: 304, headers: { 'x-poll-interval': '5' } }]).f }),
    )
    const none = await gh.poll?.(ctx({ secrets, fetch: fakeFetch([{ status: 304 }]).f }))
    expect(hi?.nextInS).toBe(300)
    expect(lo?.nextInS).toBe(60)
    expect(none?.nextInS).toBe(60)
  })

  it('errors name the status but never the token', async () => {
    await expect(gh.poll?.(ctx({ secrets, fetch: fakeFetch([{ status: 401 }]).f }))).rejects.toThrow(
      'GitHub answered 401',
    )
    await expect(gh.poll?.(ctx({ secrets: {}, fetch: fakeFetch([]).f }))).rejects.toThrow(/no token/)
  })

  it('reports a truncated page', async () => {
    const res = await gh.poll?.(
      ctx({
        secrets,
        fetch: fakeFetch([
          { body: '[]', headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' } },
        ]).f,
      }),
    )
    expect(res?.truncated).toBe(true)
  })

  it('normalizes the fixture: kinds, priorities, html urls, and no javascript: urls', async () => {
    const events = (
      await Promise.all(
        (JSON.parse(list) as unknown[]).map((n) =>
          gh.normalize(raw(JSON.stringify(n), { 'x-talos-poll': 'github' }), conn({ integration: 'github' })),
        ),
      )
    ).flat()
    expect(stable(events)).toMatchSnapshot()
    for (const e of events) expect(NormalizedEvent.safeParse(e).success).toBe(true)
    expect(events.map((e) => e.kind)).toEqual([
      'github.review_requested',
      'github.mention',
      'github.ci_failed',
      'github.event',
    ])
    expect(events[0]?.url).toBe('https://github.com/example-org/example-repo/pull/41')
    expect(events[3]?.url).toBeUndefined()
  })

  it('toggles keep mentions, review requests and failed CI by default, and drop the rest', async () => {
    const toggle = moduleExtras(gh).toggle
    const events = (
      await Promise.all(
        (JSON.parse(list) as unknown[]).map((n) =>
          gh.normalize(raw(JSON.stringify(n), { 'x-talos-poll': 'github' }), conn({ integration: 'github' })),
        ),
      )
    ).flat()
    const defaults = Object.fromEntries(gh.setup.filters.map((f) => [f.key, f.default]))
    const kept = events
      .filter((e) => Object.entries(defaults).every(([k, v]) => toggle?.(k, v, e, conn())))
      .map((e) => e.kind)
    expect(kept).toEqual(['github.review_requested', 'github.mention', 'github.ci_failed'])
  })

  it('webhook deliveries go to webhooks.ts (WP3b): unsigned ones are rejected', async () => {
    const res = await gh.verify(
      { headers: { 'x-github-event': 'push' }, rawBody: new Uint8Array(), url: 'x', now: NOW },
      { secrets: ['s'], extra: {} },
    )
    expect(res).toEqual({ ok: false, reason: 'missing_header' })
    expect(
      await gh.verify({ headers: {}, rawBody: new Uint8Array(), url: 'x', now: NOW }, { secrets: ['s'], extra: {} }),
    ).toEqual({ ok: false, reason: 'poll_only' })
  })
})
