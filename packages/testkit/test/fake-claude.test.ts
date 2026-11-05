import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineBridgeContract, FakeApp, FakeClaude, FakeRelay, waitFor } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'fixtures', 'stub-bridge.ts')

async function launch(relay: FakeRelay, pinned: Record<string, unknown>, autoReply = false) {
  const key = relay.bridgeKey
  const claude = new FakeClaude({
    command: 'bun',
    args: ['run', stub],
    autoReply,
    env: {
      RELAY_WS: relay.wsBase,
      KEY_PKCS8: key.privateKeyPkcs8B64,
      KEY_ID: key.keyId,
      PINNED: JSON.stringify(pinned),
      THREADS: 'general,inbox',
    },
  })
  await claude.start()
  return { claude, stop: () => claude.stop() }
}

// The stub plays the real bridge, so this runs the whole bridge contract through FakeClaude inside the kit.
defineBridgeContract('stub bridge (kit self-test)', { launch: (relay, pinned) => launch(relay, pinned) })

describe('FakeClaude', () => {
  it('records channel notifications and, in autoReply mode, answers with "ack: <content>"', async () => {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    await app.connect()
    const b = await launch(relay, { [app.device.deviceId]: app.device.publicJwk }, true)
    try {
      await relay.rec.expectFrame('hello', (f) => f.role === 'bridge', { direction: 'from_bridge' })
      await app.sendMessage('general', 'ping claude')
      await app.expectFrame('reply', (f) => f.message.text === 'ack: ping claude')
      expect(b.claude.notifications[0]?.meta.kind).toBe('text')
      await waitFor(() => b.claude.toolCalls.length > 0)
      expect(b.claude.toolCalls[0]?.name).toBe('reply')
      expect(b.claude.serverInstructions).toContain('reply')
    } finally {
      await b.stop()
      await app.close()
      await relay.stop()
    }
  })
})
