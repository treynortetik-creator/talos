// Review of the device-proof change: the gaps that were left open after the first pass.
//  - a device enrolled after the change must not be imitable by a sign-in that leaves the proof out
//  - an open browser upgrades in place (no sign-out needed), and that ends sessions attached without a proof
//  - the first proven sign-in ends sessions attached through the compat path
//  - the owner can see which devices have proved their key
//  - the CLI's revoke route says when a passkey stays valid
import {
  bindingMac,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  loginProofCodeId,
  newEnrollCode,
  SESSION_PROOF_CODE_ID,
  signDeviceProof,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, type Harness, makeHarness, newDevice } from './helpers.ts'
import { softAuthenticator } from './soft-passkey.ts'

afterEach(afterEachReset)

type Auth = ReturnType<typeof softAuthenticator>
type Dev = Awaited<ReturnType<typeof newDevice>>
const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string
const xff = { 'X-Forwarded-For': '203.0.113.7' }

async function mintCode(h: Harness) {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const r = await h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
  })
  expect(r.status).toBe(200)
  return { code, codeAuth }
}

/** Registers the passkey with a setup code and returns the session that comes with it. */
async function registerPasskey(h: Harness, passkey: Auth): Promise<string> {
  const { codeAuth } = await mintCode(h)
  const opts = await h.post('/api/auth/enroll/options', { code_auth: codeAuth }, undefined, xff)
  const { challenge } = (await opts.json()) as { challenge: string }
  const res = await h.post(
    '/api/auth/enroll/verify',
    { code_auth: codeAuth, response: passkey.register(challenge) },
    undefined,
    xff,
  )
  expect(res.status).toBe(200)
  return cookieFrom(res)
}

/** The real enrollment route (half 2): a fresh device key is enrolled by the signed-in session with a new code. */
async function enrollDevice(h: Harness, cookie: string, d: Dev) {
  const c = await mintCode(h)
  const res = await h.post(
    '/api/auth/device/verify',
    {
      device: { id: d.id, name: 'Desktop browser', pubkey_jwk: d.jwk },
      binding: bindingMac(deriveEnrollBind(c.code), d.id, d.jwk),
      code_auth: c.codeAuth,
    },
    cookie,
  )
  expect(res.status).toBe(202)
  h.state.core.setPinned(d.id, true) // the Mac's "y"
}

async function loginWith(h: Harness, passkey: Auth, d: Dev | null, opts: { proof?: boolean; cookie?: string } = {}) {
  const o = await h.post('/api/auth/login/options', {})
  const { challenge } = (await o.json()) as { challenge: string }
  const body: Record<string, unknown> = { response: passkey.assert(challenge) }
  if (d) body.device_id = d.id
  if (d && opts.proof !== false) {
    body.device_proof = {
      nonce: challenge,
      sig: await signDeviceProof(d.key.privateKey, {
        nonce: challenge,
        codeId: loginProofCodeId(passkey.credId),
        deviceId: d.id,
      }),
    }
  }
  return h.post('/api/auth/login/verify', body, opts.cookie)
}

const probe = async (h: Harness, cookie: string) =>
  (await h.app.request('/probe/session', { headers: { Cookie: cookie } })).status

/** A pinned desktop enrolled through the real route, plus a thief session that got in through the compat path. */
async function world() {
  const h = await makeHarness()
  const passkey = softAuthenticator()
  const regCookie = await registerPasskey(h, passkey)
  const desktop = await newDevice()
  await enrollDevice(h, regCookie, desktop)
  return { h, passkey, desktop }
}

describe('a device enrolled after the change is already provable', () => {
  it('ATTACK: enroll, then a sign-in naming it with no proof is refused (no sign-in needed first)', async () => {
    const { h, passkey, desktop } = await world()
    expect(h.state.core.device(desktop.id)?.loginProvenAt).not.toBeNull()
    const thief = await loginWith(h, passkey, desktop, { proof: false })
    expect(thief.status).toBe(403)
    expect(((await thief.json()) as { error: string }).error).toBe('device_proof_required')
    expect(thief.headers.get('set-cookie')).toBeNull()
  })

  it('the real desktop still signs in with its proof', async () => {
    const { h, passkey, desktop } = await world()
    const ok = await loginWith(h, passkey, desktop)
    expect(ok.status).toBe(200)
    expect(await probe(h, cookieFrom(ok))).toBe(200)
  })

  it('ATTACK: a second caller that names the desktop but proves with its own key is refused', async () => {
    const { h, passkey, desktop } = await world()
    const thief = await newDevice()
    const o = await h.post('/api/auth/login/options', {})
    const { challenge } = (await o.json()) as { challenge: string }
    const sig = await signDeviceProof(thief.key.privateKey, {
      nonce: challenge,
      codeId: loginProofCodeId(passkey.credId),
      deviceId: desktop.id,
    })
    const res = await h.post('/api/auth/login/verify', {
      response: passkey.assert(challenge),
      device_id: desktop.id,
      device_proof: { nonce: challenge, sig },
    })
    expect(res.status).toBe(401)
  })
})

describe('the first proven sign-in ends sessions attached without a proof', () => {
  async function compatWorld() {
    // A device from before the change: pinned, never proved, so the compat path still lets a proof-less sign-in in.
    const h = await makeHarness()
    const passkey = softAuthenticator()
    await registerPasskey(h, passkey)
    const desktop = await newDevice()
    h.state.core.upsertDevice({
      id: desktop.id as never,
      name: 'Desktop browser',
      pubkeyJwk: desktop.jwk,
      credentialId: passkey.credId,
      binding: 'b',
      codeId: 'c',
    })
    h.state.core.setPinned(desktop.id, true)
    return { h, passkey, desktop }
  }

  it('ATTACK: the thief session from the compat path dies when the real desktop first proves', async () => {
    const { h, passkey, desktop } = await compatWorld()
    const thief = await loginWith(h, passkey, desktop, { proof: false })
    expect(thief.status).toBe(200)
    const thiefCookie = cookieFrom(thief)
    expect(await probe(h, thiefCookie)).toBe(200)
    const real = await loginWith(h, passkey, desktop)
    expect(real.status).toBe(200)
    expect(await probe(h, thiefCookie)).toBe(401)
    expect(await probe(h, cookieFrom(real))).toBe(200)
    // and the thief cannot come back
    expect((await loginWith(h, passkey, desktop, { proof: false })).status).toBe(403)
  })

  it('later proven sign-ins do not sign out the owner other tabs', async () => {
    const { h, passkey, desktop } = await compatWorld()
    const a = cookieFrom(await loginWith(h, passkey, desktop))
    const b = cookieFrom(await loginWith(h, passkey, desktop))
    expect(await probe(h, a)).toBe(200)
    expect(await probe(h, b)).toBe(200)
  })

  it('a session of another device is not touched', async () => {
    const { h, passkey, desktop } = await compatWorld()
    const phone = await newDevice()
    h.state.core.upsertDevice({
      id: phone.id as never,
      name: 'iPhone',
      pubkeyJwk: phone.jwk,
      credentialId: passkey.credId,
      binding: 'b',
      codeId: 'c2',
    })
    h.state.core.setPinned(phone.id, true)
    const phoneCookie = h.login(passkey.credId, phone.id)
    expect((await loginWith(h, passkey, desktop)).status).toBe(200)
    expect(await probe(h, phoneCookie)).toBe(200)
  })

  it('closes live sockets of the sessions it ended', async () => {
    const { h, passkey, desktop } = await compatWorld()
    let revalidated = 0
    const real = h.fake.services.bus.revalidateApps.bind(h.fake.services.bus)
    h.fake.services.bus.revalidateApps = () => {
      revalidated++
      real()
    }
    await loginWith(h, passkey, desktop, { proof: false })
    expect(revalidated).toBe(0)
    await loginWith(h, passkey, desktop)
    expect(revalidated).toBe(1)
  })
})

describe('an open browser proves its key in place', () => {
  async function liveWorld() {
    const h = await makeHarness()
    const passkey = softAuthenticator()
    await registerPasskey(h, passkey)
    const desktop = await newDevice()
    h.state.core.upsertDevice({
      id: desktop.id as never,
      name: 'Desktop browser',
      pubkeyJwk: desktop.jwk,
      credentialId: passkey.credId,
      binding: 'b',
      codeId: 'c',
    })
    h.state.core.setPinned(desktop.id, true)
    const owner = cookieFrom(await loginWith(h, passkey, desktop, { proof: false })) // an old tab, never proved
    const thief = cookieFrom(await loginWith(h, passkey, desktop, { proof: false }))
    return { h, passkey, desktop, owner, thief }
  }
  const options = async (h: Harness, cookie: string) =>
    ((await (await h.post('/api/auth/device/prove/options', {}, cookie)).json()) as { challenge: string }).challenge
  const sigFor = (d: Dev, nonce: string, codeId = SESSION_PROOF_CODE_ID) =>
    signDeviceProof(d.key.privateKey, { nonce, codeId, deviceId: d.id })

  it('the owner tab proves, the device becomes proven, the thief session ends and the owner keeps theirs', async () => {
    const { h, passkey, desktop, owner, thief } = await liveWorld()
    expect(h.state.core.device(desktop.id)?.loginProvenAt).toBeNull()
    const nonce = await options(h, owner)
    const res = await h.post('/api/auth/device/prove', { nonce, sig: await sigFor(desktop, nonce) }, owner)
    expect(res.status).toBe(200)
    expect(h.state.core.device(desktop.id)?.loginProvenAt).not.toBeNull()
    expect(await probe(h, owner)).toBe(200)
    expect(await probe(h, thief)).toBe(401)
    expect((await loginWith(h, passkey, desktop, { proof: false })).status).toBe(403)
  })

  it('ATTACK: the thief session cannot prove without the private key (own key, and garbage)', async () => {
    const { h, desktop, thief } = await liveWorld()
    const nonce = await options(h, thief)
    const own = await newDevice()
    const forged = await signDeviceProof(own.key.privateKey, {
      nonce,
      codeId: SESSION_PROOF_CODE_ID,
      deviceId: desktop.id,
    })
    expect((await h.post('/api/auth/device/prove', { nonce, sig: forged }, thief)).status).toBe(401)
    expect((await h.post('/api/auth/device/prove', { nonce, sig: 'x'.repeat(86) }, thief)).status).toBe(401)
    expect(h.state.core.device(desktop.id)?.loginProvenAt).toBeNull()
    expect(await probe(h, thief)).toBe(200) // refused, not signed out: nothing was proven
  })

  it('a challenge is single use, and belongs to the session that asked for it', async () => {
    const { h, desktop, owner, thief } = await liveWorld()
    const nonce = await options(h, owner)
    const sig = await sigFor(desktop, nonce)
    // another session replays the owner's challenge and signature
    expect((await h.post('/api/auth/device/prove', { nonce, sig }, thief)).status).toBe(401)
    expect((await h.post('/api/auth/device/prove', { nonce, sig }, owner)).status).toBe(200)
    // used once
    expect((await h.post('/api/auth/device/prove', { nonce, sig }, owner)).status).toBe(401)
  })

  it('a sign-in proof or an enrollment-style proof cannot stand in for a session proof', async () => {
    const { h, passkey, desktop, owner } = await liveWorld()
    const nonce = await options(h, owner)
    for (const codeId of [loginProofCodeId(passkey.credId), 'some-enroll-code-id']) {
      const sig = await sigFor(desktop, nonce, codeId)
      expect((await h.post('/api/auth/device/prove', { nonce, sig }, owner)).status).toBe(401)
    }
    expect(h.state.core.device(desktop.id)?.loginProvenAt).toBeNull()
  })

  it('page loads spend their own budget: 200 opens in a day leave sign-in and sign-out-everywhere untouched', async () => {
    const { h, passkey, desktop, owner } = await liveWorld()
    // Prove once, then keep opening the page: every open asks "is this device proven?" and gets "proven".
    const nonce = await options(h, owner)
    expect((await h.post('/api/auth/device/prove', { nonce, sig: await sigFor(desktop, nonce) }, owner)).status).toBe(
      200,
    )
    const spread = (24 * 3600_000) / 200
    for (let i = 0; i < 200; i++) {
      h.fake.clock.advance(spread)
      const res = await h.post('/api/auth/device/prove/options', {}, owner)
      expect(res.status, `open ${i}`).toBe(200)
    }
    // The shared sign-in budget is full: a sign-in (2 calls) and logout-all still go through from the same address.
    const again = await loginWith(h, passkey, desktop)
    expect(again.status).toBe(200)
    expect((await h.post('/api/auth/logout-all', {}, cookieFrom(again))).status).toBe(204)
  })

  it('ATTACK: a stranger hammering the prove routes is limited, and signs nobody out of login', async () => {
    const { h, passkey, desktop, owner } = await liveWorld()
    let limited = 0
    for (let i = 0; i < 400; i++)
      if ((await h.post('/api/auth/device/prove/options', {}, owner)).status === 429) limited++
    expect(limited).toBeGreaterThan(0) // the prove routes are still bounded
    expect((await loginWith(h, passkey, desktop, { proof: false })).status).toBe(200) // this device never proved, so the compat path answers; the point is it is not 429
  })

  it('needs a session, a device-bound session and a well-formed body', async () => {
    const { h, owner } = await liveWorld()
    expect((await h.post('/api/auth/device/prove/options', {})).status).toBe(401)
    expect((await h.post('/api/auth/device/prove', { nonce: 'a', sig: 'b' })).status).toBe(401)
    expect((await h.post('/api/auth/device/prove', { nonce: 'a', sig: 'b' }, owner)).status).toBe(400)
    expect((await h.post('/api/auth/device/prove', 'nope' as never, owner)).status).toBe(400)
  })

  it('ATTACK: an oversized body on each proof route is refused 413 and proves nothing (the 64 KiB cap covers them)', async () => {
    const { h, desktop, owner, thief } = await liveWorld()
    const nonce = await options(h, owner)
    const sig = await sigFor(desktop, nonce)
    const pad = 'x'.repeat(70 * 1024)
    // A valid proof with junk padded past the cap must not be acted on: the cap fires while the handler reads it.
    const res = await h.post('/api/auth/device/prove', { nonce, sig, pad }, owner)
    expect(res.status).toBe(413)
    // The options route never reads its body, so a streamed overrun costs nothing; a declared length over the cap is
    // still refused up front, before anything is read.
    const declared = await h.post('/api/auth/device/prove/options', {}, owner, {
      'Content-Length': String(1024 * 1024),
    })
    expect(declared.status).toBe(413)
    expect(await probe(h, thief)).toBe(200) // the oversized proof was not accepted, so the thief session is not ended
    // the same challenge still works with a normal body (it was not burned by the refused one)
    expect((await h.post('/api/auth/device/prove', { nonce, sig }, owner)).status).toBe(200)
    expect(await probe(h, thief)).toBe(401)
  })
})

describe('the owner can see which devices proved their key', () => {
  it('GET /api/devices carries login_proven_at (null until the first proof)', async () => {
    const { h, passkey, desktop } = await world()
    const phone = await newDevice()
    h.state.core.upsertDevice({
      id: phone.id as never,
      name: 'iPhone',
      pubkeyJwk: phone.jwk,
      credentialId: passkey.credId,
      binding: 'b',
      codeId: 'c3',
    })
    h.state.core.setPinned(phone.id, true)
    const cookie = cookieFrom(await loginWith(h, passkey, desktop))
    const list = (await (await h.app.request('/api/devices', { headers: { Cookie: cookie } })).json()) as Array<{
      id: string
      login_proven_at?: string | null
    }>
    expect(Date.parse(list.find((d) => d.id === desktop.id)?.login_proven_at as string)).toBeGreaterThan(0)
    expect(list.find((d) => d.id === phone.id)?.login_proven_at).toBeNull()
  })
})

describe('the bridge revoke route says when a passkey stays valid', () => {
  async function two() {
    const h = await makeHarness()
    const a = await newDevice()
    const b = await newDevice()
    for (const [d, i] of [
      [a, 1],
      [b, 2],
    ] as const) {
      h.state.core.upsertDevice({
        id: d.id as never,
        name: `d${i}`,
        pubkeyJwk: d.jwk,
        credentialId: 'cred-1',
        binding: 'b',
        codeId: `c${i}`,
      })
      h.state.core.setPinned(d.id, true)
    }
    return { h, a, b }
  }

  it('shared_passkey is true while another pinned device uses the passkey, false for the last one', async () => {
    const { h, a, b } = await two()
    const first = await h.bridgePost(`/bridge/devices/${a.id}/revoke`, {})
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, shared_passkey: true })
    const last = await h.bridgePost(`/bridge/devices/${b.id}/revoke`, {})
    expect(await last.json()).toEqual({ ok: true, shared_passkey: false })
  })

  it('an unknown device is still a 404', async () => {
    const { h } = await two()
    const x = await newDevice()
    expect((await h.bridgePost(`/bridge/devices/${x.id}/revoke`, {})).status).toBe(404)
  })
})
