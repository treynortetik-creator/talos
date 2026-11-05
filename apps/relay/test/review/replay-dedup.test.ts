// Review fix #23: GitHub, Jira and Linear dedup on an unsigned delivery-id header. A captured signed body replayed with a
// fresh id must still be recognised, so the relay also dedups on the hash of the signed body.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

describe('replayed signed bodies', () => {
  it('GitHub: the same signed body under a new delivery id is stored once', async () => {
    const s = setup()
    const c = await s.create('github')
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })
    const sig = `sha256=${createHmac('sha256', c.secret).update(body).digest('hex')}`
    const send = (delivery: string) =>
      s.post('github', c.id, body, {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'ping',
        'x-github-delivery': delivery,
      })
    expect((await send('11111111-aaaa')).status).toBe(200)
    expect((await send('22222222-bbbb')).status).toBe(200)
    await s.drain()
    expect(s.count('hooks_inbound')).toBe(1)
    const dup = s.f.db.prepare("select count(*) as n from hooks_deliveries where reason = 'duplicate'").get() as {
      n: number
    }
    expect(dup.n).toBe(1)
  })

  it('GitHub: two different signed bodies are both kept', async () => {
    const s = setup()
    const c = await s.create('github')
    for (const [i, hook_id] of [1, 2].entries()) {
      const body = JSON.stringify({ zen: 'x', hook_id })
      const sig = `sha256=${createHmac('sha256', c.secret).update(body).digest('hex')}`
      const res = await s.post('github', c.id, body, {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'ping',
        'x-github-delivery': `d-${i}`,
      })
      expect(res.status).toBe(200)
    }
    await s.drain()
    expect(s.count('hooks_inbound')).toBe(2)
  })
})
