// BYOR phase 4: the attest frames and the route. Not durable, not consumable, never in an outbox; the relay asks, the Mac answers.
import { describe, expect, test } from 'vitest'
import {
  ATTEST_FEATURE,
  CONSUMABLE_FRAME_TYPES,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  frameSchemas,
  parseFrame,
  routes,
} from '../src/index.ts'

const NONCE = 'A'.repeat(43)
const KEY = 'B'.repeat(43)
const SIG = 'C'.repeat(86)
const env = { v: 1, id: '01JBBTS4M3N5PXYZ0123456789', ts: '2026-11-17T10:00:00.000Z' }
const cert = { relay_id: 'r_abcdefghijklmnopqrst', old_pubkey: KEY, new_pubkey: KEY, sig: SIG }

describe('attest frames', () => {
  test('the feature name', () => expect(ATTEST_FEATURE).toBe('attest/1'))
  test('attest.request: a 43-character base64url nonce, nothing else', () => {
    expect(parseFrame({ ...env, type: 'attest.request', nonce: NONCE }, { direction: 'relay_to_bridge' }).ok).toBe(true)
    for (const nonce of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, 7])
      expect(parseFrame({ ...env, type: 'attest.request', nonce }).ok).toBe(false)
  })
  test('attest.response: ref, pubkey, sig, and at most 8 strict certificates', () => {
    const ok = { ...env, type: 'attest.response', ref: env.id, pubkey: KEY, sig: SIG, chain: [cert] }
    expect(parseFrame(ok, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(parseFrame({ ...ok, chain: Array(8).fill(cert) }).ok).toBe(true)
    expect(parseFrame({ ...ok, chain: Array(9).fill(cert) }).ok).toBe(false)
    expect(parseFrame({ ...ok, chain: [{ ...cert, extra: 1 }] }).ok).toBe(false)
    expect(parseFrame({ ...ok, chain: [{ ...cert, relay_id: 'r_short' }] }).ok).toBe(false)
    expect(parseFrame({ ...ok, sig: 'C'.repeat(85) }).ok).toBe(false)
  })
  test('each goes one way only, and neither is durable or consumable', () => {
    expect(frameSchemas['attest.request']).toBeDefined()
    expect(frameSchemas['attest.response']).toBeDefined()
    expect(DIRECTION_TYPES.relay_to_bridge).toContain('attest.request')
    expect(DIRECTION_TYPES.bridge_to_relay).toContain('attest.response')
    expect(DIRECTION_TYPES.bridge_to_relay).not.toContain('attest.request')
    expect(DIRECTION_TYPES.relay_to_bridge).not.toContain('attest.response')
    expect(DIRECTION_TYPES.app_to_relay).not.toContain('attest.request')
    expect(DIRECTION_TYPES.relay_to_app).not.toContain('attest.response')
    for (const t of ['attest.request', 'attest.response']) {
      expect(DURABLE_FRAME_TYPES).not.toContain(t)
      expect(CONSUMABLE_FRAME_TYPES).not.toContain(t)
    }
  })
})

describe('route bridgeAttest', () => {
  test('POST /api/bridge/attest, public, owned by BYOR, strict request and answer', () => {
    const r = routes.bridgeAttest
    expect([r.method, r.path, r.auth, r.owner]).toEqual(['POST', '/api/bridge/attest', 'none', 'BYOR'])
    expect(r.req.safeParse({ nonce: NONCE }).success).toBe(true)
    expect(r.req.safeParse({ nonce: NONCE, extra: 1 }).success).toBe(false)
    expect(r.req.safeParse({ nonce: 'A'.repeat(42) }).success).toBe(false)
    expect(r.res.safeParse({ pubkey: KEY, sig: SIG, chain: [] }).success).toBe(true)
    expect(r.res.safeParse({ pubkey: KEY, sig: SIG, chain: [], x: 1 }).success).toBe(false)
  })
})
