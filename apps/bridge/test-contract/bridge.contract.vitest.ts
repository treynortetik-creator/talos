import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BridgeHandle,
  type BridgeHarness,
  defineBridgeContract,
  FakeClaude,
  loadExampleConfig,
} from '@talos-app/testkit'
import { bridgeEnv, makeRoot, removeRoot } from './bridge-env.ts'

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What restart() needs to bring the same bridge back: its folder (home, seen ids, ledger, pins) and the relay it talks to. */
const state = new WeakMap<BridgeHandle, { root: string; home: string; relayHttp: string }>()

async function spawn(root: string, home: string, relayHttp: string): Promise<BridgeHandle> {
  const claude = await new FakeClaude({
    command: 'bun',
    args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
    cwd: BRIDGE_DIR,
    // the child's HOME, inbox, Claude folder and Chronos are all under `root`: nothing of the owner's real home is read
    env: bridgeEnv(home, relayHttp, root),
  }).start()
  const handle: BridgeHandle = {
    claude,
    // the last stop takes the folder with it; a restart stops only the process (restart below)
    stop: async () => {
      await claude.stop()
      removeRoot(root)
    },
    logText: () => {
      try {
        return readFileSync(join(home, 'bridge.log'), 'utf8')
      } catch {
        return ''
      }
    },
  }
  state.set(handle, { root, home, relayHttp })
  return handle
}

const harness: BridgeHarness = {
  async launch(relay, pinned) {
    const root = makeRoot()
    const home = join(root, 'home')
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
    return spawn(root, home, relay.httpUrl)
  },
  async restart(handle) {
    const s = state.get(handle)
    if (!s) throw new Error('unknown bridge handle')
    await handle.claude.stop() // the process only: the folder stays for the bridge that comes back
    return spawn(s.root, s.home, s.relayHttp)
  },
}

defineBridgeContract('real bridge (bun, stdio)', harness)
