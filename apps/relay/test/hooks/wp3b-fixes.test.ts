// PR9 review fixes (F1 re-paste grace, F4 claim redeem, F5 header strip) through the real relay.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const sign = (secret: string, t: string, body: string) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

describe('WP3b review fixes', () => {
  it('F1: a re-pasted Stripe secret keeps the old one valid for 24 h, then only the new one', async () => {
    const s = setup({})
    const oldS = 'whsec_OLDoldOLDoldOLDold000001'
    const newS = 'whsec_NEWnewNEWnewNEWnew000002'
    const c = await s.create('stripe', { fields: { signing_secret: oldS } })
    await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: { signing_secret: newS } })
    const send = async (secret: string, id: string) => {
      const body = JSON.stringify({ id, type: 'invoice.paid', created: 1761660000, data: { object: {} } })
      const t = String(Math.floor(s.f.clock.now() / 1000))
      return (
        await s.post('stripe', c.id, body, {
          'content-type': 'application/json',
          'stripe-signature': sign(secret, t, body),
        })
      ).status
    }
    expect(await send(newS, 'evt_a')).toBe(200)
    expect(await send(oldS, 'evt_b')).toBe(200)
    s.f.clock.advance(25 * 3600_000)
    expect(await send(oldS, 'evt_c')).toBe(401)
    expect(await send(newS, 'evt_d')).toBe(200)
  })

  it('F4: forward issues a claim code and /claim redeems it once', async () => {
    const s = setup({})
    const c = await s.create('forward')
    expect(typeof c.claim_code).toBe('string')
    const claim = () =>
      s.post('forward', `${c.id}/claim`, JSON.stringify({ claim_code: c.claim_code }), {
        'content-type': 'application/json',
      })
    const ok = await claim()
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { secret: string }).secret).toMatch(/^whsec_/)
    expect((await claim()).status).toBe(410)
  })
})
