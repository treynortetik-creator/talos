// A stopped relay still handles the frames that arrive while its sockets drain (a bridge ack, a card), and must arm no new
// timer for them: a timer armed after stop() is one nothing clears (in a same-process restart it fires against the old hub).
// Left on purpose: a push sent for such a frame (push.ts withinDeadline) still arms its 30 s send deadline. It is unref'd and
// cleared when the send settles, and gating notify on a stopped hub would drop a needs-you push for a card from the drain.
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

/** A real-time clock that remembers which timers are still waiting to fire. */
function trackedClock() {
  const live = new Set<unknown>()
  return {
    live,
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => {
      const h = setTimeout(() => {
        live.delete(h)
        fn()
      }, ms)
      live.add(h)
      h.unref?.()
      return h
    },
    clearTimeout: (h: unknown) => {
      live.delete(h)
      clearTimeout(h as ReturnType<typeof setTimeout>)
    },
  }
}

async function world() {
  const clock = trackedClock()
  relay = await startTestRelay({ clock })
  const r = relay
  const k = kit(r)
  const app = await k.connectedApp()
  const bridge = await k
    .bridge({
      pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
      consume: 'manual',
      autoReply: false,
      verifyOwner: false,
    })
    .connect()
  return { clock, r, app, bridge }
}

describe('a stopped hub arms no timer', () => {
  it('the ack of a message still in flight at stop is recorded and starts no queued timer', async () => {
    const { clock, r, app, bridge } = await world()
    const sent = await app.sendMessage('general', 'in flight')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    await waitFor(() => r.runtime.store.outboxRow(String(sent.id))?.delivered === 1, 5000, 'delivered')

    r.runtime.stop() // what the relay does first on a deploy; the sockets are still open: the drain
    expect(clock.live.size).toBe(0)
    expect(bridge.consume(String(sent.id))).toBe(true)
    // the ack is still handled: the row is consumed and gone
    await waitFor(() => r.runtime.store.outboxRow(String(sent.id)) === undefined, 5000, 'ack handled')
    expect(clock.live.size).toBe(0)
  })

  it('a card the bridge sends during the drain is stored and arms no expiry timer', async () => {
    const { clock, r, bridge } = await world()
    r.runtime.stop()
    expect(clock.live.size).toBe(0)
    const card = bridge.createCard({ thread_id: 'general', title: 'During the drain' })
    await waitFor(() => r.runtime.store.getCard(card.id)?.state === 'pending', 5000, 'card stored')
    expect(clock.live.size).toBe(0)
  })
})
