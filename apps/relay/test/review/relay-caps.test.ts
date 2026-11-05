// Security package relay-caps: request-size caps, header-first checks on signed uploads, a revoke that checks the session
// before it reads anything, and the right client address. Every attack here is aimed at the REAL routes (real auth, real
// core, real hooks) through Hono's request(), with a body that counts how many bytes the relay actually pulled from it.
// "Pulled" is the measure: a 413 that arrives after the relay buffered 300 MB is not a fix.
import { generateBridgeKey, newChallengeNonce, signBridgeHttp, signChallenge } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyBridgeHello } from '../../src/auth/contract.ts'
import { pickClientIp } from '../../src/client-ip.ts'
import { DEFAULT_BODY_CAP, hasBodyBytes } from '../../src/core/body-guard.ts'
import { UNVERIFIED_READS_MAX, UNVERIFIED_READS_PER_IP } from '../../src/core/upload-gate.ts'
import { buildApp } from '../../src/routes.ts'
import { afterEachReset, makeHarness } from '../auth/helpers.ts'
import { ORIGIN, type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  afterEachReset()
})

const MiB = 1024 * 1024
/** Slack for the one chunk in flight plus the stream's own read-ahead. */
const SLACK = 4 * 16 * 1024

/** A request body of `total` bytes that records how many the reader has taken. */
function counting(total: number, chunk = 16 * 1024) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close()
      const n = Math.min(chunk, total - sent)
      sent += n
      c.enqueue(new Uint8Array(n))
    },
  })
  return { stream, pulled: () => sent }
}

/** A body that sends one chunk and then waits until `release()` (an upload that is still in progress). */
function stalled() {
  let release: () => void = () => {}
  const gate = new Promise<void>((res) => {
    release = res
  })
  let first = true
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (first) {
        first = false
        c.enqueue(new Uint8Array(1024))
        return
      }
      await gate
      c.close()
    },
  })
  return { stream, release }
}

const send = (app: { request: (r: Request) => Response | Promise<Response> }, url: string, init: RequestInit) =>
  app.request(new Request(`http://relay.test${url}`, { ...init, duplex: 'half' } as RequestInit))

const browserHeaders = (ip: string, cookie?: string, extra: Record<string, string> = {}) => ({
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'Content-Type': 'application/json',
  'X-Real-IP': ip,
  ...(cookie ? { Cookie: cookie } : {}),
  ...extra,
})

const AUTH_POSTS = [
  '/api/auth/enroll/options',
  '/api/auth/enroll/verify',
  '/api/auth/enroll/session',
  '/api/auth/login/options',
  '/api/auth/login/verify',
  '/api/auth/device/verify',
  '/api/auth/stepup/options',
  '/api/auth/stepup/verify',
  '/api/auth/logout',
  '/api/auth/logout-all',
]

describe('1. every /api/auth/* route refuses an oversized body without reading it', () => {
  it('on the full app (global cap), signed in and not', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const owner = await r.owner()
    let n = 0
    for (const path of AUTH_POSTS) {
      for (const cookie of [undefined, owner.cookie]) {
        const body = counting(16 * MiB)
        const res = await send(app, path, {
          method: 'POST',
          headers: browserHeaders(`198.51.100.${++n}`, cookie),
          body: body.stream,
        })
        expect(res.status, `${path} ${cookie ? 'signed in' : 'anonymous'}`).toBeLessThan(500)
        expect(body.pulled(), `${path} ${cookie ? 'signed in' : 'anonymous'} pulled`).toBeLessThanOrEqual(
          DEFAULT_BODY_CAP + SLACK,
        )
      }
    }
  })

  it('on the auth module alone (its own guard, not only the global one)', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    let n = 0
    for (const path of AUTH_POSTS) {
      const body = counting(16 * MiB)
      const res = await send(h.app, path, {
        method: 'POST',
        headers: h.jsonHeaders(cookie, { 'X-Real-IP': `198.51.100.${++n}` }),
        body: body.stream,
      })
      expect(res.status, path).toBeLessThan(500)
      expect(body.pulled(), `${path} pulled`).toBeLessThanOrEqual(DEFAULT_BODY_CAP + SLACK)
    }
  })

  it('answers 413 (not 400) when a sign-in body is too big, and still accepts a normal one', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const big = await send(app, '/api/auth/enroll/options', {
      method: 'POST',
      headers: browserHeaders('198.51.100.1'),
      body: counting(MiB).stream,
    })
    expect(big.status).toBe(413)
    const ok = await send(app, '/api/auth/login/options', {
      method: 'POST',
      headers: browserHeaders('198.51.100.2'),
      body: '{}',
    })
    expect(ok.status).toBe(200)
  })

  it('a declared length over the cap is refused with no body read at all', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const body = counting(MiB)
    const res = await send(app, '/api/auth/enroll/options', {
      method: 'POST',
      headers: browserHeaders('198.51.100.3', undefined, { 'Content-Length': String(MiB) }),
      body: body.stream,
    })
    expect(res.status).toBe(413)
    expect(body.pulled()).toBeLessThanOrEqual(SLACK)
  })

  it('other JSON routes get the blanket cap too (a route nobody remembered)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const owner = await r.owner()
    for (const path of ['/api/connections', '/api/push/subscribe', '/api/push/apns']) {
      const body = counting(16 * MiB)
      const res = await send(app, path, {
        method: 'POST',
        headers: browserHeaders('198.51.100.9', owner.cookie),
        body: body.stream,
      })
      expect(res.status, path).toBe(413)
      expect(body.pulled(), path).toBeLessThanOrEqual(DEFAULT_BODY_CAP + SLACK)
    }
  })

  it('the routes that take big bodies are not shrunk: a 200 KiB frame post and a 1 MiB hook body still reach their handlers', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    // /bridge/post: body is read after the key check; a frame of 200 KiB is under its own 256 KiB cap
    const raw = new Uint8Array(200 * 1024).fill(0x20)
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body: raw,
    })
    const res = await send(app, '/bridge/post', {
      method: 'POST',
      headers: { authorization, 'X-Real-IP': '198.51.100.7' },
      body: raw,
    })
    expect(res.status).toBe(400) // reached the frame parser (bad_frame), not the 64 KiB cap's 413
  })
})

describe('1b. the CSRF empty-body check never buffers', () => {
  it('hasBodyBytes stops at the first chunk of a huge body', async () => {
    const body = counting(64 * MiB)
    const req = new Request('http://x/y', { method: 'POST', body: body.stream, duplex: 'half' } as RequestInit)
    expect(await hasBodyBytes(req)).toBe(true)
    expect(body.pulled()).toBeLessThanOrEqual(SLACK)
  })
  it('an empty body is empty, and a declared length counts without a read', async () => {
    expect(await hasBodyBytes(new Request('http://x/y', { method: 'POST' }))).toBe(false)
    expect(await hasBodyBytes(new Request('http://x/y', { method: 'POST', body: '' }))).toBe(false)
    expect(await hasBodyBytes(new Request('http://x/y', { method: 'POST', body: 'a' }))).toBe(true)
  })
})

describe('2. POST /api/devices/:id/revoke checks the session before it reads, and is rate limited', () => {
  const noType = (ip: string, cookie?: string) => ({
    Origin: ORIGIN,
    'X-Talos-CSRF': '1',
    'X-Real-IP': ip,
    ...(cookie ? { Cookie: cookie } : {}),
  })

  it('no session + no content type + a huge body: 401 and the body is not read', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const body = counting(64 * MiB)
    const res = await send(app, '/api/devices/dv_x/revoke', {
      method: 'POST',
      headers: noType('198.51.100.20'),
      body: body.stream,
    })
    expect(res.status).toBe(401)
    expect(body.pulled()).toBeLessThanOrEqual(SLACK)
  })

  it('a signed-in owner with a body and no content type is refused 403 without the body being buffered', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const owner = await r.owner()
    const body = counting(64 * MiB)
    const res = await send(app, '/api/devices/dv_x/revoke', {
      method: 'POST',
      headers: noType('198.51.100.21', owner.cookie),
      body: body.stream,
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'csrf_content_type' })
    expect(body.pulled()).toBeLessThanOrEqual(SLACK)
  })

  it('is rate limited per address, in its own bucket (sign-in is not spent)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const seen: number[] = []
    for (let i = 0; i < 30; i++)
      seen.push(
        (await send(app, '/api/devices/dv_x/revoke', { method: 'POST', headers: noType('198.51.100.22'), body: '' }))
          .status,
      )
    expect(seen.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(seen.slice(20).every((s) => s === 429)).toBe(true)
    // another address is untouched, and so is the sign-in budget of the first
    const other = await send(app, '/api/devices/dv_x/revoke', {
      method: 'POST',
      headers: noType('198.51.100.23'),
      body: '',
    })
    expect(other.status).toBe(401)
    const login = await send(app, '/api/auth/login/options', {
      method: 'POST',
      headers: browserHeaders('198.51.100.22'),
      body: '{}',
    })
    expect(login.status).toBe(200)
  })

  it('the real owner can still revoke (session, csrf, step-up, in that order)', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const token = r.auth.core.mintStepup(b.sessionId, 'device:revoke')
    const res = await r.post(`/api/devices/${a.device.deviceId}/revoke`, { stepup_token: token }, b)
    expect(res.status).toBe(204)
  })
})

describe('3. PUT /bridge/media checks the key id and the time before it reads the body', () => {
  const put = (app: ReturnType<typeof buildApp>, headers: Record<string, string>, body: BodyInit) =>
    send(app, '/bridge/media/md_00000000000000000000000000', { method: 'PUT', headers, body })

  it('no Authorization, an unknown key id, and a stale time are all 401 with the body untouched', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const stranger = await generateBridgeKey()
    const sign = (key: typeof stranger, ts?: number) =>
      signBridgeHttp({
        privateKey: key.privateKey,
        keyId: key.keyId,
        method: 'PUT',
        pathWithQuery: '/bridge/media/md_00000000000000000000000000',
        body: '',
        ...(ts ? { ts } : {}),
      })
    const stale = Math.floor(Date.now() / 1000) - 3600
    const cases: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['garbage header', { authorization: 'TalosBridge nonsense' }],
      ['unknown key id', { authorization: await sign(stranger) }],
      ['stale time', { authorization: await sign(r.bridgeKey, stale) }],
    ]
    for (const [name, headers] of cases) {
      const body = counting(60 * MiB)
      const res = await put(app, { ...headers, 'X-Real-IP': '198.51.100.30' }, body.stream as never)
      expect(res.status, name).toBe(401)
      expect(body.pulled(), name).toBeLessThanOrEqual(SLACK)
    }
  })

  it('a good, signed upload still lands (wire format unchanged)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8,
      6, 0, 0, 0,
    ])
    const path = '/bridge/media/md_0000000000000000000000000A'
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'PUT',
      pathWithQuery: path,
      body: png,
    })
    const res = await send(app, path, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'image/png', 'X-Real-IP': '198.51.100.31' },
      body: png,
    })
    expect(res.status).toBe(200)
  })

  it('only a few unproven uploads can be in flight: per address, and in all', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    // names the real key id with a fresh time, so it passes the header check; the signature cannot be checked until the body is in
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'PUT',
      pathWithQuery: '/bridge/media/md_00000000000000000000000000',
      body: '',
    })
    const held: Array<{ release: () => void; res: Promise<Response> }> = []
    const open = (ip: string) => {
      const s = stalled()
      const res = Promise.resolve(put(app, { authorization, 'X-Real-IP': ip }, s.stream as never))
      held.push({ release: s.release, res })
      return res
    }
    for (let i = 0; i < UNVERIFIED_READS_PER_IP; i++) open('198.51.100.40')
    await new Promise((res) => setTimeout(res, 100))
    const over = await put(app, { authorization, 'X-Real-IP': '198.51.100.40' }, counting(1024 * 1024).stream as never)
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBeTruthy()
    // a different address still gets in, up to the global limit
    for (let i = 0; i < UNVERIFIED_READS_MAX - UNVERIFIED_READS_PER_IP; i++) open('198.51.100.41')
    await new Promise((res) => setTimeout(res, 100))
    const global = await put(
      app,
      { authorization, 'X-Real-IP': '198.51.100.42' },
      counting(1024 * 1024).stream as never,
    )
    expect(global.status).toBe(429)
    // slots come back when the uploads end (here: all fail the signature, so 401), nothing leaks
    for (const h of held) h.release()
    for (const h of held) expect((await h.res).status).toBe(401)
    const after = await put(app, { authorization, 'X-Real-IP': '198.51.100.40' }, counting(1024 * 1024).stream as never)
    expect(after.status).toBe(401)
  })

  it('small signed bodies (the Mac posting frames side by side) never wait on the gate', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const out = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const raw = new TextEncoder().encode(`{"n":${i}}`)
        const authorization = await signBridgeHttp({
          privateKey: r?.bridgeKey.privateKey as never,
          keyId: r?.bridgeKey.keyId as string,
          method: 'POST',
          pathWithQuery: '/bridge/post',
          body: raw,
        })
        return (
          await send(app, '/bridge/post', {
            method: 'POST',
            headers: { authorization, 'content-length': String(raw.length), 'X-Real-IP': '198.51.100.50' },
            body: raw,
          })
        ).status
      }),
    )
    expect(out.every((s) => s === 400)).toBe(true) // reached the frame parser, none answered 429
  })
})

describe('4. the client address', () => {
  it('pickClientIp: X-Real-IP wins, a malformed one falls back, hops 0 ignores every header', () => {
    const edge = '203.0.113.9, 84.17.44.225'
    expect(pickClientIp({ realIp: '203.0.113.9', xff: edge, remote: '10.0.0.1', hops: 1 })).toBe('203.0.113.9')
    expect(pickClientIp({ realIp: '2001:db8::7', xff: edge, remote: '10.0.0.1', hops: 1 })).toBe('2001:db8:0:0::') // per /64
    // hostile text in the header is not an address
    for (const bad of ['evil, 1.2.3.4', '<script>', 'a'.repeat(5000), '', ' ', '999.1.1.1'])
      expect(pickClientIp({ realIp: bad, xff: edge, remote: '10.0.0.1', hops: 1 }), bad).toBe('84.17.44.225')
    // no X-Real-IP: the old rule still works for a proxy that only sets X-Forwarded-For
    expect(pickClientIp({ xff: '198.51.100.4', remote: '10.0.0.1', hops: 1 })).toBe('198.51.100.4')
    expect(pickClientIp({ realIp: '203.0.113.9', xff: edge, remote: '10.0.0.1', hops: 0 })).toBe('10.0.0.1')
    expect(pickClientIp({ realIp: '203.0.113.9', hops: 0 })).toBe('unknown')
  })

  it('two visitors behind one shared edge hop get separate sign-in budgets (the lock-out attack)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const edgeHop = '84.17.44.225'
    // a stranger burns 10 sign-in calls from the same edge site as the owner
    for (let i = 0; i < 10; i++) {
      const res = await send(app, '/api/auth/login/options', {
        method: 'POST',
        headers: browserHeaders('203.0.113.66', undefined, { 'X-Forwarded-For': `203.0.113.66, ${edgeHop}` }),
        body: '{}',
      })
      expect(res.status).toBe(200)
    }
    const stranger = await send(app, '/api/auth/login/options', {
      method: 'POST',
      headers: browserHeaders('203.0.113.66', undefined, { 'X-Forwarded-For': `203.0.113.66, ${edgeHop}` }),
      body: '{}',
    })
    expect(stranger.status).toBe(429)
    const owner = await send(app, '/api/auth/login/options', {
      method: 'POST',
      headers: browserHeaders('198.51.100.1', undefined, { 'X-Forwarded-For': `198.51.100.1, ${edgeHop}` }),
      body: '{}',
    })
    expect(owner.status).toBe(200)
  })

  it('with TRUST_PROXY_HOPS=0 a client-sent X-Real-IP cannot pick its own bucket', async () => {
    r = await startRealRelay({ env: { TRUST_PROXY_HOPS: '0' } })
    const app = buildApp(r.relay.services)
    const seen: number[] = []
    for (let i = 0; i < 12; i++)
      seen.push(
        (
          await send(app, '/api/auth/login/options', {
            method: 'POST',
            headers: browserHeaders(`203.0.113.${i + 1}`),
            body: '{}',
          })
        ).status,
      )
    expect(seen.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(seen.slice(10).every((s) => s === 429)).toBe(true)
  })

  it('five bad hellos from one address do not lock a valid Mac key out of that address', async () => {
    const h = await makeHarness()
    const ip = '203.0.113.77'
    const stranger = await generateBridgeKey()
    const mk = () => ({
      nonce: newChallengeNonce(),
      relay_host: 'relay.example.com',
      server_time: Math.floor(h.fake.clock.now() / 1000),
    })
    for (let i = 0; i < 5; i++) {
      const ch = mk()
      const sig = await signChallenge(stranger.privateKey, ch)
      expect((await verifyBridgeHello({ hello: { key_id: stranger.keyId, sig }, challenge: ch, ip })).ok).toBe(false)
    }
    // the address is now blocked for strangers...
    const ch1 = mk()
    const bad = await verifyBridgeHello({
      hello: { key_id: stranger.keyId, sig: await signChallenge(stranger.privateKey, ch1) },
      challenge: ch1,
      ip,
    })
    expect(bad).toEqual({ ok: false, reason: 'ip_blocked' })
    // ...but the real Mac, proving it holds the trusted key, still gets in
    const ch2 = mk()
    const good = await verifyBridgeHello({
      hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch2) },
      challenge: ch2,
      ip,
    })
    expect(good).toEqual({ ok: true, keyId: h.bridgeKey.keyId })
    // a replay of that same hello on the blocked address is still refused
    const replay = await verifyBridgeHello({
      hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch2) },
      challenge: ch2,
      ip,
    })
    expect(replay.ok).toBe(false)
    // and a valid key with a wrong signature on the blocked address is refused and counted
    const ch3 = mk()
    const forged = await verifyBridgeHello({
      hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(stranger.privateKey, ch3) },
      challenge: ch3,
      ip,
    })
    expect(forged.ok).toBe(false)
  })
})
