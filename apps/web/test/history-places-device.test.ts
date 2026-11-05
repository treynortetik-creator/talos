// @vitest-environment node
// D1 review: the real socket client against the testkit FakeRelay. A first page of history on a device that has never
// caught up must move `lastSeq`, or the next hello (last_seq 0) gets no catch-up and replies that landed while the
// socket was down are lost for good. A page asked for before a `catchup.reset` is dropped, not merged beside the rows
// from after the wipe. `ready.read_upto` reaches the store, and marking read moves it.
import { type MessageT, newId } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let bridge: FakeBridge
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, features: [] }).connect()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  await waitFor(() => client.store.getState().presence.bridge_online, 4000, 'bridge online')
})
afterEach(async () => {
  client.close()
  await bridge.close()
  await relay.stop()
})

const msg = (seq: number): MessageT => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: `message ${seq}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  seq,
  created_at: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + seq * 1000).toISOString(),
})
const hellos = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'hello')
const answer = async (messages: MessageT[], hasMore = false) => {
  const req = await bridge.expectFrame('history.request', () => true, { direction: 'in' })
  bridge.send(
    mkFrame('history.page', {
      request_id: req.request_id,
      thread_id: 'general',
      messages,
      has_more: hasMore,
    }) as never,
  )
  return req
}

describe('history on a device that has never caught up', () => {
  it('the newest page moves lastSeq, so the next hello asks for what came after it', async () => {
    expect(client.store.getState().lastSeq).toBe(0)
    const p = client.loadHistory('general')
    await answer([msg(998), msg(999), msg(1000)])
    await p
    expect(client.store.getState().lastSeq).toBe(1000)
    const before = hellos().length
    client.reconnect()
    await waitFor(() => hellos().length > before, 4000, 'second hello')
    expect(hellos().at(-1)?.raw.last_seq).toBe(1000)
  })

  it('an older page (before_seq) does not move it', async () => {
    const p = client.loadHistory('general', 500)
    await answer([msg(498), msg(499)])
    await p
    expect(client.store.getState().lastSeq).toBe(0)
    expect(client.store.getState().messages.general?.length).toBe(2)
  })

  it('a page asked for before a catchup.reset is dropped and reported stale', async () => {
    const p = client.loadHistory('general', 900)
    const req = await bridge.expectFrame('history.request', () => true, { direction: 'in' })
    relay.sendToApps(mkFrame('catchup.reset', { min_seq: 5000 }))
    await waitFor(() => client.store.getState().lastSeq >= 4999, 2000, 'reset applied')
    bridge.send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'general',
        messages: [msg(897), msg(898)],
        has_more: true,
      }) as never,
    )
    const res = await p
    expect(res).toEqual({ hasMore: true, stale: true })
    expect(client.store.getState().messages.general ?? []).toEqual([])
  })
})

describe('the relay read mark', () => {
  it('ready.read_upto lands in the store and markThreadRead moves it', async () => {
    relay.sendToApps(
      mkFrame('ready', {
        session_id: 'sess_x',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 9,
        presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
        read_upto: { general: 7 },
        unread: { general: 2 },
      }),
    )
    await waitFor(() => client.store.getState().readUpto?.general === 7, 2000, 'read_upto')
    client.markThreadRead('general', 9)
    expect(client.store.getState().readUpto?.general).toBe(9)
    expect(client.store.getState().unread.general).toBe(0)
  })
})
