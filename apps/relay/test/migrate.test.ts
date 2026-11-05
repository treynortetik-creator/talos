import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MODULE_ORDER, migrate } from '../src/migrate.ts'

function dirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'))
  for (const [p, sql] of Object.entries(files)) {
    mkdirSync(join(dir, p.split('/')[0] as string), { recursive: true })
    writeFileSync(join(dir, p), sql)
  }
  return dir
}
const tableNames = (db: Database.Database) =>
  (
    db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)

describe('migration runner', () => {
  it('runs modules in the order core, auth, hooks, voice and files in lexical order', () => {
    const dir = dirWith({
      'voice/0001_init.sql': 'create table voice_calls (id integer);',
      'hooks/0002_more.sql': 'alter table hooks_dedup add column seen_at text;',
      'hooks/0001_init.sql': 'create table hooks_dedup (key text primary key);',
      'auth/0001_init.sql': 'create table auth_users (id integer);',
      'core/0010_late.sql': 'alter table core_messages add column x text;',
      'core/0002_msgs.sql': 'create table core_messages (id integer);',
    })
    const db = new Database(':memory:')
    const applied = migrate(db, { dir })
    expect(applied.map((a) => `${a.module}/${a.name}`)).toEqual([
      'core/0002_msgs',
      'core/0010_late',
      'auth/0001_init',
      'hooks/0001_init',
      'hooks/0002_more',
      'voice/0001_init',
    ])
    expect(MODULE_ORDER).toEqual(['core', 'auth', 'hooks', 'voice'])
  })

  it('records applied files in _migrations and is idempotent', () => {
    const dir = dirWith({ 'core/0001_init.sql': 'create table core_a (id integer);' })
    const db = new Database(':memory:')
    migrate(db, { dir, now: () => '2026-10-28T00:00:00.000Z' })
    expect(db.prepare('select module, name, applied_at from _migrations').all()).toEqual([
      { module: 'core', name: '0001_init', applied_at: '2026-10-28T00:00:00.000Z' },
    ])
    expect(migrate(db, { dir })).toEqual([])
    expect(tableNames(db)).toEqual(['_migrations', 'core_a'])
  })

  it('applies only new files on a later run', () => {
    const dir = dirWith({ 'core/0001_init.sql': 'create table core_a (id integer);' })
    const db = new Database(':memory:')
    migrate(db, { dir })
    writeFileSync(join(dir, 'core', '0002_more.sql'), 'create table core_b (id integer);')
    expect(migrate(db, { dir }).map((a) => a.name)).toEqual(['0002_more'])
  })

  it('one transaction per file: a failing file leaves nothing behind, earlier files stay applied', () => {
    const dir = dirWith({
      'core/0001_ok.sql': 'create table core_a (id integer);',
      'core/0002_bad.sql': 'create table core_b (id integer); insert into nope values (1);',
    })
    const db = new Database(':memory:')
    expect(() => migrate(db, { dir })).toThrow(/nope/)
    expect(tableNames(db)).toEqual(['_migrations', 'core_a'])
    expect(db.prepare('select name from _migrations').all()).toEqual([{ name: '0001_ok' }])
  })

  it('refuses a table without its module prefix and rolls the file back', () => {
    const dir = dirWith({ 'hooks/0001_init.sql': 'create table auth_sneaky (id integer);' })
    const db = new Database(':memory:')
    expect(() => migrate(db, { dir })).toThrow(/must be prefixed "hooks_"/)
    expect(tableNames(db)).toEqual(['_migrations'])
  })

  it('refuses badly named files', () => {
    const dir = dirWith({ 'core/init.sql': 'select 1;' })
    expect(() => migrate(new Database(':memory:'), { dir })).toThrow(/0001_name\.sql/)
  })

  it('can run a subset of modules and tolerates modules with no directory', () => {
    const dir = dirWith({
      'core/0001_init.sql': 'create table core_a (id integer);',
      'auth/0001_init.sql': 'create table auth_a (id integer);',
    })
    const db = new Database(':memory:')
    expect(migrate(db, { dir, modules: ['core', 'voice'] }).map((a) => a.module)).toEqual(['core'])
  })
})
