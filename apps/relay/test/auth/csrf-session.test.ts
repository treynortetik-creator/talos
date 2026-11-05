import { afterEach, describe, expect, it } from 'vitest'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { afterEachReset, makeHarness, ORIGIN } from './helpers.ts'

afterEach(afterEachReset)
const DAY = 24 * 3600_000

describe('CSRF (spec 5.4)', () => {
  it('POST without X-Talos-CSRF is 403', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    const res = await h.app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
    })
    expect(res.status).toBe(403)
  })

  it('wrong Origin is 403', async () => {
    const h = await makeHarness()
    const res = await h.post('/api/auth/logout', {}, h.login(), { Origin: 'https://evil.example.net' })
    expect(res.status).toBe(403)
  })

  it('missing Origin is 403', async () => {
    const h = await makeHarness()
    const headers = h.jsonHeaders(h.login())
    delete (headers as Record<string, string | undefined>).Origin
    const res = await h.app.request('/api/auth/logout', { method: 'POST', headers, body: '{}' })
    expect(res.status).toBe(403)
  })

  it('form-encoded and text/plain bodies are 403', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const res = await h.app.request('/api/auth/logout', {
        method: 'POST',
        headers: h.jsonHeaders(cookie, { 'Content-Type': type }),
        body: 'a=b',
      })
      expect(res.status, type).toBe(403)
    }
  })

  it('a correct request passes and logout clears the cookie', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    const res = await h.post('/api/auth/logout', {}, cookie)
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-talos_s=; Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
    )
    const after = await h.app.request('/probe/session', { headers: { Cookie: cookie } })
    expect(after.status).toBe(401)
  })
})

describe('sessions', () => {
  it('no cookie and a forged cookie are 401', async () => {
    const h = await makeHarness()
    expect((await h.app.request('/probe/session')).status).toBe(401)
    const forged = `${COOKIE_NAME}=${'A'.repeat(43)}`
    expect((await h.app.request('/probe/session', { headers: { Cookie: forged } })).status).toBe(401)
    expect((await h.app.request('/probe/session', { headers: { Cookie: `${COOKIE_NAME}=short` } })).status).toBe(401)
  })

  it('stores only a hash of the cookie value', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    const token = cookie.split('=')[1] as string
    const rows = h.fake.db.prepare('select id from auth_sessions').all() as Array<{ id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).not.toBe(token)
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('idle for more than 14 days is 401', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    h.fake.clock.advance(14 * DAY + 1000)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('SESSION_IDLE_DAYS and SESSION_TTL_DAYS move both limits, and the cookie lifetime follows the TTL', async () => {
    const h = await makeHarness({ env: { SESSION_TTL_DAYS: '60', SESSION_IDLE_DAYS: '20' } })
    const cookie = await h.loginPinned()
    h.fake.clock.advance(15 * DAY) // past the old 14-day idle, inside the new 20
    const alive = await h.app.request('/probe/session', { headers: { Cookie: cookie } })
    expect(alive.status).toBe(200)
    expect(alive.headers.get('set-cookie') ?? '').toContain(`Max-Age=${60 * 86400}`)
    h.fake.clock.advance(21 * DAY)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('a shorter SESSION_IDLE_DAYS ends an unused session sooner and still slides for an active one', async () => {
    const h = await makeHarness({ env: { SESSION_TTL_DAYS: '5', SESSION_IDLE_DAYS: '3' } })
    const active = await h.loginPinned()
    const forgotten = await h.loginPinned()
    for (let i = 0; i < 3; i++) {
      h.fake.clock.advance(2 * DAY)
      expect(
        (await h.app.request('/probe/session', { headers: { Cookie: active } })).status,
        `day ${(i + 1) * 2}`,
      ).toBe(200)
    }
    // six days in: the one that was never used again has been idle for six days, past the three allowed
    expect((await h.app.request('/probe/session', { headers: { Cookie: forgotten } })).status).toBe(401)
  })

  it('activity slides the expiry: a session used every 10 days outlives 30 days', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    for (let i = 0; i < 4; i++) {
      h.fake.clock.advance(10 * DAY)
      expect(
        (await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status,
        `day ${(i + 1) * 10}`,
      ).toBe(200)
    }
  })

  it('logout-all kills every session', async () => {
    const h = await makeHarness()
    const a = await h.loginPinned()
    const b = await h.loginPinned()
    expect((await h.post('/api/auth/logout-all', {}, a)).status).toBe(204)
    for (const c of [a, b]) expect((await h.app.request('/probe/session', { headers: { Cookie: c } })).status).toBe(401)
    expect(h.fake.bus.revalidations).toBeGreaterThan(0) // live sockets are re-checked
  })

  it('logout-all from a session the Mac has not pinned is refused (review #28)', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned()
    const stranger = h.login('cred-stranger')
    expect((await h.post('/api/auth/logout-all', {}, stranger)).status).toBe(403)
    expect((await h.app.request('/probe/session', { headers: { Cookie: owner } })).status).toBe(200)
  })
})

describe('/ws upgrade guard', () => {
  it('without a cookie is 401, with a bad Origin is 403, with both right passes', async () => {
    const h = await makeHarness()
    const cookie = h.login()
    expect((await h.app.request('/probe/ws', { headers: { Origin: ORIGIN } })).status).toBe(401)
    expect(
      (await h.app.request('/probe/ws', { headers: { Origin: 'https://evil.example.net', Cookie: cookie } })).status,
    ).toBe(403)
    expect((await h.app.request('/probe/ws', { headers: { Cookie: cookie } })).status).toBe(403)
    const ok = await h.app.request('/probe/ws', { headers: { Origin: ORIGIN, Cookie: cookie } })
    expect(ok.status).toBe(200)
    expect(
      (await h.app.request('/probe/ws', { headers: { Origin: ORIGIN, Cookie: `${COOKIE_NAME}=${'B'.repeat(43)}` } }))
        .status,
    ).toBe(401)
  })
})

describe('rate limits (spec 5.4)', () => {
  it('the 11th /api/auth call in a minute is 429, and the bucket refills', async () => {
    const h = await makeHarness()
    for (let i = 0; i < 10; i++) expect((await h.post('/api/auth/login/options', {})).status, `call ${i + 1}`).toBe(200)
    const eleventh = await h.post('/api/auth/login/options', {})
    expect(eleventh.status).toBe(429)
    expect(Number(eleventh.headers.get('retry-after'))).toBeGreaterThan(0)
    h.fake.clock.advance(61_000)
    expect((await h.post('/api/auth/login/options', {})).status).toBe(200)
  })

  it('limits are per client IP (the entry TRUST_PROXY_HOPS from the right of X-Forwarded-For)', async () => {
    const h = await makeHarness()
    for (let i = 0; i < 10; i++)
      await h.post('/api/auth/login/options', {}, undefined, { 'X-Forwarded-For': '198.51.100.1' })
    expect((await h.post('/api/auth/login/options', {}, undefined, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(
      429,
    )
    // A spoofed leftmost entry does not buy a fresh bucket: hops=1 reads the rightmost (the proxy-appended) entry.
    expect(
      (await h.post('/api/auth/login/options', {}, undefined, { 'X-Forwarded-For': '9.9.9.9, 198.51.100.1' })).status,
    ).toBe(429)
    expect((await h.post('/api/auth/login/options', {}, undefined, { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(
      200,
    )
  })

  it('50 calls a day per IP is the second ceiling', async () => {
    const h = await makeHarness()
    let denied = 0
    for (let i = 0; i < 60; i++) {
      if ((await h.post('/api/auth/login/options', {})).status === 429) denied++
      h.fake.clock.advance(7000) // under the per-minute limit, over the daily one
    }
    expect(denied).toBeGreaterThan(0)
  })
})
