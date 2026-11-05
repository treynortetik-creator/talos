import { describe, expect, it } from 'vitest'
import {
  b64urlDecode,
  b64urlEncode,
  bridgeKeyId,
  challengeString,
  generateBridgeKey,
  importBridgePrivateKey,
  newChallengeNonce,
  parseBridgeAuthHeader,
  sha256Hex,
  signBridgeHttp,
  signChallenge,
  signRotation,
  verifyBridgeHttp,
  verifyChallenge,
  verifyRotation,
} from '../src/index.ts'

describe('bridge challenge', () => {
  it('has the documented string and round trips', async () => {
    const k = await generateBridgeKey()
    const c = { nonce: newChallengeNonce(), relay_host: 'relay.example.com', server_time: 1793203930 }
    expect(challengeString(c)).toBe(`talos-relay/v1\n${c.nonce}\nrelay.example.com\n1793203930`)
    const sig = await signChallenge(k.privateKey, c)
    expect(b64urlDecode(sig)).toHaveLength(64)
    expect(await verifyChallenge(k.publicKeyB64, c, sig)).toBe(true)
  })
  it('fails for another host, nonce, time or key', async () => {
    const k = await generateBridgeKey()
    const other = await generateBridgeKey()
    const c = { nonce: newChallengeNonce(), relay_host: 'relay.example.com', server_time: 1793203930 }
    const sig = await signChallenge(k.privateKey, c)
    expect(await verifyChallenge(k.publicKeyB64, { ...c, relay_host: 'evil.example.com' }, sig)).toBe(false)
    expect(await verifyChallenge(k.publicKeyB64, { ...c, nonce: newChallengeNonce() }, sig)).toBe(false)
    expect(await verifyChallenge(k.publicKeyB64, { ...c, server_time: c.server_time + 1 }, sig)).toBe(false)
    expect(await verifyChallenge(other.publicKeyB64, c, sig)).toBe(false)
    expect(await verifyChallenge(k.publicKeyB64, c, 'short')).toBe(false)
  })
  it('key id is the first 16 hex of sha256(raw public key)', async () => {
    const k = await generateBridgeKey()
    const raw = b64urlDecode(k.publicKeyB64)
    expect(raw).toHaveLength(32)
    expect(k.keyId).toBe(sha256Hex(raw).slice(0, 16))
    expect(bridgeKeyId(raw)).toBe(k.keyId)
  })
  it('private key survives the PKCS8 round trip', async () => {
    const k = await generateBridgeKey()
    const again = await importBridgePrivateKey(k.privateKeyPkcs8B64)
    const c = { nonce: newChallengeNonce(), relay_host: 'h', server_time: 1 }
    expect(await verifyChallenge(k.publicKeyB64, c, await signChallenge(again, c))).toBe(true)
  })
})

describe('bridge HTTP signatures', () => {
  const NOW = 1793203930
  it('signs and verifies, with the documented header shape', async () => {
    const k = await generateBridgeKey()
    const body = JSON.stringify({ hello: 'world' })
    const header = await signBridgeHttp({
      privateKey: k.privateKey,
      keyId: k.keyId,
      method: 'post',
      pathWithQuery: '/bridge/post',
      body,
      ts: NOW,
    })
    expect(header).toMatch(
      /^TalosBridge key_id=[0-9a-f]{16},ts=1793203930,nonce=[A-Za-z0-9_-]{22},sig=[A-Za-z0-9_-]{86}$/,
    )
    const keys = [{ keyId: k.keyId, publicKeyB64: k.publicKeyB64 }]
    const ok = await verifyBridgeHttp({
      header,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body,
      nowS: NOW + 5,
      keys,
    })
    expect(ok).toMatchObject({ ok: true, keyId: k.keyId, ts: NOW })
  })
  it('rejects changed method, path, query, body, skew, unknown key and junk', async () => {
    const k = await generateBridgeKey()
    const keys = [{ keyId: k.keyId, publicKeyB64: k.publicKeyB64 }]
    const base = { method: 'GET', pathWithQuery: '/bridge/digest?since=2026-10-28T00:00:00Z', body: '' }
    const header = await signBridgeHttp({ privateKey: k.privateKey, keyId: k.keyId, ts: NOW, ...base })
    const v = (o: Partial<Parameters<typeof verifyBridgeHttp>[0]>) =>
      verifyBridgeHttp({ header, ...base, nowS: NOW, keys, ...o })
    expect((await v({})).ok).toBe(true)
    expect(await v({ method: 'POST' })).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(await v({ pathWithQuery: '/bridge/digest?since=2026-10-29T00:00:00Z' })).toMatchObject({
      reason: 'bad_signature',
    })
    expect(await v({ body: 'x' })).toMatchObject({ reason: 'bad_signature' })
    expect(await v({ nowS: NOW + 121 })).toMatchObject({ reason: 'skew' })
    expect(await v({ nowS: NOW - 121 })).toMatchObject({ reason: 'skew' })
    expect((await v({ nowS: NOW + 120 })).ok).toBe(true)
    expect(await v({ keys: [] })).toMatchObject({ reason: 'unknown_key' })
    expect(await v({ header: 'Bearer abc' })).toMatchObject({ reason: 'malformed' })
    expect(await v({ header: header.replace('ts=', 'ts=x') })).toMatchObject({ reason: 'malformed' })
  })
  it('parses the header strictly', () => {
    expect(
      parseBridgeAuthHeader('TalosBridge key_id=0123456789abcdef,ts=1,nonce=AAAAAAAAAAAAAAAAAAAAAA,sig=x'),
    ).toMatchObject({ ts: 1 })
    expect(parseBridgeAuthHeader('TalosBridge key_id=ZZ,ts=1,nonce=AAAAAAAAAAAAAAAAAAAAAA,sig=x')).toBeNull()
  })
  it('rotation signature is by the new key over the documented string', async () => {
    const next = await generateBridgeKey()
    const sig = await signRotation(next.privateKey, next.publicKeyB64, NOW)
    expect(await verifyRotation(next.publicKeyB64, NOW, sig)).toBe(true)
    expect(await verifyRotation(next.publicKeyB64, NOW + 1, sig)).toBe(false)
    // The literal text, signed by hand: a signature over exactly the documented string is what verifies.
    const signText = async (text: string) =>
      b64urlEncode(new Uint8Array(await crypto.subtle.sign('Ed25519', next.privateKey, new TextEncoder().encode(text))))
    expect(
      await verifyRotation(next.publicKeyB64, NOW, await signText(`talos-rotate/v1\n${next.publicKeyB64}\n${NOW}`)),
    ).toBe(true)
    // A signature over the same fields under another domain, or without the new key in the text, is not a rotation.
    const wrong = [
      `talos-relay/v1\n${next.publicKeyB64}\n${NOW}`,
      `talos-rotate/v1\n${NOW}`,
      `talos-rotate/v2\n${next.publicKeyB64}\n${NOW}`,
    ]
    for (const text of wrong)
      expect(await verifyRotation(next.publicKeyB64, NOW, await signText(text)), text).toBe(false)
  })
})
