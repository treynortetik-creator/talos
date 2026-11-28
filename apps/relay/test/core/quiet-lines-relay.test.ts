// The last lines of a quiet pane (protocol quiet-lines.ts) cross the relay as an EPHEMERAL frame: sent live, only to an app whose hello listed
// quiet-lines/1, never stored (a reconnecting app is not sent it again), and listed by the relay in its `ready` so a bridge knows to send it.
import { newId, QUIET_LINES_FEATURE } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const lines = (messageId: string) => ({
  type: 'quiet.lines' as const,
  message_id: messageId,
  thread_id: 'general',
  lines: ['Reading the file', 'Running the tests'],
})

describe('quiet.lines through the relay', () => {
  it('the relay lists the feature in its ready, so a bridge knows it may send it', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const app = await kit(relay).connectedApp({ visible: false })
    const ready = app.rec.frames.find((r) => r.raw.type === 'ready')?.raw as { features?: string[] } | undefined
    expect(ready?.features).toContain(QUIET_LINES_FEATURE)
  })

  it('goes live to an app that listed the feature, and NOT to one that did not', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const withIt = await k.connectedApp({ visible: false, features: [QUIET_LINES_FEATURE] })
    const without = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({
        pinnedDevices: {
          [withIt.device.deviceId]: withIt.device.publicJwk,
          [without.device.deviceId]: without.device.publicJwk,
        },
        autoReply: false,
      })
      .connect()
    const id = newId('m')
    bridge.send(lines(id))
    const got = await withIt.expectFrame('quiet.lines', (f) => f.message_id === id)
    expect(got.lines).toEqual(['Reading the file', 'Running the tests'])
    await new Promise((r) => setTimeout(r, t(300))) // timing-ok: negative window: the other app is sent nothing
    expect(without.rec.frames.some((r) => r.raw.type === 'quiet.lines')).toBe(false)
  })

  it('is not stored: an app that connects afterwards is not sent it, in catch-up or otherwise', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const first = await k.connectedApp({ visible: false, features: [QUIET_LINES_FEATURE] })
    const bridge = await k
      .bridge({ pinnedDevices: { [first.device.deviceId]: first.device.publicJwk }, autoReply: false })
      .connect()
    const id = newId('m')
    bridge.send(lines(id))
    await first.expectFrame('quiet.lines', (f) => f.message_id === id)
    const later = await k.connectedApp({
      deviceKey: first.device,
      visible: false,
      lastSeq: 0,
      features: [QUIET_LINES_FEATURE],
    })
    await new Promise((r) => setTimeout(r, t(300))) // timing-ok: negative window
    expect(later.rec.frames.some((r) => r.raw.type === 'quiet.lines')).toBe(false)
  })
})
