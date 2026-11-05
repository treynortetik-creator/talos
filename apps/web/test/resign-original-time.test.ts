// @vitest-environment node
// A queued message signed again because it waited too long keeps the time it was first written (`original_ts`, signed), but
// only for a Mac that lists `original-ts/1`: an older Mac's strict parser would refuse the unknown field.
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
    features: ['original-ts/1'],
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

describe('a re-signed frame keeps the time the words were first written', () => {
  it('carries original_ts (signed) when the Mac says it understands it, so old text does not read as new', async () => {
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'written ten days ago' })
    const [orig] = await queuedFrames()
    skew = 0
    await reopen()
    await waitFor(() => fromApp('message').length === 1, 8000, 'sent')
    const sent = fromApp('message')[0]?.raw as Record<string, unknown>
    expect(sent.id).not.toBe(orig?.id)
    expect(sent.original_ts).toBe(orig?.ts)
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    expect(await verifyOwnerFrame(sent, key.publicJwk)).toBe(true)
    // ...and it is covered by the signature: a changed original time on the wire no longer verifies
    expect(await verifyOwnerFrame({ ...sent, original_ts: new Date().toISOString() }, key.publicJwk)).toBe(false)
    expect(Date.now() - Date.parse(String(sent.ts))).toBeLessThan(DAY)
  })

  it('a second re-sign (the owner taps retry) still points at the first write, not at the previous re-sign', async () => {
    skew = -20 * DAY
    await client.sendMessage({ threadId: 'general', text: 'very old' })
    const [orig] = await queuedFrames()
    relay.swallowAcks = true // written to the relay, never acked: it stays queued
    skew = -10 * DAY
    await reopen() // first re-sign: written 20 days ago, signed again "10 days ago"
    await waitFor(() => fromApp('message').length === 1, 8000, 'first resend')
    client.close()
    relay.swallowAcks = false
    skew = 15 * DAY
    relay.forgetSeen()
    bridge.state.forgetSeen()
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 8000, 'online')
    await new Promise((r) => setTimeout(r, 300))
    const row = (client.store.getState().messages.general ?? []).find((m) => m.author === 'owner')
    client.retryMessage(String(row?.id))
    await waitFor(() => fromApp('message').length === 2, 8000, 'sent after the tap')
    const second = fromApp('message')[1]?.raw as Record<string, unknown>
    expect(second.original_ts).toBe(orig?.ts)
    expect(second.ts).not.toBe(orig?.ts)
  })

  it('a Mac that does not list the feature gets a frame without the field (its strict parser would refuse it)', async () => {
    await bridge.close()
    bridge = await new FakeBridge({
      relayWs: relay.wsBase,
      key: relay.bridgeKey,
      now: () => Date.now() + skew,
      pinnedDevices: {
        [(await client.deviceKey())?.deviceId as string]: (await client.deviceKey())?.publicJwk as never,
      },
      features: [],
    }).connect()
    skew = -10 * DAY
    await client.sendMessage({ threadId: 'general', text: 'old news' })
    skew = 0
    await reopen()
    await waitFor(() => fromApp('message').length === 1, 8000, 'sent')
    const sent = (fromApp('message')[0]?.raw ?? {}) as Record<string, unknown>
    expect(sent.original_ts).toBeUndefined()
  })
})

describe('a voice note is as old as the first time it was signed', () => {
  const note = () => ({
    media_id: newId('md'),
    kind: 'voice_note' as const,
    role: 'attachment' as const,
    mime: 'audio/webm',
    name: 'v.webm',
    size: 3,
    sha256: 'a'.repeat(64),
  })
  const failedAs = (id: string) => client.meta.getState().failed[id]

  it('a note signed again at day 6.5 whose write was lost is treated as aged at day 8, and the text behind it is released', async () => {
    skew = -6.5 * DAY // recorded and uploaded 6.5 days ago
    const sent = await client.sendVoiceNote({ threadId: 'general', attachment: note() })
    skew = 0
    relay.swallowAcks = true // the write reaches the relay, the ack never comes back: it stays queued
    await reopen()
    await waitFor(() => fromApp('voice_note').length === 1, 8000, 'signed again and written once')
    const [resigned] = fromApp('voice_note')
    expect(resigned?.raw.original_ts).toBeDefined() // the first signing time rides along
    client.close()
    relay.swallowAcks = false
    relay.forgetSeen()
    bridge.state.forgetSeen()
    skew = 1.5 * DAY // eight days since the upload: the relay has deleted the audio, though the new signature is only 1.5 days old
    online = false
    client = make()
    await client.start({ pinned: true })
    await client.sendMessage({ threadId: 'general', text: 'behind the note' }) // queued after the note, never written yet
    online = true
    client.reconnect()
    await waitFor(() => failedAs(sent.clientMsgId) === 'final', 8000, 'the note is shown as gone')
    expect(fromApp('voice_note')).toHaveLength(1) // not sent again, which would be a false "sent"
    await waitFor(() => fromApp('message').length === 1, 8000, 'the text behind it is released')
  })

  it('a note with no original time that is under a week old is sent as before', async () => {
    skew = -3 * DAY
    const sent = await client.sendVoiceNote({ threadId: 'general', attachment: note() })
    skew = 0
    await reopen()
    await waitFor(() => fromApp('voice_note').length === 1, 8000, 'sent')
    expect(failedAs(sent.clientMsgId)).toBeUndefined()
    expect(fromApp('voice_note')[0]?.raw.original_ts).toBeUndefined()
  })
})
