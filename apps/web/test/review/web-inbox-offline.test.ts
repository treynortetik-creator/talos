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

  /**
   * A WebSocket whose frames and close event can be held back: the relay's answer is on its way on the old socket when
   * the client lets go of it, the window the race lived in. Each socket created is kept, oldest first.
   */
  function holdingSockets() {
    const made: Held[] = []
    class Held extends WebSocket {
      holding = false
      held: Array<() => void> = []
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        made.push(this)
      }
      override set onmessage(h: ((ev: MessageEvent) => void) | null) {
        super.onmessage = h && ((ev) => (this.holding ? this.held.push(() => h.call(this, ev)) : h.call(this, ev)))
      }
      override get onmessage() {
        return super.onmessage
      }
      override set onclose(h: ((ev: CloseEvent) => void) | null) {
        super.onclose = h && ((ev) => (this.holding ? this.held.push(() => h.call(this, ev)) : h.call(this, ev)))
      }
      override get onclose() {
        return super.onclose
      }
      release() {
        this.holding = false
        for (const f of this.held.splice(0)) f()
      }
    }
    return { WebSocketImpl: Held as unknown as typeof WebSocket, made }
  }
  async function startHeld(inboxAnswerGraceMs: number) {
    const relay = await new FakeRelay().start()
    const { WebSocketImpl, made } = holdingSockets()
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
      WebSocketImpl,
      inboxAnswerGraceMs,
    })
    await client.ensureDevice()
    await client.start({ pinned: true })
    await waitUntil(() => client.store.getState().connection === 'online', 3000, 'online')
    const sent = (eventId: string) =>
      relay.frames.filter(
        (f) => f.direction === 'from_app' && f.raw.type === 'inbox.update' && f.raw.event_id === eventId,
      )
    const errors = () => relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'error')
    return { relay, client, sent, errors, made }
  }

  it('is not sent again by a reconnect made while the refusal is still on its way', async () => {
    const { relay, client, sent, errors, made } = await startHeld(60_000) // only the close can release it
    try {
      const old = made[0]
      if (!old) throw new Error('no socket')
      old.holding = true
      relay.inboxError = 'bad_frame'
      await client.updateInbox(EVENT, { state: 'done' })
      await waitUntil(() => errors().length === 1 && old.held.length > 0, 3000, 'the refusal, not yet read')
      relay.inboxError = null
      client.reconnect() // inside the window: the refusal is sent, the client has not read it
      await waitUntil(() => made.length === 2 && client.store.getState().connection === 'online', 3000, 'online again')
      await client.updateInbox(OTHER, { state: 'done' })
      await waitUntil(() => sent(OTHER).length === 1, 3000, 'the later change')
      expect(sent(EVENT)).toHaveLength(1) // the new connection did not send it while the old one could still answer
      old.release() // the refusal arrives, then the old socket's close
      await new Promise((r) => setTimeout(r, 100))
      await client.updateInbox(OTHER, { state: 'snoozed', snoozeUntil: '2030-01-01T00:00:00.000Z' })
      await waitUntil(() => sent(OTHER).length === 2, 3000, 'a change after the close')
      expect(sent(EVENT)).toHaveLength(1)
    } finally {
      client.close()
      await relay.stop()
    }
  })

  it('goes out again when the old socket closes without its answer', async () => {
    const { relay, client, sent, made } = await startHeld(100)
    try {
      const old = made[0]
      if (!old) throw new Error('no socket')
      old.holding = true
      await client.updateInbox(EVENT, { state: 'done' })
      await waitUntil(() => sent(EVENT).length === 1 && old.held.length > 0, 3000, 'sent, its ack not yet read')
      client.reconnect()
      await waitUntil(() => client.store.getState().connection === 'online', 3000, 'online again')
      await waitUntil(() => old.readyState === WebSocket.CLOSED, 3000, 'the old socket closed, its close held')
      old.held.length = 0 // the ack and the close are lost: nothing more comes on it
      old.release()
      // its close never reaches the client either: the grace gives it up
      await waitUntil(() => sent(EVENT).length === 2, 5000, 'sent again once the old socket is given up')
    } finally {
      client.close()
      await relay.stop()
    }
  })

  it('goes out on the new connection when a could-not-save answer arrives late on the old one', async () => {
    const { relay, client, sent, errors, made } = await startHeld(60_000)
    try {
      const old = made[0]
      if (!old) throw new Error('no socket')
      old.holding = true
      relay.inboxError = 'internal'
      await client.updateInbox(EVENT, { state: 'done' })
      await waitUntil(() => errors().length === 1 && old.held.length > 0, 3000, 'could not save, not yet read')
      relay.inboxError = null
      client.reconnect()
      await waitUntil(() => made.length === 2 && client.store.getState().connection === 'online', 3000, 'online again')
      expect(sent(EVENT)).toHaveLength(1) // still on the wire on the old socket
      await waitUntil(() => old.readyState === WebSocket.CLOSED, 3000, 'the old socket closed, its close held')
      const close = old.held.pop() // the answer arrives; the close stays held, so only the answer can send it again
      old.release()
      await waitUntil(() => sent(EVENT).length === 2, 3000, 'sent again on the new connection')
      close?.()
    } finally {
      client.close()
      await relay.stop()
    }
  })
})
