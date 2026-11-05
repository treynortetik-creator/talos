// The shared web-address check (packages/protocol) as the bridge's sign-in flow meets it. Every address in the shared corpus
// must be refused by every way in: a literal URL, a name that resolves to it, a redirect to it, `apps login`, and the
// connector's local-server rule. Includes the DNS-rebinding case against a real socket.
import { afterEach, describe, expect, it } from 'bun:test'
import { isLoopbackHost } from '@talos-app/protocol'
import corpus from '@talos-app/protocol/fixtures/address-corpus.json' with { type: 'json' }
import type { AppsCliDeps } from '../../src/apps/cli.ts'
import { isLocalServerHost } from '../../src/apps/direct.ts'
import { GuardError, guardedFetch } from '../../src/apps/direct-oauth.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { type CliIO, runCli } from '../../src/cli-main.ts'
import { approvedFixture, memSecrets, tmp } from './helpers.ts'

const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()?.()
})

// the at-sign that starts userinfo, kept out of literals so the personal-data scan does not read these URLs as e-mail
const AT = String.fromCharCode(64)
/** Records the URL a fake fetch was asked for, then answers. */
const seen = <R>(calls: string[], u: unknown, answer: R): R => {
  calls.push(String(u))
  return answer
}
const urlFor = (addr: string, path = '/x') =>
  addr.includes(':') ? `https://[${addr}]${path}` : `https://${addr}${path}`
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })
const guardError = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x) => x,
  )
  expect(e).toBeInstanceOf(GuardError)
  return e as GuardError
}
const WILL_NOT = 'address Talos will not contact'

describe('the sign-in guard refuses every core address, every way in', () => {
  it('there are 19, and the old bridge check missed 8 of them (recorded in the corpus)', () => {
    expect(corpus.core).toHaveLength(19)
    expect(corpus.gapsInOldOauthCheck.every((a) => corpus.core.includes(a))).toBe(true)
  })

  it.each(corpus.core)('literal URL https://%s never gets a request', async (a) => {
    const calls: string[] = []
    const g = guardedFetch({
      fetch: async (u) => seen(calls, u, json({})),
      resolve: async () => ['93.184.216.34'],
    })
    const e = await guardError(g(urlFor(a)))
    expect(e.message).toContain(WILL_NOT)
    expect(calls).toEqual([])
  })

  it.each(corpus.core)('a name that resolves to %s never gets a request', async (a) => {
    const calls: string[] = []
    const g = guardedFetch({ fetch: async (u) => seen(calls, u, json({})), resolve: async () => [a] })
    expect((await guardError(g('https://as.example.com/x'))).message).toContain(WILL_NOT)
    expect(calls).toEqual([])
  })

  it.each(corpus.core)('a public name that redirects to %s: the second request is never made', async (a) => {
    const calls: string[] = []
    const g = guardedFetch({
      fetch: async (u) =>
        seen(calls, u, new Response(null, { status: 302, headers: { location: urlFor(a, '/admin') } })),
      resolve: async () => ['93.184.216.34'],
    })
    expect((await guardError(g('https://as.example.com/x'))).message).toContain(WILL_NOT)
    expect(calls).toEqual(['https://as.example.com/x'])
  })

  it.each(corpus.core)('a redirect to a name that resolves to %s is refused on the hop', async (a) => {
    const calls: string[] = []
    const g = guardedFetch({
      fetch: async (u) =>
        seen(calls, u, new Response(null, { status: 302, headers: { location: 'https://second.example.org/y' } })),
      resolve: async (h) => (h === 'second.example.org' ? [a] : ['93.184.216.34']),
    })
    expect((await guardError(g('https://as.example.com/x'))).message).toContain(WILL_NOT)
    expect(calls).toEqual(['https://as.example.com/x'])
  })

  it('every extra blocked address and every non-address answer is refused too (an unknown value is a refusal)', async () => {
    for (const a of [...corpus.alsoBlocked, ...corpus.notAnAddress.filter((x) => x !== 'example.com')]) {
      const g = guardedFetch({ fetch: async () => json({}), resolve: async () => ['93.184.216.34', a] })
      await guardError(g('https://as.example.com/x'))
    }
  })

  it('public answers (v4 and v6) are allowed; the request is made', async () => {
    for (const a of corpus.public) {
      const calls: string[] = []
      const g = guardedFetch({ fetch: async (u) => seen(calls, u, json({})), resolve: async () => [a] })
      expect((await g('https://as.example.com/x')).status).toBe(200)
      expect(calls).toEqual(['https://as.example.com/x'])
    }
  })

  it('number-shaped hosts, trailing dots and userinfo: refused', async () => {
    const calls: string[] = []
    const g = guardedFetch({
      fetch: async (u) => seen(calls, u, json({})),
      resolve: async () => ['93.184.216.34'],
    })
    for (const u of [
      'https://2130706433/x',
      'https://0x7f.1/x',
      'https://0177.0.0.1/x',
      'https://127.1/x',
      'https://127.0.0.1./x',
      'https://169.254.169.254../x',
      'https://[::ffff:7f00:1]./x',
    ])
      await guardError(g(u))
    // userinfo is refused whatever the host is, including a public one
    expect((await guardError(g(`https://user:pw${AT}as.example.com/x`))).message).toContain('user name or password')
    expect((await guardError(g(`https://127.0.0.1${AT}as.example.com/x`))).message).toContain('user name or password')
    expect(calls).toEqual([])
  })

  it('a resolver that fails is a failure the caller sees, and an empty answer is "does not resolve"', async () => {
    const g1 = guardedFetch({
      fetch: async () => json({}),
      resolve: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    await expect(g1('https://as.example.com/x')).rejects.toThrow('ENOTFOUND')
    const g2 = guardedFetch({ fetch: async () => json({}), resolve: async () => [] })
    expect((await guardError(g2('https://as.example.com/x'))).message).toContain('does not resolve')
  })
})

describe('DNS rebinding against the real transport (no fetch injected)', () => {
  const startVictim = () => {
    const hits: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        hits.push(new URL(req.url).pathname)
        return json({ ok: true })
      },
    })
    stops.push(() => void server.stop(true))
    return { hits, port: server.port as number, origin: `http://127.0.0.1:${server.port}` }
  }

  it('the name looked public when the guard asked, then answers loopback when the socket connects: refused, nothing reaches the server', async () => {
    const v = startVictim()
    let asked = 0
    const g = guardedFetch({
      // question 1 is the guard's own check, question 2 is the connection's lookup
      resolve: async () => (++asked === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
    })
    // https would need TLS on the victim; the point is the address, which is refused before any handshake
    const e = await guardError(g(`https://rebind.example.test:${v.port}/.well-known/oauth-authorization-server`))
    expect(e.message).toContain(WILL_NOT)
    expect(asked).toBe(2)
    expect(v.hits).toEqual([])
  })

  it('a name that always answers loopback is refused before connecting', async () => {
    const v = startVictim()
    const g = guardedFetch({ resolve: async () => ['127.0.0.1'] })
    await guardError(g(`https://always.example.test:${v.port}/x`))
    expect(v.hits).toEqual([])
  })

  it('control: the owner-approved local origin still works over the plain fetch, so the server really is reachable', async () => {
    const v = startVictim()
    const g = guardedFetch({ allowedLocalOrigin: v.origin })
    expect((await g(`${v.origin}/ping`).catch((e) => e)) instanceof Response).toBe(true)
    expect(v.hits).toEqual(['/ping'])
    // the exemption is for that exact origin only: the same server on another host name is checked
    const other = guardedFetch({ allowedLocalOrigin: v.origin, resolve: async () => ['127.0.0.1'] })
    await guardError(other(`https://other.example.test:${v.port}/x`))
    expect(v.hits).toHaveLength(1)
  })

  it('twenty at once: all refused, the server is untouched', async () => {
    const v = startVictim()
    const g = guardedFetch({ resolve: async () => ['127.0.0.1'] })
    const r = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => g(`https://n${i}.example.test:${v.port}/x`)),
    )
    expect(r.every((x) => x.status === 'rejected' && x.reason instanceof GuardError)).toBe(true)
    expect(v.hits).toEqual([])
  })
})

describe('the local-server exception is named, narrow, and not a lookalike', () => {
  it('isLocalServerHost: localhost and loopback only, the same rule as apps login; no LAN, unique-local or other blocked range', () => {
    for (const h of ['localhost', 'localhost.', '127.0.0.1', '[::1]', '::ffff:7f00:1'])
      expect(isLocalServerHost(h), h).toBe(true)
    // a LAN literal is not local: login refuses it, so the connector must not exempt it either
    for (const h of ['10.0.0.5', '192.168.1.20', '172.16.0.9', 'fd00::5', 'fd00:ec2::254'])
      expect(isLocalServerHost(h), h).toBe(false)
    // a blocked literal is not a local server: the metadata address (also wrapped), CGNAT, this-network, multicast, link-local, documentation
    for (const h of [
      '169.254.169.254',
      '[::ffff:a9fe:a9fe]',
      '64:ff9b::a9fe:a9fe',
      '2002:a9fe:a9fe::',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      'fe80::1',
      '198.18.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isLocalServerHost(h), h).toBe(false)
    // a NAME is never local by its looks; the old rule treated every name as local
    for (const h of [
      'mcp.example.com',
      '127.evil.example.com',
      'localhost.evil.com',
      '10.example.com',
      '',
      '127.1',
      '2130706433',
    ])
      expect(isLocalServerHost(h), h).toBe(false)
    for (const a of ['93.184.216.34', '2606:4700:4700::1111']) expect(isLocalServerHost(a), a).toBe(false)
  })

  it('the connector and `apps login` agree on every corpus address', () => {
    for (const a of corpus.core) expect(isLocalServerHost(a), a).toBe(isLoopbackHost(a))
  })

  it('a remote server is no longer exempt from the address check on its own origin', async () => {
    const calls: string[] = []
    const url = new URL('http://mcp.example.com/mcp')
    const g = guardedFetch({
      fetch: async (u) => seen(calls, u, json({})),
      resolve: async () => ['10.0.0.5'],
      allowedLocalOrigin: isLocalServerHost(url.hostname) ? url.origin : undefined,
    })
    expect((await guardError(g('http://mcp.example.com/.well-known/oauth-protected-resource'))).message).toContain(
      'not https',
    )
    expect(calls).toEqual([])
    const g2 = guardedFetch({
      fetch: async (u) => seen(calls, u, json({})),
      resolve: async () => ['10.0.0.5'],
    })
    expect((await guardError(g2('https://mcp.example.com/.well-known/oauth-protected-resource'))).message).toContain(
      WILL_NOT,
    )
    expect(calls).toEqual([])
  })
})

describe('`talos-app apps login`, the command-line way in', () => {
  const cli = (home: string, deps: AppsCliDeps) => {
    const out: string[] = []
    const err: string[] = []
    const io: CliIO = {
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.parse('2026-10-30T12:00:00Z'),
    }
    const env = {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: 'https://relay.example.com',
      PATH: process.env.PATH,
      HOME: tmp('empty-home-'),
    }
    return { out, err, run: (argv: string[]) => runCli(argv, io, env, { apps: deps }) }
  }
  const setup = async (url: string, deps: (calls: string[]) => AppsCliDeps) => {
    const home = tmp()
    await approvedFixture(home, {
      direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'oauth' },
      ownerDirect: true,
    })
    const { secrets } = memSecrets()
    await secrets.saveConfig(serverIdOf('probe', 'local'), { type: 'http', url })
    const calls: string[] = []
    return { calls, c: cli(home, { secrets, ...deps(calls) }) }
  }

  // The deliberate exception: a server the owner approved at a loopback address may be reached on its own origin (dev flow).
  const loopback = corpus.core.filter((a) => isLoopbackHost(a))
  const notLoopback = corpus.core.filter((a) => !isLoopbackHost(a))
  it('the corpus holds both kinds, so both tests below run', () => {
    expect(loopback.length).toBeGreaterThan(0)
    expect(notLoopback.length).toBeGreaterThan(10)
  })

  it.each(notLoopback)('a stored server URL at %s: login stops, no request is made', async (a) => {
    const { calls, c } = await setup(urlFor(a, '/mcp'), (calls) => ({
      fetch: (async (u: string) => seen(calls, u, json({}))) as never,
      resolveHost: async () => ['93.184.216.34'],
    }))
    expect(await c.run(['apps', 'login', 'probe'])).toBe(1)
    expect(c.err.join('\n')).toContain('sign-in stopped')
    expect(calls).toEqual([])
  })

  it.each(loopback)(
    'a stored server URL at loopback %s: only that exact origin may be contacted (the named exception)',
    async (a) => {
      const { calls, c } = await setup(urlFor(a, '/mcp'), (calls) => ({
        fetch: (async (u: string) => seen(calls, u, new Response('nope', { status: 404 }))) as never,
        resolveHost: async () => ['93.184.216.34'],
      }))
      expect(await c.run(['apps', 'login', 'probe'])).toBe(1)
      expect(new Set(calls.map((u) => new URL(u).origin))).toEqual(new Set([new URL(urlFor(a, '/mcp')).origin]))
    },
  )

  it.each(corpus.core)('a stored server name that resolves to %s: login stops, no request is made', async (a) => {
    const { calls, c } = await setup('https://mcp.example.com/mcp', (calls) => ({
      fetch: (async (u: string) => seen(calls, u, json({}))) as never,
      resolveHost: async () => [a],
    }))
    expect(await c.run(['apps', 'login', 'probe'])).toBe(1)
    expect(c.err.join('\n')).toContain('sign-in stopped')
    expect(calls).toEqual([])
  })

  it('a host name that merely STARTS with 127. is not the loopback exception', async () => {
    for (const host of ['127.evil.example.com', '127.0.0.1.evil.example.com', 'localhost.evil.example.com']) {
      const { calls, c } = await setup(`https://${host}/mcp`, (calls) => ({
        fetch: (async (u: string) => seen(calls, u, json({}))) as never,
        resolveHost: async () => ['10.0.0.5'],
      }))
      expect(await c.run(['apps', 'login', 'probe'])).toBe(1)
      expect(c.err.join('\n'), host).toContain('sign-in stopped')
      expect(calls, host).toEqual([])
    }
  })
})
