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
    fakeWindow.dispatchEvent(new Event('keydown')) // inside 15 s: throttled
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

  // A pointermove where the pointer did not move is the page reflowing under a still cursor (Chromium fires one): counting it
  // kept an owner who walked away "here", and the relay held the push.
  const move = (x: number, y: number) => Object.assign(new Event('pointermove'), { screenX: x, screenY: y })

  it('a pointermove counts only when the pointer moved on the screen; the first one only records', async () => {
    await start()
    t += 60_000
    fakeWindow.dispatchEvent(move(100, 200)) // the first: where the cursor is, not a sign of anyone
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(0)
    fakeWindow.dispatchEvent(move(100, 200)) // the page reflowed under the still cursor
    fakeWindow.dispatchEvent(move(100, 200))
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(0)
    fakeWindow.dispatchEvent(move(101, 200)) // a person moved it
    await waitFor(() => visibilityFrames().length === 1, 3000, 'a real move')
    t += 16_000
    fakeWindow.dispatchEvent(new Event('keydown')) // keys, taps, touches and wheels count as before
    await waitFor(() => visibilityFrames().length === 2, 3000, 'a key')
  })

  it('after the page was hidden and shown again, the first pointermove only records', async () => {
    await start()
    t += 60_000
    fakeWindow.dispatchEvent(move(10, 10))
    fakeWindow.dispatchEvent(move(20, 20))
    await waitFor(() => visibilityFrames().length === 1, 3000, 'a real move')
    visible = false
    ;(g.document as EventTarget).dispatchEvent(new Event('visibilitychange'))
    visible = true
    ;(g.document as EventTarget).dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => visibilityFrames().length === 3, 3000, 'the hidden and visible frames')
    t += 60_000
    fakeWindow.dispatchEvent(move(500, 500)) // the cursor somewhere else when the page came back: only recorded
    await new Promise((r) => setTimeout(r, 100))
    expect(visibilityFrames()).toHaveLength(3)
    fakeWindow.dispatchEvent(move(510, 500))
    await waitFor(() => visibilityFrames().length === 4, 3000, 'a real move after coming back')
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
})
