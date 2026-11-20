// @vitest-environment node
// Voice input was archived on 2026-11-19 (tag archive/voice-2026-11-19, docs/archived/voice.md). A device that still holds a
// queued voice note, a live-call question or a recording waiting to upload from an older build never sends them: on load they
// are removed, with one line saying so, and an ordinary queued message is left alone.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'
import { countUnsent } from '../src/lib/unsent.ts'

const NOTE = 'An unsent voice note was removed (voice notes are off)'

let relay: FakeRelay
let storage: Storage
let online = false
let client: SocketClient
const make = () =>
  createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => online,
  })
const owned = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type !== 'hello')
const notes = (c: SocketClient) =>
  Object.values(c.store.getState().messages)
    .flat()
    .filter((m) => m.author === 'system' && m.text === NOTE)

beforeEach(async () => {
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  online = false
  client = make()
  await client.ensureDevice()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

/** What an older build left on the device: a voice note and a live-call question in the outbox, and a recording to upload. */
async function leaveVoiceBehind() {
  const frame = (kind: string, id: string) => ({
    id,
    order: 50,
    kind,
    clientMsgId: `m_${id}`,
    threadId: 'general',
    bytes: JSON.stringify({ v: 1, type: kind, id, ts: new Date().toISOString() }),
    writtenAt: null,
  })
  await storage.put('outbox', 'fr_note', frame('voice_note', 'fr_note'))
  await storage.put('outbox', 'fr_ask', frame('voice.ask', 'fr_ask'))
  await storage.put('blobs', 'm_blob', {
    clientMsgId: 'm_blob',
    threadId: 'general',
    mime: 'audio/webm',
    name: 'v.webm',
    blob: new Blob(['abc'], { type: 'audio/webm' }),
    order: 51,
  })
}

describe('voice entries left in the queue by an older build', () => {
  it('are dropped on load, never sent, and one line says so; a queued message stays and is sent', async () => {
    await client.sendMessage({ threadId: 'general', text: 'still here' })
    client.close()
    await leaveVoiceBehind()

    client = make()
    await client.start({ pinned: true })
    expect((await storage.all('outbox')).map((e) => (e as { kind: string }).kind)).toEqual(['message'])
    expect((await storage.all('blobs')).length).toBe(0)
    expect(client.outboxSize()).toBe(1)
    expect(notes(client)).toHaveLength(1)

    online = true
    client.close()
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.outboxSize() === 0, 8000, 'the message went')
    expect(owned().map((f) => f.raw.type)).toEqual(['message'])
    expect(notes(client)).toHaveLength(0) // said once: nothing left to remove the next time
  })

  it('a queued live-call question alone is dropped without a note (it never was an unsent note)', async () => {
    client.close()
    await storage.put('outbox', 'fr_ask', {
      id: 'fr_ask',
      order: 1,
      kind: 'voice.ask',
      clientMsgId: 'dl_1',
      threadId: 'general',
      bytes: '{}',
      writtenAt: null,
    })
    client = make()
    await client.start({ pinned: true })
    expect((await storage.all('outbox')).length).toBe(0)
    expect(notes(client)).toHaveLength(0)
  })

  it('a leftover voice note or voice.ask is not counted as unsent (it will be removed, not sent)', async () => {
    const fresh = createMemoryStorage()
    await fresh.put('outbox', 'fr_note', { kind: 'voice_note', clientMsgId: 'm_note' })
    await fresh.put('outbox', 'fr_ask', { kind: 'voice.ask' })
    await fresh.put('outbox', 'fr_msg', { kind: 'message', clientMsgId: 'm_msg' })
    const n = await countUnsent(fresh)
    expect(n.sendable + n.other).toBe(1)
  })
})
