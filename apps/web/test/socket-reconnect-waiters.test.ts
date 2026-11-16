// @vitest-environment node
// `reconnect()` replaces the socket by hand, so the old socket's close handler no longer runs. Whatever was waiting for an
// answer on the old socket (a card decision, a config change) can never get one: it must be told so at once, the same as
// when a socket drops by itself, instead of waiting out its own 12 to 20 s timer (bug hunt 2026-11-10, web "plausible").
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoAnswerError } from '../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { scriptedSockets } from './helpers/scripted-socket.ts'

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

it('a request waiting on the old socket is rejected when reconnect() replaces it', async () => {
  relay.swallowAcks = true // the relay took the frame; the answer never reaches the app
  const started = Date.now()
  const threads = client.store.getState().threads.map((t, i, a) => ({ ...t, order: a.length - i }))
  const outcome = client.patchConfig({ threads }).then(
    () => 'answered',
    (e: unknown) => e,
  )
  await waitFor(
    () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'config.patch'),
    2000,
    'sent',
  )
  client.reconnect()
  const e = await outcome
  expect(e).toBeInstanceOf(NoAnswerError)
  expect(Date.now() - started).toBeLessThan(5000)
  // and the client comes back on a new socket
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'back')
})

// A history page comes back on the socket that asked for it. The scripted socket (helpers/scripted-socket.ts) never
// answers one, as a Mac that is slow or gone would not.
describe('a history request still waiting when its socket goes', () => {
  const latePage = (requestId: unknown) =>
    mkFrame('history.page', {
      request_id: requestId,
      thread_id: 'general',
      messages: [
        {
          id: newId('m'),
          thread_id: 'general',
          seq: 3,
          author: 'agent',
          kind: 'text',
          text: 'late',
          format: 'markdown',
          attachments: [],
          via: 'app',
          created_at: new Date().toISOString(),
        },
      ],
      has_more: false,
    })

  it('control: the same page is taken while the request is still waiting on a live socket', async () => {
    const { rig, c, outcome } = await waitingForHistory()
    try {
      rig.push(latePage(rig.sent('history.request')[0]?.request_id))
      expect(await outcome).toBe('answered')
      expect((c.store.getState().messages.general ?? []).map((m) => m.text)).toEqual(['late'])
    } finally {
      c.close()
    }
  })

  async function waitingForHistory() {
    const rig = scriptedSockets({ unread: {} })
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://scripted.invalid/ws',
      WebSocketImpl: rig.Impl,
      backoff: { baseMs: 5, maxMs: 10 },
      isOnline: () => true,
    })
    await c.ensureDevice()
    await c.start({ pinned: true })
    await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
    const started = Date.now()
    const outcome = c.loadHistory('general', 5).then(
      () => 'answered',
      (e: { message?: string }) => e.message ?? 'failed',
    )
    await waitFor(() => rig.sent('history.request').length === 1, 2000, 'asked')
    return { rig, c, outcome, started }
  }

  it('fails at once when the connection drops', async () => {
    const { rig, c, outcome, started } = await waitingForHistory()
    try {
      rig.drop()
      expect(await outcome).toBe('Connection lost')
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      c.close()
    }
  })

  it('fails at once when reconnect() replaces the socket, and the next request works from a clean slate', async () => {
    const { rig, c, outcome, started } = await waitingForHistory()
    try {
      c.reconnect()
      expect(await outcome).toBe('Connection lost')
      expect(Date.now() - started).toBeLessThan(5000)
      await waitFor(() => rig.sockets.length === 2 && c.store.getState().connection === 'online', 4000, 'back')
      // a late page for the request that was given up on is not merged
      const asked = rig.sent('history.request')[0]
      rig.push(latePage(asked?.request_id))
      expect(c.store.getState().messages.general ?? []).toEqual([])
    } finally {
      c.close()
    }
  })
})
