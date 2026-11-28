// A message's `actions` (the quiet-agent notice's Open terminal button) passes through the relay: live to the app, and again from the
// history when the app reconnects. The relay carries the message as it came; the app reads an action it cannot understand as absent.
import { Message, type MessageT, newId } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HistoryCtx, historyFrames } from '../../src/core/hub-history.ts'
import type { StoredFrame } from '../../src/core/store.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'reply' as const,
  message: {
    id: newId('m'),
    thread_id: 'general',
    author: 'system' as const,
    kind: 'text' as const,
    text,
    format: 'plain' as const,
    attachments: [],
    via: 'app' as const,
    created_at: '2026-11-26T15:00:00.000Z',
    ...extra,
  },
})

describe('message actions through the relay', () => {
  it('reach a connected app, live', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    bridge.send(reply('Trip has been quiet.', { actions: [{ kind: 'open_terminal', thread: 'trip' }] }))
    const live = await app.expectFrame('reply', (f) => f.message.text === 'Trip has been quiet.')
    expect(live.message.actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
  })

  it('are kept in the relay-served history (the stored reply frame is shown whole)', () => {
    const ctx = { d: { store: { getMeta: () => ({}) } } } as unknown as HistoryCtx
    const frame = {
      type: 'reply',
      relay: { seq: 3, received_at: '2026-11-26T15:00:00.000Z' },
      message: { ...reply('Trip has been quiet.').message, actions: [{ kind: 'open_terminal', thread: 'trip' }] },
    } as unknown as StoredFrame
    const shown = historyFrames.eventMessage.call(ctx, frame) as MessageT
    expect(shown.actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
    expect(shown.seq).toBe(3)
  })

  it('an action the app’s schema cannot read is not refused by the relay, and the text still goes', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    bridge.send(reply('Still here.', { actions: [{ kind: 'open_url', thread: 'trip' }] }))
    const f = await app.expectFrame('reply', (x) => x.message.text === 'Still here.')
    // the relay carries the frame as it came; the app's own schema reads what it cannot understand as absent
    expect(Message.parse(f.message).actions).toBeUndefined()
    expect(Message.parse(f.message).text).toBe('Still here.')
  })
})
