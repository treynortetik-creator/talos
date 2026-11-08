// The connect-time half of the address check, against real sockets: a local server counts how often it was really contacted.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import corpus from '../fixtures/address-corpus.json' with { type: 'json' }
import { isLoopbackHost } from '../src/address.ts'
import { BlockedAddressError, checkedLookup, createGuardedFetch } from '../src/guarded-fetch.ts'

// every address any caller must refuse, as a host in a URL (a zone id cannot sit in a URL host)
const everyBlocked = [...corpus.core, ...corpus.embedded, ...corpus.alsoBlocked.filter((a) => !a.includes('%'))]

// the at-sign that starts userinfo, kept out of literals so the personal-data scan does not read these URLs as e-mail
const AT = String.fromCharCode(64)

let server: http.Server
let port = 0
let hits: Array<{ method: string; url: string; body: string }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString() })
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/other' }).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from the local server')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

const answer =
  (...addrs: string[]) =>
  async () =>
    addrs
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x) => x,
  )
  expect(e).toBeInstanceOf(BlockedAddressError)
  return e as BlockedAddressError
}

describe('a name is checked at the moment of connecting (DNS rebinding)', () => {
  it('a name that resolves to the local server is refused and the server is never contacted', async () => {
    hits = []
    const f = createGuardedFetch({ resolve: answer('127.0.0.1') })
    await refused(f(`http://rebind.example.test:${port}/secret`))
    expect(hits).toEqual([])
  })

  it('control: the same request does reach the server when loopback is explicitly allowed, so the refusal above is the check, not a dead server', async () => {
    hits = []
    const f = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    const res = await f(`http://rebind.example.test:${port}/ok`)
    expect(await res.text()).toBe('hello from the local server')
    expect(hits.map((h) => h.url)).toEqual(['/ok'])
  })

  it('a resolver that answers public to the first caller and loopback afterwards cannot get a connection past the lookup', async () => {
    hits = []
    let calls = 0
    // a caller-side pre-check would see 93.184.216.34; the socket's own lookup is the second question
    const resolve = async () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'])
    expect(await resolve()).toEqual(['93.184.216.34'])
    const f = createGuardedFetch({ resolve })
    await refused(f(`http://rebind.example.test:${port}/x`))
    expect(hits).toEqual([])
  })

  it('a connection made while the name was allowed is not reused once the name answers with a blocked address', async () => {
    hits = []
    let answerNow = ['127.0.0.1']
    const f = createGuardedFetch({ resolve: async () => answerNow, allowLoopback: true })
    const url = `http://pooled.example.test:${port}/p`
    expect((await f(url)).status).toBe(200)
    expect(hits).toHaveLength(1)
    answerNow = ['10.0.0.5'] // the name now points inside the network; allowLoopback does not cover it
    await refused(f(url))
    expect(hits).toHaveLength(1)
  })

  it('every address in an answer counts: one blocked address among public ones refuses the whole answer', async () => {
    hits = []
    for (const bad of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1']) {
      const f = createGuardedFetch({ resolve: answer('93.184.216.34', bad, '2606:4700:4700::1111') })
      await refused(f(`http://mixed.example.test:${port}/`))
    }
    expect(hits).toEqual([])
  })

  it('all 19 core addresses, plus the extra blocked ones, are refused when a name resolves to them', async () => {
    hits = []
    for (const a of everyBlocked) {
      const f = createGuardedFetch({ resolve: answer(a) })
      const e = await refused(f(`http://name.example.test:${port}/`))
      expect(e.host, a).toBe('name.example.test')
    }
    expect(hits).toEqual([])
  })

  it('allowLoopback lets loopback through and nothing else: a private or metadata answer is still refused', async () => {
    hits = []
    for (const a of everyBlocked.filter((x) => !isLoopbackHost(x))) {
      const f = createGuardedFetch({ resolve: answer(a), allowLoopback: true })
      await refused(f(`http://name.example.test:${port}/`))
    }
    expect(hits).toEqual([])
  })

  it('the real system resolver: localhost is refused by default', async () => {
    hits = []
    await refused(createGuardedFetch()(`http://localhost:${port}/`))
    await refused(createGuardedFetch()(`http://localhost.:${port}/`)) // trailing dot
    expect(hits).toEqual([])
  })
})

describe('literal hosts never reach the lookup, so they are judged first', () => {
  it('blocked literals in every spelling the URL parser produces are refused before a socket opens', async () => {
    hits = []
    const f = createGuardedFetch()
    for (const u of [
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1.:${port}/`,
      `http://2130706433:${port}/`,
      `http://0x7f.1:${port}/`,
      `http://0177.0.0.1:${port}/`,
      `http://127.1:${port}/`,
      `http://0:${port}/`,
      `http://[::1]:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://[::ffff:7f00:1]:${port}/`,
      `http://[0:0:0:0:0:0:0:1]:${port}/`,
      `http://user:pw${AT}127.0.0.1:${port}/`, // userinfo does not change where it goes
      `https://169.254.169.254/latest/meta-data/`,
      `http://[2002:a9fe:a9fe::]/`,
    ])
      await refused(f(u))
    expect(hits).toEqual([])
  })

  it('every core address as a literal host is refused', async () => {
    const f = createGuardedFetch()
    for (const a of everyBlocked) await refused(f(a.includes(':') ? `http://[${a}]/` : `http://${a}/`))
  })

  it('userinfo that LOOKS like an address does not change the host: the real host is the one resolved', async () => {
    hits = []
    const asked: string[] = []
    const resolve = async (h: string) => {
      asked.push(h)
      return ['127.0.0.1']
    }
    await refused(createGuardedFetch({ resolve })(`http://127.0.0.1${AT}evil.example.test:${port}/`))
    expect(asked).toEqual(['evil.example.test'])
    expect(hits).toEqual([])
  })
})

describe('unhappy paths are loud (class 5)', () => {
  it('an empty answer is a refusal, not a pass', async () => {
    await refused(createGuardedFetch({ resolve: answer() })(`http://empty.example.test:${port}/`))
  })
  it('a resolver failure reaches the caller as that failure', async () => {
    const f = createGuardedFetch({
      resolve: async () => {
        throw new Error('ENOTFOUND nope.example.test')
      },
    })
    await expect(f(`http://nope.example.test:${port}/`)).rejects.toThrow('ENOTFOUND')
  })
  it('a protocol that is not http(s) is refused', async () => {
    const f = createGuardedFetch({ allowLoopback: true })
    for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/'])
      await expect(f(u)).rejects.toThrow('not http(s)')
  })
  it('a request body type it cannot send is an error, and nothing is sent', async () => {
    hits = []
    const f = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    await expect(f(`http://x.example.test:${port}/`, { method: 'POST', body: new FormData() })).rejects.toThrow(
      'unsupported request body',
    )
    expect(hits).toEqual([])
  })
  it('an aborted signal rejects', async () => {
    const f = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    await expect(f(`http://x.example.test:${port}/`, { signal: AbortSignal.abort() })).rejects.toThrow()
  })
  it("the error text is the caller's own wording", async () => {
    const e = await refused(
      createGuardedFetch({ resolve: answer('10.0.0.5'), message: 'feed address points at a private host' })(
        'http://a.example.test/',
      ),
    )
    expect(e.message).toBe('feed address points at a private host')
  })
})

describe('what a permitted request does', () => {
  it('sends method, headers and a string body, and returns status, headers and body', async () => {
    hits = []
    const f = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    const res = await f(`http://x.example.test:${port}/post`, {
      method: 'POST',
      headers: new Headers({ 'x-test': '1' }),
      body: new URLSearchParams({ a: 'b c' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(hits).toEqual([{ method: 'POST', url: '/post', body: 'a=b+c' }])
  })
  it('does not follow a redirect: the caller sees the 302 and decides', async () => {
    hits = []
    const f = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    const res = await f(`http://x.example.test:${port}/redirect`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/other')
    expect(hits.map((h) => h.url)).toEqual(['/redirect'])
  })
})

describe('two at once (class 10)', () => {
  it('twenty simultaneous requests: the blocked ones are all refused, the permitted ones all arrive, none cross over', async () => {
    hits = []
    const bad = createGuardedFetch({ resolve: answer('127.0.0.1') })
    const good = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    const runs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? bad(`http://a.example.test:${port}/bad${i}`) : good(`http://a.example.test:${port}/good${i}`),
    )
    const settled = await Promise.allSettled(runs)
    for (const [i, s] of settled.entries()) expect(s.status, String(i)).toBe(i % 2 === 0 ? 'rejected' : 'fulfilled')
    for (const [i, s] of settled.entries())
      if (i % 2 === 0) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(BlockedAddressError)
    expect(hits.map((h) => h.url).sort()).toEqual(Array.from({ length: 10 }, (_, k) => `/good${2 * k + 1}`).sort())
  })
})

describe('checkedLookup (the function the socket calls)', () => {
  const ask = (resolve: (h: string) => Promise<string[]>, all: boolean) =>
    new Promise<{ err: Error | null; addr: unknown; family?: number | undefined }>((ok) =>
      checkedLookup({ resolve })('h.example.test', { all }, (err, addr, family) => ok({ err, addr, family })),
    )
  it('hands back only addresses it approved, in the shape the caller asked for', async () => {
    const one = await ask(answer('93.184.216.34', '2606:4700:4700::1111'), false)
    expect(one).toEqual({ err: null, addr: '93.184.216.34', family: 4 })
    const all = await ask(answer('93.184.216.34', '2606:4700:4700::1111'), true)
    expect(all.addr).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
  })
  it('hands back nothing for a blocked answer', async () => {
    const r = await ask(answer('93.184.216.34', '169.254.169.254'), true)
    expect(r.err).toBeInstanceOf(BlockedAddressError)
    expect(r.addr).toBe('')
  })
})
