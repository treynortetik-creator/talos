// The migration runner (spec 9, seam `apps/relay/migrations/README.md`). Seam: ownership stays with WP0.
// Plain SQL files `migrations/<module>/NNNN_<name>.sql`, applied in lexical order per module, modules in the order
// core, auth, hooks, voice; one transaction per file; applied files are recorded in `_migrations`.
// Every table a file creates must be prefixed with its module (`core_`, `auth_`, `hooks_`, `voice_`), checked inside
// the transaction so a violation rolls the file back.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

export const MODULE_ORDER = ['core', 'auth', 'hooks', 'voice'] as const

const FILE = /^\d{4}_[a-z0-9_]+\.sql$/

export type MigrateOptions = {
  /** Directory holding one folder per module. Default: `apps/relay/migrations`. */
  dir?: string
  /** Modules to run, in this order. Default: all four. */
  modules?: readonly string[]
  now?: () => string
}

export type AppliedMigration = { module: string; name: string }

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

function tables(db: Database.Database): Set<string> {
  const rows = db
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

/** Applies every pending migration. Idempotent. Throws (and leaves the failing file unapplied) on any error. */
export function migrate(db: Database.Database, opts: MigrateOptions = {}): AppliedMigration[] {
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR
  const now = opts.now ?? (() => new Date().toISOString())
  db.exec(
    'create table if not exists _migrations (module text not null, name text not null, applied_at text not null, primary key (module, name))',
  )
  const done = new Set(
    (db.prepare('select module, name from _migrations').all() as AppliedMigration[]).map(
      (r) => `${r.module}/${r.name}`,
    ),
  )
  const insert = db.prepare('insert into _migrations (module, name, applied_at) values (?, ?, ?)')
  const applied: AppliedMigration[] = []

  for (const module of opts.modules ?? MODULE_ORDER) {
    const modDir = join(dir, module)
    let files: string[]
    try {
      if (!statSync(modDir).isDirectory()) continue
      files = readdirSync(modDir).filter((f) => !f.startsWith('.') && f !== 'README.md')
    } catch {
      continue // a module without migrations is fine
    }
    for (const f of files) {
      if (!FILE.test(f)) throw new Error(`migrations/${module}/${f}: file names must look like 0001_name.sql`)
    }
    for (const file of files.sort()) {
      const name = file.replace(/\.sql$/, '')
      if (done.has(`${module}/${name}`)) continue
      const sql = readFileSync(join(modDir, file), 'utf8')
      db.transaction(() => {
        const before = tables(db)
        db.exec(sql)
        for (const t of tables(db)) {
          if (before.has(t) || t === '_migrations') continue
          if (!t.startsWith(`${module}_`))
            throw new Error(`migrations/${module}/${file}: table "${t}" must be prefixed "${module}_"`)
        }
        insert.run(module, name, now())
      })()
      applied.push({ module, name })
    }
  }
  return applied
}
