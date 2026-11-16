// A reply that will never be delivered (the hub refused a thread session's post, or the relay rejected it) must not stay in
// the Mac's history, where read_thread and "stopped before it answered" would treat it as said. One the outbox kept is still on
// its way, so it stays. Real bridge on the FakeRelay; the transport is made to refuse.
import { afterEach, describe, expect, test } from 'bun:test'
import { type MessageT, newId } from '@talos-app/protocol'
import { RelayHttpError } from '../src/relay-http.ts'
import { deliverAgentMessage } from '../src/tools/send.ts'
import { RelayRejectedError } from '../src/transport.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const message = (): MessageT =>
  ({
    id: newId('m'),
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text: 'An answer.',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date().toISOString(),
  }) as MessageT

describe('a reply nothing will deliver', () => {
  test('is taken out of the history again, and the error still reaches the agent', async () => {
    h = await startHarness()
    const ctx = h.bridge.ctx
    const m = message()
    ;(ctx.transport as { sendDurable: unknown }).sendDurable = async () => {
      throw new RelayRejectedError('not_owner', 'this session can only post to thread trip')
    }
    await expect(deliverAgentMessage(ctx, m, {})).rejects.toThrow(/not_owner/)
    expect(ctx.store.getMessage(m.id)).toBeUndefined()
  })

  test('stays in the history when its frame was kept in the outbox, since it is still on its way', async () => {
    h = await startHarness()
    const ctx = h.bridge.ctx
    const m = message()
    ;(ctx.transport as { sendDurable: unknown }).sendDurable = async (frame: { id: string; type: string }) => {
      ctx.store.outboxAdd(frame.id, frame.type, JSON.stringify(frame), Date.now())
      throw new Error('the socket closed after the frame was kept')
    }
    await expect(deliverAgentMessage(ctx, m, {})).rejects.toThrow(/socket closed/)
    expect(ctx.store.getMessage(m.id)?.text).toBe('An answer.')
  })

  test('a relay 400 or 413 refuses the frame itself: the row goes', async () => {
    h = await startHarness()
    const ctx = h.bridge.ctx
    const m = message()
    ;(ctx.transport as { sendDurable: unknown }).sendDurable = async () => {
      throw new RelayHttpError(400, 'bad frame')
    }
    await expect(deliverAgentMessage(ctx, m, {})).rejects.toThrow()
    expect(ctx.store.getMessage(m.id)).toBeUndefined()
  })

  test('a timeout, a dropped connection, a 5xx, or a 401, 408 or 429 for this one request may not be the last word: the row stays', async () => {
    h = await startHarness()
    const ctx = h.bridge.ctx
    for (const err of [
      new DOMException('timed out', 'TimeoutError'),
      new Error('socket hang up'),
      new RelayHttpError(502, 'bad gateway'),
      new RelayHttpError(408, 'request timeout'),
      new RelayHttpError(429, 'rate limited'),
      new RelayHttpError(401, 'unauthorized'),
    ]) {
      const m = message()
      ;(ctx.transport as { sendDurable: unknown }).sendDurable = async () => {
        throw err
      }
      await expect(deliverAgentMessage(ctx, m, {})).rejects.toBeDefined()
      expect(ctx.store.getMessage(m.id)?.text, String(err)).toBe('An answer.')
    }
  })

  test('a delivered reply is kept, with its seq', async () => {
    h = await startHarness()
    const ctx = h.bridge.ctx
    const m = message()
    ;(ctx.transport as { sendDurable: unknown }).sendDurable = async () => ({ state: 'acked', seq: 41 })
    expect(await deliverAgentMessage(ctx, m, {})).toContain('sent')
    expect(ctx.store.getMessage(m.id)?.text).toBe('An answer.')
  })
})
