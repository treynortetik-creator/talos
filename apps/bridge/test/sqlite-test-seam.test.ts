// The product names its own syncing for the bridge's SQLite files (src/sqlite-sync.ts): synchronous = FULL, fullfsync and
// checkpoint_fullfsync ON, the same literal value on every platform (Bun's bundled SQLite on Linux and the system SQLite Bun uses
// on macOS have different defaults, so a default is never trusted). Only the bridge's test run then lowers synchronous to NORMAL
// (src/sqlite-test-seam.ts), and only through the seam.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { openHistory } from '../src/history-store.ts'
import { nullLogger } from '../src/log.ts'
import { MemoryBrowser } from '../src/memory/service.ts'
import { applyDurableSync } from '../src/sqlite-sync.ts'
import { SQLITE_TEST } from '../src/sqlite-test-seam.ts'
import { tempHome } from './helpers.ts'

const saved = SQLITE_TEST.synchronous
afterEach(() => {
  SQLITE_TEST.synchronous = saved
})
const pragma = (db: Database, name: string) => (db.query(`PRAGMA ${name}`).get() as Record<string, number>)[name]
const syncOf = (db: Database) => ({
  synchronous: pragma(db, 'synchronous'),
  fullfsync: pragma(db, 'fullfsync'),
  checkpoint_fullfsync: pragma(db, 'checkpoint_fullfsync'),
})
/** The product's value, as SQLite reports it back: FULL is 2. */
const PRODUCT = { synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1 }

function historySync() {
  const s = openHistory(join(tempHome(), 'history.sqlite'))
  try {
    return syncOf(s.db)
  } finally {
    s.close()
  }
}
function memoryIndexSync() {
  const home = tempHome()
  const svc = new MemoryBrowser({ home, clock: fakeClock(), log: nullLogger, switchOn: () => true, watch: false })
  try {
    const db = (svc as unknown as { db: Database | null }).db
    if (!db) throw new Error('the memory index did not open')
    return syncOf(db)
  } finally {
    svc.stop()
  }
}

describe('the bridge’s own SQLite files: syncing as the product runs, and in this test run', () => {
  it('as the product runs (the seam unset): FULL, fullfsync and checkpoint_fullfsync on, for both files, on every platform', () => {
    SQLITE_TEST.synchronous = null
    expect(historySync()).toEqual(PRODUCT)
    expect(memoryIndexSync()).toEqual(PRODUCT)
  })
  it('the shared helper sets that value on any connection, whatever the platform default was', () => {
    const db = new Database(join(tempHome(), 'any.sqlite'), { create: true })
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = OFF')
      db.exec('PRAGMA fullfsync = OFF')
      db.exec('PRAGMA checkpoint_fullfsync = OFF')
      applyDurableSync(db)
      expect(syncOf(db)).toEqual(PRODUCT)
    } finally {
      db.close()
    }
  })
  // Only under this run's preload (test/preload.ts); a run without it (bun test --preload none, or another runner) has nothing to
  // check here, and says so instead of failing on a setting it never made.
  it.skipIf(saved !== 'NORMAL')(
    'in this test run: NORMAL (1) for both, set by the preload after the product value',
    () => {
      expect(historySync().synchronous).toBe(1)
      expect(memoryIndexSync().synchronous).toBe(1)
    },
  )
})

/**
 * Every SQLite open in one source file, with what it is: `read-only`, `in-memory`, `durable` (the database it opened is passed
 * to applyDurableSync right after), or `MISSING applyDurableSync`. The file is transpiled first, which drops every comment, so
 * an option or a call written only in a comment counts for nothing. An open is `new X(` or `X.open(` for every name the file
 * gives bun:sqlite's Database (aliased imports and namespace imports included), in any form: assigned, returned, passed on.
 */
function sqliteOpens(file: string, source: string): string[] {
  const code = new Bun.Transpiler({ loader: 'ts', trimUnusedImports: false }).transformSync(source)
  const names = new Set<string>()
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']bun:sqlite["']/g))
    for (const part of (m[1] as string).split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (orig === 'Database') names.add(alias ?? orig)
    }
  for (const m of code.matchAll(/import\s*\*\s*as\s+([\w$]+)\s*from\s*["']bun:sqlite["']/g))
    names.add(`${m[1]}.Database`)
  if (!names.size) return []
  const esc = [...names].map((n) => n.replace(/[.$]/g, (c) => `\\${c}`)).join('|')
  const out: string[] = []
  const all = [...code.matchAll(new RegExp(`(?:\\bnew\\s+(?:${esc})|(?<![\\w$.])(?:${esc})\\.open)\\s*\\(`, 'g'))]
  for (const [k, m] of all.entries()) {
    // the arguments, up to the matching parenthesis
    let depth = 0
    let end = m.index + m[0].length - 1
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')' && --depth === 0) break
    }
    const args = code.slice(m.index + m[0].length, end)
    if (/\breadonly\s*:\s*true\b/.test(args)) out.push(`${file} read-only`)
    else if (/^\s*["']:memory:["']/.test(args)) out.push(`${file} in-memory`)
    else {
      const before = /(?:\b(?:const|let|var)\s+)?([\w$.]+)\s*=\s*$/.exec(
        code.slice(Math.max(0, m.index - 200), m.index),
      )
      const name = before?.[1]
      // the call must come before the next open, so one open's call cannot vouch for another
      const after = code.slice(end + 1, Math.min(end + 400, all[k + 1]?.index ?? code.length))
      out.push(
        name && after.includes(`applyDurableSync(${name})`) ? `${file} durable` : `${file} MISSING applyDurableSync`,
      )
    }
  }
  return out
}

describe('every SQLite open under src/ that can write uses the product value', () => {
  // A read-only or in-memory open writes nothing to disk; every other open must call applyDurableSync on the database it just
  // opened. The list is exact, so a new open has to be added here, with its decision, before it can land.
  it('read-only and in-memory opens are the only ones without it', () => {
    const src = join(import.meta.dir, '..', 'src')
    const opens: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n))
          opens.push(...sqliteOpens(relative(src, p).split(sep).join('/'), readFileSync(p, 'utf8')))
      }
    }
    walk(src)
    expect(opens.sort()).toEqual([
      'doctor-checks.ts in-memory',
      'facts-parts.ts read-only',
      'history-recover.ts durable',
      'history-recover.ts durable',
      'history-recover.ts read-only',
      'history-store.ts durable',
      'memory/service.ts durable',
    ])
  })
  it('the audit sees every form of open, and a comment counts for nothing', () => {
    const head =
      "import { Database as Db } from 'bun:sqlite'\nimport * as sq from 'bun:sqlite'\nimport { Database } from 'bun:sqlite'\n"
    const one = (body: string) => sqliteOpens('x.ts', head + body)
    expect(one('function f(p) {\n  return new Database(p)\n}')).toEqual(['x.ts MISSING applyDurableSync'])
    expect(one('const db = Database.open(p)\napplyDurableSync(db)')).toEqual(['x.ts durable'])
    expect(one('const db = Database.open(p)')).toEqual(['x.ts MISSING applyDurableSync'])
    expect(one('const db = new Db(p)')).toEqual(['x.ts MISSING applyDurableSync'])
    expect(one('const db = new Database(p)\nconst db2 = new Database(q)\napplyDurableSync(db)')).toEqual([
      'x.ts MISSING applyDurableSync',
      'x.ts MISSING applyDurableSync',
    ])
    expect(one('const db = new sq.Database(p)')).toEqual(['x.ts MISSING applyDurableSync'])
    expect(one('use(\n  new Database(\n    p,\n    { create: true },\n  ),\n)')).toEqual([
      'x.ts MISSING applyDurableSync',
    ])
    expect(one('const db = new Database(\n  p,\n  { readonly: true },\n)')).toEqual(['x.ts read-only'])
    // in comments only: neither the option nor the call counts
    expect(one('const db = new Database(p /* readonly: true */)\n// applyDurableSync(db)')).toEqual([
      'x.ts MISSING applyDurableSync',
    ])
    expect(one('// const db = new Database(p)\n/* Database.open(q) */')).toEqual([])
  })
  it('the two seam openers set the product value before the seam, so a test run ends at NORMAL', () => {
    const src = join(import.meta.dir, '..', 'src')
    for (const f of ['history-store.ts', 'memory/service.ts']) {
      const text = readFileSync(join(src, f), 'utf8')
      const durable = text.search(/^\s*applyDurableSync\((this\.)?db\)/m)
      const seam = text.search(/^\s*applySqliteTestSeam\((this\.)?db\)/m)
      expect(durable).toBeGreaterThan(-1)
      expect(seam).toBeGreaterThan(durable)
    }
  })
})

describe('who may touch the seam', () => {
  it('under src/, only the seam itself and the two openers (history-store.ts, memory/service.ts) name it', () => {
    const src = join(import.meta.dir, '..', 'src')
    const named: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && /SQLITE_TEST|applySqliteTestSeam|sqlite-test-seam/.test(readFileSync(p, 'utf8')))
          named.push(relative(src, p).split(sep).join('/'))
      }
    }
    walk(src)
    expect(named.sort()).toEqual(['history-store.ts', 'memory/service.ts', 'sqlite-test-seam.ts'])
    // and each of the two openers CALLS the seam on the database it opens, and never names the setting itself (assigned nowhere
    // but the test preload)
    for (const f of ['history-store.ts', 'memory/service.ts']) {
      const text = readFileSync(join(src, f), 'utf8')
      expect(text).not.toMatch(/SQLITE_TEST\b/)
      expect(text).toMatch(/^\s*applySqliteTestSeam\((this\.)?db\)/m)
    }
  })
})
