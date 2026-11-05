// @vitest-environment node
// A card the owner killed or sent back for changes must sit where the owner acted on it, on every device, whichever Mac
// build sent the update (an older one never closed such a card) and across a reconnect.
import { type CardT, type MessageT, newId } from '@talos-app/protocol'
import { buildCard, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orderTimelineRows } from '../src/features/threads/Timeline.tsx'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let clients: SocketClient[]

const open = async (): Promise<SocketClient> => {
  const c = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  clients.push(c)
  await c.ensureDevice()
  await c.start({ pinned: true })
  await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
  return c
}

beforeEach(async () => {
  relay = await new FakeRelay().start()
  clients = []
})
afterEach(async () => {
  for (const c of clients) c.close()
  await relay.stop()
})

const T0 = Date.UTC(2026, 9, 31, 12, 0)
const at = (min: number) => new Date(T0 + min * 60_000)
const reply = (text: string, min: number) =>
  relay.sendToApps(
    mkFrame('reply', {
      message: {
        id: newId('m'),
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text,
        format: 'plain',
        attachments: [],
        via: 'app',
        seq: 100 + min, // the relay stamps every stored message
        created_at: at(min).toISOString(),
      },
    }),
  )
const resolution = (action: 'kill' | 'revise' | 'primary', min: number) => ({
  action,
  at: at(min).toISOString(),
  edited: false,
  payload_hash: 'sha256:x',
})
const view = (c: SocketClient) => {
  const s = c.store.getState()
  const rows = orderTimelineRows(s.messages.general ?? ([] as MessageT[]), s.cards, T0 + 600 * 60_000)
  return rows.map((r) => r.message?.text ?? (r.card ? `card:${r.card.state}` : '?'))
}

describe('a decided card keeps its place across devices, Mac builds and reconnects', () => {
  for (const sends of [
    ['an older Mac (leaves the card resolved)', 'resolved'],
    ['a current Mac (closes the card)', 'done'],
  ] as const) {
    it(`${sends[0]}: both devices put a revised card at the time of the tap, before the newer reply`, async () => {
      const a = await open()
      const b = await open()
      const card: CardT = buildCard({ thread_id: 'general' }, at(0))
      relay.sendToApps(mkFrame('card.create', { card }))
      reply('before', 1)
      relay.sendToApps(
        mkFrame('card.update', { card_id: card.id, state: 'resolved', resolution: resolution('revise', 2) }),
      )
      if (sends[1] === 'done')
        relay.sendToApps(
          mkFrame('card.update', { card_id: card.id, state: 'done', resolution: resolution('revise', 2) }),
        )
      reply('after', 3)
      for (const c of [a, b])
        await waitFor(() => (c.store.getState().messages.general?.length ?? 0) === 2, 3000, 'both messages')
      for (const c of [a, b]) {
        expect(view(c)).toEqual(['before', `card:${sends[1]}`, 'after'])
        expect(c.store.getState().cards[0]?.resolution?.action).toBe('revise')
      }
    })
  }

  it('a reconnect that lists no open card keeps a resolved revise in place and still decided', async () => {
    const c = await open()
    const card = buildCard({ thread_id: 'general' }, at(0))
    relay.sendToApps(mkFrame('card.create', { card }))
    reply('before', 1)
    relay.sendToApps(mkFrame('card.update', { card_id: card.id, state: 'resolved', resolution: resolution('kill', 2) }))
    reply('after', 3)
    await waitFor(() => (c.store.getState().messages.general?.length ?? 0) === 2, 3000, 'messages')
    expect(view(c)).toEqual(['before', 'card:resolved', 'after'])
    relay.sendToApps(
      mkFrame('ready', {
        session_id: 'sess_again',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 99,
        presence: { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 },
        open_cards: [],
      }),
    )
    await waitFor(() => (c.store.getState().readySeq ?? 0) >= 2, 3000, 'second ready')
    expect(view(c)).toEqual(['before', 'card:resolved', 'after'])
  })

  it('a card still pending stays last, and moves into place the moment it is decided', async () => {
    const c = await open()
    const card = buildCard({ thread_id: 'general' }, at(0))
    relay.sendToApps(mkFrame('card.create', { card }))
    reply('later', 5)
    await waitFor(() => (c.store.getState().messages.general?.length ?? 0) === 1, 3000, 'message')
    expect(view(c)).toEqual(['later', 'card:pending'])
    relay.sendToApps(mkFrame('card.update', { card_id: card.id, state: 'done', resolution: resolution('kill', 6) }))
    await waitFor(() => c.store.getState().cards[0]?.state === 'done', 3000, 'done')
    reply('newest', 9)
    await waitFor(() => (c.store.getState().messages.general?.length ?? 0) === 2, 3000, 'newest')
    expect(view(c)).toEqual(['later', 'card:done', 'newest'])
  })
})
