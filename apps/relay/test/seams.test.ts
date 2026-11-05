import { generateBridgeKey, signBridgeHttp, signChallenge } from '@talos-app/protocol'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeStepupToken,
  guardWsUpgrade,
  requireSession,
  resetAuthImplementation,
  verifyBridgeHello,
  verifyBridgeHttp,
} from '../src/auth/contract.ts'
import { registerModules } from '../src/modules.ts'
import type { AppEnv } from '../src/services.ts'
import { createFakeServices, testEnv } from './helpers/fake-services.ts'
import { installTestAuth, mintTestStepup, testAppHeaders } from './helpers/test-auth.ts'

afterEach(() => resetAuthImplementation())

function guardApp() {
  const f = createFakeServices()
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', f.services)
    await next()
  })
  app.get('/secret', requireSession, (c) => c.text('ok'))
  app.get('/ws', async (c) => {
    const r = await guardWsUpgrade(c)
    return r instanceof Response ? r : c.json(r)
  })
  app.post('/hash', async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    return c.json(await verifyBridgeHttp(c, body))
  })
  return { app, f }
}

describe('relay seams', () => {
  it('guards deny everything until WP2 installs an implementation', async () => {
    const { app } = guardApp()
    expect((await app.request('/secret', { headers: { 'X-Test-Session': 'none' } })).status).toBe(401)
    expect((await app.request('/ws', { headers: testAppHeaders('https://relay.example.com') })).status).toBe(401)
    expect(await consumeStepupToken({ token: 'st_x', purpose: 'config:work', session: null })).toBe(false)
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: '0'.repeat(16), sig: 'x' },
          challenge: { nonce: 'n', relay_host: 'h', server_time: 1 },
          ip: '203.0.113.9',
        })
      ).ok,
    ).toBe(false)
  })

  it('X-Test-Session works only when test auth is installed', async () => {
    const { app } = guardApp()
    installTestAuth()
    expect((await app.request('/secret', { headers: { 'X-Test-Session': 'none' } })).status).toBe(200)
    expect((await app.request('/secret')).status).toBe(401)
  })

  it('test-auth WS guard: session header and Origin, 401 and 403 otherwise', async () => {
    const { app } = guardApp()
    installTestAuth()
    expect((await app.request('/ws', { headers: testAppHeaders('https://relay.example.com', 'd_abc') })).status).toBe(
      200,
    )
    expect((await app.request('/ws', { headers: { Origin: 'https://relay.example.com' } })).status).toBe(401)
    expect((await app.request('/ws', { headers: testAppHeaders('https://evil.example.net') })).status).toBe(403)
  })

  it('test-auth step-up tokens are single use and bound to a purpose', async () => {
    installTestAuth()
    const t = mintTestStepup('config:work')
    expect(await consumeStepupToken({ token: t, purpose: 'device:revoke', session: null })).toBe(false)
    expect(await consumeStepupToken({ token: t, purpose: 'config:work', session: null })).toBe(true)
    expect(await consumeStepupToken({ token: t, purpose: 'config:work', session: null })).toBe(false)
    expect(await consumeStepupToken({ token: 'st_made_up', purpose: 'config:work', session: null })).toBe(false)
  })

  it('test-auth verifies bridge hello and HTTP signatures for real when given the key', async () => {
    const key = await generateBridgeKey()
    const other = await generateBridgeKey()
    installTestAuth({ bridgeKey: key })
    const challenge = { nonce: 'A'.repeat(43), relay_host: 'relay.example.com', server_time: 1 }
    const good = await verifyBridgeHello({
      hello: { key_id: key.keyId, sig: await signChallenge(key.privateKey, challenge) },
      challenge,
      ip: '203.0.113.9',
    })
    expect(good).toEqual({ ok: true, keyId: key.keyId })
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: key.keyId, sig: await signChallenge(other.privateKey, challenge) },
          challenge,
          ip: 'x',
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: '0'.repeat(16), sig: await signChallenge(key.privateKey, challenge) },
          challenge,
          ip: 'x',
        })
      ).ok,
    ).toBe(false)

    const { app } = guardApp()
    const body = '{"a":1}'
    const header = await signBridgeHttp({
      privateKey: key.privateKey,
      keyId: key.keyId,
      method: 'POST',
      pathWithQuery: '/hash',
      body,
    })
    const post = (h?: string, b = body) =>
      app.request('/hash', { method: 'POST', body: b, headers: h ? { authorization: h } : {} })
    expect(await (await post(header)).json()).toMatchObject({ ok: true })
    expect(await (await post(header)).json()).toMatchObject({ ok: false }) // nonce replay
    expect(await (await post(undefined)).json()).toMatchObject({ ok: false })
    const h2 = await signBridgeHttp({
      privateKey: key.privateKey,
      keyId: key.keyId,
      method: 'POST',
      pathWithQuery: '/hash',
      body,
    })
    expect(await (await post(h2, '{"a":2}')).json()).toMatchObject({ ok: false })
  })

  it('registerModules boots in test, and refuses to boot with the test hook outside NODE_ENV=test', async () => {
    installTestAuth()
    await expect(registerModules(createFakeServices().services)).resolves.toBeUndefined()
    const prod = createFakeServices().services
    prod.env = testEnv({
      NODE_ENV: 'production',
      VAPID_PUBLIC_KEY: 'a',
      VAPID_PRIVATE_KEY: 'b',
      VAPID_SUBJECT: 'mailto:owner@example.com',
    })
    await expect(registerModules(prod)).rejects.toThrow(/refusing to boot/)
    resetAuthImplementation()
    await expect(registerModules(prod)).resolves.toBeUndefined()
  })
})
