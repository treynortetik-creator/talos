// BUGHUNT (presence / ephemeral state): the session module keeps the last `session.state`, `session.agents`,
// `session.inventory`, `workers.status` and per-thread states in memory for `ready` (src/session/index.ts:17-41) and never
// drops them when the bridge goes away. The hub resets its own `working` rows on a bridge close
// (src/core/hub-bridge-conn.ts:95), the session module has no such hook. A Mac that drops mid-turn (lid closed, Wi-Fi
// gone) leaves `busy: true` behind: every app that connects while the Mac is offline is told, in the same `ready` that
// says `presence.bridge_online: false`, that the session is busy, for as long as the relay process lives.
import { waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('`ready` does not report a busy session once the Mac is offline', async () => {
  relay = await startTestRelay()
  const k = kit(relay)
  const watcher = await k.connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  b.send({
    type: 'session.state',
    state: {
      session_id: 's-1',
      source: 'hooks',
      capabilities: [],
      busy: true,
      rate_limits: [],
      surfaces: [],
      at: new Date().toISOString(),
    },
  })
  await b.sync()
  // only meaningful if the relay took the frame: the app that was connected saw it
  await watcher.expectFrame('session.state' as never)
  b.ws.terminate() // the Mac drops mid-turn
  await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')

  const late = k.app()
  const ready = (await late.connect()) as unknown as {
    presence: { bridge_online: boolean }
    session_state?: { busy?: boolean }
  }
  expect(ready.presence.bridge_online).toBe(false)
  expect(ready.session_state?.busy ?? false).toBe(false)
})
