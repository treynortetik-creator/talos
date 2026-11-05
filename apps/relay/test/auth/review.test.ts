// Adversarial review of PR #2 (WP2). Every test here describes the behaviour the spec or the threat model needs;
// each one FAILS on wp2/relay-auth @ b54b67d. Software WebAuthn authenticator (attestation 'none', ES256) so the
// real /api/auth/* routes and SimpleWebAuthn verification run end to end in vitest.
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  b64urlEncode,
  bindingMac,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  generateBridgeKey,
  newEnrollCode,
  signRotation,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { afterEachReset, type Harness, makeHarness, newDevice, ORIGIN } from './helpers.ts'

afterEach(afterEachReset)

const RP_ID = new URL(ORIGIN).hostname
const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest())
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
const b64uToBytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

/** A software passkey. `credId` can be chosen: a real attacker controls it too. */
function softAuthenticator(credIdBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, b64uToBytes(jwk.x)],
    [-3, b64uToBytes(jwk.y)],
  ])
  const credId = b64urlEncode(credIdBytes)
  const counter = 0
  const counterBytes = () => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, counter)
    return b
  }
  return {
    credId,
    register(challenge: string) {
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false })
      const len = new Uint8Array([credIdBytes.length >> 8, credIdBytes.length & 0xff])
      const authData = concat(
        sha(RP_ID),
        new Uint8Array([0x45]), // UP | UV | AT
        counterBytes(),
        new Uint8Array(16),
        len,
        credIdBytes,
        isoCBOR.encode(cose as never),
      )
      const att = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]) as never,
      )
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64urlEncode(new TextEncoder().encode(clientData)),
          attestationObject: b64urlEncode(att),
          transports: ['internal'],
        },
      }
    },
    assert(challenge: string, key: KeyObject = privateKey) {
      const clientData = JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false })
      const cd = new TextEncoder().encode(clientData)
      const authData = concat(sha(RP_ID), new Uint8Array([0x05]), counterBytes())
      const sig = sign('sha256', concat(authData, sha(cd)), { key, dsaEncoding: 'der' })
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64urlEncode(cd),
          authenticatorData: b64urlEncode(authData),
          signature: b64urlEncode(new Uint8Array(sig)),
        },
      }
    },
  }
}

async function newCode(h: Harness) {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const res = await h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
  })
  expect(res.status).toBe(200)
  return { code, codeAuth, codeId: enrollCodeId(hash) }
}

const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string

async function enroll(h: Harness, codeAuth: string, a: ReturnType<typeof softAuthenticator>, ip = '203.0.113.7') {
  const xff = { 'X-Forwarded-For': ip }
  const opts = await h.post('/api/auth/enroll/options', { code_auth: codeAuth }, undefined, xff)
  if (opts.status !== 200) return opts
  const { challenge } = (await opts.json()) as { challenge: string }
  return h.post('/api/auth/enroll/verify', { code_auth: codeAuth, response: a.register(challenge) }, undefined, xff)
}

async function login(h: Harness, a: ReturnType<typeof softAuthenticator>, extra: Record<string, unknown> = {}) {
  const opts = await h.post('/api/auth/login/options', {})
  const { challenge } = (await opts.json()) as { challenge: string }
  return h.post('/api/auth/login/verify', { response: a.assert(challenge), ...extra })
}

describe('PR2 review: enrollment codes', () => {
  it('F1: one enrollment code registers ONE passkey (a link seen by someone else cannot add a silent second)', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const owner = softAuthenticator()
    expect((await enroll(h, c.codeAuth, owner)).status).toBe(200)
    // The attacker who saw the link registers their own passkey with the same code. The Mac never hears about it:
    // device.enrolled only fires on /device/verify, which the attacker skips.
    const attacker = softAuthenticator()
    const res = await enroll(h, c.codeAuth, attacker, '198.51.100.66')
    expect(res.status).toBe(410)
  })

  it('F2: registration cannot replace an existing credential (credential ids are public via excludeCredentials)', async () => {
    const h = await makeHarness()
    const owner = softAuthenticator()
    const c1 = await newCode(h)
    expect((await enroll(h, c1.codeAuth, owner)).status).toBe(200)
    const before = h.state.core.credential(owner.credId)?.publicKey
    // Second code (the owner is enrolling another keychain). The attacker reuses the OWNER's credential id with
    // their own key; the id is printed in enroll/options.excludeCredentials.
    const c2 = await newCode(h)
    const attacker = softAuthenticator(b64uToBytes(owner.credId))
    const res = await enroll(h, c2.codeAuth, attacker, '198.51.100.66')
    expect(res.status).not.toBe(200)
    expect(h.state.core.credential(owner.credId)?.publicKey).toEqual(before)
    // And the owner can still sign in.
    expect((await login(h, owner)).status).toBe(200)
  })
})

describe('PR2 review: bridge key rotation', () => {
  async function rotate(h: Harness, signer: Awaited<ReturnType<typeof generateBridgeKey>>) {
    const next = await generateBridgeKey()
    const ts = Math.floor(h.fake.clock.now() / 1000)
    const res = await h.bridgePost(
      '/bridge/rotate',
      { new_pubkey: next.publicKeyB64, sig_new: await signRotation(next.privateKey, next.publicKeyB64, ts), ts },
      { key: signer },
    )
    return { next, res }
  }

  it('F3: a PREVIOUS key (inside its 5-minute grace) cannot rotate: the stolen key cannot take over', async () => {
    const h = await makeHarness()
    const stolen = h.bridgeKey
    const { next: ownerNew, res } = await rotate(h, stolen) // the owner rotates away from a leaked key
    expect(res.status).toBe(200)
    const { next: attackerKey, res: res2 } = await rotate(h, stolen) // the thief, 1 s later, with the old key
    expect(res2.status).toBe(401)
    h.fake.clock.advance(6 * 60_000)
    const trusted = h.state.core.trustedKeys().map((k) => k.keyId)
    expect(trusted).toEqual([ownerNew.keyId])
    expect(trusted).not.toContain(attackerKey.keyId)
  })
})

describe('PR2 review: device registry', () => {
  it('F4: device.enrolled stays queued for the 24 h the bridge keeps the pending code (spec 4.10)', async () => {
    const h = await makeHarness()
    const c = await newCode(h)
    const cookie = h.login('cred-1')
    const d = await newDevice()
    const binding = bindingMac(deriveEnrollBind(c.code), d.id, d.jwk)
    const res = await h.post(
      '/api/auth/device/verify',
      { code_auth: c.codeAuth, device: { id: d.id, name: 'Phone', pubkey_jwk: d.jwk }, binding },
      cookie,
    )
    expect(res.status).toBe(202)
    const sent = h.fake.bus.toBridgeLog.find((s) => s.frame.type === 'device.enrolled')
    expect((sent?.opts as { ttl_s?: number } | undefined)?.ttl_s ?? 0).toBeGreaterThanOrEqual(24 * 3600)
  })

  it("F5 (PR15 F4): a different passkey cannot claim the owner phone's device id at sign-in", async () => {
    const h = await makeHarness()
    const ownerAuth = softAuthenticator()
    const c1 = await newCode(h)
    expect((await enroll(h, c1.codeAuth, ownerAuth)).status).toBe(200)
    const d = await newDevice()
    h.state.core.upsertDevice({
      id: d.id as never,
      name: 'Phone',
      pubkeyJwk: d.jwk,
      credentialId: ownerAuth.credId,
      binding: 'b',
      codeId: c1.codeId,
    })
    h.state.core.setPinned(d.id, true)
    // The owner signs in with the device id: pinned, sees the data.
    const ok = await login(h, ownerAuth, { device_id: d.id })
    expect(ok.status).toBe(200)
    expect((await h.app.request('/probe/session', { headers: { Cookie: cookieFrom(ok) } })).status).toBe(200)
    // A stranger with their own passkey names the same device id: signed in, but not pinned.
    const c2 = await newCode(h)
    const stranger = softAuthenticator()
    expect((await enroll(h, c2.codeAuth, stranger, '198.51.100.66')).status).toBe(200)
    const res = await login(h, stranger, { device_id: d.id })
    expect(res.status).toBe(200)
    const probe = await h.app.request('/probe/session', { headers: { Cookie: cookieFrom(res) } })
    expect(probe.status).toBe(403)
  })
})

describe('PR2 review: sessions', () => {
  it('F6: the 30-day expiry slides in the browser too (the cookie is re-issued), not only in the DB', async () => {
    const h = await makeHarness()
    const owner = softAuthenticator()
    const c = await newCode(h)
    const res = await enroll(h, c.codeAuth, owner)
    const cookie = cookieFrom(res)
    let refreshed = false
    for (let day = 10; day <= 40; day += 10) {
      h.fake.clock.advance(10 * 24 * 3600_000)
      const me = await h.app.request('/api/me', { headers: { Cookie: cookie } })
      expect(me.status).toBe(200) // the DB says the session is alive at day 40
      if (me.headers.get('set-cookie')?.includes('__Host-talos_s=')) refreshed = true
    }
    // The browser dropped the Max-Age=30d cookie at day 30 unless something re-issued it.
    expect(refreshed).toBe(true)
  })
})

describe('PR2 review: CSRF', () => {
  it('F7: a non-GET /api request with a body but no Content-Type is 403 (spec 5.4: JSON content type)', async () => {
    const h = await makeHarness()
    const cookie = h.login('cred-1')
    const res = await h.app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-Talos-CSRF': '1', Cookie: cookie },
      body: new Uint8Array([123, 125]),
    })
    expect(res.status).toBe(403)
  })
})
