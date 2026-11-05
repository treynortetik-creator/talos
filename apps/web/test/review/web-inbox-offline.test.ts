// @vitest-environment node
// Review finding #20: Done/Snooze made while offline are not silently dropped; they go out when the socket is back.
import { FakeRelay, waitFor as waitUntil } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

describe('inbox updates made offline', () => {
  it('are sent when the connection is back', async () => {
    const relay = await new FakeRelay().start()
    let online = false
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => online,
    })
    try {
      await client.ensureDevice()
      await client.start({ pinned: true })
      expect(client.store.getState().connection).toBe('offline')
      await client.updateInbox('e_01JBF40000000000000000000A', { state: 'done' })
      online = true
      client.reconnect()
      await waitUntil(
        () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'inbox.update'),
        3000,
        'inbox.update delivered',
      )
      const f = relay.frames.find((x) => x.direction === 'from_app' && x.raw.type === 'inbox.update')
      expect(f?.raw).toMatchObject({ event_id: 'e_01JBF40000000000000000000A', state: 'done' })
    } finally {
      client.close()
      await relay.stop()
    }
  })
})

describe('an inbox change the relay answers with an error', () => {
  const EVENT = 'e_01JBF40000000000000000000A'
  const OTHER = 'e_01JBF40000000000000000000B'
  async function start() {
    const relay = await new FakeRelay().start()
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    await client.ensureDevice()
    await client.start({ pinned: true })
    await waitUntil(() => client.store.getState().connection === 'online', 3000, 'online')
    const sent = (eventId: string) =>
      relay.frames.filter(
        (f) => f.direction === 'from_app' && f.raw.type === 'inbox.update' && f.raw.event_id === eventId,
      )
    const errors = () => relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'error')
    return { relay, client, sent, errors }
  }

  it('is kept when the relay could not save it, and goes out again at the next connection', async () => {
    const { relay, client, sent, errors } = await start()
    try {
      relay.inboxError = 'internal'
      await client.updateInbox(EVENT, { state: 'done' })
      await waitUntil(() => errors().length === 1, 3000, 'the relay could not save it')
      relay.inboxError = null
      client.reconnect()
      await waitUntil(() => sent(EVENT).length === 2, 3000, 'sent again')
      const again = sent(EVENT)[1]?.raw.id
      await waitUntil(
        () => relay.frames.some((f) => f.direction === 'to_app' && f.raw.type === 'ack' && f.raw.ref === again),
        3000,
        'acked',
      )
    } finally {
      client.close()
      await relay.stop()
    }
  })

  it('is dropped when the relay answers with any other error, and is not sent again', async () => {
    const { relay, client, sent, errors } = await start()
    try {
      relay.inboxError = 'bad_frame'
      await client.updateInbox(EVENT, { state: 'done' })
      await waitUntil(() => errors().length === 1, 3000, 'the relay refused it')
      relay.inboxError = null
      client.reconnect()
      await waitUntil(() => client.store.getState().connection === 'online', 3000, 'online again')
      // frames from the app arrive in order: once this later change is seen, a resend of the first would be seen too
      await client.updateInbox(OTHER, { state: 'done' })
      await waitUntil(() => sent(OTHER).length === 1, 3000, 'the later change')
      expect(sent(EVENT)).toHaveLength(1)
    } finally {
      client.close()
      await relay.stop()
    }
  })
})
