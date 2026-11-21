import { describe, expect, it } from 'vitest'
import { routes } from '../src/http.ts'

describe('/healthz and /api/me: release', () => {
  const me = {
    device_pinned: false,
    has_passkey: true,
    rp_id: 'relay.example.com',
    version: 'abc1234',
    bridge_online: true,
  }
  it('both parse with and without release (old relay, old client)', () => {
    expect(routes.healthz.res.parse({ ok: true, version: 'abc1234' }).release).toBeUndefined()
    expect(routes.healthz.res.parse({ ok: true, version: 'abc1234', release: '0.1.8' }).release).toBe('0.1.8')
    expect(routes.me.res.parse(me).release).toBeUndefined()
    expect(routes.me.res.parse({ ...me, release: '0.1.8' }).release).toBe('0.1.8')
  })
  it('a junk release degrades that field, not the answer', () => {
    expect(routes.healthz.res.parse({ ok: true, version: 'abc1234', release: 7 }).release).toBeUndefined()
    expect(routes.me.res.parse({ ...me, release: 'x'.repeat(200) }).version).toBe('abc1234')
  })
})
