// The connector's own wiring of the sign-in address check. address-entry-points.test.ts re-builds the local-server option by
// hand; these tests drive the real connector instead, so a wrong line inside `connect` turns them red.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { makeDirectConnector, realDirectConnector } from '../../src/apps/direct.ts'
import { TalosOAuthProvider } from '../../src/apps/direct-oauth.ts'
import { memSecrets } from './helpers.ts'

const realFetch = globalThis.fetch
let calls: Array<{ method: string; url: string }> = []

beforeEach(() => {
  calls = []
  // The MCP endpoint itself goes over the global fetch. Every request that reaches it is recorded; the endpoint asks for sign-in.
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u)
    calls.push({ method: init?.method ?? 'GET', url })
    if (url.includes('/.well-known/')) return new Response('{}', { status: 404 })
    return new Response('', {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
      },
    })
  }) as never
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const provider = () => new TalosOAuthProvider(memSecrets().secrets, 'srv', 'http://127.0.0.1:9/callback')
const signInRequests = () =>
  calls.filter((c) => c.url.includes('/.well-known/') || c.url.includes('/oauth') || c.url.includes('/token'))

describe('realDirectConnector with an OAuth provider: sign-in requests go through the address check', () => {
  for (const url of [
    'http://mcp.example.test/mcp', // a NAME is never local by its looks (the old line made every name local)
    'http://169.254.169.254/mcp', // the cloud metadata address is a blocked literal, not a local server
    'http://[::ffff:a9fe:a9fe]/mcp', // the same address in its mapped form
    'http://[64:ff9b::a9fe:a9fe]/mcp', // NAT64 form of the metadata address
    'http://[2002:a9fe:a9fe::]/mcp', // 6to4 form
    'http://169.254.1.1/mcp', // other link-local
    'http://[fe80::1]/mcp',
    'http://224.0.0.1/mcp', // multicast
    'http://100.64.0.1/mcp', // carrier-grade NAT
    'http://0.0.0.0/mcp',
    'http://192.168.1.20/mcp', // a LAN literal: login refuses it, so the connector must too
    'http://10.0.0.5/mcp',
    'http://172.16.0.9/mcp',
    'http://[fd00::5]/mcp',
    'http://[fd00:ec2::254]/mcp', // the IPv6 metadata address sits inside fc00::/7
  ]) {
    it(`${url}: connect fails and no sign-in request is sent to it`, async () => {
      const e = await realDirectConnector.connect({ type: 'http', url }, { kind: 'oauth', provider: provider() }).then(
        () => undefined,
        (x) => x,
      )
      expect(e).toBeInstanceOf(Error)
      expect(calls.some((c) => c.method === 'POST')).toBe(true) // the harness did reach the sign-in decision
      expect(signInRequests()).toEqual([])
    })
  }

  it('control: an owner-approved local server (a loopback literal) does get its sign-in discovery over the plain fetch', async () => {
    await realDirectConnector
      .connect({ type: 'http', url: 'http://127.0.0.1:9/mcp' }, { kind: 'oauth', provider: provider() })
      .catch(() => {})
    expect(signInRequests().length).toBeGreaterThan(0)
  })

  it('a named https server that resolves to a private address is refused at the address check, and nothing is sent to it', async () => {
    const asked: string[] = []
    const connector = makeDirectConnector({
      resolve: async (h) => {
        asked.push(h)
        return ['10.0.0.5']
      },
    })
    const e = await connector
      .connect({ type: 'http', url: 'https://mcp.example.test/mcp' }, { kind: 'oauth', provider: provider() })
      .then(
        () => undefined,
        (x) => x,
      )
    expect(e).toBeInstanceOf(Error)
    expect(asked).toContain('mcp.example.test') // the guard really resolved and judged the name
    expect(signInRequests()).toEqual([])
  })
})
