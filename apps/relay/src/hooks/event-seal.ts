// Inbox and webhook event text is stored sealed (AES-256-GCM with the relay's data key, bound to the event id), like the
// relay's other stored text. Rows from before sealing existed carry plain `event_json`; they stay readable and are sealed
// by `sealLegacyEvents`.
import type { NormalizedEventT } from '@talos-app/protocol'
import type { RelayServices } from '../services.ts'

/** Rows sealed per housekeeping tick (every 30 seconds). */
export const SEAL_BATCH = 500

const aad = (eventId: string) => `hooks_events:${eventId}`

export function sealEvent(services: RelayServices, event: NormalizedEventT): Buffer {
  return Buffer.from(services.crypto.encrypt(new TextEncoder().encode(JSON.stringify(event)), aad(event.id)))
}

type Sealed = { event_id: string; event_json: string; event_enc?: Buffer | null }

/** The event a row holds. Throws if a sealed row no longer opens (wrong key, tampering, a copy moved to another id). */
export function openEvent(services: RelayServices, row: Sealed): NormalizedEventT {
  if (row.event_enc && row.event_enc.length > 0)
    return JSON.parse(new TextDecoder().decode(services.crypto.decrypt(row.event_enc, aad(row.event_id))))
  return JSON.parse(row.event_json) as NormalizedEventT
}

/**
 * Seals rows that still hold plain text: rows from before this existed, or written by an older build that was still
 * running during a deploy. Idempotent and safe to repeat. `secure_delete` makes SQLite overwrite the old text in place
 * instead of leaving it in a freed page (copies already in the write-ahead log go when it is next checkpointed).
 */
export function sealLegacyEvents(services: RelayServices, batch = SEAL_BATCH): number {
  const { db } = services
  const rows = db
    .prepare("select event_id, event_json from hooks_events where event_enc is null and event_json != '' limit ?")
    .all(batch) as Array<{ event_id: string; event_json: string }>
  if (rows.length === 0) return 0
  db.pragma('secure_delete = ON')
  const set = db.prepare(
    "update hooks_events set event_enc = ?, event_json = '' where event_id = ? and event_enc is null and event_json = ?",
  )
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const sealed = Buffer.from(services.crypto.encrypt(new TextEncoder().encode(r.event_json), aad(r.event_id)))
      n += set.run(sealed, r.event_id, r.event_json).changes
    }
  })()
  return n
}
