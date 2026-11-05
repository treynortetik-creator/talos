// @vitest-environment node
// Review finding #8 (client side): a voice.ask is only meaningful during the call that spoke it. It must leave the
// persisted outbox on any refusal, when the call ends, and on a fresh start (a reload ends the call).
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient, type OutboxEntry } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const VID = newId('v')
let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function held(storage = createMemoryStorage()) {
  relay ??= await new FakeRelay().start()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: false }) // owner frames wait, so the ask stays in the outbox
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  await client.sendVoiceAsk({
    voiceSessionId: VID,
    delegationId: 'dg_1',
    threadId: 'general',
    question: 'what is on my plate',
    transcriptTail: '',
  } as never)
  const [entry] = await storage.all<OutboxEntry>('outbox')
  if (!entry) throw new Error('no outbox entry')
  return { client, storage, entry }
}

describe('voice.ask outbox', () => {
  it.each(['internal', 'rate_limited', 'mac_offline', 'device_not_pinned'])(
    'a refusal (%s) removes the ask from the persisted outbox',
    async (code) => {
      const { client, storage, entry } = await held()
      expect(client.outboxSize()).toBe(1)
      relay?.sendToApps(mkFrame('error', { ref: entry.id, code, message: 'no' }))
      await waitFor(() => client.outboxSize() === 0, 2000, 'ask dropped')
      expect((await storage.all('outbox')).length).toBe(0)
      client.close()
    },
  )

  it('the end of the call removes the ask', async () => {
    const { client, storage } = await held()
    relay?.sendToApps(mkFrame('voice.state', { voice_session_id: VID, state: 'ended' }))
    await waitFor(() => client.outboxSize() === 0, 2000, 'ask dropped')
    expect((await storage.all('outbox')).length).toBe(0)
    client.close()
  })

  it('an ask left from a previous page load is discarded on start', async () => {
    const { client, storage } = await held()
    client.close()
    const again = createSocketClient({
      storage,
      wsUrl: `${relay?.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    await again.start({ pinned: false })
    expect(again.outboxSize()).toBe(0)
    expect((await storage.all('outbox')).length).toBe(0)
    again.close()
  })
})
