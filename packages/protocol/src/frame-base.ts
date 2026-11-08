// The envelope every frame schema starts from, and the two builders the frame files use (frames.ts, frames-cards.ts).
import { z } from 'zod'
import { DeviceId, IsoTs, Ulid } from './ids.ts'

/** Added by the relay on the way through (sequence number and receive time). Never covered by a signature. */
export const RelayMeta = z.object({ seq: z.number().int(), received_at: IsoTs })

const envelope = {
  v: z.literal(1),
  id: Ulid,
  ts: IsoTs,
  relay: RelayMeta.optional(),
}

/** 86 base64url chars = 64 raw IEEE P1363 bytes. DER signatures are longer and rejected. */
export const Osig = z.string().regex(/^[A-Za-z0-9_-]{86}$/)

export function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ ...envelope, type: z.literal(type), ...shape })
}

/** Owner (signed) frames: strict, and no `.default()` anywhere inside (3.5 raw-JSON rule). */
export function ownerFrame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ ...envelope, type: z.literal(type), ...shape, device_id: DeviceId, osig: Osig })
}
