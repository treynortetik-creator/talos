import { afterEach, describe, expect, it } from 'vitest'
import { consumeStepupToken } from '../../src/auth/contract.ts'
import { afterEachReset, makeHarness, newDevice } from './helpers.ts'

afterEach(afterEachReset)

async function pinnedDevice(h: Awaited<ReturnType<typeof makeHarness>>) {
  const d = await newDevice()
  h.state.core.upsertDevice({
    id: d.id as never,
    name: 'Test phone',
    pubkeyJwk: d.jwk,
    credentialId: 'cred-1',
    binding: 'b',
    codeId: 'c',
  })
  h.state.core.setPinned(d.id, true)
  return d
}

describe('step-up tokens (spec 5.2)', () => {
  it('a fresh token for the right purpose is accepted once, then 403 on reuse', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const token = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    const second = await pinnedDevice(h) // keeps the passkey (and so the session) alive after the first revoke
    const ok = await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: token }, cookie)
    expect(ok.status).toBe(204)
    const again = await h.post(`/api/devices/${second.id}/revoke`, { stepup_token: token }, cookie)
    expect(again.status).toBe(403)
    expect(h.state.core.device(second.id)?.revoked).toBe(false)
  })

  it('a token minted for another purpose is 403 and is not burned by the failed attempt', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const wrong = h.state.core.mintStepup(sess?.id as string, 'config:work')
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: wrong }, cookie)).status).toBe(403)
    expect(h.state.core.device(d.id)?.revoked).toBe(false)
    // still good for its own purpose
    expect(h.state.core.consumeStepup(wrong, 'config:work', sess?.id as string)).toBe(true)
  })

  it('a 121 s old token is 403, a 119 s old one is accepted', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const stale = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    const fresh = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    h.fake.clock.advance(121_000)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: stale }, cookie)).status).toBe(403)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: fresh }, cookie)).status).toBe(403)
    const ok = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    h.fake.clock.advance(119_000)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: ok }, cookie)).status).toBe(204)
  })

  it('a token is bound to its session: another session cannot use it', async () => {
    const h = await makeHarness()
    const a = await h.loginPinned()
    const b = await h.loginPinned()
    const d = await pinnedDevice(h)
    const sa = h.state.core.lookupSession(a.split('=')[1] as string)
    const token = h.state.core.mintStepup(sa?.id as string, 'device:revoke')
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: token }, b)).status).toBe(403)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: token }, a)).status).toBe(204)
  })

  it('the token can ride in the X-Talos-Stepup header', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const token = h.state.core.mintStepup(sess?.id as string, 'device:revoke')
    expect((await h.post(`/api/devices/${d.id}/revoke`, {}, cookie, { 'X-Talos-Stepup': token })).status).toBe(204)
  })

  it('no token, a garbage token and no session are refused', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    expect((await h.post(`/api/devices/${d.id}/revoke`, {}, cookie)).status).toBe(403)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: 'nope' }, cookie)).status).toBe(403)
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: 'nope' })).status).toBe(401)
  })

  it('the stored form is a hash, not the token', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const token = h.state.core.mintStepup(sess?.id as string, 'config:work')
    const rows = h.fake.db.prepare('select token_hash from auth_stepup').all() as Array<{ token_hash: string }>
    expect(rows.map((r) => r.token_hash)).not.toContain(token)
  })

  it('consumeStepupToken (the WebSocket path) is single use, purpose-exact and session-bound', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const sess = h.state.core.lookupSession(cookie.split('=')[1] as string)
    const session = { sessionId: sess?.id as string, deviceId: null }
    const cardPurpose = 'card:c_01JBF3V7Q8K2M4N6P8R0S2T41M' as const
    const t = h.state.core.mintStepup(session.sessionId, cardPurpose)
    expect(await consumeStepupToken({ token: t, purpose: 'config:work', session })).toBe(false)
    expect(await consumeStepupToken({ token: t, purpose: cardPurpose, session: null })).toBe(false)
    expect(
      await consumeStepupToken({ token: t, purpose: cardPurpose, session: { sessionId: 'other', deviceId: null } }),
    ).toBe(false)
    expect(await consumeStepupToken({ token: t, purpose: cardPurpose, session })).toBe(true)
    expect(await consumeStepupToken({ token: t, purpose: cardPurpose, session })).toBe(false)
  })
})
