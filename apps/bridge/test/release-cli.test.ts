import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { releaseFeedTestSeam } from '../src/release-feed.ts'
import { tempHome } from './helpers.ts'

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  ...extra,
})
const FEED = [rel('mac-v0.1.6'), rel('mac-v0.1.7'), rel('mac-v0.1.8'), rel('mac-v0.1.9', { draft: true })]

let servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  releaseFeedTestSeam.url = undefined
  for (const s of servers) s.stop(true)
  servers = []
})

/** A relay that answers /healthz with `health`, and a releases feed; counts the feed's requests. */
function world(health: Record<string, unknown>, feed: unknown = FEED) {
  const feedHits = { n: 0 }
  const feedSrv = Bun.serve({
    port: 0,
    fetch() {
      feedHits.n++
      return Response.json(feed)
    },
  })
  const relaySrv = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/healthz'
        ? Response.json({ ok: true, ...health })
        : new Response('no', { status: 404 }),
  })
  servers.push(feedSrv, relaySrv)
  const home = tempHome()
  releaseFeedTestSeam.url = `http://127.0.0.1:${feedSrv.port}/releases`
  return {
    feedHits,
    home,
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: `http://127.0.0.1:${relaySrv.port}`,
    },
  }
}
const io = () => {
  const out: string[] = []
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
const doctorRow = async (env: Record<string, string>) => {
  const a = io()
  await runCli(['doctor', '--json', '--agent-dir', join(env.TALOS_APP_HOME as string, 'none')], a.io, env)
  const parsed = JSON.parse(a.out.join('\n')) as { checks: Array<{ name: string; level: string; detail: string }> }
  return parsed.checks
}
const statusJson = async (env: Record<string, string>) => {
  const a = io()
  await runCli(['status', '--json'], a.io, env)
  return JSON.parse(a.out.join('\n')) as { relay_release: Record<string, unknown> }
}

describe('doctor: relay release', () => {
  test('latest: ok, right after relay /healthz', async () => {
    const w = world({ version: 'abc1234', release: '0.1.8' })
    const rows = await doctorRow(w.env)
    const i = rows.findIndex((r) => r.name === 'relay /healthz')
    expect(rows[i + 1]).toMatchObject({ name: 'relay release', level: 'ok' })
    expect(JSON.stringify(rows[i + 1])).toContain('on 0.1.8 (the latest release)')
  })
  test('behind: warn with the count, both versions and the Railway way', async () => {
    const w = world({ version: 'abc1234', release: '0.1.6' })
    const row = (await doctorRow(w.env)).find((r) => r.name === 'relay release')
    expect(row?.level).toBe('warn')
    const text = JSON.stringify(row)
    expect(text).toContain('your online relay is 2 releases behind (on 0.1.6, latest 0.1.8)')
    expect(text).toContain('Railway updates an image relay within a few hours')
    expect(text).toContain('to update now, redeploy it in Railway')
  })
  test('one behind says "1 release"', async () => {
    const w = world({ version: 'abc1234', release: '0.1.7' })
    expect(JSON.stringify((await doctorRow(w.env)).find((r) => r.name === 'relay release'))).toContain(
      'is 1 release behind',
    )
  })
  test('not a release build: ok, with the commit, and the feed is never asked', async () => {
    const w = world({ version: 'abc1234' })
    const row = (await doctorRow(w.env)).find((r) => r.name === 'relay release')
    expect(row?.level).toBe('ok')
    expect(JSON.stringify(row)).toContain(
      'not a release build (commit abc1234): a relay that deploys from main, or one too old to report its release',
    )
    expect(w.feedHits.n).toBe(0)
  })
  test('unknown: ok, offline wording, never a warning', async () => {
    const w = world({ version: 'abc1234', release: '0.1.8' })
    releaseFeedTestSeam.url = 'http://127.0.0.1:9/releases'
    const env = w.env
    const row = (await doctorRow(env)).find((r) => r.name === 'relay release')
    expect(row?.level).toBe('ok')
    expect(JSON.stringify(row)).toContain("can't check releases right now (offline)")
  })
  test('a relay that says version: 7 does not crash doctor or status', async () => {
    const w = world({ version: 7, release: 8 })
    const row = (await doctorRow(w.env)).find((r) => r.name === 'relay release')
    expect(row?.level).toBe('ok')
    expect(JSON.stringify(row)).toContain('not a release build')
    expect((await statusJson(w.env)).relay_release).toEqual({ state: 'not-a-release' })
    const v = world({ version: 7, release: '0.1.8' })
    expect((await statusJson(v.env)).relay_release).toEqual({ state: 'latest', relay: '0.1.8', latest: '0.1.8' })
  })
  test('unknown names the reason: rate limit, an empty list, offline', async () => {
    const reason = async (answer: () => Response) => {
      const feed = Bun.serve({ port: 0, fetch: answer })
      servers.push(feed)
      const w = world({ version: 'abc1234', release: '0.1.8' })
      releaseFeedTestSeam.url = `http://127.0.0.1:${feed.port}/x`
      const env = w.env
      return JSON.stringify((await doctorRow(env)).find((r) => r.name === 'relay release'))
    }
    expect(await reason(() => new Response('no', { status: 403 }))).toContain(
      '(GitHub is rate-limiting this computer, try later)',
    )
    expect(await reason(() => Response.json([]))).toContain('(no releases listed)')
    expect(await reason(() => new Response('x', { status: 500 }))).toContain("can't check releases right now (offline)")
  })
  test('ahead: ok', async () => {
    const w = world({ version: 'abc1234', release: '0.2.0' })
    const row = (await doctorRow(w.env)).find((r) => r.name === 'relay release')
    expect(row?.level).toBe('ok')
    expect(JSON.stringify(row)).toContain('newer than the latest published release (0.1.8)')
  })
  test('an unreachable relay: no relay release row and no feed request', async () => {
    const w = world({ version: 'abc1234', release: '0.1.6' })
    const env = { ...w.env, TALOS_APP_RELAY_URL: 'http://127.0.0.1:9' }
    expect((await doctorRow(env)).some((r) => r.name === 'relay release')).toBe(false)
    expect(w.feedHits.n).toBe(0)
    expect(existsSync(join(w.home, 'release-feed.json'))).toBe(false)
  })
  test('the existing "bridge and relay versions" row is still there', async () => {
    const w = world({ version: '0123456', release: '0.1.8' })
    expect((await doctorRow(w.env)).some((r) => r.name === 'bridge and relay versions')).toBe(true)
  })
})

describe('status: relay release', () => {
  test('--json: relay_release for latest, behind, not-a-release, unknown', async () => {
    expect((await statusJson(world({ version: 'abc1234', release: '0.1.8' }).env)).relay_release).toEqual({
      state: 'latest',
      relay: '0.1.8',
      latest: '0.1.8',
    })
    expect((await statusJson(world({ version: 'abc1234', release: '0.1.6' }).env)).relay_release).toEqual({
      state: 'behind',
      relay: '0.1.6',
      latest: '0.1.8',
      behind: 2,
    })
    expect((await statusJson(world({ version: 'abc1234' }).env)).relay_release).toEqual({ state: 'not-a-release' })
    const w = world({ version: 'abc1234', release: '0.1.8' })
    releaseFeedTestSeam.url = 'http://127.0.0.1:9/x'
    expect((await statusJson(w.env)).relay_release).toEqual({
      state: 'unknown',
      relay: '0.1.8',
    })
  })
  test('--json with no relay URL or an unreachable relay: unknown, no feed request', async () => {
    const w = world({ version: 'abc1234', release: '0.1.6' })
    const down = await statusJson({ ...w.env, TALOS_APP_RELAY_URL: 'http://127.0.0.1:9' })
    expect(down.relay_release).toEqual({ state: 'unknown' })
    const none = await statusJson({ TALOS_APP_HOME: tempHome() })
    expect(none.relay_release).toEqual({ state: 'unknown' })
    expect(w.feedHits.n).toBe(0)
  })
  test('text: one line with the same fact', async () => {
    const a = io()
    const w = world({ version: 'abc1234', release: '0.1.6' })
    await runCli(['status'], a.io, w.env)
    expect(
      a.out.filter((l) =>
        l.startsWith('relay release: your online relay is 2 releases behind (on 0.1.6, latest 0.1.8)'),
      ),
    ).toHaveLength(1)
    const b = io()
    await runCli(['status'], b.io, world({ version: 'abc1234', release: '0.1.8' }).env)
    expect(b.out).toContain('relay release: on 0.1.8 (the latest release)')
  })
})
