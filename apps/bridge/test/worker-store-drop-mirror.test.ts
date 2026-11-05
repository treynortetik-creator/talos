// R1-9: history.sqlite files written before the Telegram removal still hold mirror_pending / mirror_sent. Opening the
// worker store drops them (and only them), once or many times.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { WorkerStore } from '../src/worker/store.ts'

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)

describe('WorkerStore migration', () => {
  test('drops the old mirror tables, keeps the rest, and is safe to run again', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE mirror_pending (ord INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL, frame_id TEXT);
      CREATE TABLE mirror_sent (frame_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      INSERT INTO mirror_pending(text, created_at) VALUES ('old', 1);`)
    const store = new WorkerStore(db)
    expect(store.setCardRaiser('c1', 'trip', 1)).toBe(true)
    expect(tables(db)).not.toContain('mirror_pending')
    expect(tables(db)).not.toContain('mirror_sent')
    expect(tables(db)).toEqual(
      expect.arrayContaining(['worker_routes', 'inbound_claims', 'claim_settled', 'card_raisers']),
    )
    new WorkerStore(db) // a second open
    expect(store.cardRaiser('c1')).toBe('trip')
  })
  test('a fresh database never gets them', () => {
    const db = new Database(':memory:')
    new WorkerStore(db)
    expect(tables(db).filter((n) => n.startsWith('mirror_'))).toEqual([])
  })
})
