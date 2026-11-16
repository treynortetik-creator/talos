// Bug hunt R14, on the REAL auth and its real token bucket: the relay's two upload limits answer differently (the hourly
// count is rate_limited, the daily megabytes daily_limit), both with Retry-After, and an upload refused for another reason
// never spends the hourly token.
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterEachReset } from '../auth/helpers.ts'
import { ORIGIN, type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  afterEachReset()
})

const up = (rel: RealRelay, cookie: string, bytes: Uint8Array, extra: Record<string, string> = {}) =>
  fetch(`${rel.httpBase}/api/media`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: cookie, 'content-type': 'image/png', 'X-Talos-CSRF': '1', ...extra },
    body: bytes as BodyInit,
  })
const png = (n: number) => {
  const b = new Uint8Array(n)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}

describe('the upload limits', () => {
  it('the hourly count answers rate_limited with Retry-After; refused uploads do not spend it', async () => {
    r = await startRealRelay({ env: { MEDIA_UPLOADS_PER_HOUR: '2' } })
    const o = await r.owner()
    // refused for other reasons first: an empty body and a wrong checksum
    expect((await up(r, o.cookie, new Uint8Array(0))).status).toBe(400)
    expect((await up(r, o.cookie, png(64), { 'x-talos-sha256': '0'.repeat(64) })).status).toBe(400)
    expect((await up(r, o.cookie, png(64))).status).toBe(200)
    expect((await up(r, o.cookie, png(65))).status).toBe(200)
    const over = await up(r, o.cookie, png(66))
    expect(over.status).toBe(429)
    expect(((await over.json()) as { error: string }).error).toBe('rate_limited')
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('the daily megabytes answer daily_limit with Retry-After, and leave the hourly count alone', async () => {
    r = await startRealRelay({ env: { MEDIA_UPLOADS_PER_HOUR: '3', MEDIA_DAILY_MAX_MB: '1' } })
    const o = await r.owner()
    expect((await up(r, o.cookie, png(700_000))).status).toBe(200)
    const daily = await up(r, o.cookie, png(700_000))
    expect(daily.status).toBe(429)
    expect(((await daily.json()) as { error: string }).error).toBe('daily_limit')
    expect(Number(daily.headers.get('retry-after'))).toBeGreaterThan(3600)
    // the refused one spent no hourly token: two small ones still fit in the three an hour
    expect((await up(r, o.cookie, png(64))).status).toBe(200)
    expect((await up(r, o.cookie, png(65))).status).toBe(200)
  })

  it("the daily Retry-After waits until enough of the owner's own uploads have left the window", async () => {
    const c = fakeClock()
    r = await startRealRelay({ clock: c, env: { MEDIA_DAILY_MAX_MB: '1' } })
    const o = await r.owner()
    expect((await up(r, o.cookie, png(300_000))).status).toBe(200) // t0
    c.advance(3_600_000)
    expect((await up(r, o.cookie, png(600_000))).status).toBe(200) // t0 + 1 h
    // 500 KB more needs both gone: the 300 KB one alone (at t0 + 24 h) still leaves 600 + 500 KB over 1 MB
    const daily = await up(r, o.cookie, png(500_000))
    expect(daily.status).toBe(429)
    expect(Number(daily.headers.get('retry-after'))).toBe(24 * 3600) // the 600 KB one leaves at t0 + 25 h
    // a file bigger than the whole budget never fits: no Retry-After
    const never = await up(r, o.cookie, png(1_100_000))
    expect(never.status).toBe(429)
    expect(never.headers.get('retry-after')).toBeNull()
  })

  it('uploads refused after their body was read have their own bound, and never touch the hourly count', async () => {
    r = await startRealRelay({ env: { MEDIA_UPLOADS_PER_HOUR: '2' } })
    const o = await r.owner()
    for (let i = 0; i < 60; i++) expect((await up(r, o.cookie, new Uint8Array(0))).status).toBe(400)
    const bounded = await up(r, o.cookie, new Uint8Array(0))
    expect(bounded.status).toBe(429)
    expect(((await bounded.json()) as { error: string }).error).toBe('rate_limited')
    expect(Number(bounded.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await up(r, o.cookie, png(64))).status).toBe(200) // the owner's hourly uploads are untouched
  })
})
