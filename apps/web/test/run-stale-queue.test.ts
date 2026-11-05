// @vitest-environment node
// A Run the owner tapped while offline is not sent if it waited more than a day: the tap approved a script for that
// moment. The age is read from the signed frame itself (its first signing time), so no state is kept for it.
import { newId, RUN_MAX_AGE_MS, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runText } from '../src/features/threads/runBlock.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

const HOUR = 3600_000
const DAY = RUN_MAX_AGE_MS
let relay: FakeRelay
let bridge: FakeBridge
let storage: Storage
let skew = 0
let online = false
let client: SocketClient

const make = () =>
  createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => online,
    now: () => Date.now() + skew,
  })

beforeEach(async () => {
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  skew = 0
  online = false
  client = make()
  const key = await client.ensureDevice()
  bridge = await new FakeBridge({
    relayWs: relay.wsBase,
    key: relay.bridgeKey,
    now: () => Date.now() + skew,
    pinnedDevices: { [key.deviceId]: key.publicJwk },
  }).connect()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const fromApp = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)
const RUN = runText('echo hi\n', 'sh') as string
const tap = (text = RUN) =>
  client.sendMessage({ threadId: 'general', text, intent: 'run', runBlock: { message_id: newId('m'), index: 0 } })

async function reopen() {
  client.close()
  online = true
  client = make()
  await client.start({ pinned: true })
}

describe('a Run that waited in the offline queue', () => {
  it('is not sent after a day: it becomes a failed message that says why, and the Mac never gets it', async () => {
    skew = -(DAY + HOUR)
    const sent = await tap()
    skew = 0
    await reopen()
    await waitFor(() => client.store.getState().connection === 'online', 8000, 'online')
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'final', 8000, 'shown as failed for good')
    expect(fromApp('message')).toHaveLength(0)
    expect(bridge.notified).toHaveLength(0)
    const said = (client.store.getState().messages.general ?? []).find((m) => m.author === 'system')
    expect(said?.text).toMatch(/Run waited more than a day and was not sent/)
    expect(said?.text).toMatch(/ask your agent to post the script again/)
    expect(said?.text).not.toMatch(/Tap Run/)
  })

  it('is sent, with the bytes it was signed with, when it waited less than a day', async () => {
    skew = -(DAY - 2 * HOUR)
    await tap()
    skew = 0
    await reopen()
    await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac took it')
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    const frame = fromApp('message')[0]?.raw as Record<string, unknown>
    expect(frame.text).toBe(RUN)
    expect(frame.intent).toBe('run')
    expect((frame.run_block as { index: number }).index).toBe(0) // the block it is for went out, inside the signature
    expect(await verifyOwnerFrame(frame, key.publicJwk)).toBe(true)
  })

  it('an ordinary message that waited the same time is still sent', async () => {
    skew = -(DAY + HOUR)
    await client.sendMessage({ threadId: 'general', text: 'still wanted' })
    skew = 0
    await reopen()
    await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac took it')
  })

  it('the same words with no Run intent are only text: a day old, they are still sent', async () => {
    skew = -(DAY + HOUR)
    await client.sendMessage({ threadId: 'general', text: RUN })
    skew = 0
    await reopen()
    await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac took it')
    expect(Object.values(client.meta.getState().failed)).toEqual([])
  })

  it('a Run that was written to a socket and never acked, then waited a day, says it may already have run', async () => {
    relay.swallowAcks = true // the Mac got it; the ack never came back
    online = true
    await reopen()
    const sent = await tap()
    await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac has it')
    expect(client.outboxSize()).toBe(1)
    relay.swallowAcks = false
    client.close()
    skew = DAY + HOUR
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'final', 8000, 'failed for good')
    const said = (client.store.getState().messages.general ?? []).find((m) => m.author === 'system')
    expect(said?.text).toMatch(/may already have run/)
    expect(said?.text).not.toMatch(/was not sent/)
    expect(said?.text).not.toMatch(/Tap Run/)
    expect(fromApp('message')).toHaveLength(1) // not written a second time
  })

  it('stays refused after a reload: the age comes from the saved signed frame', async () => {
    skew = -(DAY + HOUR)
    const sent = await tap()
    client.close()
    skew = 0
    client = make() // offline, a new page load
    await client.start({ pinned: true })
    await reopen()
    await waitFor(() => client.meta.getState().failed[sent.clientMsgId] === 'final', 8000, 'failed again')
    expect(fromApp('message')).toHaveLength(0)
  })
})
