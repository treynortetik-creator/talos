// @vitest-environment node
// D36 and D38 on the REAL socket client against the fake relay: mark unread goes to the relay and the relay's answer sets
// the count and the mark; a `not_delivered` receipt (live, or in `ready`) sticks and a later catch-up row does not turn it
// back into "Sent".
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const reply = (thread_id: string, text: string) =>
  mkFrame('reply', {
    message: {
      id: newId('m'),
      thread_id,
      author: 'agent',
      kind: 'text',
      text,
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: new Date().toISOString(),
    },
  })

async function online() {
  relay = await new FakeRelay().start()
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return { client, relay }
}
const readyFrame = (extra: Record<string, unknown>) =>
  mkFrame('ready', {
    session_id: 'sess_test',
    policy: { max_frame_bytes: 262144, ping_ms: 25000 },
    server_seq: 0,
    presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
    ...extra,
  })

describe('D36 mark unread on the real client', () => {
  it('sends thread.unread, shows one unread at once, and takes the relay answer (count and mark)', async () => {
    const { client, relay } = await online()
    try {
      relay.sendToApps(reply('general', 'hello'))
      await waitFor(() => (client.store.getState().unread.general ?? 0) === 1, 3000, 'unread')
      client.markThreadRead('general', 50)
      expect(client.store.getState().unread.general).toBe(0)
      client.store.setState({ readUpto: { general: 50 } })

      expect(client.markThreadUnread('general')).toBe(true)
      expect(client.store.getState().unread.general).toBe(1)
      await waitFor(() => relay.rec.of('thread.unread', 'from_app').length === 1, 3000, 'frame reached the relay')

      // the relay answers with the truth: three unread, the mark under the first of them
      relay.sendToApps(mkFrame('thread.unread', { thread_id: 'general', up_to_seq: 41, count: 3 }))
      await waitFor(() => client.store.getState().unread.general === 3, 3000, 'count from the relay')
      expect(client.store.getState().readUpto?.general).toBe(41)

      // no mark in the answer (the rows aged out): the mark stays, the count is at least one
      relay.sendToApps(mkFrame('thread.unread', { thread_id: 'general', count: 1 }))
      await waitFor(() => client.store.getState().unread.general === 1, 3000, 'count one')
      expect(client.store.getState().readUpto?.general).toBe(41)
    } finally {
      client.close()
    }
  })

  it('offline it changes nothing and says so', async () => {
    const { client, relay } = await online()
    client.close()
    await relay.stop()
    expect(client.markThreadUnread('general')).toBe(false)
    expect(client.store.getState().unread.general ?? 0).toBe(0)
  })
})

describe('D38 not_delivered on the real client', () => {
  it('a live receipt marks the row, and a catch-up copy of the message does not turn it back into Sent', async () => {
    const { client, relay } = await online()
    try {
      const sent = await client.sendMessage({ threadId: 'general', text: 'anyone home?' })
      await waitFor(
        () => client.store.getState().messages.general?.some((m) => m.id === sent.clientMsgId) === true,
        3000,
        'row',
      )
      relay.sendToApps(mkFrame('receipt', { message_id: sent.clientMsgId, state: 'not_delivered' }))
      await waitFor(
        () =>
          client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.receipt === 'not_delivered',
        3000,
        'receipt',
      )
      const row = client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)
      relay.sendToApps(
        mkFrame('message.stored', { client_msg_id: sent.clientMsgId, message: { ...row, receipt: 'sent', seq: 9 } }),
      )
      await waitFor(
        () => client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.seq === 9,
        3000,
        'stored',
      )
      expect(client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.receipt).toBe(
        'not_delivered',
      )
    } finally {
      client.close()
    }
  })

  it('Delete works on a row that already left the outbox (it was acked and stored)', async () => {
    const { client, relay } = await online()
    try {
      const sent = await client.sendMessage({ threadId: 'general', text: 'gone for good' })
      await waitFor(
        () => client.store.getState().messages.general?.some((m) => m.id === sent.clientMsgId) === true,
        3000,
        'row',
      )
      await waitFor(() => relay.rec.of('message', 'from_app').length === 1, 3000, 'reached the relay')
      relay.sendToApps(mkFrame('receipt', { message_id: sent.clientMsgId, state: 'not_delivered' }))
      await waitFor(
        () =>
          client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.receipt === 'not_delivered',
        3000,
        'receipt',
      )
      await client.discardMessage(sent.clientMsgId)
      expect(client.store.getState().messages.general?.some((m) => m.id === sent.clientMsgId)).toBe(false)
    } finally {
      client.close()
    }
  })

  it('ready.not_delivered marks a row this device held while it was away', async () => {
    const { client, relay } = await online()
    try {
      const sent = await client.sendMessage({ threadId: 'general', text: 'sent before I closed the lid' })
      await waitFor(
        () => client.store.getState().messages.general?.some((m) => m.id === sent.clientMsgId) === true,
        3000,
        'row',
      )
      relay.sendToApps(readyFrame({ not_delivered: [sent.clientMsgId] }))
      await waitFor(
        () =>
          client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.receipt === 'not_delivered',
        3000,
        'ready marks it',
      )
    } finally {
      client.close()
    }
  })

  it('a row that only arrives after ready.not_delivered (a catch-up on a device that lacked it) is not shown as Sent', async () => {
    const { client, relay } = await online()
    try {
      const id = newId('m')
      relay.sendToApps(readyFrame({ not_delivered: [id] }))
      await sleep(80)
      relay.sendToApps(
        mkFrame('message.stored', {
          client_msg_id: id,
          message: {
            id,
            thread_id: 'general',
            seq: 12,
            author: 'owner',
            kind: 'text',
            text: 'sent from my other phone',
            format: 'plain',
            attachments: [],
            via: 'app',
            receipt: 'sent',
            created_at: new Date().toISOString(),
          },
        }),
      )
      await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 3000, 'row')
      expect(client.store.getState().messages.general?.find((m) => m.id === id)?.receipt).toBe('not_delivered')
    } finally {
      client.close()
    }
  })

  it('an unknown receipt word on a message degrades that one field, never the row', async () => {
    const { Message } = await import('@talos-app/protocol')
    const m = Message.parse({
      id: newId('m'),
      thread_id: 'general',
      author: 'owner',
      kind: 'text',
      text: 'x',
      receipt: 'from_the_future',
      created_at: new Date().toISOString(),
    })
    expect(m.receipt).toBeUndefined()
    expect(m.text).toBe('x')
  })
})

describe('review findings', () => {
  it('catchup.reset keeps a row the relay gave up on (it is the only copy), and drops the others below the window', async () => {
    const { client, relay } = await online()
    try {
      const sent = await client.sendMessage({ threadId: 'general', text: 'the only copy' })
      await waitFor(
        () => client.store.getState().messages.general?.some((m) => m.id === sent.clientMsgId) === true,
        3000,
        'row',
      )
      relay.sendToApps(
        mkFrame('message.stored', {
          client_msg_id: sent.clientMsgId,
          message: {
            id: sent.clientMsgId,
            thread_id: 'general',
            seq: 1,
            author: 'owner',
            kind: 'text',
            text: 'the only copy',
            format: 'plain',
            attachments: [],
            via: 'app',
            created_at: new Date().toISOString(),
          },
        }),
      )
      await waitFor(
        () => client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.seq === 1,
        3000,
        'stored',
      )
      const other = newId('m')
      relay.sendToApps(
        mkFrame('reply', {
          message: {
            id: other,
            thread_id: 'general',
            seq: 2,
            author: 'agent',
            kind: 'text',
            text: 'old reply',
            format: 'markdown',
            attachments: [],
            via: 'app',
            created_at: new Date().toISOString(),
          },
        }),
      )
      await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === other) === true, 3000, 'reply')
      relay.sendToApps(mkFrame('receipt', { message_id: sent.clientMsgId, state: 'not_delivered' }))
      await waitFor(
        () =>
          client.store.getState().messages.general?.find((m) => m.id === sent.clientMsgId)?.receipt === 'not_delivered',
        3000,
        'lost',
      )
      relay.sendToApps(mkFrame('catchup.reset', { min_seq: 10 }))
      await waitFor(
        () => client.store.getState().messages.general?.some((m) => m.id === other) === false,
        3000,
        'reset',
      )
      const left = client.store.getState().messages.general ?? []
      expect(left.map((m) => m.id)).toEqual([sent.clientMsgId])
      expect(left[0]?.receipt).toBe('not_delivered')
    } finally {
      client.close()
    }
  })

  it('Mark read that needs a connection changes nothing offline, and reports false', async () => {
    const { client, relay } = await online()
    relay.sendToApps(reply('general', 'hello'))
    await waitFor(() => (client.store.getState().unread.general ?? 0) === 1, 3000, 'unread')
    client.close()
    await relay.stop()
    expect(client.markThreadRead('general', 5, { needConnection: true })).toBe(false)
    expect(client.store.getState().unread.general).toBe(1)
    // reading an open thread still clears the badge at once (Timeline), the mark goes out when the socket is back
    expect(client.markThreadRead('general', 5)).toBe(true)
    expect(client.store.getState().unread.general).toBe(0)
  })

  it('ready records the relay seq, which a Mark read can use before any catch-up', async () => {
    const { client, relay } = await online()
    try {
      relay.sendToApps(readyFrame({ server_seq: 321 }))
      await waitFor(() => client.store.getState().serverSeq === 321, 3000, 'serverSeq')
    } finally {
      client.close()
    }
  })
})
