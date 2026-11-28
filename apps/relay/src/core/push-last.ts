// "Why was that push plain?": how the latest message push to each phone left (core_push_last, one row per phone, latest only).
// Free functions over the store's database, so the store itself stays under its size limit. Read by GET /api/push/apns.
// Refused pushes (Apple said no) and pushes that hit the send deadline are not recorded: nothing is known about how they left.
import { createHash } from 'node:crypto'
import type { RelayPlainReasonT } from '@talos-app/protocol'
import type Database from 'better-sqlite3'

/** Why there was no seal for a phone (decided on the relay, before the send). */
export type SealWhy = 'no_grant' | 'grant_expired' | 'grant_bad' | 'seal_failed'
/** Why the sender put the plain body on the wire although a seal was offered. */
export type SenderWhy = 'too_big' | 'grant_changed' | 'seal_failed'
// Both lists together are the relay codes the protocol has words for; the test checks they are equal.
export type PushLastRow = { rich: boolean; reason?: RelayPlainReasonT; id?: string; at: number }

/**
 * Records how a push to this phone left. `at` is when that push STARTED, and an older start never replaces a newer one, so a
 * slow push that finishes last cannot overwrite the one sent after it.
 */
export function putPushLast(
  db: Database.Database,
  at: number,
  deviceId: string,
  last: { rich: boolean; reason?: RelayPlainReasonT; id?: string },
) {
  db.prepare(
    `insert into core_push_last (device_id, rich, reason, seal_id, at) values (?, ?, ?, ?, ?)
     on conflict(device_id) do update set rich = excluded.rich, reason = excluded.reason, seal_id = excluded.seal_id,
       at = excluded.at where excluded.at >= core_push_last.at`,
  ).run(deviceId, last.rich ? 1 : 0, last.reason ?? null, last.id ?? null, at)
}

export function pushLast(db: Database.Database, deviceId: string): PushLastRow | null {
  const r = db.prepare('select rich, reason, seal_id, at from core_push_last where device_id = ?').get(deviceId) as
    | { rich: number; reason: RelayPlainReasonT | null; seal_id: string | null; at: number }
    | undefined
  return r
    ? {
        rich: r.rich === 1,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.seal_id ? { id: r.seal_id } : {}),
        at: r.at,
      }
    : null
}

/** The phone is gone (turned off, Apple's 410, signed out, revoked): its readout goes too. */
export function dropPushLast(db: Database.Database, deviceId: string) {
  db.prepare('delete from core_push_last where device_id = ?').run(deviceId)
}

/** A registration with a token other than the one held (iOS rotated it) ends the old readout; the same token keeps it. */
export function dropPushLastIfTokenChanged(db: Database.Database, deviceId: string, token: string) {
  const hash = createHash('sha256').update(token).digest('hex')
  db.prepare(
    'delete from core_push_last where device_id = ? and not exists (select 1 from core_push_devices where device_id = ? and token_hash = ?)',
  ).run(deviceId, deviceId, hash)
}

/** True when the phone has a grant row that has run out (so "no text" is the key's age, not a choice). */
export function nativeGrantExpired(db: Database.Database, now: number, deviceId: string): boolean {
  return Boolean(db.prepare('select 1 from core_native_grants where device_id = ? and exp <= ?').get(deviceId, now))
}
