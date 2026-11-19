// The guarded fetch of the sender: a name that resolves to nothing is a network error (retried); a private address stops at once.
import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '@talos-app/testkit'
import { PeerService } from '../../src/peer/service.ts'
import { type Install, install, linkBoth, rowsOf } from './helpers.ts'

let a: Install | undefined
let b: Install | undefined
afterEach(async () => {
  await a?.stop()
  await b?.stop()
  a = b = undefined
})

async function withResolver(resolve: (h: string) => Promise<string[]>) {
  a = await install()
  b = await install()
  await linkBoth(a, b)
  a.bridge.ctx.config.update((c) => ({
    ...c,
    peers: [{ name: 'work', url: 'https://peer.example.com/hook/peer/cn_x', daily_cap: 50 }],
  }))
  return new PeerService(a.bridge.ctx, { secrets: a.secrets, clock: a.clock, resolve })
}

describe('the sender address check', () => {
  test('a lookup that returns no addresses is retried', async () => {
    const svc = await withResolver(async () => [])
    await svc.send({ peer: 'work', text: 'hello' })
    await waitFor(() => (a as Install).bridge.ctx.peers?.ledger.outbox !== undefined, 1000)
    await new Promise((r) => setTimeout(r, 300))
    const row = (a as Install).bridge.ctx.store.db.query('SELECT state, attempts FROM peer_outbox').get() as {
      state: string
      attempts: number
    }
    expect(row).toEqual({ state: 'pending', attempts: 1 })
    expect(rowsOf(a as Install).some((t) => t.includes('Talos will not contact'))).toBe(false)
    svc.stop()
  })

  test('a private address stops at once', async () => {
    const svc = await withResolver(async () => ['10.0.0.5'])
    await svc.send({ peer: 'work', text: 'hello' })
    await waitFor(() => rowsOf(a as Install).some((t) => t.includes('Talos will not contact')), 4000, 'the row')
    svc.stop()
  })
})
