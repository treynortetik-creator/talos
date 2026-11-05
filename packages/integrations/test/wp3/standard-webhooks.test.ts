import { describe, expect, it } from 'vitest'
import {
  decodeSecretKey,
  newWebhookSecret,
  safeEqual,
  signStandard,
  verifyStandard,
} from '../../src/standard-webhooks.ts'
import { enc, NOW, OTHER_SECRET, SECRET, signedReq } from './helpers.ts'

const BODY = '{"test": 2432232314}'

describe('Standard Webhooks verifier', () => {
  it('reproduces the published test vector', () => {
    const h = signStandard({ secret: SECRET, id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestampS: 1614265330, body: BODY })
    expect(h['webhook-signature']).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
    const res = verifyStandard(
      { headers: h, rawBody: enc(BODY), url: 'https://x.example.com', now: 1614265330 * 1000 },
      { secrets: [SECRET] },
    )
    expect(res).toEqual({ ok: true, deliveryKey: 'wh:msg_p5jXN8AQM9LWM0D4loKWxJek' })
  })

  it('accepts a valid signature', () => {
    expect(verifyStandard(signedReq(BODY), { secrets: [SECRET] })).toEqual({ ok: true, deliveryKey: 'wh:msg_test_1' })
  })

  it('rejects a tampered body', () => {
    const req = signedReq(BODY)
    expect(verifyStandard({ ...req, rawBody: enc(`${BODY} `) }, { secrets: [SECRET] })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('rejects the wrong secret', () => {
    expect(verifyStandard(signedReq(BODY), { secrets: [OTHER_SECRET] })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('rejects missing headers', () => {
    const req = signedReq(BODY)
    for (const h of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const headers = { ...req.headers }
      delete headers[h]
      expect(verifyStandard({ ...req, headers }, { secrets: [SECRET] })).toEqual({
        ok: false,
        reason: 'missing_header',
      })
    }
  })

  it('rejects a stale or future timestamp but allows the edge of the window', () => {
    const old = signedReq(BODY, SECRET, { tsS: Math.floor(NOW / 1000) - 301 })
    const future = signedReq(BODY, SECRET, { tsS: Math.floor(NOW / 1000) + 301 })
    const edge = signedReq(BODY, SECRET, { tsS: Math.floor(NOW / 1000) - 299 })
    expect(verifyStandard(old, { secrets: [SECRET] })).toEqual({ ok: false, reason: 'stale_timestamp' })
    expect(verifyStandard(future, { secrets: [SECRET] })).toEqual({ ok: false, reason: 'stale_timestamp' })
    expect(verifyStandard(edge, { secrets: [SECRET] }).ok).toBe(true)
  })

  it('a rotated secret: both the new and the old one verify', () => {
    const signedWithOld = signedReq(BODY, SECRET)
    const signedWithNew = signedReq(BODY, OTHER_SECRET)
    const secrets = [OTHER_SECRET, SECRET]
    expect(verifyStandard(signedWithOld, { secrets }).ok).toBe(true)
    expect(verifyStandard(signedWithNew, { secrets }).ok).toBe(true)
    expect(verifyStandard(signedWithOld, { secrets: [OTHER_SECRET] }).ok).toBe(false)
  })

  it('accepts any v1 entry in a space-separated list and ignores other schemes', () => {
    const req = signedReq(BODY)
    const good = req.headers['webhook-signature'] as string
    const headers = { ...req.headers, 'webhook-signature': `v2,AAAA v1,AAAA ${good}` }
    expect(verifyStandard({ ...req, headers }, { secrets: [SECRET] }).ok).toBe(true)
    expect(
      verifyStandard({ ...req, headers: { ...req.headers, 'webhook-signature': 'v2,AAAA' } }, { secrets: [SECRET] }),
    ).toEqual({
      ok: false,
      reason: 'no_v1_signature',
    })
  })

  it('refuses keys outside 24..64 bytes', () => {
    expect(decodeSecretKey(`whsec_${Buffer.alloc(23).toString('base64')}`)).toBeNull()
    expect(decodeSecretKey(`whsec_${Buffer.alloc(65).toString('base64')}`)).toBeNull()
    expect(decodeSecretKey(`whsec_${Buffer.alloc(24).toString('base64')}`)).not.toBeNull()
    expect(decodeSecretKey(`whsec_${Buffer.alloc(64).toString('base64')}`)).not.toBeNull()
    expect(verifyStandard(signedReq(BODY), { secrets: ['whsec_short'] })).toEqual({
      ok: false,
      reason: 'no_valid_secret',
    })
  })

  it('newWebhookSecret makes a usable 32-byte secret', () => {
    const s = newWebhookSecret()
    expect(s.startsWith('whsec_')).toBe(true)
    expect(decodeSecretKey(s)?.length).toBe(32)
    expect(newWebhookSecret()).not.toBe(s)
  })

  it('safeEqual compares without caring about length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})
