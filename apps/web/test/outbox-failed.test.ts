// @vitest-environment node
// A server error never deletes a signed frame. It stays in the outbox with a visible failed state, and "tap to retry"
// resends the IDENTICAL bytes. Also: a bare ack does not advance lastSeq, only a stored message does.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient, MAX_UPLOAD_BYTES, type OutboxEntry } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function setup(pinned: boolean) {
  relay = await new FakeRelay().start()
  const storage = createMemoryStorage()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return { client, storage, relay }
}

describe('outbox failed state', () => {
  it('a terminal error marks the message failed, keeps the bytes, and retry resends them unchanged', async () => {
    const { client, storage, relay } = await setup(false)
    try {
      const res = await client.sendMessage({ threadId: 'general', text: 'keep me' })
      const [entry] = await storage.all<OutboxEntry>('outbox')
      if (!entry) throw new Error('no entry')
      relay.sendToApps(mkFrame('error', { ref: entry.id, code: 'internal', message: 'x' }))
      await waitFor(() => client.meta.getState().failed[res.clientMsgId] === 'retry', 2000, 'failed')
      expect(client.outboxSize()).toBe(1)
      // retry once the device is pinned: the exact signed bytes go out again
      client.setPinned(true)
      client.retryMessage(res.clientMsgId)
      await waitFor(
        () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.id === entry.id).length >= 1,
        2000,
        'resent',
      )
      const sent = relay.frames.filter((f) => f.direction === 'from_app' && f.raw.id === entry.id)
      expect(sent.every((f) => JSON.stringify(f.raw) === entry.bytes)).toBe(true)
      expect(client.meta.getState().failed[res.clientMsgId]).toBeUndefined()
    } finally {
      client.close()
    }
  })

  it('a Run that failed keeps its intent and the block it is for through a retry: the same signed bytes go out again', async () => {
    // (A Run is never signed again by the age rule: one older than a day is refused first, long before the 6 days at which
    // other frames are signed again. What a retry sends is the saved signed frame, so the block it names cannot change.)
    const { client, storage, relay } = await setup(false)
    try {
      const block = { message_id: newId('m'), index: 2 }
      const res = await client.sendMessage({
        threadId: 'general',
        text: 'Run exactly this:\n\n```sh\necho hi\n```',
        intent: 'run',
        runBlock: block,
      })
      const [entry] = await storage.all<OutboxEntry>('outbox')
      if (!entry) throw new Error('no entry')
      expect(JSON.parse(entry.bytes)).toMatchObject({ intent: 'run', run_block: block })
      relay.sendToApps(mkFrame('error', { ref: entry.id, code: 'internal', message: 'x' }))
      await waitFor(() => client.meta.getState().failed[res.clientMsgId] === 'retry', 2000, 'failed')
      client.setPinned(true)
      client.retryMessage(res.clientMsgId)
      await waitFor(() => relay.frames.some((f) => f.direction === 'from_app' && f.raw.id === entry.id), 2000, 'resent')
      const sent = relay.frames.find((f) => f.direction === 'from_app' && f.raw.id === entry.id)
      expect(sent?.raw).toMatchObject({ intent: 'run', run_block: block })
      expect(JSON.stringify(sent?.raw)).toBe(entry.bytes)
    } finally {
      client.close()
    }
  })

  it('device_not_pinned keeps the frame queued (not failed) and flips devicePinned off', async () => {
    const { client, storage, relay } = await setup(false)
    try {
      const res = await client.sendMessage({ threadId: 'general', text: 'pin me' })
      const [entry] = await storage.all<OutboxEntry>('outbox')
      if (!entry) throw new Error('no entry')
      relay.sendToApps(mkFrame('error', { ref: entry.id, code: 'device_not_pinned', message: 'x' }))
      await new Promise((r) => setTimeout(r, 150))
      expect(client.store.getState().devicePinned).toBe(false)
      expect(client.meta.getState().failed[res.clientMsgId]).toBeUndefined()
      expect(client.outboxSize()).toBe(1)
    } finally {
      client.close()
    }
  })

  it('a message.stored seq advances lastSeq, a bare ack does not', async () => {
    const { client, relay } = await setup(true)
    try {
      relay.sendToApps(mkFrame('ack', { ref: newId('m').replace('m_', '').padEnd(26, '0').slice(0, 26), seq: 999 }))
      // The client handles frames in the order they arrive, so once the stored message below has landed the ack is settled.
      relay.sendToApps(
        mkFrame('message.stored', {
          client_msg_id: newId('m'),
          message: {
            id: newId('m'),
            thread_id: 'general',
            seq: 7,
            author: 'owner',
            kind: 'text',
            text: 'from another device',
            format: 'plain',
            attachments: [],
            via: 'app',
            created_at: new Date().toISOString(),
          },
        }),
      )
      await waitFor(() => client.store.getState().lastSeq === 7, 2000, 'the stored message advanced lastSeq')
      expect(client.store.getState().lastSeq).toBeLessThan(999)
    } finally {
      client.close()
    }
  })

  // Transient and pin errors never throw the signed frame away: it stays queued in memory and in storage.
  it.each(['rate_limited', 'mac_offline'])('error{ref, code:%s} does not discard a held signed frame', async (code) => {
    const { client, storage, relay } = await setup(false)
    try {
      const res = await client.sendMessage({ threadId: 'general', text: 'held until pinned' })
      expect(res.state).toBe('held_unpinned')
      const [entry] = await storage.all<OutboxEntry>('outbox')
      if (!entry) throw new Error('no outbox entry')
      relay.sendToApps(mkFrame('error', { ref: entry.id, code, message: 'x' }))
      // A receipt sent after the error is handled after it, so waiting for it settles the error.
      relay.sendToApps(mkFrame('receipt', { message_id: res.clientMsgId, state: 'seen' }))
      await waitFor(
        () => client.store.getState().messages.general?.find((m) => m.id === res.clientMsgId)?.receipt === 'seen',
        2000,
        'the receipt marker',
      )
      expect(client.outboxSize()).toBe(1)
      expect((await storage.all('outbox')).length).toBe(1)
    } finally {
      client.close()
    }
  })

  it('refuses a file over the cap before reading it', async () => {
    const { client } = await setup(true)
    try {
      const big = {
        size: MAX_UPLOAD_BYTES + 1,
        type: 'video/mp4',
        arrayBuffer: () => Promise.reject(new Error('read')),
      }
      await expect(client.uploadMedia(big as unknown as Blob, { name: 'big.mp4' })).rejects.toMatchObject({
        code: 'too_large',
      })
    } finally {
      client.close()
    }
  })
})
