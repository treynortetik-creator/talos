// What the owner already sent from this device that nothing has delivered yet: queued messages and voice notes. A session
// that merely ran out of time keeps them for the next sign-in; every other end (revoke, sign-out, sign-out everywhere, a
// reason nobody knows) removes them. These helpers read and discard that queue without needing a running client.
import { loadDeviceKey } from './deviceKey.ts'
import type { Storage } from './storage.ts'

/**
 * Only a session that ran out of time, one replaced by the owner signing in again, or a tab whose device key is no longer
 * the one this browser holds (`device_changed`: the queue in storage belongs to the newer key) keeps the queue. The relay
 * says why a session ended (`reason`); no reason, or one this build does not know, means wipe: a lost phone must never
 * keep its owner's words because a relay did not say.
 */
export const keepsUnsent = (reason: string | null | undefined): boolean =>
  reason === 'expired' || reason === 'signed_in_again' || reason === 'device_changed'

/**
 * A session that ended because this browser itself moved on: its device key was replaced (`device_changed`), or the owner
 * signed in again over it (`signed_in_again`). The stored chats, drafts and schedules now belong to the tab that did that.
 */
export const sharesStorage = (reason: string | null | undefined): boolean =>
  reason === 'device_changed' || reason === 'signed_in_again'

/** The device id a queued frame was signed for, or null when its bytes cannot be read. */
export function signedFor(bytes: string): string | null {
  try {
    const id = (JSON.parse(bytes) as { device_id?: unknown }).device_id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

type Queued = { kind?: string; bytes?: string }
type QueuedVoice = { deviceId?: string }

/**
 * How many waiting items this device's key can actually send (`sendable`), and how many belong to another key and will be
 * removed instead (`other`). With no key nothing can be sent.
 */
export async function countUnsent(storage: Storage): Promise<{ sendable: number; other: number }> {
  const key = await loadDeviceKey(storage)
  const rows = (await storage.all<Queued>('outbox')).filter((e) => e.kind !== 'voice.ask')
  const blobs = await storage.all<QueuedVoice>('blobs')
  let sendable = 0
  let other = 0
  for (const e of rows) {
    const who = typeof e.bytes === 'string' ? signedFor(e.bytes) : null
    if (key && (who === null || who === key.deviceId)) sendable++
    else other++
  }
  for (const v of blobs) {
    if (key && (v.deviceId === undefined || v.deviceId === key.deviceId)) sendable++
    else other++
  }
  return { sendable, other }
}

/**
 * Removes every queued message and voice note on this device, and the problem reports waiting to be sent (they hold a
 * screenshot the owner may not want left on a device that signed out). Throws if a store could not be emptied.
 * Problem reports are not counted by `countUnsent`: they are not something the owner wrote to be delivered.
 */
export async function discardUnsent(storage: Storage): Promise<void> {
  let failure: unknown
  for (const name of ['outbox', 'blobs', 'problems'] as const) {
    try {
      await storage.clear(name)
    } catch (e) {
      failure ??= e
    }
  }
  if (failure) throw failure
}
