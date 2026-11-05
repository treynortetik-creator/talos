// Review fix #4 against the real relay: claim_code must survive the protocol schema the web client parses with.
import { routes } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

describe('#4 claim_code survives the protocol schema', () => {
  it('create returns it through the schema the web client parses with', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const res = await r.post('/api/connections', { integration: 'gmail', name: 'mail' }, owner)
    const parsed = routes.connectionCreate.res.parse(await res.json())
    expect(parsed.claim_code).toMatch(/^[0-9A-Za-z]{22}$/)
  })

  it('rotate returns the new claim code through the schema too', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const made = await r.post('/api/connections', { integration: 'gmail', name: 'mail' }, owner)
    const c = (await made.json()) as { id: string }
    const res = await r.post(`/api/connections/${c.id}/rotate`, {}, owner)
    const parsed = routes.connectionRotate.res.parse(await res.json())
    expect(parsed.claim_code).toMatch(/^[0-9A-Za-z]{22}$/)
  })
})
