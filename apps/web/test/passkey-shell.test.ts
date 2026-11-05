// @vitest-environment node
// WP-I6 / audit O1: step-up in the iPhone shell. Same routes, same passkey, same token; the only new behaviour is that a
// shell that CANNOT run a passkey says so (and before a challenge is issued), instead of a false "cancelled".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }))
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication, startRegistration: vi.fn() }))

import {
  PASSKEY_BLOCK_COPY,
  PasskeyUnavailableError,
  passkeyBlock,
  passkeyErrorCopy,
  prewarmPasskeyGate,
  resetPasskeyGate,
} from '../src/lib/passkeyGate.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

const g = globalThis as Record<string, unknown>
const AASA = '/.well-known/apple-app-site-association'
const OPTIONS = '/api/auth/stepup/options'
let calls: string[] = []
let aasa: Response
let client: SocketClient

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

function asIphoneShell(on: boolean) {
  if (on) {
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    g.PublicKeyCredential = function PublicKeyCredential() {}
  } else {
    delete g.Capacitor
    delete g.PublicKeyCredential
  }
}

beforeEach(() => {
  calls = []
  aasa = json({ error: 'not_found' }, 404)
  resetPasskeyGate()
  startAuthentication.mockReset()
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    if (url === AASA) return aasa.clone()
    if (url.endsWith('/stepup/options')) return json({ challenge: 'c', rpId: 'relay.example.com' })
    if (url.endsWith('/stepup/verify')) return json({ stepup_token: 'st_ok' })
    return json({}, 404)
  })
  client = createSocketClient({ storage: createMemoryStorage(), wsUrl: 'ws://127.0.0.1:1/ws', isOnline: () => true })
})
afterEach(() => {
  client.close()
  asIphoneShell(false)
  vi.unstubAllGlobals()
})

describe('passkey step-up in the iPhone shell', () => {
  it('browser: unchanged. Same options and verify routes, no AASA lookup, a Cancel stays a Cancel', async () => {
    startAuthentication.mockResolvedValue({ id: 'cred' })
    await expect(client.stepup('device:revoke')).resolves.toBe('st_ok')
    expect(calls.some((c) => c === AASA)).toBe(false)
    expect(calls.filter((c) => c.includes('stepup'))).toHaveLength(2)
    const cancel = Object.assign(new Error('x'), { name: 'NotAllowedError' })
    startAuthentication.mockRejectedValue(cancel)
    await expect(client.stepup('device:revoke')).rejects.toBe(cancel)
  })

  it('shell, relay does not serve the AASA: says so, asks for no challenge, never opens a passkey prompt', async () => {
    asIphoneShell(true)
    const err = await client.stepup('device:revoke').catch((e) => e)
    expect(err).toBeInstanceOf(PasskeyUnavailableError)
    expect(err.reason).toBe('not_linked')
    expect(passkeyErrorCopy(err)).toBe(PASSKEY_BLOCK_COPY.not_linked)
    expect(passkeyErrorCopy(err)).not.toMatch(/cancel/i)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(calls).not.toContain(OPTIONS)
  })

  it('Mac app detected from the page scope alone (no installShell): mac_app, no network', async () => {
    const scope: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage() {} } } },
      navigator: { userAgent: 'Mozilla/5.0 TalosDesktop/1.0' },
    }
    scope.top = scope
    expect(await passkeyBlock({ scope })).toBe('mac_app')
    expect(calls).toEqual([])
  })

  it('shell, web view without WebAuthn at all: not_linked, no network', async () => {
    asIphoneShell(true)
    delete g.PublicKeyCredential
    expect(await passkeyBlock()).toBe('not_linked')
    expect(calls).toEqual([])
  })

  it('shell, AASA present: the SAME passkey flow runs (options, prompt, verify) and returns the same token', async () => {
    asIphoneShell(true)
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    startAuthentication.mockResolvedValue({ id: 'cred' })
    await expect(client.stepup('card:c_x')).resolves.toBe('st_ok')
    expect(startAuthentication).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.includes('stepup'))).toEqual([OPTIONS, '/api/auth/stepup/verify'])
  })

  it('shell, AASA present but the prompt is refused: shell_declined, never the false "cancelled"', async () => {
    asIphoneShell(true)
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    startAuthentication.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotAllowedError' }))
    const err = await client.stepup('device:revoke').catch((e) => e)
    expect(err).toBeInstanceOf(PasskeyUnavailableError)
    expect(err.reason).toBe('shell_declined')
    expect(passkeyErrorCopy(err)).toMatch(/Safari or the Home Screen app/)
  })

  it('shell, the check is not cached when it fails: a relay fixed later works without a restart', async () => {
    asIphoneShell(true)
    expect(await passkeyBlock()).toBe('not_linked')
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    expect(await passkeyBlock()).toBeNull()
  })

  it('an AASA with no apps, or junk, or a 404, counts as not linked', async () => {
    asIphoneShell(true)
    for (const bad of [
      json({ webcredentials: { apps: [] } }),
      json({}),
      new Response('<html>', { status: 200 }),
      json({ error: 'not_found' }, 404),
    ]) {
      aasa = bad
      expect(await passkeyBlock()).toBe('not_linked')
    }
  })

  it('audit finding: a relay or network that cannot answer is NOT reported as "not linked"', async () => {
    asIphoneShell(true)
    for (const down of [json({}, 502), json({}, 503), json({}, 500)]) {
      aasa = down
      expect(await passkeyBlock()).toBeNull()
    }
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    expect(await passkeyBlock()).toBeNull()
  })

  it('audit finding: a linked build with a relay hiccup still reaches the prompt, and the real error is the one shown', async () => {
    asIphoneShell(true)
    aasa = json({}, 502)
    startAuthentication.mockResolvedValue({ id: 'cred' })
    await expect(client.stepup('card:c_x')).resolves.toBe('st_ok')
    expect(startAuthentication).toHaveBeenCalledTimes(1)
  })

  it('audit finding: the lookup is done BEFORE the tap, so nothing sits between the tap and the prompt but the challenge', async () => {
    asIphoneShell(true)
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    prewarmPasskeyGate()
    await vi.waitFor(() => expect(calls).toEqual([AASA]))
    await new Promise((r) => setTimeout(r, 0))
    calls = []
    startAuthentication.mockImplementation(async () => {
      // by the time the prompt opens, only the challenge request has gone out: no AASA hop in between
      expect(calls).toEqual([OPTIONS])
      return { id: 'cred' }
    })
    await expect(client.stepup('card:c_x')).resolves.toBe('st_ok')
    expect(calls).not.toContain(AASA)
  })

  it('audit finding: a tap while the lookup is still in flight reuses it (one lookup, not two)', async () => {
    asIphoneShell(true)
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    startAuthentication.mockResolvedValue({ id: 'cred' })
    prewarmPasskeyGate()
    await expect(client.stepup('card:c_x')).resolves.toBe('st_ok')
    expect(calls.filter((c) => c === AASA)).toHaveLength(1)
  })

  it('audit finding: starting the client warms the lookup (iPhone shell only; a browser makes no AASA request)', async () => {
    asIphoneShell(true)
    aasa = json({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    await client.start()
    await vi.waitFor(() => expect(calls).toContain(AASA))
    client.close()
    calls = []
    asIphoneShell(false)
    resetPasskeyGate()
    client = createSocketClient({ storage: createMemoryStorage(), wsUrl: 'ws://127.0.0.1:1/ws', isOnline: () => true })
    await client.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).not.toContain(AASA)
  })

  it('prewarm never throws and does nothing in the Mac app or a browser', async () => {
    expect(() => prewarmPasskeyGate()).not.toThrow()
    expect(calls).toEqual([])
    const scope: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage() {} } } },
      navigator: { userAgent: 'Mozilla/5.0 TalosDesktop/1.0' },
    }
    scope.top = scope
    prewarmPasskeyGate({ scope })
    expect(calls).toEqual([])
  })
})
