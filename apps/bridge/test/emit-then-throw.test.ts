import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { t } from '@talos-app/testkit'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(100_000))

let h: Harness
afterEach(async () => h?.stop())

const copies = (text: string) => h.notes.filter((n) => n.content.includes(text))

describe('an owner message that reached the agent, then something after the hand-over throws', () => {
  // inbound-messages.ts onMessage: emit, then bumpLastOwnerTs, afterOwnerNotify, done. A throw in between (the store busy
  // or full) used to leave the frame unseen and unconsumed, so the relay's replay on the next hello handed it over again.
  test('the replay after a reconnect is consumed, not delivered a second time', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store as unknown as { kvSet: (k: string, v: string) => void }
    const real = store.kvSet.bind(store)
    let thrown = 0
    store.kvSet = (k, v) => {
      if (k === 'last_owner_ts' && thrown === 0) {
        thrown++
        throw new Error('database is locked')
      }
      return real(k, v)
    }
    const sent = await h.app.sendMessage('general', 'once only please')
    await waitFor(() => copies('once only please').length >= 1, 4000, 'the message to reach the agent')
    await waitFor(() => thrown === 1, 4000, 'the injected throw')
    // the link comes back: the relay still holds the frame (it was never consumed), so it sends it again on the next hello
    h.relay.dropBridge()
    await h.relay.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'from_bridge' })
    await sleep(t(300))
    expect(copies('once only please')).toHaveLength(1)
  })
})
