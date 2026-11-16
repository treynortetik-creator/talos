// BUGHUNT (catch-up): `catchup.reset` tells an app "there is a hole between what you have and what the relay still holds",
// and the app drops every cached row below `min_seq` (apps/web/src/lib/socket-frames-catchup.ts:61-74). The relay decides it
// from `floor`, the lowest seq of ANY stored frame (src/core/store.ts:865-869, src/core/hub-history.ts:146), but an app only
// ever counts app-visible frames. So when the newest frames before a quiet week were bridge-only (a session control, a
// webhook event, a share, a notification tap), the sweep moves the floor past them and a device that has missed NOTHING
// is told to reset: its cached timeline is wiped although it was complete. With the last frame app-visible, the same
// device gets no reset. Whether an owner keeps the cache after a week away depends on the audience of the last frame.
// Suggested fix: keep an app floor (highest pruned app-visible seq + 1) and compare `since` with that.
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a device that missed nothing gets no catchup.reset after the buffer aged out', async () => {
  const c = fakeClock('2026-10-01T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const { mkFrame } = await import('@talos-app/testkit')
  const { newId, newUlid } = await import('@talos-app/protocol')
  const reply = mkFrame('reply', {
    message: {
      id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'the last thing said before the holiday',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(c.now()).toISOString(),
    },
  })
  b.send(reply)
  await a.expectFrame('reply', (f) => f.id === reply.id)
  const have = a.lastSeq // the device holds everything app-visible
  expect(have).toBe(relay.runtime.store.maxSeq())

  // One bridge-only frame after it, queued exactly the way the session module queues a control (src/session/index.ts:104).
  await relay.runtime.hub.toBridge(
    { type: 'session.control', control_id: newUlid(), thread_id: 'general', action: 'stop' },
    { durable: true, ttl_s: 300 },
  )
  expect(relay.runtime.store.maxSeq()).toBe(have + 1)
  await a.close()
  await b.close()
  await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')

  c.advance(8 * 86_400_000) // a week away: the hourly sweeps empty the buffer
  expect(relay.runtime.store.floor()).toBe(have + 2)

  const mark = a.rec.frames.length
  await a.connect() // hello{last_seq: have}
  a.send({ type: 'ping', nonce: 'barrier2' })
  await a.expectFrame('pong', (f) => f.nonce === 'barrier2', { since: mark })
  const resets = a.rec.frames.slice(mark).filter((r) => r.raw.type === 'catchup.reset')
  expect(resets).toEqual([])
})
