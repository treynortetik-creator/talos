import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import {
  FEED_FAILURE_MEMORY_MS,
  FEED_FRESH_MS,
  FEED_STALE_MAX_MS,
  loadReleaseList,
  loadReleases,
  parseReleaseFeed,
  RELEASE_FEED_URL,
  relayReleaseState,
} from '../src/release-feed.ts'
import { tempHome } from './helpers.ts'

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  ...extra,
})
const FEED = [
  rel('mac-v0.1.8'),
  rel('mac-v0.1.6'),
  rel('mac-v0.1.10'),
  rel('mac-v0.1.7', { draft: true }),
  rel('mac-v0.1.9', { prerelease: true }),
  rel('v0.2.0'), // not a mac tag
  rel('mac-v0.2'), // not strict semver
  rel('mac-v0.3.0-rc1'),
  rel('relay-v0.4.0'),
  rel('mac-v0.1.6'), // twice
  { tag_name: 5 },
  'junk',
]

describe('parseReleaseFeed', () => {
  test('mac-v<semver> only, no drafts or prereleases, sorted by semver (0.1.10 after 0.1.8), once each', () => {
    expect(parseReleaseFeed(FEED)).toEqual(['0.1.6', '0.1.8', '0.1.10'])
  })
  test('anything that is not a list is an empty list', () => {
    expect(parseReleaseFeed({ message: 'rate limited' })).toEqual([])
    expect(parseReleaseFeed(null)).toEqual([])
  })
})

type Seen = { url: string; headers: Headers }
function fakeFetch(answers: Array<() => Response | Promise<Response>>) {
  const seen: Seen[] = []
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) })
    const next = answers.shift()
    if (!next) throw new Error('unexpected fetch')
    return next()
  }
  return { fn, seen }
}
const ok =
  (body: unknown = FEED) =>
  () =>
    Response.json(body)
const boom = () => () => {
  throw new Error('offline')
}

describe('loadReleaseList: cache', () => {
  test('fetches, writes release-feed.json (0600), and uses the cache for 6 hours', async () => {
    const home = tempHome()
    const clock = fakeClock()
    const f = fakeFetch([ok()])
    const d = { home, now: clock.now, fetch: f.fn }
    expect(await loadReleaseList(d)).toEqual(['0.1.6', '0.1.8', '0.1.10'])
    const file = join(home, 'release-feed.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    clock.set(clock.now() + FEED_FRESH_MS - 1000)
    expect(await loadReleaseList(d)).toEqual(['0.1.6', '0.1.8', '0.1.10'])
    expect(f.seen).toHaveLength(1)
    f.seen.length = 0
    const g = fakeFetch([ok([rel('mac-v0.1.11')])])
    clock.set(clock.now() + 2000) // past 6 hours
    expect(await loadReleaseList({ ...d, fetch: g.fn })).toEqual(['0.1.11'])
    expect(g.seen).toHaveLength(1)
  })

  test('a failed fetch keeps a cache up to 7 days old, then the answer is unknown', async () => {
    const home = tempHome()
    const clock = fakeClock()
    expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([ok()]).fn })).toHaveLength(3)
    clock.set(clock.now() + 3 * 86_400_000)
    expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([boom()]).fn })).toEqual([
      '0.1.6',
      '0.1.8',
      '0.1.10',
    ])
    clock.set(clock.now() + FEED_STALE_MAX_MS) // now 10 days since the fetch
    expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([boom()]).fn })).toBeUndefined()
  })

  test('no cache and no network is unknown; a corrupt cache is ignored; a non-200 or a junk body is a failed fetch', async () => {
    const clock = fakeClock()
    const fails = [boom(), () => new Response('no', { status: 403 }), () => new Response('<html>')]
    for (const answer of fails) {
      const home = tempHome()
      expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([answer]).fn })).toBeUndefined()
    }
    const home = tempHome()
    writeFileSync(join(home, 'release-feed.json'), '{not json')
    expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([ok()]).fn })).toEqual([
      '0.1.6',
      '0.1.8',
      '0.1.10',
    ])
  })

  test('a failed fetch does not push the cache forward: the 7 days count from the last good fetch', async () => {
    const home = tempHome()
    const clock = fakeClock()
    await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([ok()]).fn })
    for (let day = 0; day < 6; day++) {
      clock.set(clock.now() + 86_400_000)
      await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([boom()]).fn })
    }
    clock.set(clock.now() + 2 * 86_400_000)
    expect(await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([boom()]).fn })).toBeUndefined()
  })

  test('a response over the size cap is a failed fetch', async () => {
    const home = tempHome()
    const big = JSON.stringify([rel('mac-v0.1.8', { body: 'x'.repeat(3 * 1024 * 1024) })])
    expect(
      await loadReleaseList({ home, now: Date.now, fetch: fakeFetch([() => new Response(big)]).fn }),
    ).toBeUndefined()
  })
})

describe('loadReleaseList: a test feed address never touches the real cache', () => {
  test('with url set: no read, no write of release-feed.json', async () => {
    const home = tempHome()
    const clock = fakeClock()
    await loadReleaseList({ home, now: clock.now, fetch: fakeFetch([ok([rel('mac-v0.1.8')])]).fn })
    const before = readFileSync(join(home, 'release-feed.json'), 'utf8')
    const f = fakeFetch([ok([rel('mac-v9.9.9')])])
    expect(await loadReleaseList({ home, now: clock.now, url: 'http://127.0.0.1:1/x', fetch: f.fn })).toEqual(['9.9.9'])
    expect(f.seen).toHaveLength(1) // the real cache was fresh, and was not used
    expect(readFileSync(join(home, 'release-feed.json'), 'utf8')).toBe(before)
    const fresh = tempHome()
    await loadReleaseList({ home: fresh, now: clock.now, url: 'http://127.0.0.1:1/x', fetch: fakeFetch([ok()]).fn })
    expect(existsSync(join(fresh, 'release-feed.json'))).toBe(false)
  })
})

describe('loadReleases: a failure is remembered for 15 minutes, and says why', () => {
  const status = (n: number) => () => new Response('no', { status: n })
  test('a failed fetch is not retried inside the window, for network, 403, 429 and an empty list', async () => {
    for (const [answer, why] of [
      [boom(), 'offline'],
      [status(403), 'rate-limited'],
      [status(429), 'rate-limited'],
      [ok([rel('v1.0.0')]), 'empty'],
      [status(500), 'offline'],
    ] as const) {
      const home = tempHome()
      const clock = fakeClock()
      const f = fakeFetch([answer])
      expect(await loadReleases({ home, now: clock.now, fetch: f.fn })).toEqual({ versions: undefined, failure: why })
      clock.set(clock.now() + FEED_FAILURE_MEMORY_MS - 1000)
      expect(await loadReleases({ home, now: clock.now, fetch: f.fn })).toEqual({ versions: undefined, failure: why })
      expect(f.seen).toHaveLength(1)
      clock.set(clock.now() + 2000)
      const g = fakeFetch([ok()])
      expect((await loadReleases({ home, now: clock.now, fetch: g.fn })).versions).toEqual(['0.1.6', '0.1.8', '0.1.10'])
      expect(g.seen).toHaveLength(1)
    }
  })
  test('inside the window a stale cache is still used, and the good time is not pushed forward', async () => {
    const home = tempHome()
    const clock = fakeClock()
    await loadReleases({ home, now: clock.now, fetch: fakeFetch([ok()]).fn })
    clock.set(clock.now() + FEED_FRESH_MS + 1000)
    const f = fakeFetch([status(403)])
    expect((await loadReleases({ home, now: clock.now, fetch: f.fn })).versions).toEqual(['0.1.6', '0.1.8', '0.1.10'])
    expect((await loadReleases({ home, now: clock.now, fetch: f.fn })).versions).toEqual(['0.1.6', '0.1.8', '0.1.10'])
    expect(f.seen).toHaveLength(1)
    clock.set(clock.now() + 7 * 86_400_000)
    expect((await loadReleases({ home, now: clock.now, fetch: fakeFetch([status(403)]).fn })).versions).toBeUndefined()
  })
})

describe('loadReleaseList: the request', () => {
  test('the GitHub releases API of the public release repo, no auth, a generic user agent', async () => {
    const f = fakeFetch([ok()])
    await loadReleaseList({ home: tempHome(), now: Date.now, fetch: f.fn })
    expect(f.seen[0]?.url).toBe(RELEASE_FEED_URL)
    expect(RELEASE_FEED_URL).toMatch(/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\?per_page=100$/)
    const h = f.seen[0]?.headers as Headers
    expect(h.has('authorization')).toBe(false)
    expect(h.has('cookie')).toBe(false)
    expect(h.get('user-agent')).toMatch(/^talos-app-release-check$/)
  })

  let srv: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => srv?.stop(true))

  test('over a real socket: no Authorization header, and a redirect is not followed', async () => {
    const hits: Array<{ path: string; auth: string | null; ua: string | null }> = []
    srv = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        hits.push({ path: u.pathname, auth: req.headers.get('authorization'), ua: req.headers.get('user-agent') })
        if (u.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/elsewhere' } })
        return Response.json(FEED)
      },
    })
    const base = `http://127.0.0.1:${srv.port}`
    expect(await loadReleaseList({ home: tempHome(), now: Date.now, url: `${base}/ok` })).toEqual([
      '0.1.6',
      '0.1.8',
      '0.1.10',
    ])
    expect(hits[0]?.auth).toBeNull()
    expect(hits[0]?.ua).toBe('talos-app-release-check')
    hits.length = 0
    expect(await loadReleaseList({ home: tempHome(), now: Date.now, url: `${base}/redirect` })).toBeUndefined()
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
  })

  test('the real guarded fetch refuses a name that resolves to a private address', async () => {
    const resolved: string[] = []
    const got = await loadReleaseList({
      home: tempHome(),
      now: Date.now,
      resolve: async (h) => {
        resolved.push(h)
        return ['10.0.0.5']
      },
    })
    expect(got).toBeUndefined()
    expect(resolved).toEqual(['api.github.com'])
  })
})

describe('relayReleaseState', () => {
  const list = ['0.1.6', '0.1.7', '0.1.8']
  test('latest', () => {
    expect(relayReleaseState({ release: '0.1.8', version: 'abc1234' }, list)).toEqual({
      state: 'latest',
      relay: '0.1.8',
      latest: '0.1.8',
    })
  })
  test('behind counts the releases newer than the relay, across a gap and for a release the list does not have', () => {
    expect(relayReleaseState({ release: '0.1.6' }, list)).toEqual({
      state: 'behind',
      n: 2,
      relay: '0.1.6',
      latest: '0.1.8',
    })
    expect(relayReleaseState({ release: '0.1.7' }, list)).toEqual({
      state: 'behind',
      n: 1,
      relay: '0.1.7',
      latest: '0.1.8',
    })
    const gappy = ['0.1.0', '0.1.3', '0.1.9', '0.1.10', '0.1.12']
    expect(relayReleaseState({ release: '0.1.3' }, gappy)).toMatchObject({ state: 'behind', n: 3 })
    // the relay's release is not in the list (yanked, or a draft): still counted by version
    expect(relayReleaseState({ release: '0.1.5' }, gappy)).toMatchObject({ state: 'behind', n: 3, latest: '0.1.12' })
    expect(relayReleaseState({ release: '0.0.1' }, gappy)).toMatchObject({ state: 'behind', n: 5 })
  })
  test('ahead: newer than the newest published', () => {
    expect(relayReleaseState({ release: '0.1.9' }, list)).toEqual({ state: 'ahead', relay: '0.1.9', latest: '0.1.8' })
    expect(relayReleaseState({ release: '0.2.0' }, list)).toMatchObject({ state: 'ahead' })
  })
  test('not-a-release: no release field (a main build, or a relay too old to say), never behind, even with no list', () => {
    expect(relayReleaseState({ version: 'abc1234' }, list)).toEqual({ state: 'not-a-release', commit: 'abc1234' })
    expect(relayReleaseState({ version: 'dev' }, list)).toEqual({ state: 'not-a-release' })
    expect(relayReleaseState({}, undefined)).toEqual({ state: 'not-a-release' })
    expect(relayReleaseState({ release: 'v0.1.6', version: 'abc1234' }, list)).toMatchObject({ state: 'not-a-release' })
  })
  test('a version that is not a string (a hostile or broken relay) is no commit, and never throws', () => {
    expect(relayReleaseState({ version: 7 as unknown as string }, list)).toEqual({ state: 'not-a-release' })
    expect(relayReleaseState({ release: 7 as unknown as string, version: {} as unknown as string }, list)).toEqual({
      state: 'not-a-release',
    })
  })
  test('unknown says why when it is told', () => {
    expect(relayReleaseState({ release: '0.1.8' }, undefined, 'rate-limited')).toEqual({
      state: 'unknown',
      relay: '0.1.8',
      why: 'rate-limited',
    })
  })
  test('unknown: a release and no list', () => {
    expect(relayReleaseState({ release: '0.1.8' }, undefined)).toEqual({ state: 'unknown', relay: '0.1.8' })
    expect(relayReleaseState({ release: '0.1.8' }, [])).toEqual({ state: 'unknown', relay: '0.1.8' })
  })
})
