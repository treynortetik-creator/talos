// Review fixes for "sign out everywhere" versus a pairing in progress (harness: the real auth module, an in-memory bus).
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness, registerPasskey } from './helpers.ts'
import { softAuthenticator } from './soft-passkey.ts'

afterEach(afterEachReset)

describe('sign out everywhere: review fixes', () => {
  it('a device that was paired and later unpinned by a declined re-enroll is not revoked (it was never "pending")', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned('cred-owner')
    await h.loginPinned('cred-owner')
    const victim = h.state.core.devices()[1]!
    h.state.core.declineDevice(victim.id) // the Mac answered N / timed out on a re-enroll of a paired device
    expect((await h.post('/api/auth/logout-all', {}, owner)).status).toBe(204)
    expect(h.state.core.device(victim.id)).toMatchObject({ pinned: false, revoked: false })
    const sent = (h.fake.bus as unknown as { toBridgeLog: Array<{ frame: { type: string; device_id?: string } }> })
      .toBridgeLog
    expect(sent.some((f) => f.frame.type === 'device.revoked' && f.frame.device_id === victim.id)).toBe(false)
  })

  it('a passkey registered halfway through a cancelled pairing cannot sign in afterwards', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned('cred-owner')
    const stranger = softAuthenticator()
    await registerPasskey(h, stranger) // half 1; device/verify never ran
    expect(h.state.core.credential(stranger.credId)).toBeTruthy()
    expect((await h.post('/api/auth/logout-all', {}, owner)).status).toBe(204)
    expect(h.state.core.credential(stranger.credId)).toBeFalsy()
    const o = await h.post('/api/auth/login/options', {})
    const { challenge } = (await o.json()) as { challenge: string }
    const res = await h.post('/api/auth/login/verify', { response: stranger.assert(challenge) })
    expect(res.status).toBe(401)
  })

  it('the passkey of a device that was paired once survives, even while its registration code is still in the table', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned('cred-owner')
    await h.loginPinned('cred-paired')
    const dev = h.state.core.devices().find((d) => d.credentialId === 'cred-paired')!
    h.state.core.setPinned(dev.id, true)
    h.state.core.declineDevice(dev.id) // paired before, unpinned by an unanswered re-enroll
    h.state.core.db
      .prepare(
        'insert into auth_enroll_codes (code_id, code_auth_hash, label, created_at, expires_at, registered_credential_id) values (?, ?, ?, ?, ?, ?)',
      )
      .run('y', 'h2', null, 1, Date.now() + 1e6, 'cred-paired')
    expect((await h.post('/api/auth/logout-all', {}, owner)).status).toBe(204)
    expect(h.state.core.credential('cred-paired')).toBeTruthy()
  })

  it('the owner passkey of a paired device survives', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned('cred-owner')
    expect((await h.post('/api/auth/logout-all', {}, owner)).status).toBe(204)
    expect(h.state.core.credential('cred-owner')).toBeTruthy()
  })

  it('ending sessions and cancelling pairings is one transaction: a failure in the second undoes the first', async () => {
    const h = await makeHarness()
    const owner = await h.loginPinned('cred-owner')
    const core = h.state.core
    core.db.exec(
      "create trigger boom before update of burned_at on auth_enroll_codes begin select raise(abort, 'boom'); end",
    )
    core.db
      .prepare(
        'insert into auth_enroll_codes (code_id, code_auth_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?)',
      )
      .run('x', 'h', null, 1, Date.now() + 1e6)
    let threw = false
    try {
      core.signOutEverywhere()
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(core.db.prepare('select count(*) from auth_sessions').pluck().get()).toBeGreaterThan(0)
    void owner
  })
})
