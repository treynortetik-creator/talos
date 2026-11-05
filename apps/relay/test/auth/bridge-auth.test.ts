import {
  b64urlEncode,
  generateBridgeKey,
  newChallengeNonce,
  signBridgeHttp,
  signChallenge,
  signRotation,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyBridgeHello } from '../../src/auth/contract.ts'
import { AuthCore } from '../../src/auth/core.ts'
import { afterEachReset, makeHarness } from './helpers.ts'

afterEach(afterEachReset)

const challengeFor = (h: Awaited<ReturnType<typeof makeHarness>>) => ({
  nonce: newChallengeNonce(),
  relay_host: 'relay.example.com',
  server_time: Math.floor(h.fake.clock.now() / 1000),
})

describe('bridge hello (Ed25519 challenge)', () => {
  it('accepts the right key', async () => {
    const h = await makeHarness()
    const ch = challengeFor(h)
    const sig = await signChallenge(h.bridgeKey.privateKey, ch)
    expect(
      await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig }, challenge: ch, ip: '198.51.100.5' }),
    ).toEqual({
      ok: true,
      keyId: h.bridgeKey.keyId,
    })
  })

  it('rejects a wrong key (unknown key_id, and a known key_id with another key signing)', async () => {
    const h = await makeHarness()
    const other = await generateBridgeKey()
    const ch = challengeFor(h)
    const bySigner = await signChallenge(other.privateKey, ch)
    expect(
      (await verifyBridgeHello({ hello: { key_id: other.keyId, sig: bySigner }, challenge: ch, ip: 'a' })).ok,
    ).toBe(false)
    expect(
      (await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig: bySigner }, challenge: ch, ip: 'a' })).ok,
    ).toBe(false)
  })

  it("rejects a hello signed for another socket's nonce, and a nonce used twice", async () => {
    const h = await makeHarness()
    const a = challengeFor(h)
    const b = challengeFor(h)
    const sigA = await signChallenge(h.bridgeKey.privateKey, a)
    expect(
      (await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig: sigA }, challenge: b, ip: 'a' })).ok,
    ).toBe(false)
    expect(
      (await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig: sigA }, challenge: a, ip: 'a' })).ok,
    ).toBe(true)
    const again = await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig: sigA }, challenge: a, ip: 'a' })
    expect(again).toEqual({ ok: false, reason: 'nonce replayed' })
  })

  it('rejects a challenge for another relay host', async () => {
    const h = await makeHarness()
    const ch = { ...challengeFor(h), relay_host: 'evil.example.net' }
    const sig = await signChallenge(h.bridgeKey.privateKey, ch)
    expect((await verifyBridgeHello({ hello: { key_id: h.bridgeKey.keyId, sig }, challenge: ch, ip: 'a' })).ok).toBe(
      false,
    )
  })

  it('5 failed hellos in 10 minutes block the IP for an hour for strangers; the right key still gets in', async () => {
    const h = await makeHarness()
    const other = await generateBridgeKey()
    for (let i = 0; i < 5; i++) {
      const ch = challengeFor(h)
      await verifyBridgeHello({
        hello: { key_id: other.keyId, sig: await signChallenge(other.privateKey, ch) },
        challenge: ch,
        ip: '198.51.100.5',
      })
    }
    const ch = challengeFor(h)
    const good = { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch) }
    // a stranger on the blocked address is refused...
    const chS = challengeFor(h)
    expect(
      await verifyBridgeHello({
        hello: { key_id: other.keyId, sig: await signChallenge(other.privateKey, chS) },
        challenge: chS,
        ip: '198.51.100.5',
      }),
    ).toEqual({ ok: false, reason: 'ip_blocked' })
    // ...but the Mac, proving it holds the trusted key, is not locked out by someone else on its address
    expect(await verifyBridgeHello({ hello: good, challenge: ch, ip: '198.51.100.5' })).toEqual({
      ok: true,
      keyId: h.bridgeKey.keyId,
    })
    // another IP is unaffected
    const ch2 = challengeFor(h)
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch2) },
          challenge: ch2,
          ip: '198.51.100.6',
        })
      ).ok,
    ).toBe(true)
    h.fake.clock.advance(3600_000 + 1000)
    const ch3 = challengeFor(h)
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch3) },
          challenge: ch3,
          ip: '198.51.100.5',
        })
      ).ok,
    ).toBe(true)
  })

  it('failures older than 10 minutes do not add up', async () => {
    const h = await makeHarness()
    const other = await generateBridgeKey()
    for (let i = 0; i < 8; i++) {
      const ch = challengeFor(h)
      await verifyBridgeHello({
        hello: { key_id: other.keyId, sig: await signChallenge(other.privateKey, ch) },
        challenge: ch,
        ip: 'x',
      })
      h.fake.clock.advance(3 * 60_000)
    }
    const ch = challengeFor(h)
    expect(
      (
        await verifyBridgeHello({
          hello: { key_id: h.bridgeKey.keyId, sig: await signChallenge(h.bridgeKey.privateKey, ch) },
          challenge: ch,
          ip: 'x',
        })
      ).ok,
    ).toBe(true)
  })
})

describe('bridge HTTP signatures', () => {
  const enrollBody = (h: Awaited<ReturnType<typeof makeHarness>>) => ({
    code_id: '0'.repeat(16),
    code_auth_hash: '0'.repeat(64),
    expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
  })

  it('a valid request passes; skew of 3 minutes is 401; a nonce replay is 401', async () => {
    const h = await makeHarness()
    const body = { ...enrollBody(h) }
    expect((await h.bridgePost('/bridge/enroll', body)).status).toBe(200)
    const now = Math.floor(h.fake.clock.now() / 1000)
    expect((await h.bridgePost('/bridge/enroll', body, { ts: now - 180 })).status).toBe(401)
    expect((await h.bridgePost('/bridge/enroll', body, { ts: now + 180 })).status).toBe(401)
    expect((await h.bridgePost('/bridge/enroll', body, { ts: now - 100 })).status).toBe(200)
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
    expect((await h.bridgePost('/bridge/enroll', body, { nonce })).status).toBe(200)
    expect((await h.bridgePost('/bridge/enroll', body, { nonce })).status).toBe(401)
  })

  it('a nonce is remembered for 10 minutes, then forgotten', async () => {
    const h = await makeHarness()
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
    expect(h.state.core.useNonce(nonce)).toBe(true)
    h.fake.clock.advance(9 * 60_000)
    expect(h.state.core.useNonce(nonce)).toBe(false)
    h.fake.clock.advance(2 * 60_000)
    h.state.core.purge()
    expect(h.state.core.useNonce(nonce)).toBe(true)
  })

  it('a body altered after signing, an unknown key and a missing header are 401', async () => {
    const h = await makeHarness()
    const other = await generateBridgeKey()
    expect((await h.bridgePost('/bridge/enroll', enrollBody(h), { key: other })).status).toBe(401)
    expect(
      (await h.app.request('/bridge/enroll', { method: 'POST', body: JSON.stringify(enrollBody(h)) })).status,
    ).toBe(401)
    // Control: the exact bytes that were signed go through; changing one field afterwards does not.
    const signedBody = JSON.stringify(enrollBody(h))
    const authorization = await signBridgeHttp({
      privateKey: h.bridgeKey.privateKey,
      keyId: h.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/enroll',
      body: signedBody,
      ts: Math.floor(h.fake.clock.now() / 1000),
    })
    const send = (body: string) =>
      h.app.request('/bridge/enroll', { method: 'POST', headers: { Authorization: authorization }, body })
    const tampered = JSON.stringify({ ...enrollBody(h), code_auth_hash: 'f'.repeat(64) })
    expect((await send(tampered)).status).toBe(401)
    expect((await send(signedBody)).status).toBe(200)
  })
})

describe('POST /bridge/rotate', () => {
  async function rotate(h: Awaited<ReturnType<typeof makeHarness>>, signer = h.bridgeKey) {
    const next = await generateBridgeKey()
    const ts = Math.floor(h.fake.clock.now() / 1000)
    const res = await h.bridgePost(
      '/bridge/rotate',
      { new_pubkey: next.publicKeyB64, sig_new: await signRotation(next.privateKey, next.publicKeyB64, ts), ts },
      { key: signer },
    )
    return { next, res }
  }
  const ping = (h: Awaited<ReturnType<typeof makeHarness>>, key: Awaited<ReturnType<typeof generateBridgeKey>>) =>
    h.bridgePost('/bridge/devices/d_aaaaaaaaaaaaaaaaaaaa/revoke', {}, { key })

  it('the new key works, the old key works for 5 minutes then fails', async () => {
    const h = await makeHarness()
    const { next, res } = await rotate(h)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, key_id: next.keyId })
    // 404 (unknown device) proves the signature was accepted; 401 would be a rejected signature.
    expect((await ping(h, next)).status).toBe(404)
    expect((await ping(h, h.bridgeKey)).status).toBe(404)
    h.fake.clock.advance(4 * 60_000)
    expect((await ping(h, h.bridgeKey)).status).toBe(404)
    h.fake.clock.advance(61_000)
    expect((await ping(h, h.bridgeKey)).status).toBe(401)
    expect((await ping(h, next)).status).toBe(404)
  })

  it('the env key stops being a bootstrap once a rotated key is active', async () => {
    const h = await makeHarness()
    const { next } = await rotate(h)
    h.fake.clock.advance(6 * 60_000)
    expect(h.state.core.trustedKeys().map((k) => k.keyId)).toEqual([next.keyId])
  })

  it('sig_new made by the wrong key is 401 and changes nothing', async () => {
    const h = await makeHarness()
    const next = await generateBridgeKey()
    const ts = Math.floor(h.fake.clock.now() / 1000)
    // signed by the OLD key instead of the new one
    const res = await h.bridgePost('/bridge/rotate', {
      new_pubkey: next.publicKeyB64,
      sig_new: await signRotation(h.bridgeKey.privateKey, next.publicKeyB64, ts),
      ts,
    })
    expect(res.status).toBe(401)
    expect((await ping(h, next)).status).toBe(401)
    expect((await ping(h, h.bridgeKey)).status).toBe(404)
  })

  it('a stale ts is 401', async () => {
    const h = await makeHarness()
    const next = await generateBridgeKey()
    const ts = Math.floor(h.fake.clock.now() / 1000) - 600
    const res = await h.bridgePost('/bridge/rotate', {
      new_pubkey: next.publicKeyB64,
      sig_new: await signRotation(next.privateKey, next.publicKeyB64, ts),
      ts,
    })
    expect(res.status).toBe(401)
  })

  it('BRIDGE_PUBKEY_FORCE=1 makes the env key win and refuses rotation', async () => {
    const h = await makeHarness({ env: { BRIDGE_PUBKEY_FORCE: '1' } })
    const { res } = await rotate(h)
    expect(res.status).toBe(409)
    expect(h.state.core.trustedKeys().map((k) => k.keyId)).toEqual([h.bridgeKey.keyId])
  })

  it('FORCE after a rotation: the env key is trusted again and the rotated key is not', async () => {
    const first = await makeHarness()
    const { next } = await rotate(first)
    const dbRows = first.fake.db.prepare('select * from auth_bridge_keys').all()
    expect(dbRows.length).toBeGreaterThan(0)
    // Same database, now booted with FORCE: simulate by flipping the env flag on the services.
    ;(first.fake.services.env as { BRIDGE_PUBKEY_FORCE: boolean }).BRIDGE_PUBKEY_FORCE = true
    expect(first.state.core.trustedKeys().map((k) => k.keyId)).toEqual([first.bridgeKey.keyId])
    expect((await ping(first, next)).status).toBe(401)
  })

  it('D12: a FORCE boot makes the env key the active one and retires the rest, so turning FORCE off keeps it that way', async () => {
    const first = await makeHarness()
    const { next } = await rotate(first)
    expect(first.state.core.activeKey()?.keyId).toBe(next.keyId)
    // Reboot on the same database with FORCE on: a fresh AuthCore is what a relay start builds.
    const env = first.fake.services.env as { BRIDGE_PUBKEY_FORCE: boolean }
    env.BRIDGE_PUBKEY_FORCE = true
    const booted = new AuthCore(first.fake.services)
    const rows = first.fake.db.prepare('select key_id, status from auth_bridge_keys').all()
    expect(rows).toEqual([{ key_id: first.bridgeKey.keyId, status: 'active' }])
    // Operator removes FORCE and redeploys: the dead rotated key must not come back.
    env.BRIDGE_PUBKEY_FORCE = false
    expect(booted.trustedKeys().map((k) => k.keyId)).toEqual([first.bridgeKey.keyId])
    expect(booted.activeKey()?.keyId).toBe(first.bridgeKey.keyId)
    expect((await ping(first, next)).status).toBe(401)
    expect((await ping(first, first.bridgeKey)).status).toBe(404)
    // ...and rotation works again from the env key.
    const again = await rotate(first)
    expect(again.res.status).toBe(200)
  })

  it('D12: a normal boot (FORCE off) leaves the rotated key alone', async () => {
    const first = await makeHarness()
    const { next } = await rotate(first)
    const booted = new AuthCore(first.fake.services)
    expect(booted.activeKey()?.keyId).toBe(next.keyId)
  })

  it('without any env key and no rotation, nothing is trusted', async () => {
    const h = await makeHarness({ withBridgeKey: false })
    expect(h.state.core.trustedKeys()).toEqual([])
    expect((await ping(h, h.bridgeKey)).status).toBe(401)
  })
})
