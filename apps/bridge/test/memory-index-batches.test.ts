// The memory index is built in batches: many notes per commit, not one commit per note. Each commit of the bridge's SQLite files
// waits for a full sync to the disk (src/sqlite-sync.ts), so a build of thousands of notes one commit at a time would wait for
// thousands of syncs. A note's row and its text still go in the same commit, and a build that fails midway keeps the batches
// it finished and none of the one it was in.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { memoryIndexPath } from '../src/memory/config.ts'
import { MEMORY_INDEX_BATCH, MemoryBrowser } from '../src/memory/service.ts'
import { tempHome } from './helpers.ts'

function homeWithNotes(n: number): string {
  const home = tempHome()
  const agent = join(home, 'agent')
  for (let i = 0; i < n; i++) {
    const d = join(agent, 'notes', `d${i % 7}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `n${i}.md`), `# Note ${i}\nzzbatchword ${i}\n`)
  }
  writeFileSync(
    join(home, 'memory.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      agent_dir: agent,
      max_file_kb: 512,
      roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*'], exclude: [] }],
    }),
    { mode: 0o600 },
  )
  return home
}

/** What another connection sees committed: rows in idx_files, rows in mem_fts, and rows of either without the other. */
function committed(home: string) {
  const db = new Database(memoryIndexPath(home), { readonly: true })
  try {
    const n = (sql: string) => (db.query(sql).get() as { n: number }).n
    return {
      files: n('SELECT count(*) AS n FROM idx_files'),
      fts: n('SELECT count(*) AS n FROM mem_fts'),
      orphans:
        n('SELECT count(*) AS n FROM idx_files WHERE id NOT IN (SELECT rowid FROM mem_fts)') +
        n('SELECT count(*) AS n FROM mem_fts WHERE rowid NOT IN (SELECT id FROM idx_files)'),
    }
  } catch {
    return { files: 0, fts: 0, orphans: 0 } // the tables are not even visible yet
  } finally {
    db.close()
  }
}

describe('memory index builds commit in batches', () => {
  test('mid-batch, another connection sees none of the batch; at the end it sees every note, each with its text', async () => {
    const total = MEMORY_INDEX_BATCH * 2 + 17
    const home = homeWithNotes(total)
    const seen: Array<{ n: number; files: number }> = []
    const svc = new MemoryBrowser({
      home,
      clock: fakeClock(),
      log: nullLogger,
      switchOn: () => true,
      watch: false,
      afterNoteIndexed: (n) => {
        if (n === 50 || n === MEMORY_INDEX_BATCH + 50) seen.push({ n, files: committed(home).files })
      },
    })
    try {
      await svc.idle()
      // one commit per note would show 49 or 50 here; a batch shows what the previous batches committed and nothing more
      expect(seen).toEqual([
        { n: 50, files: 0 },
        { n: MEMORY_INDEX_BATCH + 50, files: MEMORY_INDEX_BATCH },
      ])
      expect(committed(home)).toEqual({ files: total, fts: total, orphans: 0 })
    } finally {
      svc.stop()
    }
  })

  test('a build that fails midway keeps the finished batches whole and none of the failing one', async () => {
    const home = homeWithNotes(MEMORY_INDEX_BATCH * 2)
    const svc = new MemoryBrowser({
      home,
      clock: fakeClock(),
      log: nullLogger,
      switchOn: () => true,
      watch: false,
      afterNoteIndexed: (n) => {
        if (n === MEMORY_INDEX_BATCH + 10) throw new Error('disk full (test)')
      },
    })
    try {
      await svc.idle()
      expect(committed(home)).toEqual({ files: MEMORY_INDEX_BATCH, fts: MEMORY_INDEX_BATCH, orphans: 0 })
      // and the connection is usable afterwards: no transaction left open
      const db = (svc as unknown as { db: Database }).db
      expect(db.inTransaction).toBe(false)
    } finally {
      svc.stop()
    }
  })
})
