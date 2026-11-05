// @vitest-environment node
// The relay stored a message but the connection died before its ack reached the app. The app must keep the message,
// send the identical bytes once more after it reconnects, and then stop. The relay answers the repeat as a duplicate.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

const fromApp = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)

describe('a message whose ack never arrives', () => {
  it('stays queued, is resent with identical bytes exactly once after reconnect, and then clears', async () => {
    relay.swallowAcks = true
    await client.sendMessage({ threadId: 'general', text: 'are you there' })
    await waitFor(() => fromApp('message').length === 1, 4000, 'first send')
    expect(client.outboxSize()).toBe(1) // no ack: still held
    const hellos = fromApp('hello').length

    relay.dropApps() // the link dies with the ack unsent
    relay.swallowAcks = false
    await waitFor(() => fromApp('message').length === 2, 4000, 'resend')
    await waitFor(() => client.outboxSize() === 0, 4000, 'duplicate ack clears the queue')
    expect(fromApp('message')[1]?.text).toBe(fromApp('message')[0]?.text) // identical bytes, same signature and id

    // Another reconnect must not send it a third time.
    relay.dropApps()
    await waitFor(() => fromApp('hello').length >= hellos + 2, 4000, 'second reconnect')
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(fromApp('message')).toHaveLength(2)
    // the relay answered the repeat as a duplicate: it announced the stored message once
    expect(relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'message.stored')).toHaveLength(1)
  })
})
