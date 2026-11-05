// @vitest-environment jsdom
// The browser going offline while an approval is in flight: the frame was sent, so it got no answer; it did not "never leave".
import type { CardT } from '@talos-app/protocol'
import { buildCard, FakeRelay, mkFrame, NodeWebSocket, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NoAnswerError, NotSentError, type TalosClientError } from '../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient
let card: CardT

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  card = buildCard({ thread_id: 'general' })
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

it('the browser going offline mid-resolve rejects it as sent with no answer, not as never sent', async () => {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
  relay.swallowAcks = true
  const outcome = client.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }).catch((e) => e)
  await waitFor(
    () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'card.resolve'),
    2000,
    'card.resolve sent',
  )
  window.dispatchEvent(new Event('offline'))
  const err = (await outcome) as TalosClientError
  expect(err.message).toBe('Offline')
  expect(err).toBeInstanceOf(NoAnswerError) // the frame had already left the phone
  expect(err).not.toBeInstanceOf(NotSentError)
})
