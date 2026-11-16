// Review round on the folder-flip fix (PR for fix/memory-dir-flip). Every test forces the swap INSIDE the race window
// through the safe-open seam, so none of it depends on load or timing. Each one fails if its fix is taken out.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { fakeClock, mkFrame, waitScale } from '@talos-app/testkit'
import { normaliseToolResponse } from '../src/apps/captures.ts'
import { nullLogger } from '../src/log.ts'
import { MediaError, MediaStore } from '../src/media.ts'
import { memoryIndexPath } from '../src/memory/config.ts'
import { MemoryScope } from '../src/memory/scope.ts'
import { MemoryBrowser } from '../src/memory/service.ts'
import { openResolvedNoFollow, openSeam, strayLog } from '../src/safe-open.ts'
import { FileIndexer } from '../src/search/files.ts'

const SECRET = 'zzSECRETzz'
const cleanup: string[] = []
afterEach(() => {
  openSeam.beforeOpen = undefined
  openSeam.afterOpen = undefined
  openSeam.betweenRechecks = undefined
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})
const mk = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-sh-')))
  cleanup.push(d)
  return d
}
const put = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}
const cfg = (agent: string, path = 'notes') =>
  ({
    version: 1,
    enabled: true,
    agent_dir: agent,
    roots: [{ id: 'notes', label: 'Notes', path, include: ['**/*.md'], exclude: [] }],
    max_file_kb: 512,
  }) as never

describe('agent uploads (reply/attach) read through the checked handle', () => {
  function setup() {
    const base = mk()
    const home = join(base, 'home')
    const media = join(home, 'media')
    mkdirSync(media, { recursive: true })
    put(join(home, 'keys.txt'), `${SECRET} device key\n`)
    put(join(base, 'work', 'sub', 'keys.txt'), 'harmless\n')
    const sent: string[] = []
    const http = { putMedia: async (_i: string, b: Uint8Array) => void sent.push(Buffer.from(b).toString()) }
    const store = new MediaStore({ home, media } as never, http as never)
    return { base, home, store, sent }
  }

  test('control: a protected file is refused by path', async () => {
    const { home, store } = setup()
    await expect(store.upload(join(home, 'keys.txt'))).rejects.toThrow(/protected/)
  })

  test('a folder swapped for a link to the bridge home inside the window: nothing leaves the Mac', async () => {
    const { base, home, store, sent } = setup()
    let hit = 0
    openSeam.beforeOpen = () => {
      hit++
      renameSync(join(base, 'work', 'sub'), join(base, 'work', '.real'))
      symlinkSync(home, join(base, 'work', 'sub'))
    }
    await expect(store.upload(join(base, 'work', 'sub', 'keys.txt'))).rejects.toThrow(MediaError)
    expect(hit).toBe(1) // the read really went through the safe open
    expect(sent).toEqual([])
  })

  test('no swap: a normal file still uploads', async () => {
    const { base, store, sent } = setup()
    const ref = await store.upload(join(base, 'work', 'sub', 'keys.txt'))
    expect(ref.size).toBe(9)
    expect(sent).toEqual(['harmless\n'])
  })
})

describe('the oversize tool-result reader', () => {
  test('the result file swapped for a link inside the window: the outside text is not returned', () => {
    const base = mk()
    const tdir = join(base, 'proj')
    const sid = 'sess1'
    const tr = join(tdir, sid, 'tool-results')
    mkdirSync(tr, { recursive: true })
    const f = join(tr, 'mcp-srv-tool.txt')
    writeFileSync(f, '{"ok":"inside"}')
    put(join(base, 'outside.txt'), `{"leak":"${SECRET}"}`)
    const ctx = {
      server: 'srv',
      tool: 'tool',
      transcript_path: join(tdir, 't.jsonl'),
      session_id: sid,
      nowMs: Date.now(),
    }
    const resp = `Error: result (15 characters) exceeds maximum allowed tokens. Output has been saved to ${f}.`
    let hit = 0
    openSeam.beforeOpen = () => {
      hit++
      rmSync(f)
      symlinkSync(join(base, 'outside.txt'), f)
    }
    const r = normaliseToolResponse(resp, ctx)
    expect(hit).toBe(1)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
})

describe('the safe open asks where the handle really is', () => {
  test('a REAL folder renamed in at the open and back out before the check is refused', () => {
    const agent = mk()
    const n = join(agent, 'notes')
    put(join(n, 'a', 'f.md'), '# inside\n')
    put(join(agent, 'outside', 'f.md'), `# out\n${SECRET}\n`)
    const scope = new MemoryScope(cfg(agent))
    const flipIn = () => {
      renameSync(join(n, 'a'), join(agent, 'held'))
      renameSync(join(agent, 'outside'), join(n, 'a'))
    }
    const flipOut = () => {
      renameSync(join(n, 'a'), join(agent, 'outside'))
      renameSync(join(agent, 'held'), join(n, 'a'))
    }
    // the CI triple flip, done with renames: no link anywhere, so only the question "where is the handle" can see it
    openSeam.beforeOpen = flipIn
    openSeam.afterOpen = flipOut
    openSeam.betweenRechecks = flipIn
    expect(scope.open('notes', 'a/f.md')).toBeNull()
  })

  test('control: with no swap the same open works', () => {
    const agent = mk()
    put(join(agent, 'notes', 'a', 'f.md'), '# inside\n')
    const o = new MemoryScope(cfg(agent)).open('notes', 'a/f.md')
    expect(o).not.toBeNull()
    o?.close()
  })
})

describe('the root is proved inside agent_dir when the scope is built', () => {
  test('a root folder that is now a link out of agent_dir is not a root', () => {
    const base = mk()
    const agent = join(base, 'agent')
    put(join(base, 'other', 'race.md'), `# race\n${SECRET}\n`)
    mkdirSync(agent)
    symlinkSync(join(base, 'other'), join(agent, 'notes')) // what parse saw as a folder inside agent_dir, swapped
    const scope = new MemoryScope(cfg(agent))
    expect(scope.roots).toEqual([])
    expect(scope.open('notes', 'race.md')).toBeNull()
  })

  test('control: a normal root and a root that is a link INSIDE agent_dir both work', () => {
    const agent = mk()
    put(join(agent, 'real', 'x.md'), '# x\n')
    symlinkSync(join(agent, 'real'), join(agent, 'notes'))
    const scope = new MemoryScope(cfg(agent))
    expect(scope.roots.length).toBe(1)
    const h = scope.open('notes', 'x.md')
    expect(h).not.toBeNull()
    h?.close()
  })
})

describe('listings do not name folders that lead out of the root', () => {
  test('dirVisible: a folder that is a link out of the root is not visible; a folder link inside is', () => {
    const agent = mk()
    const n = join(agent, 'notes')
    put(join(n, 'in', 'a.md'), '# a\n')
    put(join(agent, 'outside', 'plan.md'), '# plan\n')
    symlinkSync(join(agent, 'outside'), join(n, 'sub'))
    symlinkSync(join(n, 'in'), join(n, 'alias'))
    const scope = new MemoryScope(cfg(agent))
    expect(scope.dirVisible('notes', 'in')).toBe(true)
    expect(scope.dirVisible('notes', 'alias')).toBe(true)
    expect(scope.dirVisible('notes', 'sub')).toBe(false)
  })
})

describe('the search attachment reader', () => {
  const ID = 'md_00000000000000000000000000'
  function media() {
    const base = mk()
    const dir = join(base, 'media')
    mkdirSync(dir)
    const idx = new FileIndexer(null as never, dir) as unknown as { read: (id: string) => string | null }
    const sidecar = (path: string) => writeFileSync(join(dir, `${ID}.json`), JSON.stringify({ path }))
    return { base, dir, idx, sidecar }
  }

  test('control: a text file reads', () => {
    const { dir, idx, sidecar } = media()
    put(join(dir, `${ID}.txt`), 'hello\n')
    sidecar(join(dir, `${ID}.txt`))
    expect(idx.read(ID)).toBe('hello\n')
  })

  test('a hard link to a file outside the media folder is not indexed', () => {
    const { base, dir, idx, sidecar } = media()
    put(join(base, 'outside.txt'), `${SECRET}\n`)
    linkSync(join(base, 'outside.txt'), join(dir, `${ID}.txt`))
    sidecar(join(dir, `${ID}.txt`))
    expect(idx.read(ID)).toBeNull()
  })

  test('a hard link whose in-folder name is removed after the open is refused: the outside name keeps the handle linked', () => {
    const { base, dir, idx, sidecar } = media()
    put(join(base, 'outside.txt'), `${SECRET}\n`)
    linkSync(join(base, 'outside.txt'), join(dir, `${ID}.txt`))
    sidecar(join(dir, `${ID}.txt`))
    openSeam.afterOpen = (p) => {
      if (!p.endsWith('.txt')) return // the sidecar is opened first
      openSeam.afterOpen = undefined
      unlinkSync(join(dir, `${ID}.txt`)) // now only the outside name is left, so the handle's link count reads 1
    }
    expect(idx.read(ID)).toBeNull()
  })

  test('a named pipe is refused without waiting for a writer (a blocked open would freeze the whole bridge)', async () => {
    const { dir, sidecar } = media()
    const fifo = join(dir, `${ID}.txt`)
    Bun.spawnSync(['mkfifo', fifo])
    sidecar(fifo)
    const script = `import { FileIndexer } from ${JSON.stringify(join(import.meta.dir, '../src/search/files.ts'))}
console.log(String(new FileIndexer(null, ${JSON.stringify(dir)}).read(${JSON.stringify(ID)})))`
    const p = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' })
    // a blocked open never ends, so this only has to outlast a slow start of a fresh bun on a loaded machine
    const timer = setTimeout(() => p.kill(9), Math.min(4000 * waitScale(), 25_000))
    const code = await p.exited
    clearTimeout(timer)
    expect(code).toBe(0) // killed = 137: the open blocked
    expect((await new Response(p.stdout).text()).trim()).toBe('null')
  }, 30_000)

  test('a swapped folder at the open is refused (shared helper)', () => {
    const base = mk()
    put(join(base, 'd', 'f.txt'), 'x')
    put(join(base, 'o', 'f.txt'), SECRET)
    openSeam.beforeOpen = () => {
      renameSync(join(base, 'd'), join(base, '.r'))
      symlinkSync(join(base, 'o'), join(base, 'd'))
    }
    expect(() => closeSync(openResolvedNoFollow(join(base, 'd', 'f.txt')))).toThrow()
  })
})

describe('the search index', () => {
  function browser(agent: string, home: string, clock = fakeClock()) {
    writeFileSync(join(home, 'memory.json'), JSON.stringify({ ...(cfg(agent) as object), agent_dir: agent }))
    const svc = new MemoryBrowser({ home, clock, log: nullLogger, switchOn: () => true, watch: false })
    const q = (t: string) =>
      svc.search({
        ...mkFrame('memory.search'),
        request_id: newUlid(),
        q: t,
        root_ids: [],
        cursor: null,
        limit: 10,
      } as never)
    return { svc, q, clock }
  }

  test('a note that stops being text leaves search too (the old text is not served)', async () => {
    const agent = mk()
    const home = mk()
    put(join(agent, 'notes', 'a.md'), `# a\n${SECRET} in the note\n`)
    const { svc, q, clock } = browser(agent, home)
    await svc.idle()
    expect((await q(SECRET)).hits.length).toBe(1)
    writeFileSync(join(agent, 'notes', 'a.md'), Buffer.from([0, 1, 2, 3, 4]))
    clock.advance(6 * 60_000)
    await svc.idle()
    expect((await q(SECRET)).hits).toEqual([])
    svc.stop()
  })

  test('an index built before this fix is emptied once and rebuilt from the files', async () => {
    const agent = mk()
    const home = mk()
    put(join(agent, 'notes', 'a.md'), '# a\nreal body\n')
    // an old index: no user_version, a row that claims outside text under the note's name with the same size and mtime
    const { svc: first } = browser(agent, home)
    await first.idle()
    first.stop()
    const db = new Database(memoryIndexPath(home))
    db.exec('PRAGMA user_version = 0')
    const row = db.query('SELECT id FROM idx_files').get() as { id: number }
    db.query('DELETE FROM mem_fts WHERE rowid = ?').run(row.id)
    db.query('INSERT INTO mem_fts (rowid, title, body) VALUES (?, ?, ?)').run(row.id, 'a', `${SECRET} planted`)
    db.close()
    const { svc, q } = browser(agent, home)
    await svc.idle()
    expect((await q(SECRET)).hits).toEqual([])
    expect((await q('real')).hits.length).toBe(1)
    svc.stop()
  })
})

// Review of 1502cd06 (Cyclops, Fable): an exclusive create on Linux goes through a handle on its folder, and what it made in
// the wrong place is taken out only through that handle, never by a path walk (lstat then unlink by path is two walks, and a
// folder swapped between them made the bridge delete a same-named file elsewhere). Linux only: macOS refuses these opens
// with O_NOFOLLOW_ANY before any of it runs.
describe.if(process.platform === 'linux')('an exclusive create on Linux (review of 1502cd06)', () => {
  const CREATE = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
  let warned: string[] = []
  const realWarn = strayLog.warn
  afterEach(() => {
    strayLog.warn = realWarn
  })
  const setup = () => {
    warned = []
    strayLog.warn = (m) => warned.push(m)
    const top = mk()
    mkdirSync(join(top, 'root', 'docs'), { recursive: true })
    mkdirSync(join(top, 'outside'))
    return { top, docs: join(top, 'root', 'docs'), outside: join(top, 'outside') }
  }

  test('a folder swapped for a link before the create makes nothing outside, not even for a moment', () => {
    const { docs, outside } = setup()
    let seenOutside = false
    openSeam.beforeOpen = (p) => {
      if (p !== join(docs, 'a.md')) return
      renameSync(docs, `${docs}-moved`)
      symlinkSync(outside, docs)
    }
    openSeam.afterOpen = () => {
      seenOutside ||= existsSync(join(outside, 'a.md'))
    }
    expect(() => openResolvedNoFollow(join(docs, 'a.md'), CREATE)).toThrow()
    expect(seenOutside).toBe(false)
    expect(existsSync(join(outside, 'a.md'))).toBe(false)
    expect(warned).toEqual([])
  })

  test('the checked folder moved away after its check: the file made in it is taken out of it, and a same-named file at the old path is left alone', () => {
    const { top, docs } = setup()
    const away = join(top, 'away')
    openSeam.afterOpen = (p) => {
      if (p !== join(docs, 'a.md')) return
      // after the create, before its check: the folder goes, and someone's own file of that name takes its place
      renameSync(docs, away)
      mkdirSync(docs)
      writeFileSync(join(docs, 'a.md'), 'their data\n')
    }
    expect(() => openResolvedNoFollow(join(docs, 'a.md'), CREATE)).toThrow('not at the resolved path')
    expect(existsSync(join(away, 'a.md'))).toBe(false) // ours, taken out through the folder handle
    expect(readFileSync(join(docs, 'a.md'), 'utf8')).toBe('their data\n') // never touched
    expect(warned).toEqual([])
  })

  test('a file that is no longer empty is not taken out, and the bridge says where it was left', () => {
    const { top, docs } = setup()
    const away = join(top, 'away')
    openSeam.afterOpen = (p) => {
      if (p !== join(docs, 'a.md')) return
      appendFileSync(join(docs, 'a.md'), 'written meanwhile\n')
      renameSync(docs, away)
    }
    expect(() => openResolvedNoFollow(join(docs, 'a.md'), CREATE)).toThrow()
    expect(readFileSync(join(away, 'a.md'), 'utf8')).toBe('written meanwhile\n')
    expect(warned).toEqual([
      `talos: a file this bridge created (empty when made) was not where it was asked for, and is left at ${JSON.stringify(join(away, 'a.md'))}`,
    ])
  })

  test('an open that does not create never removes anything, whatever its check finds', () => {
    const { top, docs } = setup()
    writeFileSync(join(docs, 'b.md'), '')
    const away = join(top, 'away')
    openSeam.afterOpen = (p) => {
      if (p === join(docs, 'b.md')) renameSync(docs, away)
    }
    expect(() => openResolvedNoFollow(join(docs, 'b.md'), constants.O_RDONLY)).toThrow()
    expect(existsSync(join(away, 'b.md'))).toBe(true)
    expect(warned).toEqual([])
  })

  test('an exclusive create where nothing moved works as before, in the folder asked for', () => {
    const { docs } = setup()
    const fd = openResolvedNoFollow(join(docs, 'c.md'), CREATE)
    closeSync(fd)
    expect(existsSync(join(docs, 'c.md'))).toBe(true)
  })
})
