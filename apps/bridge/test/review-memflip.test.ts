// Memory-flip regression tests. One test per confirmed medium-severity bug; the controls stay green.
//
// Each case runs in its own process. A blocked open or read is synchronous, so inside this runner it could never time
// out; and the kill test needs a real SIGKILL. Nothing here depends on load: the hang clock starts when the child says it
// is about to make the call, and the kill lands at a forced statement, not after a sleep.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryIndexPath } from '../src/memory/config.ts'

const SRC = join(import.meta.dir, '../src')
const BOOT_MS = 30_000 // starting Bun on a loaded Mac
const HANG_MS = 5_000 // from the child's "ready" to its exit
const TEST_MS = 60_000
const ID = `md_${'0'.repeat(25)}1`

const cleanup: string[] = []
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})
const mk = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-rmf-')))
  cleanup.push(d)
  return d
}
const js = (v: unknown) => JSON.stringify(v)
const mkfifo = (path: string) => expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0)

/** Runs a script in a new Bun. It calls `ready()` just before the call under test; still running HANG_MS later = hung. */
async function child(script: string) {
  const flag = join(mk(), 'ready')
  const prelude = `import { writeFileSync as markReady } from 'node:fs'\nconst ready = () => markReady(${js(flag)}, '1')\n`
  const p = Bun.spawn([process.execPath, '-e', prelude + script], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const boot = Date.now() + BOOT_MS
  while (!existsSync(flag) && p.exitCode === null && Date.now() < boot) await Bun.sleep(10)
  const exited = await Promise.race([p.exited.then(() => true), Bun.sleep(HANG_MS).then(() => false)])
  if (!exited) p.kill(9)
  await p.exited
  const out = (await new Response(p.stdout).text()).trim()
  const err = (await new Response(p.stderr).text()).trim()
  return { hung: !exited, out, err, signal: p.signalCode, code: p.exitCode }
}

describe('a named pipe must not freeze the bridge', () => {
  // the real tick through a real history DB, the way the live bridge runs it
  const tickScript = (home: string, media: string) => `
import { join } from 'node:path'
import { newId } from '@talos-app/protocol'
import { openHistory } from ${js(join(SRC, 'history-store.ts'))}
import { createSearchService } from ${js(join(SRC, 'search/install.ts'))}
const s = openHistory(${js(join(home, 'h.sqlite'))})
const svc = createSearchService(s, { mediaDir: ${js(media)} })
s.addMessage({ id: newId('m'), thread_id: 'general', author: 'owner', kind: 'file', text: '', format: 'plain', via: 'app',
  created_at: new Date().toISOString(),
  attachments: [{ media_id: ${js(ID)}, kind: 'file', role: 'attachment', mime: 'text/markdown', name: 'note.md', size: 6,
    sha256: 'a'.repeat(64) }] })
ready()
while (svc.tickFiles());
console.log(s.db.query('SELECT state FROM fts_files').get().state)
process.exit(0)`

  function mediaHome() {
    const home = mk()
    const media = join(home, 'media')
    mkdirSync(media)
    return { home, media, sidecar: join(media, `${ID}.json`) }
  }

  test(
    'control: a normal sidecar and text file index through the real tick',
    async () => {
      const { home, media, sidecar } = mediaHome()
      const file = join(media, `${ID}.md`)
      writeFileSync(file, 'hello\n')
      writeFileSync(sidecar, js({ path: file }))
      const r = await child(tickScript(home, media))
      expect(r.err).toBe('')
      expect(r.hung).toBe(false)
      expect(r.out).toBe('done')
    },
    TEST_MS,
  )

  // files.ts:93: existsSync, then readFileSync on the sidecar. O_NONBLOCK was added only to the attachment open at :99.
  test(
    'search reader: a pipe as the sidecar is skipped, it does not block the tick',
    async () => {
      const { home, media, sidecar } = mediaHome()
      mkfifo(sidecar)
      const r = await child(tickScript(home, media))
      expect(r.hung).toBe(false)
      expect(r.out).toBe('skipped')
    },
    TEST_MS,
  )

  const rehydrateScript = (base: string, pipe: boolean) => `
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { MediaStore } from ${js(join(SRC, 'media.ts'))}
const home = ${js(join(base, 'home'))}
const media = home + '/media'
mkdirSync(media, { recursive: true })
let sent = 0
const store = new MediaStore({ home, media }, { putMedia: async () => { sent++ } })
const out = ${js(join(base, 'out.txt'))}
writeFileSync(out, 'hello')
const ref = await store.upload(out)
sent = 0
if (${pipe}) {
  // upload keeps its own copy (up-*), and that is the path media.fetch reads: replace the copy with a pipe
  const copy = media + '/' + readdirSync(media).find((f) => f.startsWith('up-'))
  rmSync(copy)
  if (Bun.spawnSync(['mkfifo', copy]).exitCode !== 0) throw new Error('mkfifo failed')
}
ready()
const ok = await store.rehydrate(ref.media_id)
console.log(JSON.stringify({ ok, sent }))
process.exit(0)`

  test(
    'control: media.fetch re-uploads a normal file',
    async () => {
      const r = await child(rehydrateScript(mk(), false))
      expect(r.err).toBe('')
      expect(r.hung).toBe(false)
      expect(r.out).toBe(js({ ok: true, sent: 1 }))
    },
    TEST_MS,
  )

  // media.ts:181: the one read of an agent-chosen path that skips safe-open. It runs on the bridge's only thread.
  test(
    'media.fetch: the kept copy replaced by a pipe answers false, it does not block',
    async () => {
      const r = await child(rehydrateScript(mk(), true))
      expect(r.hung).toBe(false)
      expect(r.out).toBe(js({ ok: false, sent: 0 }))
    },
    TEST_MS,
  )
})

describe('an index rebuild killed mid-way', () => {
  const NOTES = 5

  function vault() {
    const agent = mk()
    const home = mk()
    mkdirSync(join(agent, 'notes'))
    for (let i = 0; i < NOTES; i++) writeFileSync(join(agent, 'notes', `n${i}.md`), `# n${i}\nuniq${i}word body\n`)
    const roots = [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md'], exclude: [] }]
    writeFileSync(
      join(home, 'memory.json'),
      js({ version: 1, enabled: true, agent_dir: agent, roots, max_file_kb: 512 }),
    )
    return { home }
  }

  // Dies by SIGKILL just before the Nth FTS insert: the same point a real kill lands on most often, without the timing.
  // Wraps the statement's run, so it still fires if the insert moves into a transaction or is prepared once.
  const killBeforeFtsInsert = (nth: number) => `
import { Database } from 'bun:sqlite'
let left = ${nth}
const seen = new WeakSet()
const hook = (orig) => function (sql, ...rest) {
  const st = orig.call(this, sql, ...rest)
  if (!/INSERT\\s+INTO\\s+mem_fts/i.test(sql) || seen.has(st)) return st
  seen.add(st)
  const run = st.run.bind(st)
  st.run = (...a) => {
    if (--left === 0) process.kill(process.pid, 'SIGKILL')
    return run(...a)
  }
  return st
}
Database.prototype.prepare = hook(Database.prototype.prepare)
Database.prototype.query = hook(Database.prototype.query)
`
  // the real MemoryBrowser, indexing to the end, then a real search for every note
  const indexScript = (home: string, hook = '') => `${hook}
import { newUlid } from '@talos-app/protocol'
import { fakeClock, mkFrame } from '@talos-app/testkit'
import { nullLogger } from ${js(join(SRC, 'log.ts'))}
import { MemoryBrowser } from ${js(join(SRC, 'memory/service.ts'))}
ready()
const svc = new MemoryBrowser({ home: ${js(home)}, clock: fakeClock(), log: nullLogger, switchOn: () => true, watch: false })
await svc.idle()
const missing = []
for (let i = 0; i < ${NOTES}; i++) {
  const r = await svc.search({ ...mkFrame('memory.search'), request_id: newUlid(), q: 'uniq' + i + 'word', root_ids: [],
    cursor: null, limit: 10 })
  if (r.hits.length !== 1) missing.push('n' + i + '.md')
}
svc.stop()
console.log(JSON.stringify(missing))
process.exit(0)`

  test(
    'control: an uninterrupted index finds every note',
    async () => {
      const { home } = vault()
      const r = await child(indexScript(home))
      expect(r.err).toBe('')
      expect(r.hung).toBe(false)
      expect(JSON.parse(r.out)).toEqual([])
    },
    TEST_MS,
  )

  // service.ts:314-316: idx_files commits on its own, the FTS insert comes after. A kill between them leaves a row that
  // says "indexed", so :291 skips the note on every later pass.
  test(
    'upgrade rebuild: after a kill and a clean rerun, every note is still searchable',
    async () => {
      const { home } = vault()
      const first = await child(indexScript(home))
      expect(JSON.parse(first.out)).toEqual([])

      // what an install looks like just before it upgrades to this PR
      const db = new Database(memoryIndexPath(home))
      db.exec('PRAGMA user_version = 1')
      db.close()

      const killed = await child(indexScript(home, killBeforeFtsInsert(3)))
      expect(killed.signal).toBe('SIGKILL') // the hook fired: the kill really landed inside the rebuild

      const rerun = await child(indexScript(home))
      expect(rerun.err).toBe('')
      expect(rerun.hung).toBe(false)
      expect(JSON.parse(rerun.out)).toEqual([])
    },
    TEST_MS,
  )
})
