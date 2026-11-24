// The key store every peer code path uses: the home-scoped one (secrets/home-scope.ts), plus the rule for a home that is not the
// account's default. Such a home may COPY a legacy (un-namespaced) peer secret into its own name when its config has a peer of
// that name; the legacy item is never deleted or changed by that (only the default home moves it). A copy cannot be proven to be
// this home's own, so it is marked (`peer-copied.json`: name and times, never the secret) and a send that the other side rejects
// says "needs re-linking" once (service.ts). A new secret or a removal for that name drops the mark, and so does a send that lands.
// Everything here names the home by the ONE real path of the call (the same one that names the item), never by the raw path.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { paths } from '../config.ts'
import { parseConfig } from '../config-file.ts'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'
import { homeScopedStore } from '../secrets/home-scope.ts'
import { PEER_SECRET_SERVICE } from './records.ts'

export const PEER_COPIED_FILE = 'peer-copied.json'
type Copied = { name: string; copied_at: number; rejected_at?: number }

const file = (real: string): string => join(real, PEER_COPIED_FILE)

function readCopied(real: string): Copied[] {
  const raw = readJsonFile<{ v?: unknown; copied?: unknown }>(file(real))
  if (raw?.v !== 1 || !Array.isArray(raw.copied)) return []
  return raw.copied.filter(
    (c): c is Copied =>
      typeof c === 'object' && c !== null && typeof c.name === 'string' && Number.isFinite(c.copied_at),
  )
}
const writeCopied = (real: string, copied: Copied[]): void => writeJsonAtomic(file(real), { v: 1, copied })

const realOf = (home: string): string | undefined => {
  try {
    return realpathSync(home)
  } catch {
    return undefined
  }
}

/** `copied`: this home's secret for `name` came from a legacy item. `rejected`: and the other side has refused its signature. */
export function peerCopyState(home: string, name: string): 'none' | 'copied' | 'rejected' {
  const real = realOf(home)
  const c = real ? readCopied(real).find((x) => x.name === name) : undefined
  return !c ? 'none' : c.rejected_at !== undefined ? 'rejected' : 'copied'
}

export const peerSecretWasCopied = (home: string, name: string): boolean => peerCopyState(home, name) !== 'none'

/** Records that the other side refused a copied secret. True the first time (say it), false when it was already known. */
export function markPeerRejected(home: string, name: string, now: number): boolean {
  const real = realOf(home)
  if (!real) return false
  const all = readCopied(real)
  const c = all.find((x) => x.name === name)
  if (!c || c.rejected_at !== undefined) return false
  writeCopied(
    real,
    all.map((x) => (x === c ? { ...x, rejected_at: now } : x)),
  )
  return true
}

/** Drops the mark of `name` (a new link, a removal, a send that landed). Best effort: a failure is reported by the caller's log. */
export function clearPeerCopied(home: string, name: string): void {
  const real = realOf(home)
  if (!real) return
  const all = readCopied(real)
  const rest = all.filter((x) => x.name !== name)
  if (rest.length !== all.length) writeCopied(real, rest)
}

const nameOf = (account: string): string => account.replace(/^[a-z]+:/, '')

/** Does the config.json of the home at `real` have a peer of that name? */
function hasConfigPeer(real: string, name: string): boolean {
  const cfg = readJsonFile(paths(real).configJson)
  const parsed = cfg ? parseConfig(cfg) : undefined
  return parsed?.ok === true && parsed.config.peers.some((p) => p.name === name)
}

export function peerScopedStore(
  store: SecretStore,
  home: string,
  opts: { log?: (line: string) => void; account?: string | null } = {},
): SecretStore {
  const scoped = homeScopedStore(store, home, {
    kind: 'peer',
    log: opts.log,
    account: opts.account,
    copyLegacyFor: (service, account, real) =>
      service === PEER_SECRET_SERVICE && account.startsWith('peer:') && hasConfigPeer(real, nameOf(account)),
    onCopy: (_service, account, real) => {
      const name = nameOf(account)
      writeCopied(real, [...readCopied(real).filter((c) => c.name !== name), { name, copied_at: Date.now() }])
    },
  })
  if (scoped === store) return store
  // the mark is best effort once the secret is stored: a failure to drop it is one log line, never a failed link or removal
  const drop = (service: string, account: string): void => {
    if (service !== PEER_SECRET_SERVICE) return
    try {
      clearPeerCopied(home, nameOf(account))
    } catch {
      opts.log?.(`could not update the copy mark of the peer "${nameOf(account)}"`)
    }
  }
  return {
    ...scoped,
    async set(service, account, value) {
      await scoped.set(service, account, value)
      drop(service, account)
    },
    async delete(service, account) {
      await scoped.delete(service, account)
      drop(service, account)
    },
  }
}
