// Keychain-wide stores (the macOS Keychain, the Secret Service) key an item by (service, account) for the whole computer, so two
// Talos homes on one account would share and overwrite each other's secrets. This wraps such a store so every item is kept under
// `<service>.<h>`, h = the first 16 hex of SHA-256 of the real path of the Talos home. The per-home file store is left as it is.
//
// An item written before this (service without the suffix) is moved into the home's own name on the first read that misses, but only
// by the account's default home (~/.config/talos/app of the password-database home, compared by real path). Any other home never
// reads, moves or deletes a legacy item, even when no default home exists yet: it is the default home's, and a home made later
// (TALOS_APP_HOME=/tmp/x) must not take it. The move writes the new item only if it is still missing just before the write, reads
// it back, then deletes the legacy one: a newer secret is never overwritten, and a delete that fails loses nothing.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { accountHome } from '../talos.ts'
import { SecretError } from './store.ts'

/** The home's real path. A home that is not there cannot be named: refused, never hashed raw. */
function realHome(home: string): string {
  try {
    return realpathSync(home)
  } catch {
    throw new SecretError('unavailable', 'the Talos home folder is missing, so its secrets cannot be named')
  }
}

const suffixOfReal = (real: string): string => createHash('sha256').update(real).digest('hex').slice(0, 16)

/** The first 16 hex of sha256 of the home's real path. */
export function homeScopeSuffix(home: string): string {
  return suffixOfReal(realHome(home))
}

/** The service name a keychain-wide store keeps this home's item under. */
export const homeScopedService = (service: string, home: string): string => `${service}.${homeScopeSuffix(home)}`

/** Is this real path the account's default home? Only that home may read, move or delete a legacy (un-namespaced) item. */
function isDefaultReal(real: string, account: string | null): boolean {
  if (account === null) return false
  try {
    return realpathSync(join(account, '.config', 'talos', 'app')) === real
  } catch {
    return false // no default home folder
  }
}

/** Is this the account's default home? */
export function mayTakeLegacy(home: string, account: string | null = accountHome()): boolean {
  let real: string
  try {
    real = realpathSync(home)
  } catch {
    return false // this home is gone
  }
  return isDefaultReal(real, account)
}

export type HomeScopeOptions = {
  /** What kind of item this is, for the one log line of a move ("peer"). */
  kind: string
  /** One line when a legacy item is moved: the kind and the name only, never the secret. */
  log?: (line: string) => void
  /** The account's home (tests); default the real one. */
  account?: string | null
}

export function homeScopedStore(store: SecretStore, home: string, opts: HomeScopeOptions): SecretStore {
  if (store.backend === 'file_0600') return store
  // The home's real path is resolved ONCE per call, and that one value names the item and decides the default-home check: a home
  // that is a symlink swapped between two lookups (to the default folder, during a store read) can never take a legacy item into
  // another home's name.
  const resolveCall = (service: string) => {
    const real = realHome(home)
    return {
      ns: `${service}.${suffixOfReal(real)}`,
      takes: isDefaultReal(real, opts.account === undefined ? accountHome() : opts.account),
    }
  }
  return {
    backend: store.backend,
    strength: store.strength,
    async get(service, account) {
      const { ns, takes } = resolveCall(service)
      const have = await store.get(ns, account)
      if (have !== undefined) return have
      if (!takes) return undefined
      const legacy = await store.get(service, account)
      if (legacy === undefined) return undefined
      // a secret that appeared since the first read is newer: it stays, and the legacy item is left alone
      const newer = await store.get(ns, account)
      if (newer !== undefined) return newer
      await store.set(ns, account, legacy)
      if ((await store.get(ns, account)) !== legacy)
        throw new SecretError('unavailable', 'the moved secret could not be read back')
      try {
        await store.delete(service, account)
      } catch {
        // kept in both places: nothing is lost, and the next read finds the new one
      }
      opts.log?.(
        `moved the ${opts.kind} secret "${account.replace(/^[a-z]+:/, '')}" to this Talos home's own key store item`,
      )
      return legacy
    },
    async set(service, account, value) {
      await store.set(resolveCall(service).ns, account, value)
    },
    async delete(service, account) {
      const { ns, takes } = resolveCall(service)
      await store.delete(ns, account)
      // a legacy copy this home could take over would come back on the next read
      if (takes) await store.delete(service, account)
    },
  }
}
