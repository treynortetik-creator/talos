// WP-I5: the APNs sender against a REAL local HTTP/2 server that verifies the ES256 provider token like Apple does.
import { buildPushPayload, type PushConfig } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ApnsSender, createApnsSender, JWT_REFRESH_MS, parseP8 } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 20_000 })

const cfg: PushConfig = {
  agent: { name: 'Talos' },
  notifications: { show_thread_names: 'fixed_only' },
  threads: [{ id: 'general', name: 'General', kind: 'fixed' }],
}
const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'
const TOKEN = 'a'.repeat(64)
const T2 = 'b'.repeat(64)
const reply = buildPushPayload({ template: 'reply', thread_id: 'general', app_badge: 3 }, cfg)

function recordingLog() {
  const lines: string[] = []
  const rec = (...a: unknown[]) => void lines.push(JSON.stringify(a))
  const log: Logger = { debug: rec, info: rec, warn: rec, error: rec, child: () => log }
  return { log, lines }
}

const open: Array<{ close(): unknown }> = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})

async function world(opts: { timeoutMs?: number; authority?: (env: 'sandbox' | 'production') => string } = {}) {
  const key = testKey()
  const fake = await startFakeApns(key.publicKey)
  open.push(fake)
  const clock = fakeClock()
  const { log, lines } = recordingLog()
  const sender = createApnsSender({
    config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
    clock,
    log,
    authority: opts.authority ?? (() => fake.url),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  }) as ApnsSender
  open.push(sender)
  return { key, fake, clock, sender, lines }
}

describe('request shape (real http2, real ES256)', () => {
  it('posts to /3/device/<token> with a valid provider token and the fixed-phrase body', async () => {
    const { fake, sender, clock } = await world()
    const r = await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(r).toMatchObject({ ok: true, gone: false, status: 200 })
    const q = fake.requests[0]
    expect(q?.token).toBe(TOKEN)
    expect(q?.jwt).toMatchObject({
      ok: true,
      kid: 'KEYID12345',
      iss: 'TEAMID1234',
      iat: Math.floor(clock.now() / 1000),
    })
    expect(q).toMatchObject({
      topic: 'com.example.talos',
      pushType: 'alert',
      priority: '10',
      collapseId: 'thread:general',
    })
    expect(Number(q?.expiration)).toBe(Math.floor(clock.now() / 1000) + 3600)
    expect(q?.body).toEqual({
      aps: {
        alert: { title: 'Talos', body: 'New reply in General' },
        badge: 3,
        sound: 'default',
        category: 'TALOS_OPEN',
        'thread-id': 'thread:general',
      },
      talos: { v: 1, kind: 'reply', thread_id: 'general', navigate: '/t/general' },
    })
  })

  it('a card push carries the Open / Approve category and the card id, still no card text', async () => {
    const { fake, sender } = await world()
    const p = buildPushPayload({ template: 'needs_you', thread_id: 'general', card_id: CARD }, cfg)
    await sender.send({ token: TOKEN, env: 'sandbox' }, p)
    const aps = fake.requests[0]?.body.aps as Record<string, unknown>
    expect(aps.category).toBe('TALOS_CARD')
    expect(fake.requests[0]?.body.talos).toMatchObject({ kind: 'card', card_id: CARD, navigate: `/card/${CARD}` })
    expect(fake.requests[0]?.rawBody.length).toBeLessThan(4096)
  })

  it('an unknown/extra value on the payload never becomes a field: only the fixed shape goes out', async () => {
    const { fake, sender } = await world()
    const dirty = {
      ...reply,
      secret_text: 'the layoffs list',
      notification: { ...reply.notification, subject: 'Re: salary' },
    }
    await sender.send({ token: TOKEN, env: 'sandbox' }, dirty as never)
    expect(fake.requests[0]?.rawBody).not.toMatch(/layoffs|salary|subject|secret_text/)
  })
})

describe('provider token lifetime (fake clock)', () => {
  it('is reused inside 50 minutes and replaced after', async () => {
    const { fake, sender, clock } = await world()
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    clock.advance(JWT_REFRESH_MS - 1000)
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(fake.requests[1]?.bearer).toBe(fake.requests[0]?.bearer)
    clock.advance(2000)
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(fake.requests[2]?.bearer).not.toBe(fake.requests[0]?.bearer)
    expect(fake.requests[2]?.jwt).toMatchObject({ ok: true, iat: Math.floor(clock.now() / 1000) })
  })

  it('a clock that steps backwards (token issued in the future) makes a fresh token', async () => {
    const { fake, sender, clock } = await world()
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    clock.set(clock.now() - 3_600_000)
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(fake.requests[1]?.bearer).not.toBe(fake.requests[0]?.bearer)
    expect(fake.requests[1]?.jwt.iat).toBe(Math.floor(clock.now() / 1000))
  })

  it('a clock that leaps a day forward refreshes once, not per request', async () => {
    const { fake, sender, clock } = await world()
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    clock.advance(86_400_000)
    await Promise.all([1, 2, 3].map(() => sender.send({ token: TOKEN, env: 'sandbox' }, reply)))
    expect(new Set(fake.requests.slice(1).map((r) => r.bearer)).size).toBe(1)
  })

  it('ExpiredProviderToken after 25 minutes gets exactly one retry on a fresh token', async () => {
    const { fake, sender, clock } = await world()
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    clock.advance(25 * 60_000)
    fake.reply(T2, [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }])
    const r = await sender.send({ token: T2, env: 'sandbox' }, reply)
    expect(r.ok).toBe(true)
    expect(fake.requests.filter((q) => q.token === T2)).toHaveLength(2)
    const [a, b] = fake.requests.filter((q) => q.token === T2)
    expect(a?.bearer).not.toBe(b?.bearer)
  })

  it('ExpiredProviderToken on a token younger than 20 minutes is not retried in a loop', async () => {
    const { fake, sender } = await world()
    fake.replyAll({ status: 403, reason: 'ExpiredProviderToken' })
    const r = await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(r.ok).toBe(false)
    expect(fake.requests.length).toBeLessThanOrEqual(2)
  })
})

describe('host by env', () => {
  it('sandbox tokens go to the sandbox host, production tokens to the production host', async () => {
    const key = testKey()
    const sb = await startFakeApns(key.publicKey)
    const prod = await startFakeApns(key.publicKey)
    open.push(sb, prod)
    const { log } = recordingLog()
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: fakeClock(),
      log,
      authority: (env) => (env === 'sandbox' ? sb.url : prod.url),
    }) as ApnsSender
    open.push(sender)
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    await sender.send({ token: T2, env: 'production' }, reply)
    expect(sb.requests.map((r) => r.token)).toEqual([TOKEN])
    expect(prod.requests.map((r) => r.token)).toEqual([T2])
  })

  it("the default hosts are Apple's", async () => {
    const { APNS_HOSTS } = await import('../../src/core/push-apns.ts')
    expect(APNS_HOSTS).toEqual({
      sandbox: 'https://api.sandbox.push.apple.com',
      production: 'https://api.push.apple.com',
    })
  })
})

describe('what Apple says back', () => {
  it.each([
    [410, 'Unregistered', true],
    [400, 'BadDeviceToken', false],
    [400, 'DeviceTokenNotForTopic', false],
    [400, 'BadTopic', false],
    [400, 'PayloadTooLarge', false],
    [403, 'InvalidProviderToken', false],
    [429, 'TooManyRequests', false],
    [500, 'InternalServerError', false],
    [503, 'ServiceUnavailable', false],
  ])('%i %s -> gone=%s', async (status, reason, gone) => {
    const { fake, sender } = await world()
    fake.replyAll({ status, reason })
    const r = await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(r).toMatchObject({ ok: false, gone, status, reason })
  })

  it('a 410 with no body is still gone; an unknown reason string is dropped, not trusted', async () => {
    const { fake, sender } = await world()
    fake.replyAll({ status: 410 })
    expect(await sender.send({ token: TOKEN, env: 'sandbox' }, reply)).toMatchObject({ ok: false, gone: true })
    fake.replyAll({ status: 400, reason: 'Bad Device Token; drop table' })
    const r = await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    expect(r.gone).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it('a server that never answers times out as a plain failure (not gone)', async () => {
    const { fake, sender } = await world({ timeoutMs: 150 })
    fake.replyAll('hang')
    // No stopwatch: the server never answers, so send() can only come back (with a plain failure) if its own timeout
    // fired. A sender with no timeout never settles and the test ends at the runner's limit.
    expect(await sender.send({ token: TOKEN, env: 'sandbox' }, reply)).toMatchObject({ ok: false, gone: false })
  })

  it('nothing listening: a plain failure, no throw', async () => {
    const { sender } = await world({ authority: () => 'http://127.0.0.1:1' })
    expect(await sender.send({ token: TOKEN, env: 'sandbox' }, reply)).toMatchObject({ ok: false, gone: false })
  })

  it('Apple hanging up an idle connection: the next send reconnects', async () => {
    const { fake, sender } = await world()
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    fake.dropSessions()
    await new Promise((r) => setTimeout(r, 50))
    expect((await sender.send({ token: TOKEN, env: 'sandbox' }, reply)).ok).toBe(true)
    expect(fake.connections).toBe(2)
  })
})

describe('two at once', () => {
  it('20 concurrent sends share one connection and all arrive', async () => {
    const { fake, sender } = await world()
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => sender.send({ token: `${i}`.padStart(64, 'c'), env: 'sandbox' }, reply)),
    )
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(fake.requests).toHaveLength(20)
    expect(fake.connections).toBe(1)
  })

  it('one device failing does not hold up another', async () => {
    const { fake, sender } = await world()
    fake.reply(TOKEN, 'hang')
    const slow = sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    const fast = await sender.send({ token: T2, env: 'sandbox' }, reply)
    expect(fast.ok).toBe(true)
    sender.close()
    expect((await slow).ok).toBe(false)
  })
})

describe('secrets stay out of logs', () => {
  it('no key material, provider token, device token or response body in any log line', async () => {
    const { fake, sender, lines, key } = await world()
    fake.replyAll({ status: 400, reason: 'BadDeviceToken' })
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    fake.replyAll({ status: 200 })
    await sender.send({ token: TOKEN, env: 'sandbox' }, reply)
    const all = lines.join('\n')
    const jwt = fake.requests[0]?.bearer.slice(7) as string
    expect(all).toContain('apns send failed')
    for (const secret of [
      TOKEN,
      jwt,
      jwt.split('.')[2] as string,
      'BEGIN',
      key.p8.split('\n')[1] as string,
      'New reply',
    ])
      expect(all).not.toContain(secret)
  })

  it('a bad key logs nothing but a fixed sentence and leaves push off', () => {
    const { log, lines } = recordingLog()
    const s = createApnsSender({
      config: {
        keyId: 'KEYID12345',
        teamId: 'TEAMID1234',
        keyP8: 'SUPER-SECRET-NOT-A-KEY',
        bundleId: 'com.example.talos',
      },
      clock: fakeClock(),
      log,
    })
    expect(s).toBeNull()
    expect(lines.join('')).not.toContain('SUPER-SECRET')
  })
})

describe('parseP8', () => {
  const k = testKey()
  it('takes a PEM, a one-line PEM with literal \\n, and the bare base64 body', () => {
    expect(parseP8(k.p8)).not.toBeNull()
    expect(parseP8(k.p8.trim().replace(/\n/g, '\\n'))).not.toBeNull()
    const body = k.p8
      .split('\n')
      .filter((l) => !l.startsWith('-----'))
      .join('')
    expect(parseP8(body)).not.toBeNull()
  })
  it('refuses junk, an empty string and a non-P-256 key', async () => {
    expect(parseP8('')).toBeNull()
    expect(parseP8('nonsense')).toBeNull()
    const { generateKeyPairSync } = await import('node:crypto')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString()
    expect(parseP8(rsa)).toBeNull()
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString()
    expect(parseP8(p384)).toBeNull()
  })
})
