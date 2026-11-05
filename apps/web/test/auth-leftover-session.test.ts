// PR #100 review, finding 9: a native shell that still holds the session of an EARLIER setup code (burned, expired, or the
// Mac said N) is "signed in" but unpinned. The relay pins a setup-code session only with the code that minted it, so the new
// code sent on that old session was refused 410 and each retry counted toward burning the new code. The shell now trades the
// new code for a fresh session first. A pinned session, and a browser with a passkey session, are left alone.
import { createExtractableDeviceKeyForTests, newEnrollCode } from '@talos-app/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runEnrollment } from '../src/features/auth/passkeys.ts'
import { useSession } from '../src/features/auth/session.ts'
import type { SocketClient } from '../src/lib/socketClient.ts'

const g = globalThis as Record<string, unknown>
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  useSession.setState({ status: 'loading', me: null, offline: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete g.Capacitor
})

async function run(opts: { shell: boolean; pinned: boolean }) {
  const reconnects: string[] = []
  if (opts.shell) g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
  const key = await createExtractableDeviceKeyForTests()
  const calls: string[] = []
  let session = 'old' // which session the cookie jar holds
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/me') return json(200, { device_pinned: opts.pinned && session === 'old', has_passkey: false })
      if (url === '/api/auth/enroll/session') {
        session = 'fresh'
        return json(200, { ok: true })
      }
      // the relay: a session made by another code cannot pin with this one
      if (url === '/api/auth/device/verify') return session === 'fresh' ? json(202, { accepted: true }) : json(410, {})
      return json(404, {})
    }),
  )
  const client = {
    ensureDevice: async () => key,
    reconnect: () => reconnects.push(session),
  } as unknown as SocketClient
  const out = await runEnrollment(newEnrollCode(), client).then(
    () => 'ok',
    (e: Error) => e.name,
  )
  return { calls, out, reconnects }
}

describe('runEnrollment in a native shell that kept an old unpinned session', () => {
  it('trades the new code for a fresh session BEFORE device/verify, and pairs', async () => {
    const r = await run({ shell: true, pinned: false })
    expect(r.out).toBe('ok')
    const order = r.calls.filter((u) => u !== '/api/me')
    expect(order).toEqual(['/api/auth/enroll/session', '/api/auth/device/verify'])
  })

  it('reconnects the socket after the session swap, so a limited socket on the old session is replaced', async () => {
    const r = await run({ shell: true, pinned: false })
    expect(r.reconnects).toEqual(['fresh'])
  })

  it('a pinned session in the shell is left alone: no enroll/session', async () => {
    const r = await run({ shell: true, pinned: true })
    expect(r.calls).not.toContain('/api/auth/enroll/session')
  })

  it('a browser with an existing passkey session is left alone: no enroll/session', async () => {
    const r = await run({ shell: false, pinned: false })
    expect(r.calls).not.toContain('/api/auth/enroll/session')
    expect(r.calls).toContain('/api/auth/device/verify')
  })
})
