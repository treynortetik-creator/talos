// defineScheduleFramesContract against the REAL bridge process (bun, stdio) with FakeRelay + FakeApp at the far end and the
// real Chronos CLI behind it (docs/SCHEDULES.md S9, WP-S1).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineScheduleFramesContract,
  FakeApp,
  FakeClaude,
  FakeRelay,
  loadExampleConfig,
  mkFrame,
} from '@talos-app/testkit'
import { ChronosBox, draft } from '../test/schedules/chronos-box.ts'

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

defineScheduleFramesContract('real bridge (bun, stdio) + real Chronos', {
  async start() {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    await app.connect()
    const box = new ChronosBox(new Date().toISOString())
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft(), new Date().toISOString())
    const home = mkdtempSync(join(tmpdir(), 'talos-sched-contract-'))
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
    writeFileSync(
      join(home, 'bridge.key'),
      JSON.stringify({
        v: 1,
        pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
        public: relay.bridgeKey.publicKeyB64,
        key_id: relay.bridgeKey.keyId,
      }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(home, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: [{ id: app.device.deviceId, name: 'Contract device', pubkey_jwk: app.device.publicJwk }],
      }),
      { mode: 0o600 },
    )
    const claude = await new FakeClaude({
      command: 'bun',
      args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
      cwd: BRIDGE_DIR,
      env: {
        TALOS_APP_HOME: home,
        TALOS_APP_RELAY_URL: relay.httpUrl,
        TALOS_APP_BRIDGE: '1',
        TALOS_APP_CHRONOS_BIN: box.bin,
      },
    }).start()
    await relay.rec.expectFrame('ready', () => true, { direction: 'to_bridge' })
    return {
      knownScheduleId: 'daily-digest',
      knownScheduleName: 'Daily Digest',
      knownPrompt: 'Summarise yesterday and post it.',
      threadId: 'general',
      sendOwner: async (frame) => {
        const signed = await app.sign({ ...mkFrame(String(frame.type)), ...frame })
        app.send(signed)
        return signed
      },
      sendUnsigned: async (frame) => {
        const f = { ...mkFrame(String(frame.type)), ...frame, device_id: app.device.deviceId, osig: 'A'.repeat(86) }
        app.send(f)
        return f
      },
      expect: (type, pred, timeoutMs) =>
        app.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      received: () => app.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw),
      stop: async () => {
        await claude.stop()
        await app.close()
        await relay.stop()
        box.dispose()
      },
    }
  },
})
