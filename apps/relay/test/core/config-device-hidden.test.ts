// A setting marked `devices: false` (the bug report webhook URL) is used by the relay and never reaches a phone or the web app:
// not in the config.sync that is stored and sent, not in a later catch-up, not in `ready`. The relay's own copy keeps it.
import { stripDeviceHidden } from '@talos-app/protocol'
import { sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const URL_SECRET = 'https://hooks.example.com/services/T000/B000/secrettoken'
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('stripDeviceHidden', () => {
  it('removes the flagged setting from a copy and leaves everything else and the original alone', () => {
    const full = { ...DEFAULT_AGENT_CONFIG, bug_webhook_url: URL_SECRET }
    const out = stripDeviceHidden(full)
    expect('bug_webhook_url' in out).toBe(false)
    expect(out.timezone).toBe(full.timezone)
    expect(full.bug_webhook_url).toBe(URL_SECRET)
  })
})

describe('config.sync with a device-hidden setting', () => {
  it('the relay keeps it; the live app, a late app (ready, catch-up) and the catch-up never see it', async () => {
    relay = await startTestRelay()
    const r = relay
    const k = kit(r)
    const live = await k.connectedApp()
    const bridge = await k.bridge({ autoReply: false, verifyOwner: false }).connect()
    bridge.send({
      type: 'config.sync',
      config: { ...DEFAULT_AGENT_CONFIG, rev: 1, bug_webhook_url: URL_SECRET },
      rev: 1,
    })
    await waitFor(() => r.relay.services.agentConfig()?.rev === 1)
    expect(r.relay.services.agentConfig()?.bug_webhook_url).toBe(URL_SECRET)
    await live.expectFrame('config.sync', (f) => f.rev === 1)
    await sleep(100)
    const late = await k.connectedApp()
    await sleep(200)
    for (const app of [live, late]) expect(JSON.stringify(app.rec.frames)).not.toContain('secrettoken')
    await live.close()
    await late.close()
    await bridge.close()
  })
})
