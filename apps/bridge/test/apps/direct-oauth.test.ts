import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { fakeClock } from '@talos-app/testkit'
import {
  bunCallbackListener,
  checkUrlSyntax,
  escapeForTerminal,
  GuardError,
  guardedFetch,
  isBlockedAddress,
  type ListenFn,
  runLogin,
  TalosOAuthProvider,
} from '../../src/apps/direct-oauth.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { memSecrets, tmp } from './helpers.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('address classification (M5.6)', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'febf::1',
    'fc00::',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.5',
    '::ffff:a00:5',
    '::10.0.0.5',
    '0:0:0:0:0:0:0:1',
    '[::1]',
    '64:ff9b::7f00:1',
    '::ffff:169.254.169.254',
    'not-an-address',
    '1.2.3',
    '300.1.1.1',
    '',
  ]
  const open = [
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '100.63.255.255',
    '192.169.0.1',
    '2606:4700:4700::1111',
    '::ffff:93.184.216.34',
    '2606:4700:4700::1001',
  ]
  for (const a of blocked) it(`blocks ${a || '(empty)'}`, () => expect(isBlockedAddress(a)).toBe(true))
  for (const a of open) it(`allows ${a}`, () => expect(isBlockedAddress(a)).toBe(false))
})

describe('the guard (E19, every case as a unit test)', () => {
  const json = (o: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(o), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  const rig = (
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
    resolveMap: Record<string, string[]> = {},
    allowedLocalOrigin?: string,
  ) => {
    const calls: string[] = []
    const resolved: string[] = []
    const g = guardedFetch({
      fetch: async (u, i) => {
        calls.push(String(u))
        return handler(String(u), i)
      },
      resolve: async (h) => {
        resolved.push(h)
        return resolveMap[h] ?? ['93.184.216.34']
      },
      allowedLocalOrigin,
    })
    return { g, calls, resolved }
  }
  const refuses = async (p: Promise<unknown>, part: string) => {
    const e = await p.then(
      () => undefined,
      (x) => x,
    )
    expect(e).toBeInstanceOf(GuardError)
    expect((e as Error).message).toContain(part)
  }

  it('an http: authorization server is refused before any request', async () => {
    const r = rig(() => json({}))
    await refuses(r.g('http://as.example.com/.well-known/oauth-authorization-server'), 'not https')
    expect(r.calls).toEqual([])
  })
  it('https://127.0.0.1:port and hosts that resolve to 10.0.0.5, 169.254.169.254, 100.64.0.1, ::1, fd00::1, ::ffff:127.0.0.1 never get a request', async () => {
    const r = rig(() => json({}), {
      'a.example.com': ['10.0.0.5'],
      'b.example.com': ['169.254.169.254'],
      'c.example.com': ['100.64.0.1'],
      'd.example.com': ['::1'],
      'e.example.com': ['fd00::1'],
      'f.example.com': ['::ffff:127.0.0.1'],
      'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
    })
    for (const u of [
      'https://127.0.0.1:9443/x',
      'https://[::1]:9443/x',
      'https://a.example.com/x',
      'https://b.example.com/x',
      'https://c.example.com/x',
      'https://d.example.com/x',
      'https://e.example.com/x',
      'https://f.example.com/x',
      'https://mixed.example.com/x',
    ])
      await refuses(r.g(u), 'address Talos will not contact')
    expect(r.calls).toEqual([])
  })
  it('a host that does not resolve is refused', async () => {
    const r = rig(() => json({}), { 'nx.example.com': [] })
    await refuses(r.g('https://nx.example.com/x'), 'does not resolve')
  })
  it("the approved server's own local origin is allowed, and only that exact origin (a different local port is not)", async () => {
    const r = rig(() => json({ ok: true }), {}, 'http://127.0.0.1:4100')
    const ok = await r.g('http://127.0.0.1:4100/.well-known/oauth-protected-resource')
    expect(ok.status).toBe(200)
    await refuses(r.g('http://127.0.0.1:4101/x'), 'not https')
    await refuses(r.g('https://127.0.0.1:4100/x'), 'address Talos will not contact') // same host, different scheme: not the approved origin
    expect(r.calls).toEqual(['http://127.0.0.1:4100/.well-known/oauth-protected-resource'])
  })
  it('userinfo, an over-long URL, and an unparseable URL are refused', async () => {
    const r = rig(() => json({}))
    const withUserinfo = new URL('https://as.example.com/x')
    withUserinfo.username = 'user'
    withUserinfo.password = 'pw'
    await refuses(r.g(withUserinfo.toString()), 'user name or password')
    await refuses(r.g(`https://as.example.com/${'a'.repeat(5000)}`), 'over 4096')
    await refuses(r.g('not a url'), 'does not parse')
    expect(r.calls).toEqual([])
  })
  it('an issuer that does not match the URL it was fetched for is refused', async () => {
    const r = rig(() =>
      json({
        issuer: 'https://evil.example.net',
        authorization_endpoint: 'https://as.example.com/a',
        token_endpoint: 'https://as.example.com/t',
      }),
    )
    await refuses(r.g('https://as.example.com/.well-known/oauth-authorization-server'), 'different issuer')
    const good = rig(() =>
      json({
        issuer: 'https://as.example.com',
        authorization_endpoint: 'https://as.example.com/a',
        token_endpoint: 'https://as.example.com/t',
      }),
    )
    expect((await good.g('https://as.example.com/.well-known/oauth-authorization-server')).status).toBe(200)
    const path = rig(() =>
      json({ issuer: 'https://as.example.com/tenant1', token_endpoint: 'https://as.example.com/t' }),
    )
    expect((await path.g('https://as.example.com/.well-known/oauth-authorization-server/tenant1')).status).toBe(200)
    expect((await path.g('https://as.example.com/tenant1/.well-known/openid-configuration')).status).toBe(200)
    const noIssuer = rig(() => json({ token_endpoint: 'https://as.example.com/t' }))
    await refuses(noIssuer.g('https://as.example.com/.well-known/oauth-authorization-server'), 'no issuer')
  })
  it('endpoints named in metadata are checked too: an http token endpoint, a registration endpoint with userinfo', async () => {
    const r = rig(() => json({ issuer: 'https://as.example.com', token_endpoint: 'http://as.example.com/t' }))
    await refuses(r.g('https://as.example.com/.well-known/oauth-authorization-server'), 'not https')
    const bad = new URL('https://as.example.com/r')
    bad.username = 'u'
    bad.password = 'p'
    const r2 = rig(() => json({ issuer: 'https://as.example.com', registration_endpoint: bad.toString() }))
    await refuses(r2.g('https://as.example.com/.well-known/oauth-authorization-server'), 'user name or password')
    const r3 = rig(() =>
      json({ resource: 'https://r.example.com', authorization_servers: ['http://evil.example.com'] }),
    )
    await refuses(r3.g('https://r.example.com/.well-known/oauth-protected-resource'), 'not https')
  })
  it('an authorization_endpoint with shell syntax or a terminal escape is just text: nothing runs, the escape is printed escaped', async () => {
    const ep = 'https://x.example/$(touch /tmp/talos-pwn)'
    const r = rig(() =>
      json({
        issuer: 'https://as.example.com',
        authorization_endpoint: ep,
        token_endpoint: 'https://as.example.com/t',
      }),
    )
    const res = await r.g('https://as.example.com/.well-known/oauth-authorization-server')
    expect((await res.json()).authorization_endpoint).toBe(ep)
    expect(existsSync('/tmp/talos-pwn')).toBe(false)
    const esc = 'https://x.example/\u001b[2J\u001b]0;pwned\u0007'
    expect(escapeForTerminal(esc)).not.toContain('\u001b')
    expect(escapeForTerminal(esc)).toContain('\\x1b')
    expect(escapeForTerminal('a b')).toContain('\\x2028')
  })
  it('redirects: 3 hops are followed (each re-checked), the 4th is refused, a redirect to a blocked address never gets a request', async () => {
    let hop = 0
    const chain = rig((_url) => {
      hop++
      return hop <= 4
        ? new Response(null, { status: 302, headers: { location: `https://as.example.com/h${hop}` } })
        : json({ ok: true })
    })
    await refuses(chain.g('https://as.example.com/start'), 'more than 3 redirects')
    expect(chain.calls.length).toBe(4)
    const three = rig((url) =>
      url.endsWith('/h3')
        ? json({ done: true })
        : new Response(null, {
            status: 302,
            headers: { location: `https://as.example.com/h${Number(url.slice(-1) === 't' ? 0 : url.slice(-1)) + 1}` },
          }),
    )
    expect((await three.g('https://as.example.com/start')).status).toBe(200)
    const evil = rig(
      () => new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } }),
      { 'internal.example.com': ['10.0.0.5'] },
    )
    await refuses(evil.g('https://as.example.com/start'), 'address Talos will not contact')
    expect(evil.calls).toEqual(['https://as.example.com/start'])
    const toHttp = rig(() => new Response(null, { status: 302, headers: { location: 'http://as.example.com/x' } }))
    await refuses(toHttp.g('https://as.example.com/start'), 'not https')
    const post = rig(() => new Response(null, { status: 307, headers: { location: 'https://as.example.com/y' } }))
    await refuses(post.g('https://as.example.com/token', { method: 'POST', body: 'x' }), 'was redirected')
  })
  it('a 2 MiB body is refused; so is a 200 that is not JSON', async () => {
    const big = rig(
      () => new Response('x'.repeat(2 * 1024 * 1024), { headers: { 'content-type': 'application/json' } }),
    )
    await refuses(big.g('https://as.example.com/m'), 'over 1 MiB')
    const html = rig(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    await refuses(html.g('https://as.example.com/m'), 'not JSON')
    const bad = rig(() => new Response('{nope', { headers: { 'content-type': 'application/json' } }))
    await refuses(bad.g('https://as.example.com/m'), 'not valid JSON')
    const err = rig(() => new Response('denied', { status: 401, headers: { 'content-type': 'text/plain' } }))
    expect((await err.g('https://as.example.com/m')).status).toBe(401) // errors pass through (capped) for the SDK to read
  })
  it('syntax check is exported and used standalone', () => {
    expect(checkUrlSyntax('https://a.example.com/x').host).toBe('a.example.com')
    expect(() => checkUrlSyntax('http://a.example.com')).toThrow(GuardError)
    expect(checkUrlSyntax('http://127.0.0.1:1/x', 'http://127.0.0.1:1').port).toBe('1')
  })
})

// ---- a local test authorization server (fixture, test-only) ------------------------------------------------------------

type AsLog = { registered: unknown[]; tokenGrants: string[]; authorizeHits: number }
function startAs(opts: { mcpPath?: string } = {}) {
  const log: AsLog = { registered: [], tokenGrants: [], authorizeHits: 0 }
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const mcp = opts.mcpPath ?? '/mcp'
  let origin = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
      if (u.pathname === mcp)
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcp}"`,
          },
        })
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return j({ resource: `${origin}${mcp}`, authorization_servers: [origin] })
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server'))
        return j({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      if (u.pathname === '/register' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>
        log.registered.push(body)
        return j({ ...body, client_id: 'client-1' }, 201)
      }
      if (u.pathname === '/authorize') {
        log.authorizeHits++
        const code = `code-${log.authorizeHits}`
        codes.set(code, {
          challenge: u.searchParams.get('code_challenge') ?? '',
          redirect: u.searchParams.get('redirect_uri') ?? '',
        })
        const to = new URL(u.searchParams.get('redirect_uri') ?? '')
        to.searchParams.set('code', code)
        to.searchParams.set('state', u.searchParams.get('state') ?? '')
        return new Response(null, { status: 302, headers: { location: to.toString() } })
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text())
        const grant = form.get('grant_type') ?? ''
        log.tokenGrants.push(grant)
        if (grant === 'authorization_code') {
          const c = codes.get(form.get('code') ?? '')
          const verifier = form.get('code_verifier') ?? ''
          const challenge = createHash('sha256').update(verifier).digest('base64url')
          if (!c || c.challenge !== challenge || c.redirect !== form.get('redirect_uri'))
            return j({ error: 'invalid_grant' }, 400)
          return j({ access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1', expires_in: 3600 })
        }
        if (grant === 'refresh_token' && form.get('refresh_token') === 'rt-1')
          return j({ access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-1', expires_in: 3600 })
        return j({ error: 'invalid_grant' }, 400)
      }
      return new Response('nf', { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  cleanups.push(() => void server.stop(true))
  return { origin, url: `${origin}${mcp}`, log, server }
}

describe('apps login against a local test authorization server', () => {
  const io = () => {
    const lines: string[] = []
    const asked: string[] = []
    return {
      lines,
      asked,
      io: {
        print: (l: string) => void lines.push(l),
        confirm: async (q: string) => {
          asked.push(q)
          return false
        },
      },
    }
  }
  /** The "browser": opens the printed URL, follows the authorize redirect, hits the loopback callback. */
  const browse = async (lines: string[], state?: (s: string) => string) => {
    let url = ''
    for (let i = 0; i < 100 && !url; i++) {
      url = lines.find((l) => l.startsWith('http://127.0.0.1')) ?? ''
      if (!url) await new Promise((r) => setTimeout(r, 10))
    }
    expect(url).not.toBe('')
    const res = await fetch(url, { redirect: 'manual' })
    const loc = new URL(res.headers.get('location') as string)
    if (state) loc.searchParams.set('state', state(loc.searchParams.get('state') ?? ''))
    return { callback: loc, hit: () => fetch(loc) }
  }

  it('full flow: PKCE S256, dynamic registration, tokens in the Keychain only, nothing token-like on disk, no opener spawned', async () => {
    const as = startAs()
    const { secrets, kc } = memSecrets()
    const t = io()
    const spawns: unknown[] = []
    const realSpawn = Bun.spawn
    ;(Bun as { spawn: unknown }).spawn = (...a: unknown[]) => {
      spawns.push(a)
      return (realSpawn as (...x: unknown[]) => unknown)(...a)
    }
    cleanups.push(() => {
      ;(Bun as { spawn: unknown }).spawn = realSpawn
    })
    const id = serverIdOf('probe', 'local')
    const done = runLogin({
      serverUrl: as.url,
      secrets,
      serverId: id,
      io: t.io,
      guard: { allowedLocalOrigin: as.origin },
    })
    const b = await browse(t.lines)
    expect((await b.hit()).status).toBe(200)
    expect(await done).toEqual({ ok: true })
    expect(spawns).toEqual([]) // nothing was opened for the owner
    // dynamic registration happened, with a loopback redirect
    expect(as.log.registered.length).toBe(1)
    expect((as.log.registered[0] as { redirect_uris: string[] }).redirect_uris[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    // tokens and the registration are in the Keychain only
    const stored = (await secrets.loadOauth(id)) as {
      tokens: { access_token: string; refresh_token: string }
      client_info: { client_id: string }
    }
    expect(stored.tokens.access_token).toBe('at-1')
    expect(stored.client_info.client_id).toBe('client-1')
    expect([...kc.items.keys()]).toEqual([`${id}/oauth`])
    expect(t.lines.join('\n')).not.toContain('at-1')
    // printed: who signs in where, and the URL verbatim
    expect(t.lines[0]).toBe(
      `Signing in to 127.0.0.1:${new URL(as.origin).port} through 127.0.0.1:${new URL(as.origin).port}.`,
    )
    expect(t.lines.some((l) => l.startsWith('Open this address in your browser'))).toBe(true)
    expect(t.asked).toEqual([]) // same site: no "different sites" question
  })
  it('refresh goes through the guarded fetch and stores the new token', async () => {
    const as = startAs()
    const { secrets } = memSecrets()
    const id = serverIdOf('probe', 'local')
    const t = io()
    const done = runLogin({
      serverUrl: as.url,
      secrets,
      serverId: id,
      io: t.io,
      guard: { allowedLocalOrigin: as.origin },
    })
    await (await browse(t.lines)).hit()
    await done
    const seen: string[] = []
    const g = guardedFetch({
      allowedLocalOrigin: as.origin,
      fetch: async (u, i) => {
        seen.push(String(u))
        return fetch(u, i)
      },
    })
    const provider = new TalosOAuthProvider(secrets, id, 'http://127.0.0.1/callback')
    expect(await auth(provider, { serverUrl: as.url, fetchFn: g })).toBe('AUTHORIZED')
    expect(as.log.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
    expect(seen.some((u) => u.endsWith('/token'))).toBe(true)
    expect(((await secrets.loadOauth(id)) as { tokens: { access_token: string } }).tokens.access_token).toBe('at-2')
  })
  it('a callback with the wrong state is rejected and does not finish the login; the right one then does', async () => {
    const as = startAs()
    const { secrets } = memSecrets()
    const t = io()
    const done = runLogin({
      serverUrl: as.url,
      secrets,
      serverId: serverIdOf('p', 'l'),
      io: t.io,
      guard: { allowedLocalOrigin: as.origin },
    })
    const b = await browse(t.lines)
    const forged = new URL(b.callback)
    forged.searchParams.set('state', `${forged.searchParams.get('state')}x`)
    expect((await fetch(forged)).status).toBe(400)
    const none = new URL(b.callback)
    none.searchParams.delete('state')
    expect((await fetch(none)).status).toBe(400)
    const other = new URL(b.callback)
    other.pathname = '/other'
    expect((await fetch(other)).status).toBe(404)
    expect((await b.hit()).status).toBe(200)
    expect(await done).toEqual({ ok: true })
    // one use: the listener is gone after the first valid callback
    await new Promise((r) => setTimeout(r, 120))
    await expect(fetch(b.callback)).rejects.toBeDefined()
  })
  it('the listener is bound to 127.0.0.1 and closes after five minutes (fake clock)', async () => {
    const clock = fakeClock()
    let host = ''
    const listen: ListenFn = async (o) => {
      const l = await bunCallbackListener({
        ...o,
        setTimer: (f, ms) => clock.setTimeout(f, ms),
        clearTimer: (h) => clock.clearTimeout(h),
      })
      host = l.host
      return l
    }
    const as = startAs()
    const { secrets } = memSecrets()
    const t = io()
    const done = runLogin({
      serverUrl: as.url,
      secrets,
      serverId: serverIdOf('p', 'l'),
      io: t.io,
      guard: { allowedLocalOrigin: as.origin },
      listen,
    })
    await browse(t.lines)
    clock.advance(5 * 60_000 - 1)
    const early = await Promise.race([done.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 30))])
    expect(early).toBe('waiting')
    clock.advance(2)
    const r = await done
    expect(r).toEqual({ ok: false, reason: 'timed out waiting for the sign-in (5 minutes)' })
    expect(host).toBe('127.0.0.1')
  })
  it('different sites: the owner is asked, and N stops before anything is printed to open', async () => {
    const fake = {
      resolve: async () => ['93.184.216.34'],
      fetch: (async (u: string | URL) => {
        const s = String(u)
        const j = (o: unknown, status = 200) =>
          new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
        if (s.includes('oauth-protected-resource'))
          return j({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.other.example.net'],
          })
        if (s.includes('oauth-authorization-server'))
          return j({
            issuer: 'https://auth.other.example.net',
            authorization_endpoint: 'https://auth.other.example.net/authorize',
            token_endpoint: 'https://auth.other.example.net/token',
            registration_endpoint: 'https://auth.other.example.net/register',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          })
        if (s.endsWith('/register')) return j({ client_id: 'c', redirect_uris: [] }, 201)
        return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      }) as typeof fetch,
    }
    const { secrets } = memSecrets()
    const t = io()
    const r = await runLogin({
      serverUrl: 'https://mcp.example.com/mcp',
      secrets,
      serverId: serverIdOf('p', 'l'),
      io: t.io,
      guard: fake,
    })
    expect(r).toEqual({ ok: false, reason: 'stopped at your request' })
    expect(t.asked.length).toBe(1)
    expect(t.asked[0]).toContain(
      'These are different sites. Continue only if you expect auth.other.example.net to sign you in to mcp.example.com.',
    )
    expect(t.lines).toEqual(['Signing in to mcp.example.com through auth.other.example.net.'])
    expect(t.lines.join('\n')).not.toContain('Open this address')
  })
  it('a hostile server: discovery that names a blocked authorization server stops with the reason and the blocked listener sees nothing', async () => {
    const hits: string[] = []
    const victim = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (r) => {
        hits.push(r.url)
        return Response.json({})
      },
    })
    cleanups.push(() => void victim.stop(true))
    let hostilePort = 0
    const hostile = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        const origin = `http://127.0.0.1:${hostilePort}`
        if (u.pathname === '/mcp') return new Response('', { status: 401 })
        if (u.pathname.startsWith('/.well-known/oauth-protected-resource'))
          return new Response(
            JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`http://127.0.0.1:${victim.port}`] }),
            { headers: { 'content-type': 'application/json' } },
          )
        return new Response('nf', { status: 404 })
      },
    })
    hostilePort = hostile.port as number
    cleanups.push(() => void hostile.stop(true))
    const { secrets } = memSecrets()
    const t = io()
    const origin = `http://127.0.0.1:${hostilePort}`
    const r = await runLogin({
      serverUrl: `${origin}/mcp`,
      secrets,
      serverId: serverIdOf('p', 'l'),
      io: t.io,
      guard: { allowedLocalOrigin: origin },
    })
    expect(r.ok).toBe(false)
    expect(hits).toEqual([]) // nothing reached the other local listener
    expect(t.lines.join('\n')).not.toContain('Open this address')
  })
  it('nothing token-like is written under a home directory by the flow', async () => {
    const home = tmp()
    const as = startAs()
    const { secrets } = memSecrets()
    const t = io()
    const done = runLogin({
      serverUrl: as.url,
      secrets,
      serverId: serverIdOf('p', 'l'),
      io: t.io,
      guard: { allowedLocalOrigin: as.origin },
    })
    await (await browse(t.lines)).hit()
    await done
    expect(readdirSync(home)).toEqual([])
  })
})

describe('the request time limit on the approved local origin', () => {
  const slow = async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        await new Promise((r) => setTimeout(r, 100))
        return Response.json({})
      },
    })
    cleanups.push(() => server.stop(true))
    return server
  }
  it('timeoutMs 0 means no limit (as in the guarded fetch): a slow local answer still arrives', async () => {
    const s = await slow()
    const g = guardedFetch({ allowedLocalOrigin: s.url.origin, timeoutMs: 0 } as never)
    expect(await (await g(`${s.url.origin}/x`)).text()).toBe('{}')
  })
  it('a positive limit shorter than the answer stops the request with a TimeoutError', async () => {
    const s = await slow()
    const g = guardedFetch({ allowedLocalOrigin: s.url.origin, timeoutMs: 10 } as never)
    const e = await g(`${s.url.origin}/x`).then(
      () => undefined,
      (x) => x,
    )
    expect((e as Error)?.name).toBe('TimeoutError')
  })
})
