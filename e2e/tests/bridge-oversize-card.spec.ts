// Review proof (bridge #7): the real stack (built relay, real bridge behind FakeClaude). A card inside every schema cap
// but over the relay's 256 KiB frame limit must be refused by the tool, not knock the bridge into a reconnect loop.
import { expect, test } from '@playwright/test'
import { type Stack, startStack } from '../harness/stack.ts'

let stack: Stack
test.beforeEach(async () => {
  stack = await startStack()
  await stack.startBridge()
})
test.afterEach(async () => {
  await stack.stop()
})

// An agent card just under the per-field caps is bigger than a frame; it used to make the bridge flap forever.
test('a card.create over 256 KiB must not knock the bridge socket into a reconnect loop', async () => {
  // Every field inside its own schema cap (body 20k, 12 fields x 20k, payload 64 KiB), so the card tool accepts it.
  const big = 'x'.repeat(19_000)
  const call = stack.claude.callTool('card', {
    thread_id: 'general',
    kind: 'generic',
    title: 'Big card',
    primary_label: 'OK',
    kill_label: 'Kill big card',
    risk: 'low',
    origin: 'chat',
    body: big,
    fields: Array.from({ length: 12 }, (_, i) => ({ key: `f${i}`, label: `Field ${i}`, value: big })),
    payload: { notes: 'y'.repeat(60_000) },
  })
  // Watch the relay's view of the bridge socket for 4 s (short of the 10/min upgrade budget, so the upgrade rate limit stays out of it).
  let flaps = 0
  let was = stack.relay.services.bus.bridgeOnline()
  const t0 = Date.now()
  while (Date.now() - t0 < 4_000) {
    const now = stack.relay.services.bus.bridgeOnline()
    if (was && !now) flaps++
    was = now
    await new Promise((r) => setTimeout(r, 20))
  }
  const reconnects = stack
    .bridgeLog()
    .split('\n')
    .filter((l) => l.includes('reconnect scheduled')).length
  // Expected: the tool refuses a card that cannot fit in one frame (or splits it), and the socket stays up.
  // Seen on main: the relay closes the bridge socket with 1009 each time the bridge flushes its outbox, the bridge
  // reconnects about once a second forever, and the tool finally answers "pending ... (relay unreachable; queued)".
  expect({ flaps, reconnects }).toEqual({ flaps: 0, reconnects: 0 })
  await call
})
