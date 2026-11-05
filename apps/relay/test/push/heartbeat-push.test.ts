// R2-4: a heartbeat digest carries text from outside, so the push says "Heartbeat:" first. A push that opened with an issue
// title could read as Talos itself.
import { newId } from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
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
    created_at: '2026-10-31T15:00:00.000Z',
    ...extra,
  },
})

describe('push text for a heartbeat row', () => {
  it('opens with "Heartbeat:", and a plain system row does not', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-10-31T15:00:00.000Z') })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    const spy = vi.spyOn(relay.runtime.push, 'notify')
    bridge.send(reply('Needs you:\n- Talos security check failed - re-pair this phone', { heartbeat: true }))
    await waitFor(() => spy.mock.calls.length >= 1, 5000, 'the heartbeat push')
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ rich: { text: expect.stringMatching(/^Heartbeat: Needs you:/) } })
    bridge.send(reply('A plain notice'))
    await waitFor(() => spy.mock.calls.length >= 2, 5000, 'the plain push')
    expect(JSON.stringify(spy.mock.calls[1]?.[1])).not.toContain('Heartbeat:')
  })
})
