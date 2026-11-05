// @vitest-environment node
// A phone clock that is minutes off must not lock the owner out of signed reads (PR #55 review, finding A): the app learns
// the relay's time from `ready` and stamps owner frames with it, so the Mac's read window (now + 2 min / now - 5 min) holds.
import { verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | undefined
let bridge: FakeBridge | undefined
let client: SocketClient | undefined

afterEach(async () => {
  client?.close()
  await bridge?.close()
  await relay?.stop()
})

async function start(skewMs: number) {
  relay = await new FakeRelay().start()
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey }).connect()
  const c = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
    now: () => Date.now() + skewMs,
  })
  client = c
  await c.ensureDevice()
  await c.start({ pinned: true })
  await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
  return c
}

const lastHistoryTs = async () => {
  const r = relay as FakeRelay
  await waitFor(
    () => r.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'history.request'),
    3000,
    'history.request',
  )
  const f = r.frames.filter((x) => x.direction === 'from_app' && x.raw.type === 'history.request').at(-1)
  return f?.raw as Record<string, unknown>
}

describe('signed frames use the relay clock', () => {
  it('a phone 6 min slow still signs a history.request within seconds of real time', async () => {
    const c = await start(-6 * 60_000)
    void c.loadHistory('general', 5).catch(() => {})
    const raw = await lastHistoryTs()
    expect(Math.abs(Date.parse(String(raw.ts)) - Date.now())).toBeLessThan(10_000)
    const key = await c.deviceKey()
    expect(await verifyOwnerFrame(raw, key?.publicJwk as never)).toBe(true)
  })

  it('a clock within round-trip noise is left alone', async () => {
    const c = await start(-5_000)
    void c.loadHistory('general', 5).catch(() => {})
    const raw = await lastHistoryTs()
    const d = Date.parse(String(raw.ts)) - Date.now()
    expect(d).toBeLessThan(-3_000)
    expect(d).toBeGreaterThan(-8_000)
  })
})
