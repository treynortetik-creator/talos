// Item 3 (device-proof): sign-in must prove the NAMED device by signing the login challenge with its device key.
// Attack reproduced first: a shared passkey plus a revoked phone let sign-in name the desktop's device id and get a pinned
// session without the desktop's private key.
import { loginProofCodeId, signDeviceProof } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, type Harness, makeHarness, newDevice, registerPasskey } from './helpers.ts'
import { softAuthenticator } from './soft-passkey.ts'

afterEach(afterEachReset)

type Auth = ReturnType<typeof softAuthenticator>
type Dev = Awaited<ReturnType<typeof newDevice>>

const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string

function pinDevice(h: Harness, d: Dev, credId: string, name: string) {
  h.state.core.upsertDevice({
    id: d.id as never,
    name,
    pubkeyJwk: d.jwk,
    credentialId: credId,
    binding: 'b',
    codeId: `c-${d.id}`,
  })
  h.state.core.setPinned(d.id, true)
}

async function twoDevices() {
  const h = await makeHarness()
  const passkey = softAuthenticator()
  await registerPasskey(h, passkey)
  const phone = await newDevice()
  const desktop = await newDevice()
  pinDevice(h, phone, passkey.credId, 'iPhone')
  pinDevice(h, desktop, passkey.credId, 'Desktop browser')
  return { h, passkey, phone, desktop }
}

/** Sign-in as the web app does it: fetch options, assert, optionally sign the same challenge with the device key. */
async function login(
  h: Harness,
  passkey: Auth,
  opts: { device?: Dev; sign?: Dev; omitProof?: boolean; challengeOverride?: string; cookie?: string } = {},
) {
  const o = await h.post('/api/auth/login/options', {})
  const { challenge } = (await o.json()) as { challenge: string }
  const body: Record<string, unknown> = { response: passkey.assert(challenge) }
  if (opts.device) body.device_id = opts.device.id
  const signer = opts.sign ?? opts.device
  if (signer && !opts.omitProof) {
    body.device_proof = {
      nonce: opts.challengeOverride ?? challenge,
      sig: await signDeviceProof(signer.key.privateKey, {
        nonce: opts.challengeOverride ?? challenge,
        codeId: loginProofCodeId(passkey.credId),
        deviceId: (opts.device ?? signer).id,
      }),
    }
  }
  return { res: await h.post('/api/auth/login/verify', body, opts.cookie), challenge, body }
}

const probe = async (h: Harness, res: Response, cookie = cookieFrom(res)) =>
  (await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status

describe('item 3: sign-in proves the named device', () => {
  it('ATTACK: shared passkey, revoked phone, sign-in naming the desktop WITHOUT its key does not get a pinned session', async () => {
    const { h, passkey, phone, desktop } = await twoDevices()
    // the desktop has signed in properly once (upgraded client): it is now known to prove itself
    expect((await login(h, passkey, { device: desktop })).res.status).toBe(200)
    h.state.core.revokeDevice(phone.id)
    // the thief holds the passkey (iCloud) and the desktop's public id, but not its private key
    const { res } = await login(h, passkey, { device: desktop, omitProof: true })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('device_proof_required')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('ATTACK: a proof signed by another key (the thief own device key) is refused, even for a never-proven device', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const thief = await newDevice()
    // the proof names the desktop's id but is signed with the thief's key
    const forged = await login(h, passkey, { device: desktop, sign: thief })
    expect(forged.res.status).toBe(401)
    expect(await probe(h, forged.res)).toBe(401)
  })

  it('a real proof signs the user in with a pinned session and marks the device as proving', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const { res } = await login(h, passkey, { device: desktop })
    expect(res.status).toBe(200)
    expect(await probe(h, res)).toBe(200)
    expect(h.state.core.device(desktop.id)?.loginProvenAt).not.toBeNull()
  })

  it('a proof is single use: replaying the same assertion and proof is refused', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const first = await login(h, passkey, { device: desktop })
    expect(first.res.status).toBe(200)
    const replay = await h.post('/api/auth/login/verify', first.body)
    expect(replay.status).toBe(401)
  })

  it('a proof over a different challenge than the one the passkey signed is refused', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const old = await login(h, passkey, { device: desktop }) // its challenge is spent
    const { res } = await login(h, passkey, { device: desktop, challengeOverride: old.challenge })
    expect(res.status).toBe(401)
  })

  it('a proof for one passkey cannot be used under another (domain-bound to the credential)', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const o = await h.post('/api/auth/login/options', {})
    const { challenge } = (await o.json()) as { challenge: string }
    const sig = await signDeviceProof(desktop.key.privateKey, {
      nonce: challenge,
      codeId: loginProofCodeId('some-other-credential'),
      deviceId: desktop.id,
    })
    const res = await h.post('/api/auth/login/verify', {
      response: passkey.assert(challenge),
      device_id: desktop.id,
      device_proof: { nonce: challenge, sig },
    })
    expect(res.status).toBe(401)
  })

  it('COMPAT: a device that never proved (old web build) still signs in as before, and the owner is alerted', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const { res } = await login(h, passkey, { device: desktop, omitProof: true })
    expect(res.status).toBe(200)
    expect(await probe(h, res)).toBe(200)
    expect(h.fake.push.intents.map((i) => i.template)).toEqual(['sign_in_unproven'])
    expect(h.state.core.device(desktop.id)?.loginProvenAt).toBeNull()
  })

  it('COMPAT: a browser with no device key (no device_id) still signs in, unpinned, as before', async () => {
    const { h, passkey } = await twoDevices()
    const { res } = await login(h, passkey)
    expect(res.status).toBe(200)
    expect(await probe(h, res)).toBe(403)
  })

  it('COMPAT: unknown extra fields and a malformed proof on a never-proven device degrade to the old behaviour', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const o = await h.post('/api/auth/login/options', {})
    const { challenge } = (await o.json()) as { challenge: string }
    const res = await h.post('/api/auth/login/verify', {
      response: passkey.assert(challenge),
      device_id: desktop.id,
      device_proof: 'garbage',
      future_field: { a: 1 },
    })
    expect(res.status).toBe(200)
  })

  it('alerts the owner on every sign-in, with fixed text', async () => {
    const { h, passkey, desktop } = await twoDevices()
    await login(h, passkey, { device: desktop })
    await login(h, passkey)
    expect(h.fake.push.intents.map((i) => i.template)).toEqual(['sign_in', 'sign_in'])
  })

  it('a refused sign-in sends no "signed in" alert', async () => {
    const { h, passkey, desktop } = await twoDevices()
    await login(h, passkey, { device: desktop })
    h.fake.push.intents.length = 0
    await login(h, passkey, { device: desktop, omitProof: true })
    expect(h.fake.push.intents).toEqual([])
  })

  it('the old session survives a refused sign-in', async () => {
    const { h, passkey, desktop } = await twoDevices()
    const good = await login(h, passkey, { device: desktop })
    const cookie = cookieFrom(good.res)
    await login(h, passkey, { device: desktop, omitProof: true, cookie })
    expect(await probe(h, good.res, cookie)).toBe(200)
  })

  it("a device's first proof over its own live cookie ends that session as signed_in_again (queue kept) and the device's other sessions as replaced", async () => {
    const { h, passkey, desktop } = await twoDevices()
    // two sign-ins from a build that never proves, one per tab; this tab's cookie rides the first-proof sign-in
    const mine = cookieFrom((await login(h, passkey, { device: desktop, omitProof: true })).res)
    const other = cookieFrom((await login(h, passkey, { device: desktop, omitProof: true })).res)
    const proven = await login(h, passkey, { device: desktop, cookie: mine })
    expect(proven.res.status).toBe(200)
    const reasonOf = async (cookie: string) => {
      const r = await h.app.request('/api/me', { headers: { Cookie: cookie } })
      return { status: r.status, reason: ((await r.json()) as { reason?: string }).reason }
    }
    expect(await reasonOf(mine)).toEqual({ status: 401, reason: 'signed_in_again' })
    expect(await reasonOf(other)).toEqual({ status: 401, reason: 'replaced' })
    expect(await probe(h, proven.res)).toBe(200)
  })

  it('DEVICE_PROOF_REQUIRED=1 refuses even a never-proven device without a proof', async () => {
    const h = await makeHarness({ env: { DEVICE_PROOF_REQUIRED: '1' } })
    const passkey = softAuthenticator()
    await registerPasskey(h, passkey)
    const d = await newDevice()
    pinDevice(h, d, passkey.credId, 'Desktop browser')
    const { res } = await login(h, passkey, { device: d, omitProof: true })
    expect(res.status).toBe(403)
    expect((await login(h, passkey, { device: d })).res.status).toBe(200)
  })

  it('a push failure is logged and does not fail the sign-in', async () => {
    const { h, passkey, desktop } = await twoDevices()
    h.fake.services.push.notify = async () => {
      throw new Error('push down')
    }
    const { res } = await login(h, passkey, { device: desktop })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fake.logs.some((l) => l.level === 'warn' && String(l.msg).includes('sign-in alert'))).toBe(true)
  })

  it('a revoked device id is never attached, proof or not', async () => {
    const { h, passkey, phone } = await twoDevices()
    h.state.core.revokeDevice(phone.id)
    const { res } = await login(h, passkey, { device: phone })
    expect(res.status).toBe(200)
    expect(await probe(h, res)).toBe(403)
  })
})

describe('item 3: revoking a device that shares a passkey', () => {
  it('lists shared_passkey for devices whose passkey another live device also uses', async () => {
    const { h, passkey, phone, desktop } = await twoDevices()
    const { res } = await login(h, passkey, { device: desktop })
    const list = (await (
      await h.app.request('/api/devices', { headers: { Cookie: cookieFrom(res) } })
    ).json()) as Array<{ id: string; shared_passkey?: boolean }>
    expect(list.find((d) => d.id === phone.id)?.shared_passkey).toBe(true)
    expect(list.find((d) => d.id === desktop.id)?.shared_passkey).toBe(true)
    h.state.core.revokeDevice(phone.id)
    const after = (await (
      await h.app.request('/api/devices', { headers: { Cookie: cookieFrom(res) } })
    ).json()) as Array<{ id: string; shared_passkey?: boolean }>
    expect(after.find((d) => d.id === desktop.id)?.shared_passkey).toBe(false)
  })
})
