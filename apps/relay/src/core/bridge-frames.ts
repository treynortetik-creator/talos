// Recalling queued durable frames for a module that must take them back (a revoked peer's `peer.message`). Plain functions over the
// core database, called through the Hub (`Bus.dropBridgeFrames`, `Bus.storedFrameIds`) so other modules never touch core tables.
import type Database from 'better-sqlite3'

/** Removes queued frames of one type (outbox rows and stored events). Runs inside the caller's transaction. */
export function dropBridgeFrames(db: Database.Database, frameIds: readonly string[], type: string): void {
  for (const id of frameIds) {
    db.prepare('delete from core_outbox where frame_id = ? and type = ?').run(id, type)
    db.prepare('delete from core_events where frame_id = ? and type = ?').run(id, type)
  }
}

/** Which of these frame ids still have a stored event (the rest were consumed or expired). */
export function storedFrameIds(db: Database.Database, frameIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const id of frameIds) if (db.prepare('select 1 from core_events where frame_id = ?').get(id)) out.add(id)
  return out
}
