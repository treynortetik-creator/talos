// `apps login` must not wait forever on a stalled server (class 9), and the owner must be told why it stopped (class 5).
import { afterEach, describe, expect, it } from 'bun:test'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { guardedFetch, runLogin } from '../../src/apps/direct-oauth.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { memSecrets } from './helpers.ts'

const closers: Array<() => void> = []
afterEach(() => {
  while (closers.length) closers.pop()?.()
})

/** Accepts connections and never answers, or answers the headers and then goes quiet. */
function stalledServer(mode: 'silent' | 'headers-then-silence') {
  const socks = new Set<net.Socket>()
  const s = net.createServer((c) => {
    socks.add(c)
    c.on('error', () => {})
    c.once('data', () => {
      if (mode === 'headers-then-silence')
        c.write('HTTP/1.1 200 ok\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"issuer":')
    })
  })
  return new Promise<{ origin: string }>((ok) =>
    s.listen(0, '127.0.0.1', () => {
      closers.push(() => {
        for (const c of socks) c.destroy()
        s.close()
      })
      ok({ origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}` })
    }),
  )
}

const settle = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e) => e as Error,
  )

describe('a stalled server', () => {
  for (const mode of ['silent', 'headers-then-silence'] as const) {
    it(`${mode}: the approved local origin's request ends with a TimeoutError instead of hanging`, async () => {
      const srv = await stalledServer(mode)
      const g = guardedFetch({ allowedLocalOrigin: srv.origin, timeoutMs: 100 })
      const e = await settle(g(`${srv.origin}/.well-known/oauth-authorization-server`))
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).name).toBe('TimeoutError')
    })
  }

  it('runLogin stops and tells the owner the server did not answer in time', async () => {
    const srv = await stalledServer('silent')
    const { secrets } = memSecrets()
    const lines: string[] = []
    const r = await runLogin({
      serverUrl: `${srv.origin}/mcp`,
      secrets,
      serverId: serverIdOf('stalled', 'local'),
      io: { print: (l) => void lines.push(l), confirm: async () => false },
      guard: { allowedLocalOrigin: srv.origin, timeoutMs: 100 },
    })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('the server did not answer in time')
    expect(lines.join('\n')).not.toContain('Signed in')
  })
})
