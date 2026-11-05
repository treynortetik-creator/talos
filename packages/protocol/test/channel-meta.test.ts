import { describe, expect, it } from 'vitest'
import { BRIDGE_TOOLS, CHANNEL_KINDS, CHANNEL_TRUSTS, ChannelMeta } from '../src/index.ts'

const ok = {
  chat_id: 'general',
  thread_id: 'general',
  thread_name: 'General',
  message_id: 'm_x',
  ts: '2026-10-28T15:00:00.000Z',
  kind: 'text',
  trust: 'owner',
}

describe('ChannelMeta', () => {
  it('accepts the always-present keys and optional extras including file_path_2..10', () => {
    expect(ChannelMeta.safeParse(ok).success).toBe(true)
    expect(
      ChannelMeta.safeParse({
        ...ok,
        user: 'owner',
        file_path: '/a',
        file_path_2: '/b',
        file_path_10: '/j',
        batch_count: '3',
      }).success,
    ).toBe(true)
  })
  it('every kind and trust in the spec is accepted, nothing else', () => {
    for (const kind of CHANNEL_KINDS) expect(ChannelMeta.safeParse({ ...ok, kind }).success, kind).toBe(true)
    for (const trust of CHANNEL_TRUSTS) expect(ChannelMeta.safeParse({ ...ok, trust }).success, trust).toBe(true)
    expect(ChannelMeta.safeParse({ ...ok, kind: 'telepathy' }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...ok, trust: 'admin' }).success).toBe(false)
    expect(CHANNEL_KINDS).toHaveLength(15) // 10 of spec 4.3 + schedule_run, schedule_held, spawn_request, share (V2 V1.3)
  })
  it('rejects hyphenated keys, non-string values and chat_id != thread_id', () => {
    expect(ChannelMeta.safeParse({ ...ok, 'thread-id': 'x' }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...ok, duration_s: 4 }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...ok, chat_id: 'other' }).success).toBe(false)
  })
  it('lists the 12 bridge tools of spec 4.4', () => {
    expect(BRIDGE_TOOLS).toHaveLength(12)
    expect(new Set(BRIDGE_TOOLS).size).toBe(12)
  })
})
