// @vitest-environment node
// The Mac refuses an owner signature older than 8 days. A queued message or voice note that waited that long is signed
// again by the same device key (new frame id and time, same client message id) before it is sent, so waiting through a
// long session expiry does not turn into a silent refusal. The fake Mac checks signature, age and repeats like the real one.
import { newId, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

const DAY = 24 * 3600_000
let relay: FakeRelay
let bridge: FakeBridge
let storage: Storage
let skew = 0 // what the client's clock reads, relative to the real one
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
    now: () => Date.now() + skew, // the Mac's clock moves with the phone's: it is the same wall time in this test
    pinnedDevices: { [key.deviceId]: key.publicJwk },
  }).connect()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const queuedFrames = async () =>
  (await storage.all<{ bytes: string }>('outbox')).map((e) => JSON.parse(e.bytes) as Record<string, unknown>)
const fromApp = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)

async function reopen() {
  client.close()
  online = true
  client = make()
  await client.start({ pinned: true })
}

describe('a queued message that outlived the Mac age limit', () => {
  it('is signed again with a fresh time and the same client message id, and the Mac takes it', async () => {
    skew = -10 * DAY // signed ten days ago, by this clock
    const sent = await client.sendMessage({ threadId: 'general', text: 'still wanted' })
    // A voice note older than the relay keeps its upload (7 days) is shown as failed instead; this one is just past the re-sign age.
    skew = -6.5 * DAY
    await client.sendVoiceNote({
      threadId: 'general',
      attachment: {
        media_id: newId('md'),
        kind: 'voice_note',
        role: 'attachment',
        mime: 'audio/webm',
        name: 'v.webm',
        size: 3,
        sha256: 'a'.repeat(64),
      },
    })
    const before = await queuedFrames()
    expect(before).toHaveLength(2)
    for (const f of before) expect(Date.now() - Date.parse(String(f.ts))).toBeGreaterThan(6 * DAY) // old enough to be signed again

    skew = 0
    await reopen()
    await waitFor(() => bridge.notified.length === 2, 8000, 'the Mac took both')
    await waitFor(() => client.outboxSize() === 0, 8000, 'acked')
    expect(relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'error')).toHaveLength(0)

    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    const sentFrames = [...fromApp('message'), ...fromApp('voice_note')].map((f) => f.raw)
    expect(sentFrames).toHaveLength(2)
    for (const f of sentFrames) {
      expect(await verifyOwnerFrame(f, key.publicJwk)).toBe(true) // the same device key, the same signature check
      expect(Math.abs(Date.now() - Date.parse(String(f.ts)))).toBeLessThan(DAY)
      expect(before.some((o) => o.id === f.id)).toBe(false) // a new frame id
      expect(before.some((o) => o.client_msg_id === f.client_msg_id)).toBe(true) // the same message
    }
    expect(sentFrames.some((f) => f.client_msg_id === sent.clientMsgId)).toBe(true)
  })

  it('a message the Mac already has is not delivered twice when it is signed again', async () => {
    relay.swallowAcks = true // the relay stored it and passed it on; the ack never reached the phone
    online = true
    await reopen()
    await client.sendMessage({ threadId: 'general', text: 'once' })
    await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac has it')
    expect(client.outboxSize()).toBe(1)

    relay.swallowAcks = false
    client.close()
    skew = 6.5 * DAY // most of a week passes before the phone is opened again (inside the dedupe memory)
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.outboxSize() === 0, 8000, 'the repeat is answered as one the relay already has')
    expect(fromApp('message').length).toBe(2)
    expect(JSON.parse(String(fromApp('message')[1]?.text ?? '')).id).not.toBe(
      JSON.parse(String(fromApp('message')[0]?.text ?? '')).id,
    )
    expect(bridge.notified).toHaveLength(1)
  })

  it('a message that is not old goes out with exactly the bytes it was signed with', async () => {
    skew = -2 * DAY
    await client.sendMessage({ threadId: 'general', text: 'recent enough' })
    const [orig] = await queuedFrames()
    skew = 0
    await reopen()
    await waitFor(() => fromApp('message').length === 1, 8000, 'sent')
    expect(JSON.parse(String(fromApp('message')[0]?.text)).id).toBe(orig?.id)
  })

  describe('past the point where the relay and the Mac forget ids (about 8 days)', () => {
    async function ackLostThenFifteenDays() {
      relay.swallowAcks = true
      online = true
      await reopen()
      await client.sendMessage({ threadId: 'general', text: 'maybe delivered' })
      await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac has it')
      expect(client.outboxSize()).toBe(1) // the ack never came
      relay.swallowAcks = false
      client.close()
      skew = 15 * DAY
      relay.forgetSeen() // the relay's id memory is gone by now,
      bridge.state.forgetSeen() // and so is the Mac's
      client = make()
      await client.start({ pinned: true })
      await waitFor(() => client.store.getState().connection === 'online', 8000, 'online')
    }

    it('a message that was written but never acked is not sent again on its own; it is a failed row that says so', async () => {
      await ackLostThenFifteenDays()
      await new Promise((r) => setTimeout(r, 300)) // the flush has had its chance
      expect(fromApp('message')).toHaveLength(1) // nothing was written again
      expect(bridge.notified).toHaveLength(1) // so the agent has it once, not twice
      const row = (client.store.getState().messages.general ?? []).find((m) => m.author === 'owner')
      expect(row).toBeDefined()
      expect(Object.values(client.meta.getState().failed)).toEqual(['retry'])
      const said = (client.store.getState().messages.general ?? []).find((m) => m.author === 'system')
      expect(said?.text).toMatch(/may already have been delivered/)
    })

    it('tapping retry signs it again and sends it, new frame id, same message', async () => {
      await ackLostThenFifteenDays()
      await new Promise((r) => setTimeout(r, 300))
      const first = JSON.parse(String(fromApp('message')[0]?.text))
      const row = (client.store.getState().messages.general ?? []).find((m) => m.author === 'owner')
      client.retryMessage(String(row?.id))
      await waitFor(() => fromApp('message').length === 2, 8000, 'sent after the tap')
      const again = JSON.parse(String(fromApp('message')[1]?.text))
      expect(again.id).not.toBe(first.id)
      expect(again.client_msg_id).toBe(first.client_msg_id)
      await waitFor(() => client.outboxSize() === 0, 8000, 'acked')
      expect(Date.now() + skew - Date.parse(again.ts)).toBeLessThan(DAY) // freshly signed
    })

    it('an entry saved by an older build (no write record) counts as written', async () => {
      relay.forgetSeen()
      client.close()
      skew = -15 * DAY
      const old = make()
      await old.sendMessage({ threadId: 'general', text: 'from the old build' })
      old.close()
      const [row] = await storage.all<Record<string, unknown>>('outbox')
      const { writtenAt: _w, ...legacy } = row as Record<string, unknown>
      await storage.put('outbox', String(legacy.id), legacy) // no `writtenAt` at all
      skew = 0
      online = true
      client = make()
      await client.start({ pinned: true })
      await waitFor(() => client.store.getState().connection === 'online', 8000, 'online')
      await new Promise((r) => setTimeout(r, 300))
      expect(fromApp('message')).toHaveLength(0)
      expect(Object.values(client.meta.getState().failed)).toEqual(['retry'])
    })

    it('a message that was never written to a socket is signed again and sent however old it is', async () => {
      skew = -15 * DAY
      await client.sendMessage({ threadId: 'general', text: 'queued the whole time' })
      client.close()
      skew = 0
      online = true
      client = make()
      await client.start({ pinned: true })
      await waitFor(() => bridge.notified.length === 1, 8000, 'the Mac took it')
      expect(Object.values(client.meta.getState().failed)).toHaveLength(0)
    })
  })
})
