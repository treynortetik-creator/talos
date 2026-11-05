// Item 3: the sign-in proof reuses the enrollment proof; the label keeps the two apart. Device lists from older relays still parse.
import { describe, expect, it } from 'vitest'
import {
  createExtractableDeviceKeyForTests,
  Device,
  loginProofCodeId,
  signDeviceProof,
  verifyDeviceProof,
} from '../src/index.ts'

describe('login proof', () => {
  it('verifies for the same nonce, passkey and device, and for nothing else', async () => {
    const k = await createExtractableDeviceKeyForTests()
    const other = await createExtractableDeviceKeyForTests()
    const nonce = 'N'.repeat(43)
    const args = { nonce, codeId: loginProofCodeId('cred-1'), deviceId: k.deviceId }
    const sig = await signDeviceProof(k.privateKey, args)
    expect(await verifyDeviceProof(k.publicJwk, { ...args, sig })).toBe(true)
    expect(await verifyDeviceProof(k.publicJwk, { ...args, nonce: 'M'.repeat(43), sig })).toBe(false)
    expect(await verifyDeviceProof(k.publicJwk, { ...args, codeId: loginProofCodeId('cred-2'), sig })).toBe(false)
    expect(await verifyDeviceProof(k.publicJwk, { ...args, codeId: 'a'.repeat(32), sig })).toBe(false) // an enrollment code id
    expect(await verifyDeviceProof(other.publicJwk, { ...args, sig })).toBe(false)
  })
})

describe('Device list', () => {
  it('parses an entry from an older relay (no shared_passkey) and from a newer one', async () => {
    const k = await createExtractableDeviceKeyForTests()
    const base = {
      id: k.deviceId,
      name: 'Phone',
      pubkey_jwk: k.publicJwk,
      pinned: true,
      revoked: false,
      created_at: '2026-10-01T00:00:00.000Z',
      last_used_at: null,
    }
    expect(Device.safeParse(base).success).toBe(true)
    expect(Device.safeParse({ ...base, shared_passkey: true }).success).toBe(true)
  })
})
