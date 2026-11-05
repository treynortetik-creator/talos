import {
  bindingMac,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  newEnrollCode,
  signDeviceProof,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, makeHarness, newDevice } from './helpers.ts'

afterEach(afterEachReset)

async function newCode(h: Awaited<ReturnType<typeof makeHarness>>, ttlMs = 600_000) {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const res = await h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(h.fake.clock.now() + ttlMs).toISOString(),
    label: 'test',
  })
  return { code, codeAuth, hash, codeId: enrollCodeId(hash), res }
}

describe('POST /bridge/enroll', () => {
  it('registers a code; the relay stores only the hash', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    expect(c.res.status).toBe(200)
    const rows = h.fake.db.prepare('select * from auth_enroll_codes').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(c.codeAuth)
    expect(JSON.stringify(rows)).not.toContain(c.code)
  })

  it('is idempotent for the same code and 409 for a clashing id', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const again = await h.bridgePost('/bridge/enroll', {
      code_id: c.codeId,
      code_auth_hash: c.hash,
      expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
    })
    expect(again.status).toBe(200)
    const other = await h.bridgePost('/bridge/enroll', {
      code_id: c.codeId,
      code_auth_hash: 'f'.repeat(64),
      expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
    })
    expect(other.status).toBe(409)
  })

  it('refuses a code_id that does not match the hash, a past expiry and a TTL above 10 minutes', async () => {
    const h = await makeHarness()
    const hash = 'a'.repeat(64)
    const exp = (ms: number) => new Date(h.fake.clock.now() + ms).toISOString()
    expect(
      (await h.bridgePost('/bridge/enroll', { code_id: 'b'.repeat(16), code_auth_hash: hash, expires_at: exp(60_000) }))
        .status,
    ).toBe(409)
    expect(
      (
        await h.bridgePost('/bridge/enroll', {
          code_id: enrollCodeId(hash),
          code_auth_hash: hash,
          expires_at: exp(-1000),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await h.bridgePost('/bridge/enroll', {
          code_id: enrollCodeId(hash),
          code_auth_hash: hash,
          expires_at: exp(3600_000),
        })
      ).status,
    ).toBe(400)
    expect((await h.bridgePost('/bridge/enroll', { nope: true })).status).toBe(400)
  })

  it('needs a valid bridge signature', async () => {
    const h = await makeHarness()
    const res = await h.app.request('/bridge/enroll', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })
})

describe('enrollment codes gate registration (spec 5.2)', () => {
  it('a valid code gets registration options with the pinned parameters', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const res = await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth })
    expect(res.status).toBe(200)
    const o = (await res.json()) as {
      rp: unknown
      attestation: string
      authenticatorSelection: unknown
      pubKeyCredParams: Array<{ alg: number }>
      user: { name: string }
    }
    expect(o.rp).toEqual({ name: 'Talos', id: 'relay.example.com' })
    expect(o.attestation).toBe('none')
    expect(o.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
    expect(o.pubKeyCredParams.map((p) => p.alg).sort()).toEqual([-257, -8, -7].sort())
    expect(o.user.name).toBe('owner')
  })

  it('the WebAuthn userID is fixed across calls', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const a = (await (await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth })).json()) as {
      user: { id: string }
    }
    const b = (await (
      await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth }, undefined, {
        'X-Forwarded-For': '198.51.100.9',
      })
    ).json()) as { user: { id: string } }
    expect(a.user.id).toBe(b.user.id)
  })

  it('an unknown code is 410', async () => {
    const h = await makeHarness()
    expect((await h.post('/api/auth/enroll/options', { code_auth: 'nope' })).status).toBe(410)
    expect((await h.post('/api/auth/enroll/verify', { code_auth: 'nope', response: {} })).status).toBe(410)
  })

  it('an expired code is 410', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    h.fake.clock.advance(600_001)
    expect((await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth })).status).toBe(410)
  })

  it('a used code is 410', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    h.state.core.markCodeUsed(c.codeId)
    expect((await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth })).status).toBe(410)
  })

  it('5 wrong code_auth calls burn every outstanding code, even a valid one', async () => {
    const h = await makeHarness()
    const a = await newCode(h)
    const b = await newCode(h)
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await h.post('/api/auth/enroll/options', { code_auth: `wrong-${i}` }, undefined, {
            'X-Forwarded-For': `198.51.100.${i + 1}`,
          })
        ).status,
      ).toBe(410)
    }
    // 4 failures: codes still alive
    expect(h.state.core.findCode(a.codeAuth)).not.toBeNull()
    expect(
      (
        await h.post('/api/auth/enroll/options', { code_auth: 'wrong-4' }, undefined, {
          'X-Forwarded-For': '198.51.100.20',
        })
      ).status,
    ).toBe(410)
    // from any IP: counted globally, so the 6th call (a correct one) is gone
    expect(
      (
        await h.post('/api/auth/enroll/options', { code_auth: a.codeAuth }, undefined, {
          'X-Forwarded-For': '198.51.100.30',
        })
      ).status,
    ).toBe(410)
    expect(
      (
        await h.post('/api/auth/enroll/options', { code_auth: b.codeAuth }, undefined, {
          'X-Forwarded-For': '198.51.100.31',
        })
      ).status,
    ).toBe(410)
    // a code registered afterwards is fine
    const c = await newCode(h)
    expect(
      (
        await h.post('/api/auth/enroll/options', { code_auth: c.codeAuth }, undefined, {
          'X-Forwarded-For': '198.51.100.32',
        })
      ).status,
    ).toBe(200)
  })

  it('failures older than 10 minutes do not count', async () => {
    const h = await makeHarness()
    await newCode(h, 600_000)
    for (let i = 0; i < 4; i++)
      await h.post('/api/auth/enroll/options', { code_auth: `wrong-${i}` }, undefined, {
        'X-Forwarded-For': `198.51.100.${i + 1}`,
      })
    h.fake.clock.advance(9 * 60_000)
    const fresh = await newCode(h)
    h.fake.clock.advance(2 * 60_000)
    await h.post('/api/auth/enroll/options', { code_auth: 'wrong-x' }, undefined, {
      'X-Forwarded-For': '198.51.100.40',
    })
    expect(h.state.core.findCode(fresh.codeAuth)).not.toBeNull()
  })

  it('registration needs the CSRF headers too', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const res = await h.app.request('/api/auth/enroll/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_auth: c.codeAuth }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/auth/device/verify (half 2)', () => {
  async function setup() {
    const h = await makeHarness()
    const c = await newCode(h)
    const cookie = h.login()
    const d = await newDevice()
    const binding = bindingMac(deriveEnrollBind(c.code), d.id, d.jwk)
    const body = {
      device: { id: d.id, name: 'iPhone (Home Screen)', pubkey_jwk: d.jwk },
      binding,
      code_auth: c.codeAuth,
    }
    return { h, c, cookie, d, body }
  }

  it('needs a session', async () => {
    const { h, body } = await setup()
    expect((await h.post('/api/auth/device/verify', body)).status).toBe(401)
  })

  it('accepts a valid enrollment: 202, device.enrolled to the bridge, /api/me says not pinned', async () => {
    const { h, cookie, body, d, c } = await setup()
    const res = await h.post('/api/auth/device/verify', body, cookie)
    expect(res.status).toBe(202)
    const sent = h.fake.bus.toBridgeLog.map((s) => s.frame).filter((f) => f.type === 'device.enrolled')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      device: { id: d.id, name: 'iPhone (Home Screen)' },
      binding: body.binding,
      code_id: c.codeId,
      credential_id: 'cred-1',
    })
    expect(h.fake.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true })
    const me = (await (await h.app.request('/api/me', { headers: { Cookie: cookie } })).json()) as Record<
      string,
      unknown
    >
    expect(me).toMatchObject({
      device_id: d.id,
      device_pinned: false,
      has_passkey: true,
      rp_id: 'relay.example.com',
      bridge_online: false,
    })
  })

  it('refuses a device id already pinned under another credential, and never unpins a pinned one', async () => {
    const { h, body, d } = await setup()
    h.state.core.upsertDevice({
      id: d.id as never,
      name: 'Owner phone',
      pubkeyJwk: d.jwk,
      credentialId: 'cred-owner',
      binding: 'b',
      codeId: 'c0',
    })
    h.state.core.setPinned(d.id, true)
    // another credential's session, holding a live code
    const res = await h.post('/api/auth/device/verify', body, h.login('cred-other'))
    expect(res.status).toBe(409)
    expect(h.state.core.device(d.id)).toMatchObject({ pinned: true, credentialId: 'cred-owner' })
    // the same credential re-verifying keeps the pin too
    const c2 = await newCode(h)
    const again = { ...body, code_auth: c2.codeAuth, binding: bindingMac(deriveEnrollBind(c2.code), d.id, d.jwk) }
    // ...but only with proof that it holds the device's private key (WP-N0 review F1): 409 + a nonce, sign it, send again
    const owner = h.login('cred-owner')
    const ask = await h.post('/api/auth/device/verify', again, owner)
    expect(ask.status).toBe(409)
    const { error, challenge } = (await ask.json()) as { error: string; challenge: string }
    expect(error).toBe('device_proof_required')
    expect(h.state.core.findCode(again.code_auth)).not.toBeNull() // asking for proof does not burn the code
    const sig = await signDeviceProof(d.key.privateKey, {
      nonce: challenge,
      codeId: enrollCodeId(enrollAuthHash(c2.codeAuth)),
      deviceId: d.id,
    })
    expect(
      (await h.post('/api/auth/device/verify', { ...again, proof: { nonce: challenge, sig } }, owner)).status,
    ).toBe(202)
    expect(h.state.core.device(d.id)?.pinned).toBe(true)
    // the nonce is single use
    const c3 = await newCode(h)
    const third = { ...body, code_auth: c3.codeAuth, binding: bindingMac(deriveEnrollBind(c3.code), d.id, d.jwk) }
    expect(
      (await h.post('/api/auth/device/verify', { ...third, proof: { nonce: challenge, sig } }, owner)).status,
    ).toBe(409)
  })

  it('/api/me reports device_pinned:false until device.pinned{ok:true} arrives from the Mac', async () => {
    const { h, cookie, body, d } = await setup()
    await h.post('/api/auth/device/verify', body, cookie)
    const frame = {
      v: 1,
      type: 'device.pinned',
      id: '01JBF3V7Q8K2M4N6P8R0S2T41N',
      ts: new Date().toISOString(),
      device_id: d.id,
      ok: true,
    }
    await h.fake.bus.injectBridgeFrame(frame)
    const me = (await (await h.app.request('/api/me', { headers: { Cookie: cookie } })).json()) as Record<
      string,
      unknown
    >
    expect(me.device_pinned).toBe(true)
    // The hub stores, fans out and pushes the device.pinned frame itself (one frame, one push per pin, review #26): this
    // module only flips the pin and has the live sockets re-gated.
    expect(h.fake.bus.toAppsLog.map((s) => s.frame).filter((f) => f.type === 'device.pinned')).toHaveLength(0)
    expect(h.fake.bus.revalidations).toBe(1)
  })

  it('a declined pin leaves the device unpinned', async () => {
    const { h, cookie, body, d } = await setup()
    await h.post('/api/auth/device/verify', body, cookie)
    await h.fake.bus.injectBridgeFrame({
      v: 1,
      type: 'device.pinned',
      id: '01JBF3V7Q8K2M4N6P8R0S2T41N',
      ts: new Date().toISOString(),
      device_id: d.id,
      ok: false,
      reason: 'declined',
    })
    expect(h.state.core.device(d.id)?.pinned).toBe(false)
    expect(h.fake.push.intents).toEqual([])
  })

  it('consumes the code: a second device with the same code is 410', async () => {
    const { h, cookie, body } = await setup()
    expect((await h.post('/api/auth/device/verify', body, cookie)).status).toBe(202)
    const other = await newDevice()
    const second = { ...body, device: { id: other.id, name: 'Other', pubkey_jwk: other.jwk } }
    expect((await h.post('/api/auth/device/verify', second, cookie)).status).toBe(410)
  })

  it('a wrong code_auth is 410 and counts toward the burn rule: the fifth burns the valid code too', async () => {
    const { h, cookie, body } = await setup()
    for (let i = 0; i < 4; i++) {
      const res = await h.post('/api/auth/device/verify', { ...body, code_auth: `wrong-${i}` }, cookie)
      expect(res.status).toBe(410)
    }
    expect(h.state.core.findCode(body.code_auth)).not.toBeNull() // four misses leave the real code alive
    expect((await h.post('/api/auth/device/verify', { ...body, code_auth: 'wrong-4' }, cookie)).status).toBe(410)
    expect(h.state.core.findCode(body.code_auth)).toBeNull()
    expect((await h.post('/api/auth/device/verify', body, cookie)).status).toBe(410)
  })

  it('a device id that is not the hash of its key is 400', async () => {
    const { h, cookie, body } = await setup()
    const other = await newDevice()
    const bad = { ...body, device: { ...body.device, id: other.id } }
    expect((await h.post('/api/auth/device/verify', bad, cookie)).status).toBe(400)
  })

  it('does not call WebAuthn registration: it works with only a session and a code', async () => {
    const { h, cookie, body } = await setup()
    const before = h.fake.db.prepare('select count(*) as n from auth_credentials').pluck().get()
    await h.post('/api/auth/device/verify', body, cookie)
    expect(h.fake.db.prepare('select count(*) as n from auth_credentials').pluck().get()).toBe(before)
  })

  it('a revoked device cannot be re-enrolled with the same key', async () => {
    const { h, cookie, body, d } = await setup()
    await h.post('/api/auth/device/verify', body, cookie)
    h.state.core.revokeDevice(d.id)
    const c2 = await newCode(h)
    // revoking the only device dropped the passkey and its sessions; sign in again
    expect((await h.post('/api/auth/device/verify', { ...body, code_auth: c2.codeAuth }, cookie)).status).toBe(401)
    expect((await h.post('/api/auth/device/verify', { ...body, code_auth: c2.codeAuth }, h.login())).status).toBe(409)
  })
})
