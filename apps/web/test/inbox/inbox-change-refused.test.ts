// @vitest-environment node
// Done and Snooze are shown at once and queued. When the relay refuses the change for good (any error but `internal`; the
// real relay answers `bad_frame` "That inbox change did not apply."), the queue drops it. The row must then go back to what
// it was: the app must not show "done" for an item the relay still holds as new (bug hunt 2026-11-10, web finding 21).
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { scriptedSockets } from '../helpers/scripted-socket.ts'

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

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms))
const errorsToApp = () => relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'error').length

async function oneItem(over: Record<string, unknown> = {}): Promise<string> {
  relay.sendToApps({
    ...mkFrame('inbox.item', {
      item: {
        id: `e_${newId('m').slice(2)}`,
        source: 'generic',
        connection: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
        kind: 'generic.note',
        title: 'A note',
        summary: 'Something happened',
        actor: {},
        ts: new Date().toISOString(),
        thread: 'inbox',
        work: false,
        priority: 'high',
        state: 'new',
        ...over,
      },
    }),
    relay: { seq: 1, received_at: new Date().toISOString() },
  })
  await waitFor(() => client.store.getState().inbox.length === 1, 2000, 'item')
  return client.store.getState().inbox[0]?.id as string
}
const item = () => client.store.getState().inbox[0]

describe('an inbox change the relay refuses', () => {
  it('does not stay applied on screen', async () => {
    const id = await oneItem()
    relay.inboxError = 'bad_frame'
    await client.updateInbox(id, { state: 'done' })
    expect(item()?.state).toBe('done') // shown at once
    await waitFor(() => errorsToApp() === 1, 2000, 'relay refused')
    await settle()
    // The relay still holds the item as new. The app must not go on showing it as done.
    expect(item()?.state).toBe('new')
  })

  it('a refused snooze takes its time back off the row too', async () => {
    const id = await oneItem()
    relay.inboxError = 'bad_frame'
    await client.updateInbox(id, { state: 'snoozed', snoozeUntil: '2099-01-01T00:00:00.000Z' })
    expect(item()?.snooze_until).toBe('2099-01-01T00:00:00.000Z')
    await waitFor(() => errorsToApp() === 1, 2000, 'relay refused')
    await settle()
    expect(item()?.state).toBe('new')
    expect(item()?.snooze_until).toBeUndefined()
  })

  it('a change the relay could not save (`internal`) stays shown and is sent again', async () => {
    const id = await oneItem()
    relay.inboxError = 'internal'
    await client.updateInbox(id, { state: 'done' })
    await waitFor(() => errorsToApp() === 1, 2000, 'relay failed')
    await settle()
    expect(item()?.state).toBe('done')
    relay.inboxError = null
    client.reconnect()
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'to_app' && f.raw.type === 'ack'),
      4000,
      'acked on the next connection',
    )
    expect(item()?.state).toBe('done')
  })

  it('an accepted change is not rolled back by a later refusal of another change', async () => {
    const id = await oneItem()
    await client.updateInbox(id, { state: 'read' })
    await waitFor(() => relay.frames.some((f) => f.direction === 'to_app' && f.raw.type === 'ack'), 2000, 'acked')
    relay.inboxError = 'bad_frame'
    await client.updateInbox(id, { state: 'done' })
    await waitFor(() => errorsToApp() === 1, 2000, 'relay refused')
    await settle()
    // back to what the relay last accepted, not to the state before that
    expect(item()?.state).toBe('read')
  })

  it('a refusal does not undo what another device changed in the meantime', async () => {
    const id = await oneItem()
    relay.inboxError = 'bad_frame'
    await client.updateInbox(id, { state: 'done' })
    // another device's change for the same item lands before the refusal is read
    client.store.setState((s) => ({ inbox: s.inbox.map((i) => ({ ...i, state: 'snoozed' as const })) }))
    await waitFor(() => errorsToApp() === 1, 2000, 'relay refused')
    await settle()
    expect(item()?.state).toBe('snoozed')
  })
})

// Two changes for one item on the wire at once: the relay takes the first and refuses the second. The testkit relay
// answers each frame as it arrives, so the order is scripted here (helpers/scripted-socket.ts).
describe('a refused change on top of one the relay took', () => {
  it('goes back to the change the relay took, not to the state before both', async () => {
    const rig = scriptedSockets({ unread: {} })
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://scripted.invalid/ws',
      WebSocketImpl: rig.Impl,
      isOnline: () => true,
    })
    try {
      await c.ensureDevice()
      await c.start({ pinned: true })
      await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
      const stamp = { relay: { seq: 1, received_at: new Date().toISOString() } }
      rig.push({
        ...mkFrame('inbox.item', {
          item: {
            id: 'e_01JBF3V7Q8K2M4N6P8R0S00001',
            source: 'generic',
            connection: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
            kind: 'generic.note',
            title: 'A note',
            summary: 'Something happened',
            actor: {},
            ts: new Date().toISOString(),
            thread: 'inbox',
            work: false,
            priority: 'high',
            state: 'new',
          },
        }),
        ...stamp,
      })
      await waitFor(() => c.store.getState().inbox.length === 1, 2000, 'item')
      const id = c.store.getState().inbox[0]?.id as string
      await c.updateInbox(id, { state: 'read' })
      await c.updateInbox(id, { state: 'done' })
      const [first, second] = rig.sent('inbox.update')
      expect([first?.state, second?.state]).toEqual(['read', 'done'])
      rig.push(mkFrame('ack', { ref: first?.id, seq: 2 }))
      expect(c.store.getState().inbox[0]?.state).toBe('done') // the newer change still shows
      rig.push(mkFrame('error', { ref: second?.id, code: 'bad_frame', message: 'That inbox change did not apply.' }))
      expect(c.store.getState().inbox[0]?.state).toBe('read')
    } finally {
      c.close()
    }
  })
})
