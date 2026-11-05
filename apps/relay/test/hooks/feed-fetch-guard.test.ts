// The relay polls a feed address the owner typed. With no fetch injected (production) the poll must go out through the guarded
// fetch, which checks the address at connect time: the socket it opens carries its own `lookup`, so the address that is
// judged is the address that is connected to. Checking a name first and then calling a plain fetch resolves twice and
// leaves a gap for a name that answers differently the second time, so these tests look at the socket, not only the
// outcome. The system resolver is replaced for two fixed names only.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { setup } from './harness.ts'

const { REBOUND_HOST, PUBLIC_HOST } = vi.hoisted(() => ({
  REBOUND_HOST: 'rebound-feed.example.com',
  PUBLIC_HOST: 'public-feed.example.com',
}))

vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>()
  const lookup = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) =>
    host === REBOUND_HOST || host === PUBLIC_HOST
      ? cb(null, [{ address: host === REBOUND_HOST ? '127.0.0.1' : '93.184.216.34', family: 4 }])
      : (real.lookup as (...a: unknown[]) => void)(host, opts, cb)) as typeof real.lookup
  return { ...real, default: { ...real, lookup }, lookup }
})

type Lookup = (host: string, opts: unknown, cb: (err: Error | null, addrs: unknown) => void) => void

afterEach(() => {
  resetAuthImplementation()
  vi.restoreAllMocks()
})

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Blog</title><link>https://example.com/</link><description>d</description><item><title>Post a</title><link>https://example.com/p/a</link><guid>a</guid></item></channel></rss>`

describe('the relay feed poll uses the connect-time address check', () => {
  let server: http.Server
  let port = 0
  const hits: string[] = []
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(FEED)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('control: the local server answers a plain request, so a refusal below is the guard and not a dead server', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/control`)).status).toBe(200)
    expect(hits).toEqual(['/control'])
    hits.length = 0
  })

  it('a feed name that resolves to a private address is refused at connect time and the server sees nothing', async () => {
    const s = setup() // no fetch given: the production wiring
    const c = await s.create('rss', { fields: { feed_url: `http://${REBOUND_HOST}:${port}/feed.xml` } })
    await s.tick()
    const state = s.f.db.prepare('select fail_count, last_error from hooks_poll_state where conn_id = ?').get(c.id) as
      | { fail_count: number; last_error: string | null }
      | undefined
    expect(state?.last_error).toMatch(/private host/)
    expect(state?.fail_count).toBe(1)
    expect(hits).toEqual([])
    expect(s.events()).toHaveLength(0)
  })

  it('the socket the poll opens carries a lookup that refuses a private answer and passes a public one', async () => {
    const opened = vi.spyOn(http, 'request')
    const s = setup()
    await s.create('rss', { fields: { feed_url: `http://${REBOUND_HOST}:${port}/feed.xml` } })
    await s.tick()
    const lookups = opened.mock.calls.flatMap((args) =>
      args.flatMap((a) => (a && typeof a === 'object' && 'lookup' in a ? [(a as { lookup: Lookup }).lookup] : [])),
    )
    expect(lookups).toHaveLength(1) // one request, opened with the guard's own lookup (not a pre-check and a plain fetch)
    const ask = (host: string) =>
      new Promise<{ err: Error | null; addrs: unknown }>((done) =>
        lookups[0]?.(host, { all: true }, (err, addrs) => done({ err, addrs })),
      )
    expect((await ask(REBOUND_HOST)).err?.message).toMatch(/private host/)
    const ok = await ask(PUBLIC_HOST)
    expect(ok.err).toBeNull()
    expect(ok.addrs).toEqual([{ address: '93.184.216.34', family: 4 }])
  })
})
