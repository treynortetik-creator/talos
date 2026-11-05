// Independent review of PR #91. The relay's auth sweep (src/auth/index.ts) is a 10-minute timer that stop() never clears. The
// e2e suite runs the relay inside the Playwright worker, so the timer of the first stopped relay fires 10 minutes in, on a closed
// database, as an uncaught TypeError that fails whichever test is running then. Before #91 the suite took under 10 minutes.
import { fakeClock } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { startRealRelay } from './real-relay.ts'

describe('a stopped relay leaves nothing behind', () => {
  it('no sweep fires on the closed database 10 minutes after stop()', async () => {
    const clock = fakeClock()
    const r = await startRealRelay({ clock })
    await r.relay.stop()
    expect(() => clock.advance(10 * 60_000 + 1)).not.toThrow()
  })
})
