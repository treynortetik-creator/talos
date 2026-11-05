// SQLite (WAL) for the relay. One file, `relay.sqlite`, in DATA_DIR; media lives next to it in `media/`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { type MigrateOptions, migrate } from '../migrate.ts'

export function openDatabase(dataDir: string, opts: { migrate?: MigrateOptions } = {}): Database.Database {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'media'), { recursive: true })
  const db = new Database(join(dataDir, 'relay.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db, opts.migrate ?? {})
  return db
}
