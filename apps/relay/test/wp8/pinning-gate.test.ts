// Decision (FOLLOWUPS "unpinned sessions see everything"): a session whose device the Mac has not pinned may finish
// pairing and nothing else. Everything that returns the owner's data answers 403 `device_not_pinned`.
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness, newDevice } from '../auth/helpers.ts'

afterEach(afterEachReset)

describe('unpinned sessions', () => {
  it('can read /api/me (to learn they are unpinned) but not the guarded routes', async () => {
    const h = await makeHarness()
    const cookie = h.login() // a passkey session with no pinned device
    const me = await h.app.request('/api/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ device_pinned: false })
    for (const path of ['/probe/session', '/api/devices']) {
      const res = await h.app.request(path, { headers: { Cookie: cookie } })
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'device_not_pinned' })
    }
  })

  it('can still sign out', async () => {
    const h = await makeHarness()
    expect((await h.post('/api/auth/logout', {}, h.login())).status).toBe(204)
  })

  it('a device that is registered but not pinned is held out too, until the Mac pins it', async () => {
    const h = await makeHarness()
    const d = await newDevice()
    h.login()
    h.state.core.upsertDevice({
      id: d.id as never,
      name: 'Phone',
      pubkeyJwk: d.jwk,
      credentialId: 'cred-1',
      binding: 'b',
      codeId: 'c',
    })
    const cookie = h.login('cred-1', d.id)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(403)
    h.state.core.setPinned(d.id, true)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(200)
    h.state.core.revokeDevice(d.id)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(401)
  })
})
