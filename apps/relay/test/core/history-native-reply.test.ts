// RELAY-5: a reply typed in a notification is stored for apps as an owner `message.stored` row (hub-cards.ts) and has no
// `message` frame, but relay-served history dropped every owner message.stored row except a share, so the reply was
// missing from scroll-back. Its id is the native reply's (m_ + the 22-character action id), never an app message's ULID.
import { isNativeReplyMessageId, type MessageT, nativeReplyMessageId, newId } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { type HistoryCtx, historyFrames } from '../../src/core/hub-history.ts'
import type { StoredFrame } from '../../src/core/store.ts'

const ctx = { d: { store: { getMeta: () => ({}) } } } as unknown as HistoryCtx
const stored = (message: Partial<MessageT>, seq = 7) =>
  ({
    type: 'message.stored',
    relay: { seq, received_at: '2026-11-16T12:00:00.000Z' },
    message: {
      thread_id: 'general',
      author: 'owner',
      kind: 'text',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: '2026-11-16T12:00:00.000Z',
      text: 'x',
      ...message,
    },
  }) as unknown as StoredFrame
const show = (f: StoredFrame) => historyFrames.eventMessage.call(ctx, f)

describe('relay-served history: a reply typed in a notification is kept (RELAY-5)', () => {
  it('tells a native reply id from an app message id', () => {
    expect(isNativeReplyMessageId(nativeReplyMessageId('A'.repeat(22)))).toBe(true)
    expect(isNativeReplyMessageId(nativeReplyMessageId('a1_B2-c3D4e5F6g7H8i9J0'))).toBe(true)
    expect(isNativeReplyMessageId(newId('m'))).toBe(false)
    expect(isNativeReplyMessageId('m_short')).toBe(false)
  })

  it('the native reply is in the page, with its seq; an app message’s stored copy is still left to its message frame', () => {
    const reply = show(stored({ id: nativeReplyMessageId('A'.repeat(22)), text: 'on my way' }))
    expect(reply).toMatchObject({ id: `m_${'A'.repeat(22)}`, author: 'owner', text: 'on my way', seq: 7 })
    expect(show(stored({ id: newId('m') }))).toBeNull()
    // a share is kept, as before
    expect(show(stored({ id: newId('m'), via: 'share' }))).not.toBeNull()
    // the agent's rows are kept whatever their id
    expect(show(stored({ id: newId('m'), author: 'agent' }))).not.toBeNull()
  })
})
