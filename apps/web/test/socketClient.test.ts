// @vitest-environment node
// The real socket client against the testkit FakeRelay: every frame it sends parses as app->relay and every owner
// signature verifies on the raw JSON (spec 10.2 "Web contract").
import { type CardT, newId } from '@talos-app/protocol'
import { assertWebSentOnlyValidFrames, buildCard, FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type OutboxEntry, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient
let storage: Storage

beforeEach(async () => {
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
}

describe('socketClient against FakeRelay', () => {
  it('hello/ready fills threads and config', async () => {
    await online()
    const s = client.store.getState()
    expect(s.threads.map((t) => t.id)).toEqual(['general', 'inbox'])
    expect(s.config?.agent.name).toBe('Talos')
  })

  it('sends only valid app frames, all owner frames verify, and empty arrays are explicit', async () => {
    await online()
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    await client.sendMessage({ threadId: 'general', text: 'hello' })
    const att = {
      media_id: newId('md'),
      kind: 'voice_note' as const,
      role: 'attachment' as const,
      mime: 'audio/webm',
      name: 'v.webm',
      size: 3,
      sha256: 'a'.repeat(64),
    }
    await client.sendVoiceNote({ threadId: 'general', attachment: att })
    const card: CardT = buildCard({ thread_id: 'general', risk: 'high' })
    relay.sendToApps(mkFrame('card.create', { card }))
    await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
    await client.resolveCard(card.id, {
      action: 'kill',
      payloadHash: card.payload_hash,
    })
    // the relay acks on store; only the bridge's config.sync{applied} settles the patch (docs/THREADS.md)
    const patched = client.patchConfig({ timezone: 'UTC' })
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'config.patch'),
      2000,
      'patch',
    )
    const pf = relay.frames.find((f) => f.direction === 'from_app' && f.raw.type === 'config.patch')
    const cfgNow = client.store.getState().config
    if (!cfgNow) throw new Error('no config')
    relay.sendToApps(
      mkFrame('config.sync', {
        config: { ...cfgNow, rev: cfgNow.rev + 1 },
        rev: cfgNow.rev + 1,
        applied: pf?.raw.id as string,
      }),
    )
    await patched
    await client.updateInbox('e_01JBF40000000000000000000A', { state: 'done' }).catch(() => {})
    client.markThreadRead('general', 1)
    await client.loadHistory('general')
    await assertWebSentOnlyValidFrames(relay, { [key.deviceId]: key.publicJwk })
    const message = relay.frames.find((f) => f.direction === 'from_app' && f.raw.type === 'message')
    expect(message?.text).toContain('"attachments":[]')
  })

  it('holds owner frames while unpinned and sends the same bytes after the pin', async () => {
    await client.ensureDevice()
    await client.start({ pinned: false })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    const res = await client.sendMessage({ threadId: 'general', text: 'held' })
    expect(res.state).toBe('held_unpinned')
    expect(relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'message')).toHaveLength(0)
    expect(client.outboxSize()).toBe(1)
    const held = await storage.all<OutboxEntry>('outbox')
    expect(held).toHaveLength(1)
    client.setPinned(true)
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'message'),
      2000,
      'delivery',
    )
    // The signed bytes saved while held are the bytes that reach the relay: nothing was re-signed at pin time.
    const delivered = relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toBe(held[0]?.bytes)
    await waitFor(() => client.outboxSize() === 0, 2000, 'ack clears outbox')
  })

  it('reconnects with backoff after a drop and catches up from last_seq: a reply sent while away arrives', async () => {
    await online()
    const bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey }).connect()
    try {
      await client.sendMessage({ threadId: 'general', text: 'one' })
      await waitFor(() => client.store.getState().lastSeq > 0, 2000, 'seq')
      const before = client.store.getState().lastSeq
      // Hold the client off the relay so the reply below is only in the relay's buffer when it comes back.
      relay.holdApps = true
      const dropped = waitFor(() => client.store.getState().connection !== 'online', 2000, 'dropped')
      relay.dropApps()
      await dropped
      bridge.reply('general', 'said while you were away')
      await waitFor(
        () =>
          relay.stored.some((f) => (f.message as { text?: string } | undefined)?.text === 'said while you were away'),
        2000,
        'reply stored',
      )
      expect(client.store.getState().connection).not.toBe('online')
      expect(
        client.store.getState().messages.general?.some((m) => m.text === 'said while you were away') ?? false,
      ).toBe(false)
      // The client tried to come back while the reply sat in the relay, and was refused.
      await waitFor(() => relay.heldOff >= 1, 6000, 'refused while away')
      relay.holdApps = false
      await waitFor(() => client.store.getState().connection === 'online', 6000, 'back')
      await waitFor(
        () => (client.store.getState().messages.general ?? []).some((m) => m.text === 'said while you were away'),
        4000,
        'the missed reply',
      )
      expect(client.store.getState().lastSeq).toBeGreaterThan(before)
      const hello = relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'hello')
      expect(hello.length).toBeGreaterThanOrEqual(2)
      const lastHello = hello[hello.length - 1]?.raw as { last_seq: number } | undefined
      expect(lastHello?.last_seq).toBe(before)
    } finally {
      await bridge.close()
    }
  })

  it('a relay reply updates the store, bumps unread, and a receipt updates the owner message', async () => {
    await online()
    const res = await client.sendMessage({ threadId: 'general', text: 'q' })
    relay.sendToApps(mkFrame('receipt', { message_id: res.clientMsgId, state: 'seen' }))
    await waitFor(() => client.store.getState().messages.general?.[0]?.receipt === 'seen', 2000, 'seen')
    relay.sendToApps(
      mkFrame('reply', {
        message: {
          id: newId('m'),
          thread_id: 'general',
          author: 'agent',
          kind: 'text',
          text: 'a',
          format: 'markdown',
          attachments: [],
          via: 'app',
          created_at: new Date().toISOString(),
        },
      }),
    )
    await waitFor(() => (client.store.getState().unread.general ?? 0) === 1, 2000, 'unread')
  })
})
