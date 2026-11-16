// Owner messages sent while no bridge is connected wait in the relay's outbox and are all replayed, in order, once each, on
// the next authed hello, including after the bridge process restarted. Presence (the stored last-seen time) moves on a hello
// and on a close. The real hub, a fake clock.
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit, silentBridge } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const WAIT_MS = 10_000
const ids = (b: { received: Array<Record<string, unknown>> }) =>
  b.received.filter((f) => f.type === 'message').map((f) => String(f.id))

async function world() {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const app = await kit(relay).connectedApp({ visible: false })
  const send = async (n: number, from = 1) => {
    const out: string[] = []
    for (let i = from; i < from + n; i++) {
      const m = await app.sendMessage('general', `queued ${i}`)
      await app.expectFrame('ack', (f) => f.ref === m.id)
      out.push(m.id)
    }
    return out
  }
  return { c, r: relay, app, send }
}

describe('owner messages while no bridge is connected', () => {
  it('wait in the outbox, and all arrive in order, once each, on the next hello', async () => {
    const { r, send } = await world()
    const sent = await send(5)
    expect(r.runtime.store.outboxDepth()).toBe(5)
    expect(r.runtime.hub.presence()).toMatchObject({ bridge_online: false, queue_depth: 5 })

    const b = await silentBridge(r, r.bridgeKey)
    await b.sync() // the replay follows `ready` on the same socket, so it is all here before the pong
    expect(ids(b)).toEqual(sent)
  })

  it('after the bridge process restarts: only what it never consumed comes back, with what arrived meanwhile, in order', async () => {
    const { r, send } = await world()
    const first = await send(5)
    const b1 = await silentBridge(r, r.bridgeKey)
    await b1.sync()
    expect(ids(b1)).toEqual(first)
    b1.ack(first[0] as string, 'consumed') // the agent took two before the process died
    b1.ack(first[1] as string, 'consumed')
    b1.ack(first[2] as string, 'delivered') // this one reached the process but was never pushed into the agent
    await b1.sync()
    b1.ws.terminate() // the process dies: no close handshake
    await waitFor(() => !r.runtime.hub.bridgeOnline(), WAIT_MS, 'the relay to see the bridge go')
    const meanwhile = await send(2, 6)

    const b2 = await silentBridge(r, r.bridgeKey)
    await b2.sync()
    expect(ids(b2)).toEqual([...first.slice(2), ...meanwhile]) // 3, 4, 5, then 6, 7: none lost, none repeated, in order
    for (const id of ids(b2)) b2.ack(id, 'consumed')
    await b2.sync()
    await b2.close()
    const b3 = await silentBridge(r, r.bridgeKey)
    await b3.sync()
    expect(ids(b3)).toEqual([]) // everything was consumed: a third hello replays nothing
  })

  it('presence (bridge_last_seen) is stamped on a hello and again on a close', async () => {
    const { c, r } = await world()
    const seen = () => r.runtime.store.getState('bridge_last_seen')
    expect(seen()).toBeNull()
    const helloAt = c.now()
    const b = await silentBridge(r, r.bridgeKey)
    expect(seen()).toBe(String(helloAt))
    await advance(c, 90_000, 30_000) // the bridge stays; time passes
    const closeAt = c.now()
    expect(closeAt).toBeGreaterThan(helloAt)
    await b.close()
    await waitFor(() => !r.runtime.hub.bridgeOnline(), WAIT_MS, 'the relay to see the bridge go')
    expect(seen()).toBe(String(closeAt))
    expect(r.runtime.hub.presence().last_seen).toBe(new Date(closeAt).toISOString())
  })
})
