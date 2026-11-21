// The `relay connect` row of `talos-app doctor`: only when this install is connected to update its relay.
import type { SecretStore } from '@talos-app/protocol'
import type { BridgeEnv } from '../config.ts'
import { openSecretStore } from '../secrets/store.ts'
import { RAILWAY_ACCOUNT, RAILWAY_SERVICE, railwayStore, readConnection } from './files.ts'

/** `behind` rows say which command updates the relay now; this says whether it is `update` (connected) or `connect` (not yet). */
export const isConnected = (home: string): boolean => readConnection(home) !== undefined

export async function relayConnectRow(
  env: BridgeEnv,
  secrets?: SecretStore,
): Promise<{ level: 'ok' | 'warn'; detail: string } | undefined> {
  const c = readConnection(env.home)?.file
  if (!c) return undefined
  const auto = `auto-update ${c.auto_update ? 'on' : 'off'}`
  if (c.via === 'app') return { level: 'ok', detail: `connected (set up by the Talos app), ${auto}` }
  try {
    const store = railwayStore(secrets ?? (await openSecretStore({ home: env.home })), env.home)
    if (!(await store.get(RAILWAY_SERVICE, RAILWAY_ACCOUNT)))
      return {
        level: 'warn',
        detail: "the Railway token is missing from this computer's key store: run talos-app relay connect again",
      }
  } catch (e) {
    return {
      level: 'warn',
      detail: `the key store can't be read, so the Railway token can't be checked (${(e as Error).message})`,
    }
  }
  return { level: 'ok', detail: `connected (${c.kind ?? 'project'} token), ${auto}` }
}
