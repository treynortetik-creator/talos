import corpus from '@talos-app/protocol/fixtures/address-corpus.json' with { type: 'json' }
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

// every address any caller must refuse, as a host in a URL (a zone id cannot sit in a URL host)
const everyBlocked = [...corpus.core, ...corpus.embedded, ...corpus.alsoBlocked.filter((a) => !a.includes('%'))]

const TOKEN = 'ghp_exampletoken0000000000000000000000'
const notif = (id: string, reason: string, title: string, updated = '2026-10-28T14:55:00Z') => ({
  id,
  unread: true,
  reason,
  updated_at: updated,
  subject: { title, url: 'https://api.github.com/repos/example-org/example-repo/pulls/41', type: 'PullRequest' },
  repository: { full_name: 'example-org/example-repo', html_url: 'https://github.com/example-org/example-repo' },
})

type Reply = { status?: number; body?: string; headers?: Record<string, string> }
function scripted(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    const r = replies.shift() ?? { status: 500 }
    return new Response(r.status === 304 ? null : (r.body ?? '[]'), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    })
  }) as typeof fetch
  return { f, calls }
}

async function githubConn(s: ReturnType<typeof setup>) {
  const c = await s.create('github')
  // credentials route does the first poll; give the scripted fetch an empty answer for it
  await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: { token: TOKEN } })
  return c
}

describe('github notification poller in the relay', () => {
  it('polls on the tick, turns notifications into events, and stores each once', async () => {
    const fx = scripted([
      { body: '[]', headers: { 'x-poll-interval': '60' } }, // credentials check
      {
        body: JSON.stringify([
          notif('1', 'review_requested', 'Fix backoff'),
          notif('2', 'mention', 'Look at this'),
          notif('3', 'subscribed', 'chatter'),
        ]),
        headers: { 'x-poll-interval': '60', 'last-modified': 'Wed, 28 Oct 2026 14:55:00 GMT' },
      },
      { body: JSON.stringify([notif('1', 'review_requested', 'Fix backoff')]), headers: { 'x-poll-interval': '60' } }, // same item again
    ])
    const s = setup({ fetch: fx.f, random: () => 0 })
    const c = await githubConn(s)
    s.f.clock.advance(61_000)
    await s.tick()
    const events = s.eventBodies()
    expect(events.map((e) => e.kind)).toEqual(['github.review_requested', 'github.mention']) // "everything else" is off by default
    expect(events[0].url).toBe('https://github.com/example-org/example-repo/pull/41')
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(2)
    expect(s.f.push.intents).toHaveLength(1) // one push per batch
    s.f.clock.advance(61_000)
    await s.tick()
    expect(s.events()).toHaveLength(2) // the repeat was deduped
    const got = (await (await s.api('GET', `/api/connections/${c.id}`)).json()) as {
      received_24h: number
      kept_24h: number
    }
    expect(got).toMatchObject({ received_24h: 4, kept_24h: 2 })
  })

  it('a 304 costs nothing and X-Poll-Interval sets the next poll', async () => {
    const fx = scripted([
      { body: '[]', headers: { 'x-poll-interval': '300' } },
      { status: 304, headers: { 'x-poll-interval': '300' } },
      { status: 304, headers: { 'x-poll-interval': '300' } },
    ])
    const s = setup({ fetch: fx.f, random: () => 0 })
    await githubConn(s)
    s.f.clock.advance(301_000)
    await s.tick()
    expect(fx.calls).toHaveLength(2)
    expect(fx.calls[1]?.headers['if-modified-since']).toBeUndefined() // nothing returned Last-Modified yet
    s.f.clock.advance(299_000)
    await s.tick()
    expect(fx.calls).toHaveLength(2) // not due yet
    s.f.clock.advance(2_000)
    await s.tick()
    expect(fx.calls).toHaveLength(3)
    expect(s.events()).toHaveLength(0)
    expect(s.count('hooks_deliveries')).toBe(0) // quiet polls leave no trace
  })

  it('jitters the schedule but never earlier than asked', async () => {
    const fx = scripted([
      { body: '[]', headers: { 'x-poll-interval': '60' } },
      { body: '[]', headers: { 'x-poll-interval': '60' } },
    ])
    const s = setup({ fetch: fx.f, random: () => 0.99 })
    await githubConn(s)
    const next = (s.f.db.prepare('select next_at from hooks_poll_state').get() as { next_at: number }).next_at
    expect(next - s.f.clock.now()).toBeGreaterThanOrEqual(60_000)
    expect(next - s.f.clock.now()).toBeLessThanOrEqual(72_100)
  })

  it('ten failures in a row pause the connection and leave a system item', async () => {
    const fx = scripted([{ body: '[]' }, ...Array.from({ length: 20 }, () => ({ status: 401 }))])
    const s = setup({ fetch: fx.f, random: () => 0 })
    const c = await githubConn(s)
    for (let i = 0; i < 12; i++) {
      s.f.clock.advance(2 * 3600_000) // always past the backoff
      await s.tick()
    }
    const got = (await (await s.api('GET', `/api/connections/${c.id}`)).json()) as { status: string }
    expect(got.status).toBe('paused')
    const items = s.eventBodies()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'generic.event', title: 'GitHub polling paused', priority: 'high' })
    expect(items[0].summary).toBe('GitHub polling paused: GitHub answered 401. Re-paste the token.')
    expect(JSON.stringify(s.f.logs)).not.toContain(TOKEN)
    const calls = fx.calls.length
    s.f.clock.advance(2 * 3600_000)
    await s.tick()
    expect(fx.calls).toHaveLength(calls) // paused: no more polls
  })

  it('resuming a paused connection polls again soon', async () => {
    const fx = scripted([{ body: '[]' }, { body: '[]' }])
    const s = setup({ fetch: fx.f, random: () => 0 })
    const c = await githubConn(s)
    await s.api('PATCH', `/api/connections/${c.id}`, { status: 'paused' })
    await s.api('PATCH', `/api/connections/${c.id}`, { status: 'active' })
    await s.tick()
    expect(fx.calls).toHaveLength(2)
  })

  it('the Test button polls once and says what it found', async () => {
    const fx = scripted([{ body: '[]' }, { body: JSON.stringify([notif('9', 'mention', 'ping')]) }])
    const s = setup({ fetch: fx.f })
    const c = await githubConn(s)
    const out = (await (await s.api('POST', `/api/connections/${c.id}/test`, {})).json()) as {
      ok: boolean
      detail: string
    }
    expect(out).toEqual({ ok: true, detail: 'Checked just now. 1 new item(s).' })
    expect(s.events()).toHaveLength(1)
  })
})

describe('rss poller in the relay', () => {
  const feed = (items: string[]) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Blog</title><link>https://example.com/</link><description>d</description>${items
      .map(
        (g) =>
          `<item><title>Post ${g}</title><link>https://example.com/p/${g}</link><guid>${g}</guid><description>about ${g}</description></item>`,
      )
      .join('')}</channel></rss>`

  it('the first poll marks everything seen; later posts arrive as low-priority events', async () => {
    const fx = scripted([{ body: feed(['a', 'b']) }, { body: feed(['a', 'b']) }, { body: feed(['c', 'a', 'b']) }])
    const s = setup({ fetch: fx.f, random: () => 0 })
    const c = await s.create('rss', { fields: { feed_url: 'https://example.com/feed.xml' } })
    await s.tick()
    expect(s.events()).toHaveLength(0)
    s.f.clock.advance(31 * 60_000)
    await s.tick()
    expect(s.events()).toHaveLength(0)
    s.f.clock.advance(31 * 60_000)
    await s.tick()
    const ev = s.eventBodies()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'rss.item', title: 'Post c', priority: 'low', url: 'https://example.com/p/c' })
    expect(s.f.push.intents).toEqual([]) // low priority: shown, never pushed
    expect(c.id).toBeDefined()
  })

  it('refuses a feed address that points inside the network', async () => {
    const s = setup()
    for (const u of ['http://localhost/f', 'http://169.254.169.254/x', 'http://10.1.2.3/f']) {
      const res = await s.api('POST', '/api/connections', { integration: 'rss', name: 'x', fields: { feed_url: u } })
      expect(res.status, u).toBe(400)
    }
  })

  it('refuses every address in the shared corpus, however it is spelled, through the same save route', async () => {
    const s = setup()
    const spellings = [
      ...everyBlocked.map((a) => `http://${a.includes(':') ? `[${a}]` : a}/f`),
      'http://2130706433/f',
      'http://0x7f.1/f',
      'http://127.0.0.1./f',
      'http://localhost./f',
      'http://metadata.google.internal./f',
      'http://[::ffff:a9fe:a9fe]/f',
    ]
    for (const u of spellings) {
      const res = await s.api('POST', '/api/connections', { integration: 'rss', name: 'x', fields: { feed_url: u } })
      expect(res.status, u).toBe(400)
    }
  })
})
