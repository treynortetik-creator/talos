// A `peer.message` waits for a Mac whose hello lists peer/1, the way a problem report waits for problems/1: an older Mac would
// drop a frame type it does not know and say nothing.
import type { PeerMessageT } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { silentBridge } from '../core/helpers.ts'
import { type PeerWorld, peerWorld } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let w: PeerWorld | null = null
afterEach(async () => {
  await w?.r.stop()
  w = null
})
const frames = (b: Awaited<ReturnType<typeof silentBridge>>) => b.received.filter((f) => f.type === 'peer.message')

describe('peer/1', () => {
  it('is not sent to a Mac that does not list it, and is sent once a hello lists it', async () => {
    w = await peerWorld()
    const c = await w.create('work')
    const m = w.msg()
    const old = await silentBridge(w.r, w.r.bridgeKey, 0, ['problems/1'])
    expect((await w.send(c, m)).status).toBe(200)
    w.clock.advance(5_000)
    await old.sync()
    expect(frames(old)).toHaveLength(0)
    await old.close()
    const fresh = await silentBridge(w.r, w.r.bridgeKey, 0, ['peer/1'])
    await waitFor(() => frames(fresh).length >= 1, 10_000, 'delivered to a Mac that lists peer/1')
    expect((frames(fresh)[0] as { msg: PeerMessageT }).msg).toEqual(m)
    await fresh.close()
  })
})
