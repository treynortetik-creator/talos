import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { t } from '@talos-app/testkit'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(100_000))

let h: Harness
afterEach(async () => h?.stop())

const sigNotes = () => h.notes.filter((n) => n.content.includes('failed its signature check'))

describe('a forged owner message that is refused while the link is down', () => {
  // inbound.ts reject(): for a `message`, a refusal the socket could not carry leaves the frame unseen and unconsumed so the
  // relay replays it. ownerFailed() then goes on and tells the agent anyway, so the replay tells the agent a second time.
  test('the agent hears about the dropped message once, however often the relay replays it', async () => {
    h = await startHarness()
    const transport = h.bridge.ctx.transport as unknown as { sendEphemeral: (f: { type: string }) => boolean }
    const real = transport.sendEphemeral.bind(transport)
    let swallowed = 0
    // the link drops at the instant the refusal is sent: send() says false, exactly as RelayClient does while not connected
    transport.sendEphemeral = (f) => {
      if (f.type === 'error' && swallowed === 0) {
        swallowed++
        return false
      }
      return real(f)
    }
    const good = await h.app.buildMessage('general', 'legit')
    const tampered = { ...good, text: 'tampered' }
    h.app.sendRaw(JSON.stringify(tampered))
    await waitFor(() => swallowed === 1, 4000, 'the refusal that the link could not carry')
    await sleep(t(200))
    // held back for the replay: the agent is not told yet, because the refusal is decided again then
    expect(sigNotes()).toHaveLength(0)
    // the reconnect: the relay still holds the frame (never consumed), so it sends it again on the next hello
    h.relay.dropBridge()
    await h.relay.expectFrame('ack', (f) => f.ref === tampered.id && f.stage === 'consumed', {
      direction: 'from_bridge',
    })
    await sleep(t(300))
    expect(sigNotes()).toHaveLength(1)
  })
})
