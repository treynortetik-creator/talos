import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BridgeHandle,
  type BridgeHarness,
  defineBridgeContract,
  FakeClaude,
  loadExampleConfig,
} from '@talos-app/testkit'

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What restart() needs to bring the same bridge back: its home (seen ids, ledger, pins) and the relay it talks to. */
const state = new WeakMap<BridgeHandle, { home: string; relayHttp: string }>()

async function spawn(home: string, relayHttp: string): Promise<BridgeHandle> {
  const claude = await new FakeClaude({
    command: 'bun',
    args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
    cwd: BRIDGE_DIR,
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relayHttp,
      TALOS_APP_BRIDGE: '1',
    },
  }).start()
  const handle: BridgeHandle = { claude, stop: () => claude.stop() }
  state.set(handle, { home, relayHttp })
  return handle
}

const harness: BridgeHarness = {
  async launch(relay, pinned) {
    const home = mkdtempSync(join(tmpdir(), 'talos-contract-'))
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
        devices: Object.entries(pinned).map(([id, jwk]) => ({ id, name: 'Contract device', pubkey_jwk: jwk })),
      }),
      { mode: 0o600 },
    )
    return spawn(home, relay.httpUrl)
  },
  async restart(handle) {
    const s = state.get(handle)
    if (!s) throw new Error('unknown bridge handle')
    await handle.stop()
    return spawn(s.home, s.relayHttp)
  },
}

defineBridgeContract('real bridge (bun, stdio)', harness)
