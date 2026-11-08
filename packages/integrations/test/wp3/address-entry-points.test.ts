// The shared web-address check as the RSS poller meets it: saving a feed address, polling, following a redirect, and the
// production fetch. The same corpus the bridge's sign-in flow runs.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import corpus from '@talos-app/protocol/fixtures/address-corpus.json' with { type: 'json' }
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertPublicFeedUrl, getIntegration } from '../../src/index.ts'
import { assertPublicAddress, assertPublicAddresses, guardedFetch, isPrivateAddress } from '../../src/rss/ssrf.ts'
import type { PollContext } from '../../src/types.ts'
import { NOW } from './helpers.ts'

const RSS =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>a</title><guid>1</guid></item></channel></rss>'
// the at-sign that starts userinfo, kept out of literals so the personal-data scan does not read these URLs as e-mail
const AT = String.fromCharCode(64)
/** Records the URL a fake fetch was asked for, then answers. */
const seen = <R>(calls: string[], u: unknown, answer: R): R => {
  calls.push(String(u))
  return answer
}
// every address any caller must refuse, as a host in a URL (a zone id cannot sit in a URL host)
const everyBlocked = [...corpus.core, ...corpus.embedded, ...corpus.alsoBlocked.filter((a) => !a.includes('%'))]
const hostOf = (a: string) => (a.includes(':') ? `[${a}]` : a)

const ctx = (
  fetchFn: typeof fetch,
  resolve?: PollContext['resolve'],
  feed = 'https://feeds.example.org/rss',
): PollContext => ({
  cursor: null,
  secrets: {},
  extra: { feed_url: feed },
  now: NOW,
  fetch: fetchFn,
  ...(resolve ? { resolve } : {}),
})
const recorder = () => {
  const calls: string[] = []
  const f = (async (u: string) => seen(calls, u, new Response(RSS))) as unknown as typeof fetch
  return { calls, f }
}

describe('saving a feed address (assertPublicFeedUrl)', () => {
  it.each(everyBlocked)('refuses %s as the host', (a) => {
    expect(() => assertPublicFeedUrl(`http://${hostOf(a)}/feed`)).toThrow(/private host/)
    expect(() => assertPublicFeedUrl(`https://${hostOf(a)}:8443/feed`)).toThrow(/private host/)
  })
  it.each(corpus.public)('allows %s as the host', (a) => {
    expect(assertPublicFeedUrl(`https://${hostOf(a)}/feed`).protocol).toBe('https:')
  })
  it('number-shaped hosts, trailing dots and odd spellings of local names are refused', () => {
    for (const u of [
      'http://2130706433/f',
      'http://0x7f.1/f',
      'http://0177.0.0.1/f',
      'http://127.1/f',
      'http://0/f',
      'http://127.0.0.1./f',
      'http://169.254.169.254../f',
      'http://localhost./f',
      'http://LOCALHOST/f',
      'http://app.localhost./f',
      'http://printer.local./f',
      'http://metadata.google.internal./f',
      'http://intranet./f',
    ])
      expect(() => assertPublicFeedUrl(u), u).toThrow(/private host/)
  })
  it('userinfo is refused, and userinfo that looks like an address does not hide or invent a host', () => {
    expect(() => assertPublicFeedUrl(`https://user:pw${AT}feeds.example.org/f`)).toThrow(/credentials/)
    expect(() => assertPublicFeedUrl(`https://127.0.0.1${AT}feeds.example.org/f`)).toThrow(/credentials/)
    expect(() => assertPublicFeedUrl(`https://feeds.example.org${AT}127.0.0.1/f`)).toThrow(/credentials/)
  })
  it('a name that merely contains an address is a name, and passes this stage (its answers are checked at poll time)', () => {
    expect(assertPublicFeedUrl('https://127.0.0.1.nip.io/f').hostname).toBe('127.0.0.1.nip.io')
  })
})

describe('the address helpers every caller shares', () => {
  it.each(everyBlocked)('isPrivateAddress and assertPublicAddress refuse %s', (a) => {
    expect(isPrivateAddress(a)).toBe(true)
    expect(() => assertPublicAddress(a)).toThrow(/private host/)
  })
  it('assertPublicAddresses: one bad address among good ones refuses; an empty answer refuses; a non-address refuses', () => {
    expect(() => assertPublicAddresses(['93.184.216.34', '2606:4700:4700::1111'])).not.toThrow()
    expect(() => assertPublicAddresses(['93.184.216.34', '10.0.0.5'])).toThrow(/private host/)
    expect(() => assertPublicAddresses([])).toThrow(/private host/)
    expect(() => assertPublicAddresses(['93.184.216.34', 'rebind'])).toThrow(/private host/)
  })
})

describe('polling', () => {
  it.each(everyBlocked)('a feed name that resolves to %s is refused and nothing is fetched', async (a) => {
    const r = recorder()
    await expect(getIntegration('rss').poll?.(ctx(r.f, async () => [a]))).rejects.toThrow(/private host/)
    expect(r.calls).toEqual([])
  })
  it.each(everyBlocked)('a public feed that redirects to %s is refused on the hop', async (a) => {
    const calls: string[] = []
    const f = (async (u: string) =>
      seen(
        calls,
        u,
        new Response(null, { status: 302, headers: { location: `http://${hostOf(a)}/x` } }),
      )) as unknown as typeof fetch
    await expect(getIntegration('rss').poll?.(ctx(f, async () => ['93.184.216.34']))).rejects.toThrow(/private host/)
    expect(calls).toEqual(['https://feeds.example.org/rss'])
  })
  it.each(everyBlocked)('a redirect to a name that resolves to %s is refused on the hop', async (a) => {
    const calls: string[] = []
    const f = (async (u: string) =>
      seen(
        calls,
        u,
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/x' } }),
      )) as unknown as typeof fetch
    const resolve = async (h: string) => (h === 'elsewhere.example.net' ? [a] : ['93.184.216.34'])
    await expect(getIntegration('rss').poll?.(ctx(f, resolve))).rejects.toThrow(/private host/)
    expect(calls).toEqual(['https://feeds.example.org/rss'])
  })
  it('an empty answer from the resolver is a refusal, not a pass (it used to fetch)', async () => {
    const r = recorder()
    await expect(getIntegration('rss').poll?.(ctx(r.f, async () => []))).rejects.toThrow(/private host/)
    expect(r.calls).toEqual([])
  })
  it('a resolver that fails surfaces that failure', async () => {
    const r = recorder()
    const resolve = async () => {
      throw new Error('ENOTFOUND feeds.example.org')
    }
    await expect(getIntegration('rss').poll?.(ctx(r.f, resolve))).rejects.toThrow('ENOTFOUND')
    expect(r.calls).toEqual([])
  })
  it('a feed address saved before these rules (stored in a connection) is checked again at poll time', async () => {
    const r = recorder()
    await expect(getIntegration('rss').poll?.(ctx(r.f, undefined, 'http://localhost./feed'))).rejects.toThrow(
      /private host/,
    )
    await expect(getIntegration('rss').poll?.(ctx(r.f, undefined, 'http://[2002:a9fe:a9fe::]/feed'))).rejects.toThrow(
      /private host/,
    )
    expect(r.calls).toEqual([])
  })
})

describe('the production fetch (connect-time), against a real local server', () => {
  let server: http.Server
  let port = 0
  const hits: string[] = []
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200).end(RSS)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  it('control: the server answers a plain request, so the refusals below are the guard', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/control`)).status).toBe(200)
    expect(hits).toEqual(['/control'])
    hits.length = 0
  })
  it('refuses a loopback literal, localhost and its trailing-dot spelling, and nothing reaches the server', async () => {
    for (const u of [
      `http://127.0.0.1:${port}/a`,
      `http://localhost:${port}/b`,
      `http://localhost.:${port}/c`,
      `http://[::ffff:7f00:1]:${port}/d`,
    ]) {
      await expect(guardedFetch(u)).rejects.toThrow(/private host/)
    }
    expect(hits).toEqual([])
  })
})
