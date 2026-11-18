// The public relay descriptor (BYOR): GET /.well-known/talos-relay. relay_id is random, minted once and kept in the database,
// so two starts over the same file agree and it says nothing about any key or person.
import { randomBytes } from 'node:crypto'
import { base32LowerEncode, PROTOCOL_VERSION, RelayDescriptor, type RelayDescriptorT } from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import type { RelayEnv } from '../env.ts'
import { VERSION } from '../version.ts'

/** The stored relay id, minted when missing. `insert or ignore` then select, so two racing starts still agree. */
export function ensureRelayId(db: Database.Database): string {
  const fresh = `r_${base32LowerEncode(randomBytes(15)).slice(0, 20)}`
  db.prepare('insert or ignore into core_relay_meta (id, relay_id, created_at) values (1, ?, ?)').run(
    fresh,
    new Date().toISOString(),
  )
  return (db.prepare('select relay_id from core_relay_meta where id = 1').get() as { relay_id: string }).relay_id
}

/** The descriptor, checked against the strict schema before it is sent. */
export function relayDescriptor(
  db: Database.Database,
  env: Pick<RelayEnv, 'RELAY_KIND' | 'MIN_APP_VERSION'>,
): RelayDescriptorT {
  return RelayDescriptor.parse({
    protocol: PROTOCOL_VERSION,
    relay_version: VERSION,
    relay_id: ensureRelayId(db),
    kind: env.RELAY_KIND,
    min_app: env.MIN_APP_VERSION,
  })
}
