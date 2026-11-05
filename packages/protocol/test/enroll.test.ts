import { describe, expect, it } from 'vitest'
import {
  bindingMac,
  createDeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  newEnrollCode,
  normalizeEnrollCode,
  verifyBinding,
  verifyEnrollment,
} from '../src/index.ts'

describe('enrollment', () => {
  it('codes are 26 Crockford chars with a top char <= 7 (128 bits)', () => {
    for (let i = 0; i < 200; i++) {
      const c = newEnrollCode()
      expect(c).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      expect(normalizeEnrollCode(c)).toBe(c)
    }
  })
  it('normalizes look-alikes and hyphens, rejects junk', () => {
    expect(normalizeEnrollCode('0'.repeat(26))).toBe('0'.repeat(26))
    expect(normalizeEnrollCode(`o${'0'.repeat(25)}`)).toBe('0'.repeat(26))
    expect(normalizeEnrollCode(`1${'l'.repeat(25)}`)).toBe('1'.repeat(26))
    expect(normalizeEnrollCode('short')).toBeNull()
    expect(normalizeEnrollCode(`U${'0'.repeat(25)}`)).toBeNull()
    expect(normalizeEnrollCode(`Z${'0'.repeat(25)}`)).toBeNull()
  })
  it('code_auth and code_bind are domain separated and deterministic', () => {
    const code = newEnrollCode()
    expect(deriveEnrollAuth(code)).toBe(deriveEnrollAuth(code.toLowerCase()))
    expect(deriveEnrollAuth(code)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(deriveEnrollBind(code)).toString('base64url')).not.toBe(deriveEnrollAuth(code))
    expect(deriveEnrollAuth(newEnrollCode())).not.toBe(deriveEnrollAuth(code))
    expect(() => deriveEnrollAuth('bad')).toThrow()
  })
  it('the relay only needs the hash, and the code id derives from it', () => {
    const auth = deriveEnrollAuth(newEnrollCode())
    const h = enrollAuthHash(auth)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(enrollCodeId(h)).toBe(h.slice(0, 16))
  })
  it('binding round trip, and failure on any changed input', async () => {
    const code = newEnrollCode()
    const k = await createDeviceKey()
    const binding = bindingMac(deriveEnrollBind(code), k.deviceId, k.publicJwk)
    expect(verifyBinding(code, k.deviceId, k.publicJwk, binding)).toBe(true)
    const other = await createDeviceKey()
    expect(verifyBinding(code, k.deviceId, other.publicJwk, binding)).toBe(false) // relay swaps in its own key
    expect(verifyBinding(code, other.deviceId, k.publicJwk, binding)).toBe(false)
    expect(verifyBinding(newEnrollCode(), k.deviceId, k.publicJwk, binding)).toBe(false)
    expect(verifyBinding(code, k.deviceId, k.publicJwk, 'AAAA')).toBe(false)
    expect(verifyBinding('garbage', k.deviceId, k.publicJwk, binding)).toBe(false)
  })
  it('verifyEnrollment also checks that the device id is the key', async () => {
    const code = newEnrollCode()
    const k = await createDeviceKey()
    const other = await createDeviceKey()
    const binding = bindingMac(deriveEnrollBind(code), k.deviceId, k.publicJwk)
    expect(await verifyEnrollment(code, k.deviceId, k.publicJwk, binding)).toBe(true)
    // a valid MAC over a device id that is not the hash of the key must still fail
    const liarBinding = bindingMac(deriveEnrollBind(code), other.deviceId, k.publicJwk)
    expect(verifyBinding(code, other.deviceId, k.publicJwk, liarBinding)).toBe(true)
    expect(await verifyEnrollment(code, other.deviceId, k.publicJwk, liarBinding)).toBe(false)
  })
})
