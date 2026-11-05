// WP-I6: the iPhone app signs in with a setup code (a passkey-less session). Its step-up must offer the owner's EXISTING
// passkeys for the same RP ID (no new credential, no bypass), and a passkey session must stay pinned to its own credential.
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness, newDevice } from './helpers.ts'

afterEach(afterEachReset)

describe('step-up options by session kind', () => {
  it('a setup-code session (no credential) is offered the RP ID with no pinned credential: any registered passkey answers', async () => {
    const h = await makeHarness()
    h.login('cred-owner') // registers the owner's existing passkey
    const d = await newDevice()
    h.state.core.upsertDevice({
      id: d.id as never,
      name: 'iPhone app',
      pubkeyJwk: d.jwk,
      credentialId: 'cred-owner',
      binding: 'b',
      codeId: 'c',
    })
    h.state.core.setPinned(d.id, true)
    const cookie = `${h.login('cred-owner').split('=')[0]}=${h.state.core.createSession(null, d.id)}`
    const res = await h.post('/api/auth/stepup/options', { purpose: 'device:revoke' }, cookie)
    expect(res.status).toBe(200)
    const opts = (await res.json()) as { rpId: string; allowCredentials?: unknown[]; userVerification: string }
    expect(opts.rpId).toBe('relay.example.com')
    expect(opts.userVerification).toBe('required')
    expect(opts.allowCredentials ?? []).toEqual([])
  })

  it('a passkey session stays pinned to the credential it signed in with', async () => {
    const h = await makeHarness()
    const cookie = await h.loginPinned('cred-owner')
    const res = await h.post('/api/auth/stepup/options', { purpose: 'device:revoke' }, cookie)
    const opts = (await res.json()) as { allowCredentials?: Array<{ id: string }> }
    expect(opts.allowCredentials?.map((c) => c.id)).toEqual(['cred-owner'])
  })
})
