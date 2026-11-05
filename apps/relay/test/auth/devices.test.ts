import { loadExampleConfig } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness, newDevice } from './helpers.ts'

afterEach(afterEachReset)

async function enrolled(h: Awaited<ReturnType<typeof makeHarness>>, credentialId: string, pinned = true) {
  const d = await newDevice()
  h.state.core.upsertDevice({
    id: d.id as never,
    name: `Phone ${d.id.slice(2, 6)}`,
    pubkeyJwk: d.jwk,
    credentialId,
    binding: 'b',
    codeId: 'c',
  })
  if (pinned) h.state.core.setPinned(d.id, true)
  return d
}

describe('devices', () => {
  it('GET /api/devices lists devices in the protocol shape', async () => {
    const h = await makeHarness()
    const d = await enrolled(h, 'cred-1')
    const cookie = h.login('cred-1', d.id)
    const res = await h.app.request('/api/devices', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    // The listing request is itself that device being used, so it shows up as used right now.
    expect(list[0]).toMatchObject({
      id: d.id,
      pinned: true,
      revoked: false,
      last_used_at: new Date(h.fake.clock.now()).toISOString(),
      pubkey_jwk: d.jwk,
    })
    expect(Number.isNaN(Date.parse(list[0]?.created_at as string))).toBe(false)
  })

  it('devices need a session', async () => {
    const h = await makeHarness()
    expect((await h.app.request('/api/devices')).status).toBe(401)
    expect((await h.app.request('/api/me')).status).toBe(401)
  })

  it("revoke needs step-up, unpins, kills that device's sessions and tells the bridge", async () => {
    const h = await makeHarness()
    const a = await enrolled(h, 'cred-1')
    const b = await enrolled(h, 'cred-1')
    const cookieA = h.login('cred-1', a.id)
    const cookieB = h.login('cred-1', b.id)
    const sessA = h.state.core.lookupSession(cookieA.split('=')[1] as string)
    // without step-up: refused
    expect((await h.post(`/api/devices/${b.id}/revoke`, {}, cookieA)).status).toBe(403)
    const token = h.state.core.mintStepup(sessA?.id as string, 'device:revoke')
    expect((await h.post(`/api/devices/${b.id}/revoke`, { stepup_token: token }, cookieA)).status).toBe(204)
    expect(h.state.core.device(b.id)).toMatchObject({ revoked: true, pinned: false })
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookieB } })).status).toBe(401)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookieA } })).status).toBe(200)
    const frames = h.fake.bus.toBridgeLog.map((s) => s.frame).filter((f) => f.type === 'device.revoked')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ device_id: b.id })
  })

  it('trust mode (the Mac says so in the synced config): revoke needs the session, not a passkey tap; off, it still does', async () => {
    const h = await makeHarness()
    const a = await enrolled(h, 'cred-1')
    const b = await enrolled(h, 'cred-1')
    const c = await enrolled(h, 'cred-1')
    const cookieA = h.login('cred-1', a.id)
    const base = loadExampleConfig('default')
    // a config that says nothing, and one that says false: both keep the passkey step
    h.fake.setAgentConfig(base)
    expect((await h.post(`/api/devices/${b.id}/revoke`, {}, cookieA)).status).toBe(403)
    h.fake.setAgentConfig({ ...base, trust_mode: false })
    expect((await h.post(`/api/devices/${b.id}/revoke`, {}, cookieA)).status).toBe(403)
    expect(h.state.core.device(b.id)).toMatchObject({ revoked: false })
    h.fake.setAgentConfig({ ...base, trust_mode: true })
    // no session at all is still refused: only the passkey step is relaxed
    expect((await h.post(`/api/devices/${b.id}/revoke`, {})).status).toBe(401)
    expect((await h.post(`/api/devices/${b.id}/revoke`, {}, cookieA)).status).toBe(204)
    expect(h.state.core.device(b.id)).toMatchObject({ revoked: true, pinned: false })
    // a wrong-purpose token is not what lets it through, and the bridge is still told
    expect(h.fake.bus.toBridgeLog.filter((s) => s.frame.type === 'device.revoked')).toHaveLength(1)
    h.fake.setAgentConfig(null)
    expect((await h.post(`/api/devices/${c.id}/revoke`, {}, cookieA)).status).toBe(403)
  })

  it('the passkey is deleted only when no pinned device still uses it', async () => {
    const h = await makeHarness()
    const a = await enrolled(h, 'cred-1')
    const b = await enrolled(h, 'cred-1')
    h.login()
    h.state.core.revokeDevice(a.id)
    expect(h.state.core.credential('cred-1')).not.toBeNull()
    h.state.core.revokeDevice(b.id)
    expect(h.state.core.credential('cred-1')).toBeNull()
    expect(h.state.core.hasPasskey).toBe(false)
  })

  it('an unpinned device does not keep the passkey alive', async () => {
    const h = await makeHarness()
    const a = await enrolled(h, 'cred-1')
    await enrolled(h, 'cred-1', false)
    h.login()
    h.state.core.revokeDevice(a.id)
    expect(h.state.core.credential('cred-1')).toBeNull()
  })

  it('revoking an unknown or malformed id is 404', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const t1 = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    expect((await h.post('/api/devices/d_aaaaaaaaaaaaaaaaaaaa/revoke', { stepup_token: t1 }, cookie)).status).toBe(404)
    const t2 = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    expect((await h.post('/api/devices/nope/revoke', { stepup_token: t2 }, cookie)).status).toBe(404)
  })

  it('POST /bridge/devices/:id/revoke (the Mac CLI path) revokes and tells the apps', async () => {
    const h = await makeHarness()
    const d = await enrolled(h, 'cred-1')
    const cookie = h.login('cred-1', d.id)
    const res = await h.bridgePost(`/bridge/devices/${d.id}/revoke`, {})
    expect(res.status).toBe(200)
    expect(h.state.core.device(d.id)?.revoked).toBe(true)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status).toBe(401)
    expect(h.fake.bus.toAppsLog.map((s) => s.frame)).toContainEqual(
      expect.objectContaining({ type: 'device.pinned', device_id: d.id, ok: false, reason: 'revoked' }),
    )
    expect((await h.bridgePost('/bridge/devices/d_aaaaaaaaaaaaaaaaaaaa/revoke', {})).status).toBe(404)
  })

  it('a device.pinned for a revoked device is ignored', async () => {
    const h = await makeHarness()
    const d = await enrolled(h, 'cred-1', false)
    h.state.core.revokeDevice(d.id)
    await h.fake.bus.injectBridgeFrame({
      v: 1,
      type: 'device.pinned',
      id: '01JBF3V7Q8K2M4N6P8R0S2T41N',
      ts: new Date().toISOString(),
      device_id: d.id,
      ok: true,
    })
    expect(h.state.core.device(d.id)?.pinned).toBe(false)
  })
})
