import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  b64urlDecode,
  b64urlEncode,
  createDeviceKey,
  deviceIdFromJwk,
  deviceIdFromSpki,
  importDevicePrivateKey,
  OWNER_FRAME_TYPES,
  ownerSigningInput,
  parseFrame,
  signOwnerFrame,
  Thread,
  verifyOwnerFrame,
} from '../src/index.ts'
import { loadFixtures, loadTestKey } from './helpers.ts'

const fixtures = loadFixtures()
const msg = (deviceId: string) => ({
  v: 1,
  type: 'message',
  id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
  ts: '2026-10-28T15:32:10.120Z',
  thread_id: 'general',
  client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V7',
  text: 'hi',
  attachments: [],
  device_id: deviceId,
})

describe('owner signatures', () => {
  it('creates a non-extractable private key and a stable device id', async () => {
    const k = await createDeviceKey()
    expect(k.privateKey.extractable).toBe(false)
    expect(k.deviceId).toMatch(/^d_[a-z2-7]{20}$/)
    expect(await deviceIdFromJwk(k.publicJwk)).toBe(k.deviceId)
    await expect(crypto.subtle.exportKey('jwk', k.privateKey)).rejects.toThrow()
  })

  it('round trips and produces a 64-byte raw P1363 signature', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame(msg(k.deviceId), k.privateKey)
    expect(signed.osig).toHaveLength(86)
    expect(b64urlDecode(signed.osig)).toHaveLength(64)
    expect(await verifyOwnerFrame(signed, k.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame(signed, k.publicKey)).toBe(true)
  })

  it('ignores osig, relay and stepup_token when verifying', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame(msg(k.deviceId), k.privateKey)
    const forwarded = { ...signed, relay: { seq: 1, received_at: '2026-10-28T15:32:11.000Z' }, stepup_token: 'st_x' }
    expect(await verifyOwnerFrame(forwarded, k.publicJwk)).toBe(true)
  })

  it('fails when any signed field changes', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame(msg(k.deviceId), k.privateKey)
    expect(await verifyOwnerFrame({ ...signed, text: 'hi!' }, k.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame({ ...signed, thread_id: 'inbox' }, k.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame({ ...signed, attachments: [{}] }, k.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame({ ...signed, extra: 1 }, k.publicJwk)).toBe(false)
  })

  it('covers original_ts: a changed or dropped original time fails the check (it says when the words were written)', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame({ ...msg(k.deviceId), original_ts: '2026-10-20T09:00:00.000Z' }, k.privateKey)
    expect(await verifyOwnerFrame(signed, k.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame({ ...signed, original_ts: '2026-10-28T15:00:00.000Z' }, k.publicJwk)).toBe(false)
    const { original_ts: _dropped, ...without } = signed
    expect(await verifyOwnerFrame(without, k.publicJwk)).toBe(false)
  })

  it('rejects a signature from another key and a device_id that is not the key', async () => {
    const a = await createDeviceKey()
    const b = await createDeviceKey()
    const signed = await signOwnerFrame(msg(a.deviceId), a.privateKey)
    expect(await verifyOwnerFrame(signed, b.publicJwk)).toBe(false)
    const liar = await signOwnerFrame(msg(b.deviceId), a.privateKey) // claims to be b, signed by a
    expect(await verifyOwnerFrame(liar, a.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame(liar, b.publicJwk)).toBe(false)
  })

  it('rejects a DER-encoded signature', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame(msg(k.deviceId), k.privateKey)
    const raw = b64urlDecode(signed.osig)
    const trim = (b: Uint8Array) => {
      let i = 0
      while (i < b.length - 1 && b[i] === 0 && (b[i + 1] as number) < 0x80) i++
      const t = b.slice(i)
      return (t[0] as number) >= 0x80 ? Uint8Array.of(0, ...t) : t
    }
    const r = trim(raw.slice(0, 32))
    const s = trim(raw.slice(32))
    const der = Uint8Array.of(0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s)
    expect(der[0]).toBe(0x30)
    expect(await verifyOwnerFrame({ ...signed, osig: b64urlEncode(der) }, k.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame({ ...signed, osig: 'MEUCIQDexample' }, k.publicJwk)).toBe(false)
    expect(await verifyOwnerFrame({ ...signed, osig: undefined }, k.publicJwk)).toBe(false)
  })

  it('verifies every committed owner fixture with the committed test key', async () => {
    const key = loadTestKey()
    for (const t of OWNER_FRAME_TYPES) {
      expect(await verifyOwnerFrame(fixtures[t] as Record<string, unknown>, key.publicJwk), t).toBe(true)
    }
  })

  it('signs with an imported test private key (fixture generator path)', async () => {
    const key = loadTestKey()
    const priv = await importDevicePrivateKey(key.privateJwk)
    const signed = await signOwnerFrame(msg(key.deviceId), priv)
    expect(await verifyOwnerFrame(signed, key.publicJwk)).toBe(true)
  })

  it('signing input has the documented shape', () => {
    const s = ownerSigningInput(msg('d_aaaaaaaaaaaaaaaaaaaa'))
    expect(s).toMatch(/^talos-owner\/v1\nd_a{20}\n[0-9a-f]{64}$/)
    expect(() => ownerSigningInput({ type: 'message' })).toThrow()
  })

  it('deviceIdFromSpki is deterministic', () => {
    expect(deviceIdFromSpki(new Uint8Array(91))).toBe(deviceIdFromSpki(new Uint8Array(91)))
    expect(deviceIdFromSpki(new Uint8Array(91))).toMatch(/^d_[a-z2-7]{20}$/)
  })
})

describe('raw JSON rule (3.5)', () => {
  it('sign raw, zod-parse, verify the parsed value: FAILS when a defaulted field was omitted', async () => {
    const k = await createDeviceKey()
    // A model with defaults: Thread. The raw object omits notify, voice_context and archived.
    const raw = {
      id: 'general',
      name: 'General',
      kind: 'fixed',
      order: 0,
      created_at: '2026-10-28T00:00:00.000Z',
      device_id: k.deviceId,
    }
    const signed = await signOwnerFrame(raw, k.privateKey)
    const parsed = Thread.extend({ device_id: z.string(), osig: z.string() }).parse(signed)
    expect(parsed).toHaveProperty('notify', 'all') // zod rewrote the object
    expect(await verifyOwnerFrame(signed, k.publicJwk)).toBe(true) // raw verifies
    expect(await verifyOwnerFrame(parsed, k.publicJwk)).toBe(false) // parsed does not
  })

  it('same trap with an empty array default', async () => {
    const k = await createDeviceKey()
    const schema = z.object({ device_id: z.string(), osig: z.string(), a: z.array(z.string()).default([]) })
    const signed = await signOwnerFrame({ device_id: k.deviceId }, k.privateKey)
    expect(await verifyOwnerFrame(schema.parse(signed), k.publicJwk)).toBe(false)
  })

  it('real owner frames survive parseFrame, so the app must serialize every field it signs', async () => {
    const k = await createDeviceKey()
    const signed = await signOwnerFrame(msg(k.deviceId), k.privateKey)
    const res = parseFrame(signed)
    expect(res.ok).toBe(true)
    if (res.ok) expect(await verifyOwnerFrame(res.frame as Record<string, unknown>, k.publicJwk)).toBe(true)
    // omitting `attachments` is a schema error, not a silent default
    const { attachments: _a, ...without } = msg(k.deviceId)
    const signedWithout = await signOwnerFrame(without, k.privateKey)
    expect(parseFrame(signedWithout).ok).toBe(false)
  })
})

describe('M5: own __proto__ key is covered by the signature', () => {
  it('a signed frame with an extra own __proto__ key fails verification once the key changes or is added', async () => {
    const k = await createDeviceKey()
    const raw = JSON.parse(JSON.stringify(msg(k.deviceId)))
    const signed = await signOwnerFrame(raw, k.privateKey)
    const withProto = JSON.parse(`${JSON.stringify(signed).slice(0, -1)},"__proto__":{"x":1}}`)
    expect(Object.hasOwn(withProto, '__proto__')).toBe(true)
    expect(await verifyOwnerFrame(withProto, k.publicJwk)).toBe(false)
    // and a frame SIGNED with that key verifies, so the key really is part of the signing input
    const signedWithProto = await signOwnerFrame(
      JSON.parse(`${JSON.stringify(msg(k.deviceId)).slice(0, -1)},"__proto__":{"x":1}}`),
      k.privateKey,
    )
    expect(await verifyOwnerFrame(signedWithProto, k.publicJwk)).toBe(true)
    // Removing the signed key afterwards breaks the signature. (A computed `__proto__: undefined` would keep the key, so the
    // own property is deleted from a parsed copy instead.)
    const withoutKey = JSON.parse(JSON.stringify(signedWithProto))
    expect(Object.hasOwn(withoutKey, '__proto__')).toBe(true)
    Reflect.deleteProperty(withoutKey, '__proto__')
    expect(Object.hasOwn(withoutKey, '__proto__')).toBe(false)
    expect(await verifyOwnerFrame(withoutKey, k.publicJwk)).toBe(false)
  })
})
