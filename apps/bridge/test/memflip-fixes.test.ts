// Memory-flip follow-up fixes: the lower-severity findings that have a seam. The mediums are
// pinned in review-memflip.test.ts (child processes). Each test fails if its fix is taken out.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { fakeClock, mkFrame } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { MediaStore } from '../src/media.ts'
import { memoryIndexPath, parseMemoryConfig } from '../src/memory/config.ts'
import { MemoryScope } from '../src/memory/scope.ts'
import { MemoryBrowser } from '../src/memory/service.ts'
import { openSeam } from '../src/safe-open.ts'

const SECRET = 'zzSECRETzz'
const cleanup: string[] = []
afterEach(() => {
  openSeam.beforeOpen = undefined
  openSeam.afterOpen = undefined
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})
const mk = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-mf-')))
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

describe('a root may not resolve through a protected folder', () => {
  test('scope: notes -> .vault is refused; a link to a plain folder still works and opens', () => {
    const agent = mk()
    put(join(agent, '.vault', 'v.md'), `${SECRET} in denied folder`)
    symlinkSync(join(agent, '.vault'), join(agent, 'notes'))
    expect(new MemoryScope(cfg(agent)).roots).toEqual([])
    const ok = mk()
    put(join(ok, 'real', 'x.md'), '# x\n')
    symlinkSync(join(ok, 'real'), join(ok, 'notes'))
    const scope = new MemoryScope(cfg(ok))
    expect(scope.roots.length).toBe(1)
    const h = scope.open('notes', 'x.md')
    expect(h).not.toBeNull()
    h?.close()
  })

  test('config parse: the same link is refused with a message', () => {
    const agent = mk()
    put(join(agent, '.git', 'v.md'), 'x')
    symlinkSync(join(agent, '.git'), join(agent, 'notes'))
    const home = mk()
    writeFileSync(join(home, 'memory.json'), JSON.stringify(cfg(agent)))
    const r = parseMemoryConfig(JSON.parse(JSON.stringify(cfg(agent))), home)
    expect(r.ok).toBe(false)
  })
})

describe('upload and media.fetch read the handle, not the name', () => {
  function setup() {
    const base = mk()
    const home = join(base, 'home')
    const media = join(home, 'media')
    mkdirSync(media, { recursive: true })
    put(join(base, 'work', 'a.txt'), 'original\n')
    put(join(base, 'work', 'b.txt'), 'swapped-in\n')
    const sent: string[] = []
    const http = { putMedia: async (_i: string, b: Uint8Array) => void sent.push(Buffer.from(b).toString()) }
    const store = new MediaStore({ home, media } as never, http as never)
    return { base, store, sent }
  }

  test('a name replaced after the handle check does not change the bytes sent', async () => {
    const { base, store, sent } = setup()
    openSeam.afterOpen = () => {
      openSeam.afterOpen = undefined
      renameSync(join(base, 'work', 'b.txt'), join(base, 'work', 'a.txt')) // atomic replace of the name
    }
    await store.upload(join(base, 'work', 'a.txt'))
    expect(sent).toEqual(['original\n'])
  })

  test('upload through a legitimate symlink works', async () => {
    const { base, store, sent } = setup()
    symlinkSync(join(base, 'work'), join(base, 'link'))
    await store.upload(join(base, 'link', 'a.txt'))
    expect(sent).toEqual(['original\n'])
  })
})

describe('the index rebuild', () => {
  function browser(agent: string, home: string, extra: object = {}) {
    writeFileSync(join(home, 'memory.json'), JSON.stringify({ ...(cfg(agent) as object), agent_dir: agent }))
    const clock = fakeClock()
    const svc = new MemoryBrowser({ home, clock, log: nullLogger, switchOn: () => true, watch: false, ...extra })
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

  test('it yields on bytes, not only every 100 files', async () => {
    const agent = mk()
    const home = mk()
    const chunk = `${'lorem ipsum dolor '.repeat(16000)}\n` // about 288 KB
    for (let i = 0; i < 40; i++) put(join(agent, 'notes', `n${i}.md`), `# n${i}\n${chunk}`)
    let ticks = 0
    let go = true
    const spin = () => {
      if (!go) return
      ticks++
      setImmediate(spin)
    }
    const { svc } = browser(agent, home)
    setImmediate(spin)
    await svc.idle()
    go = false
    svc.stop()
    // 40 files of 288 KB is about 11 MB: at least five byte-yields land inside the rebuild, and each lets the spinner run
    expect(ticks).toBeGreaterThanOrEqual(4)
  })

  test('the upgrade wipe leaves a usable, empty index that rebuilds (drop and recreate)', async () => {
    const agent = mk()
    const home = mk()
    put(join(agent, 'notes', 'a.md'), '# a\nfindme\n')
    const first = browser(agent, home)
    await first.svc.idle()
    first.svc.stop()
    const db = new Database(memoryIndexPath(home))
    db.exec('PRAGMA user_version = 0')
    db.close()
    const { svc, q } = browser(agent, home)
    await svc.idle()
    expect((await q('findme')).hits.length).toBe(1)
    svc.stop()
  })

  test('a changed note past the text cap leaves search', async () => {
    const agent = mk()
    const home = mk()
    put(join(agent, 'notes', 'a.md'), '# a\nfirst note body\n')
    put(join(agent, 'notes', 'z.md'), `# z\n${SECRET} body\n`)
    const one = browser(agent, home)
    await one.svc.idle()
    expect((await one.q(SECRET)).hits.length).toBe(1)
    one.svc.stop()
    // a vault now past the cap: z.md changes, cannot be re-indexed, and its old text must not keep being served
    put(join(agent, 'notes', 'z.md'), `# z\n${'changed and longer '.repeat(5)}\n`)
    const { svc, q } = browser(agent, home, { maxTextBytes: 10 })
    await svc.idle()
    expect((await q(SECRET)).hits).toEqual([])
    svc.stop()
  })
})

describe('media.fetch: a pipe as the sidecar answers false', () => {
  test('it does not block', async () => {
    const base = mk()
    const media = join(base, 'media')
    mkdirSync(media)
    const id = `md_${'0'.repeat(25)}1`
    expect(Bun.spawnSync(['mkfifo', join(media, `${id}.json`)]).exitCode).toBe(0)
    const script = `import { MediaStore } from ${JSON.stringify(join(import.meta.dir, '../src/media.ts'))}
const s = new MediaStore({ home: ${JSON.stringify(base)}, media: ${JSON.stringify(media)} } as never, {} as never)
console.log(await s.rehydrate(${JSON.stringify(id)}))
process.exit(0)`
    const p = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const done = await Promise.race([p.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    if (!done) p.kill(9)
    await p.exited
    expect(done).toBe(true)
    expect((await new Response(p.stdout).text()).trim()).toBe('false')
  }, 60_000)
})
