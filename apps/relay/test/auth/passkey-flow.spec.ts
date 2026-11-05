// Passkey registration, sign-in, step-up and the two-half enrollment against an in-process relay, in Chromium with a
// CDP virtual authenticator (spec 9, WP2 acceptance). The page under test is a ~30-line harness served by the test.
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import {
  bindingMac,
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  loginProofCodeId,
  newEnrollCode,
  signDeviceProof,
} from '@talos-app/protocol'
import { type Harness, makeHarness } from './helpers.ts'

// Some sandboxes ship a Chromium whose revision differs from the one this Playwright pins.
if (process.env.TALOS_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.TALOS_CHROMIUM } })

const HARNESS = `<!doctype html><meta charset=utf-8><title>harness</title><script>
const call = async (path, body, method = 'POST') => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-talos-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
window.call = call
window.register = async (code_auth) => {
  const o = await call('/api/auth/enroll/options', { code_auth })
  if (o.status !== 200) return o
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(o.body) })
  return call('/api/auth/enroll/verify', { code_auth, response: cred.toJSON(), device_name: 'Harness passkey' })
}
window.assert = async (optionsPath, verifyPath, extra) => {
  const o = await call(optionsPath, extra && extra.purpose ? { purpose: extra.purpose } : {})
  const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(o.body) })
  return call(verifyPath, { ...extra, response: cred.toJSON() })
}
</script>`

type Relay = { h: Harness; origin: string; close(): Promise<void> }

async function startRelay(): Promise<Relay> {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
  const origin = `http://localhost:${port}`
  const h = await makeHarness({ origin })
  h.app.get('/__harness', (c) => c.html(HARNESS))
  const server = serve({ fetch: h.app.fetch, port, hostname: '127.0.0.1' })
  return { h, origin, close: () => new Promise((r) => server.close(() => r())) }
}

async function jar(
  browserContext: BrowserContext,
  relay: Relay,
  ip: string,
): Promise<{ page: Page; authenticator: string; cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> }> {
  const page = await browserContext.newPage()
  await browserContext.setExtraHTTPHeaders({ 'X-Forwarded-For': ip })
  const cdp = await browserContext.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(`${relay.origin}/__harness`)
  return { page, authenticator: authenticatorId, cdp }
}

async function newCode(relay: Relay, ttlMs = 600_000) {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const res = await relay.h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(relay.h.fake.clock.now() + ttlMs).toISOString(),
  })
  expect(res.status).toBe(200)
  return { code, codeAuth }
}

type Reply = { status: number; body: Record<string, unknown> | null }
const call = (page: Page, path: string, body?: unknown, method = 'POST') =>
  page.evaluate(([p, b, m]) => (window as unknown as { call(...a: unknown[]): Promise<Reply> }).call(p, b, m), [
    path,
    body,
    method,
  ] as const)

async function deviceBody(code: string, codeAuth: string, name = 'Harness device') {
  const k = await createExtractableDeviceKeyForTests()
  return {
    key: k,
    body: {
      device: { id: k.deviceId, name, pubkey_jwk: k.publicJwk },
      binding: bindingMac(deriveEnrollBind(code), k.deviceId, k.publicJwk),
      code_auth: codeAuth,
    },
  }
}

let relay: Relay
test.beforeEach(async () => {
  relay = await startRelay()
})
test.afterEach(async () => {
  await relay.close()
})

test('enroll with a valid code sets the exact cookie, binds the device key, and reuse is 410', async ({ browser }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.1')
  const { code, codeAuth } = await newCode(relay)

  const seen: string[] = []
  page.on('response', async (r) => {
    if (r.url().endsWith('/enroll/verify')) seen.push(((await r.allHeaders())['set-cookie'] ?? '') as string)
  })
  const reg = await page.evaluate(
    (c) => (window as unknown as { register(c: string): Promise<Reply> }).register(c),
    codeAuth,
  )
  expect(reg).toEqual({ status: 200, body: { ok: true } })

  const cookies = (await ctx.cookies()).filter((c) => c.name === '__Host-talos_s')
  expect(cookies).toHaveLength(1)
  expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' })
  expect(cookies[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect((cookies[0]?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(29 * 86400)
  await expect.poll(() => seen.length).toBe(1)
  expect(seen[0]).toMatch(
    /^__Host-talos_s=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
  )

  // half 2: the device key, with no WebAuthn registration involved
  const { key, body } = await deviceBody(code, codeAuth)
  const before = await call(page, '/api/me', undefined, 'GET')
  expect(before.body).toMatchObject({ device_pinned: false, has_passkey: true })
  expect((await call(page, '/api/auth/device/verify', body)).status).toBe(202)
  const unpinned = await call(page, '/api/me', undefined, 'GET')
  expect(unpinned.body).toMatchObject({ device_id: key.deviceId, device_pinned: false })

  // the Mac answers y
  await relay.h.fake.bus.injectBridgeFrame({
    v: 1,
    type: 'device.pinned',
    id: '01JBF3V7Q8K2M4N6P8R0S2T41N',
    ts: new Date().toISOString(),
    device_id: key.deviceId,
    ok: true,
  })
  expect((await call(page, '/api/me', undefined, 'GET')).body).toMatchObject({
    device_id: key.deviceId,
    device_pinned: true,
  })

  // the same code again, from a different browser: 410
  const other = await browser.newContext()
  const second = await jar(other, relay, '198.51.100.2')
  const again = await second.page.evaluate(
    (c) => (window as unknown as { register(c: string): Promise<Reply> }).register(c),
    codeAuth,
  )
  expect(again.status).toBe(410)
  await ctx.close()
  await other.close()
})

test('an expired code is 410', async ({ browser }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.3')
  const { codeAuth } = await newCode(relay)
  relay.h.fake.clock.advance(10 * 60_000 + 1000)
  const reg = await page.evaluate(
    (c) => (window as unknown as { register(c: string): Promise<Reply> }).register(c),
    codeAuth,
  )
  expect(reg.status).toBe(410)
  expect(await ctx.cookies()).toEqual([])
  await ctx.close()
})

test('the 6th failed enroll call in 10 minutes burns every outstanding code', async ({ browser }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.4')
  const { codeAuth } = await newCode(relay)
  const other = await newCode(relay)
  for (let i = 0; i < 5; i++) {
    expect((await call(page, '/api/auth/enroll/options', { code_auth: `wrong-${i}` })).status).toBe(410)
  }
  const reg = await page.evaluate(
    (c) => (window as unknown as { register(c: string): Promise<Reply> }).register(c),
    codeAuth,
  )
  expect(reg.status).toBe(410)
  expect((await call(page, '/api/auth/enroll/options', { code_auth: other.codeAuth })).status).toBe(410)
  await ctx.close()
})

test('a second storage jar signs in with the same passkey and binds its own device key without registering', async ({
  browser,
}) => {
  const a = await browser.newContext()
  const first = await jar(a, relay, '198.51.100.5')
  const c1 = await newCode(relay)
  expect(
    (
      await first.page.evaluate(
        (c) => (window as unknown as { register(c: string): Promise<Reply> }).register(c),
        c1.codeAuth,
      )
    ).status,
  ).toBe(200)
  const d1 = await deviceBody(c1.code, c1.codeAuth, 'First jar')
  expect((await call(first.page, '/api/auth/device/verify', d1.body)).status).toBe(202)

  // A fresh browser context is a fresh cookie and IndexedDB jar. Give it the same synced passkey.
  const { credentials } = await first.cdp.send('WebAuthn.getCredentials', { authenticatorId: first.authenticator })
  expect(credentials).toHaveLength(1)
  const b = await browser.newContext()
  const requests: string[] = []
  b.on('request', (r) => requests.push(new URL(r.url()).pathname))
  const second = await jar(b, relay, '198.51.100.6')
  for (const cred of credentials)
    await second.cdp.send('WebAuthn.addCredential', { authenticatorId: second.authenticator, credential: cred })
  expect(await b.cookies()).toEqual([])

  const login = await second.page.evaluate(() =>
    (window as unknown as { assert(a: string, b: string): Promise<Reply> }).assert(
      '/api/auth/login/options',
      '/api/auth/login/verify',
    ),
  )
  expect(login).toEqual({ status: 200, body: { ok: true } })
  expect((await call(second.page, '/api/me', undefined, 'GET')).body).toMatchObject({
    has_passkey: true,
    device_pinned: false,
  })

  const c2 = await newCode(relay)
  const d2 = await deviceBody(c2.code, c2.codeAuth, 'Second jar')
  expect((await call(second.page, '/api/auth/device/verify', d2.body)).status).toBe(202)
  expect(requests.filter((p) => p.includes('/enroll/'))).toEqual([])
  expect((await call(second.page, '/api/me', undefined, 'GET')).body).toMatchObject({
    device_id: d2.key.deviceId,
    device_pinned: false,
  })
  // The device list is owner data: it is refused until the Mac pins this jar's device (the pairing gate).
  expect((await call(second.page, '/api/devices', undefined, 'GET')).status).toBe(403)
  relay.h.state.core.setPinned(d2.key.deviceId, true)
  const devices = (await call(second.page, '/api/devices', undefined, 'GET')).body as unknown as Array<{ id: string }>
  expect(devices.map((d) => d.id).sort()).toEqual([d1.key.deviceId, d2.key.deviceId].sort())
  await a.close()
  await b.close()
})

test('sign-in rotates the session and idle for more than 14 days is 401', async ({ browser, playwright }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.7')
  const c = await newCode(relay)
  await page.evaluate((x) => (window as unknown as { register(c: string): Promise<Reply> }).register(x), c.codeAuth)
  const first = (await ctx.cookies()).find((k) => k.name === '__Host-talos_s')?.value as string

  const login = await page.evaluate(() =>
    (window as unknown as { assert(a: string, b: string): Promise<Reply> }).assert(
      '/api/auth/login/options',
      '/api/auth/login/verify',
    ),
  )
  expect(login.status).toBe(200)
  const second = (await ctx.cookies()).find((k) => k.name === '__Host-talos_s')?.value as string
  expect(second).not.toBe(first)

  const raw = await playwright.request.newContext({ baseURL: relay.origin })
  const withCookie = (v: string) => raw.get('/api/me', { headers: { Cookie: `__Host-talos_s=${v}` } })
  expect((await withCookie(first)).status()).toBe(401)
  expect((await withCookie(second)).status()).toBe(200)

  relay.h.fake.clock.advance(14 * 86400_000 + 1000)
  expect((await withCookie(second)).status()).toBe(401)
  expect((await call(page, '/api/me', undefined, 'GET')).status).toBe(401)
  await raw.dispose()
  await ctx.close()
})

test('a passkey step-up mints a single-use token bound to its purpose', async ({ browser }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.8')
  const c = await newCode(relay)
  await page.evaluate((x) => (window as unknown as { register(c: string): Promise<Reply> }).register(x), c.codeAuth)
  const d1 = await deviceBody(c.code, c.codeAuth, 'Phone')
  await call(page, '/api/auth/device/verify', d1.body)
  relay.h.state.core.setPinned(d1.key.deviceId, true)

  const run = (purpose: string) =>
    page.evaluate(
      (p) =>
        (window as unknown as { assert(a: string, b: string, e: unknown): Promise<Reply> }).assert(
          '/api/auth/stepup/options',
          '/api/auth/stepup/verify',
          { purpose: p },
        ),
      purpose,
    )

  const wrong = await run('config:work')
  expect(wrong.status).toBe(200)
  const wrongToken = (wrong.body as { stepup_token: string }).stepup_token
  expect((await call(page, `/api/devices/${d1.key.deviceId}/revoke`, { stepup_token: wrongToken })).status).toBe(403)

  const right = await run('device:revoke')
  const token = (right.body as { stepup_token: string }).stepup_token
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect((await call(page, `/api/devices/${d1.key.deviceId}/revoke`, { stepup_token: token })).status).toBe(204)
  // the only device is gone, so the passkey and the session went with it
  expect((await call(page, `/api/devices/${d1.key.deviceId}/revoke`, { stepup_token: token })).status).toBe(401)
  await ctx.close()
})

test('a step-up challenge for one purpose cannot mint a token for another', async ({ browser }) => {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, '198.51.100.9')
  const c = await newCode(relay)
  await page.evaluate((x) => (window as unknown as { register(c: string): Promise<Reply> }).register(x), c.codeAuth)
  // Step-up is for a pinned device: bind this jar's key and let the "Mac" pin it first.
  const d = await deviceBody(c.code, c.codeAuth)
  expect((await call(page, '/api/auth/device/verify', d.body)).status).toBe(202)
  relay.h.state.core.setPinned(d.key.deviceId, true)
  const opt = await call(page, '/api/auth/stepup/options', { purpose: 'config:work' })
  expect(opt.status).toBe(200)
  const res = await page.evaluate(async (options) => {
    const cred = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as never),
    })
    const r = await fetch('/api/auth/stepup/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-talos-csrf': '1' },
      body: JSON.stringify({ purpose: 'device:revoke', response: (cred as PublicKeyCredential | null)?.toJSON() }),
    })
    return r.status
  }, opt.body)
  expect(res).toBe(403)
  await ctx.close()
})

// Sign in with this jar's passkey, naming `deviceId`. `sign` is given the login challenge the relay issued and returns the
// device_proof to send (or null to send none, like a client from before the proof existed).
async function loginNaming(
  page: Page,
  deviceId: string,
  sign: ((challenge: string) => Promise<{ nonce: string; sig: string } | null>) | null,
): Promise<Reply> {
  await page.exposeFunction('signLoginProof', async (challenge: string) => (sign ? sign(challenge) : null))
  return page.evaluate(async (id) => {
    const w = window as unknown as {
      call(p: string, b: unknown): Promise<{ status: number; body: { challenge: string } }>
      signLoginProof(c: string): Promise<unknown>
    }
    const o = await w.call('/api/auth/login/options', {})
    const cred = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(o.body as never),
    })
    const proof = await w.signLoginProof(o.body.challenge)
    const r = await fetch('/api/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-talos-csrf': '1' },
      body: JSON.stringify({
        response: (cred as PublicKeyCredential).toJSON(),
        device_id: id,
        ...(proof ? { device_proof: proof } : {}),
      }),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, deviceId)
}

async function enrolledJar(browser: Browser, ip: string) {
  const ctx = await browser.newContext()
  const { page } = await jar(ctx, relay, ip)
  const c = await newCode(relay)
  await page.evaluate((x) => (window as unknown as { register(c: string): Promise<Reply> }).register(x), c.codeAuth)
  const d = await deviceBody(c.code, c.codeAuth, 'Phone')
  await call(page, '/api/auth/device/verify', d.body)
  await call(page, '/api/auth/logout', {})
  expect((await call(page, '/api/me', undefined, 'GET')).status).toBe(401)
  return { ctx, page, d }
}

test('signing in can name the device key of that storage jar, and the device signs the login challenge', async ({
  browser,
}) => {
  const { ctx, page, d } = await enrolledJar(browser, '198.51.100.10')
  let signed = ''
  const login = await loginNaming(page, d.key.deviceId, async (challenge) => {
    signed = challenge
    const passkeyId = relay.h.state.core.credentials()[0]!.credentialId
    return {
      nonce: challenge,
      sig: await signDeviceProof(d.key.privateKey, {
        nonce: challenge,
        codeId: loginProofCodeId(passkeyId),
        deviceId: d.key.deviceId,
      }),
    }
  })
  expect(signed).not.toBe('')
  expect(login.status).toBe(200)
  expect((await call(page, '/api/me', undefined, 'GET')).body).toMatchObject({
    device_id: d.key.deviceId,
    device_pinned: false,
  })
  await ctx.close()
})

test('a device that has signed in with its key cannot sign in again without it', async ({ browser }) => {
  const { ctx, page, d } = await enrolledJar(browser, '198.51.100.11')
  const login = await loginNaming(page, d.key.deviceId, null)
  expect(login.status).toBe(403)
  expect(login.body).toMatchObject({ error: 'device_proof_required' })
  expect((await call(page, '/api/me', undefined, 'GET')).status).toBe(401)
  await ctx.close()
})
