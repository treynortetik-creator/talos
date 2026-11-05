// @vitest-environment node
// The web client tells the relay someone is at the screen: a throttled visibility frame on pointer/key/touch/scroll,
// never while hidden. The relay mutes pushes only for a visible screen that reported within 60 s.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | undefined
let client: SocketClient | undefined
const g = globalThis as Record<string, unknown>
let fakeWindow: EventTarget
let t = Date.parse('2026-10-28T15:00:00Z')
let visible = true

beforeEach(() => {
  fakeWindow = new EventTarget()
  g.window = fakeWindow
  g.document = new EventTarget()
  visible = true
  t = Date.parse('2026-10-28T15:00:00Z')
})
afterEach(async () => {
  client?.close()
  await relay?.stop()
  delete g.window
  delete g.document
})

const visibilityFrames = () =>
  (relay as FakeRelay).frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'visibility').map((f) => f.raw)

async function start() {
  relay = await new FakeRelay().start()
  const c = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    isOnline: () => true,
    isVisible: () => visible,
    now: () => t,
  })
  client = c
  await c.ensureDevice()
  await c.start({ pinned: true })
  await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
}

describe('activity reports', () => {
  it('sends a visible frame on activity, at most once per 15 s, and none while hidden', async () => {
    await start()
    expect(visibilityFrames()).toHaveLength(0)
    fakeWindow.dispatchEvent(new Event('keydown'))
    await waitFor(() => visibilityFrames().length === 1, 3000, 'first report')
    expect(visibilityFrames()[0]?.state).toBe('visible')
    fakeWindow.dispatchEvent(new Event('pointermove')) // inside 15 s: throttled
    t += 14_000
    fakeWindow.dispatchEvent(new Event('touchstart'))
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(1)
    t += 2_000
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    await waitFor(() => visibilityFrames().length === 2, 3000, 'second report')
    visible = false
    t += 60_000
    fakeWindow.dispatchEvent(new Event('wheel'))
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(2)
  })

  it('a scroll alone is not activity: the timeline scrolls itself on every new row', async () => {
    await start()
    t += 60_000
    fakeWindow.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(0)
    fakeWindow.dispatchEvent(new Event('wheel')) // a person scrolling still counts
    await waitFor(() => visibilityFrames().length === 1, 3000, 'wheel report')
  })

  it('reportPresence (a live call) sends a visible frame, throttled and never while hidden', async () => {
    await start()
    ;(client as SocketClient).reportPresence?.()
    await waitFor(() => visibilityFrames().length === 1, 3000, 'presence report')
    ;(client as SocketClient).reportPresence?.() // inside 15 s
    t += 20_000
    visible = false
    ;(client as SocketClient).reportPresence?.()
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(1)
    visible = true
    ;(client as SocketClient).reportPresence?.()
    await waitFor(() => visibilityFrames().length === 2, 3000, 'second presence report')
  })
})
