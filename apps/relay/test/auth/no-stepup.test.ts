import { afterEach, describe, expect, it } from 'vitest'
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

describe('no step-up (owner ruling 2026-11-14: zero Face ID approvals; sign-in keeps the passkey)', () => {
  it('the step-up routes are gone', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    for (const p of ['/api/auth/stepup/options', '/api/auth/stepup/verify'])
      expect((await h.post(p, { purpose: 'device:revoke' }, cookie)).status, p).toBe(404)
  })

  it("revoking a device needs a signed-in session, and no token; an old app's token is ignored", async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned()
    const d = await pinnedDevice(h)
    await pinnedDevice(h) // keeps the passkey (and so the session) alive after the revoke
    expect((await h.post(`/api/devices/${d.id}/revoke`, { stepup_token: 'from-an-old-app' }, cookie)).status).toBe(204)
    expect((await h.post(`/api/devices/${d.id}/revoke`, {}, undefined as never)).status).not.toBe(204)
  })

  it('the auth core no longer mints or checks step-up tokens', async () => {
    const h = await makeHarness()
    expect('mintStepup' in h.state.core).toBe(false)
    expect('consumeStepup' in h.state.core).toBe(false)
  })
})
