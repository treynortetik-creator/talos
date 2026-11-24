// What the owner is told when a linked agent's signing secret is missing from this home's key store (a link made before the per-home
// key store, a cleared store, a legacy item that is not this home's): one plain line, in `peer list` and in `doctor`.
// The way back is the normal one: `peer accept` refuses a name that is still set up here, so `peer remove` comes first; the other
// Talos's `peer link` refuses while it still has its record of this one and says to remove it, so that line comes from its own CLI.
import { PeerName, type SecretStore } from '@talos-app/protocol'
import { type BridgeEnv, paths } from '../config.ts'
import { parseConfig } from '../config-file.ts'
import type { Check } from '../doctor-checks.ts'
import { readJsonFile } from '../fsutil.ts'
import { openSecretStore } from '../secrets/store.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from './records.ts'
import { peerScopedStore } from './secret-store.ts'

/** The line for one linked agent. `name` must be a valid peer name (it is put into a command the owner may paste). */
export function relinkLine(name: string): string {
  const n = PeerName.parse(name)
  return `link to ${n} needs re-linking: run talos-app peer remove ${n} here, then ask ${n} for a new link code (talos-app peer link on that Talos) and run talos-app peer accept <code> --name ${n}.`
}

/** The `linked agents` row: every configured peer must have its secret in this home's key store. A read only; never prints a secret. */
export async function linkedAgentsCheck(
  env: BridgeEnv,
  opts: { secrets?: SecretStore } = {},
): Promise<Check | undefined> {
  const cfg = readJsonFile(paths(env.home).configJson)
  const parsed = cfg ? parseConfig(cfg) : undefined
  if (!parsed?.ok) return undefined // the config.json row already says so
  const peers = parsed.config.peers
  const name = 'linked agents'
  if (peers.length === 0) return { level: 'ok', name, detail: 'none' }
  const missing: string[] = []
  try {
    const raw = opts.secrets ?? (await openSecretStore({ home: env.home }))
    const store = peerScopedStore(raw, env.home)
    for (const p of peers) if (!(await store.get(PEER_SECRET_SERVICE, peerSecretAccount(p.name)))) missing.push(p.name)
  } catch (e) {
    return {
      level: 'warn',
      name,
      detail: `the key store could not be read (${(e as Error).message}), so it is not known whether the links to your other Talos installs work.`,
    }
  }
  if (missing.length === 0)
    return { level: 'ok', name, detail: `${peers.length} linked agent${peers.length === 1 ? '' : 's'}` }
  return { level: 'warn', name, detail: missing.map(relinkLine).join(' ') }
}
