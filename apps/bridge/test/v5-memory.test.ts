/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// WP-V5 acceptance, bridge part (docs/V2-FEATURES.md V5.4). Real bridge (live, in process) + FakeRelay + FakeApp on a
// synthetic agent folder made in a temp dir. Nothing here reads a real notes folder.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FRAME_BYTES, MEMORY_FRAME_SLACK, MEMORY_LINKS_MAX_BYTES, newUlid, parseFrame } from '@talos-app/protocol'
import { fakeClock, mkFrame } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'
import { nullLogger } from '../src/log.ts'
import { cmdMemory } from '../src/memory/cli.ts'
import { memoryIndexPath } from '../src/memory/config.ts'
import { MemoryBrowser, WATCH_DEBOUNCE_MS } from '../src/memory/service.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
const cleanup: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  delete process.env.TALOS_APP_MEMORY_WATCH
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tmp = (p: string) => {
  const d = require('node:fs').mkdtempSync(join(tmpdir(), p))
  cleanup.push(d)
  return d as string
}
const put = (root: string, rel: string, body: string | Buffer = `# ${rel}\n`) => {
  const f = join(root, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, body)
}

/** A synthetic agent folder: a notes root with good notes, an excluded folder, a private folder and every denylist case. */
function makeAgent() {
  const agent = tmp('talos-mem-agent-')
  const n = join(agent, 'notes')
  put(
    n,
    'Overview.md',
    '---\ntitle: Project Overview\ntags: [a]\n---\n# Heading\nSee [[Launch checklist]], [[Secret plan]], [[Drafty]], [[Missing]] and [the plan](projects/example/plan.md).\n',
  )
  put(n, 'projects/example/plan.md', '# Plan\nShip the quarterly release on Friday.\n')
  put(n, 'projects/example/Launch checklist.md', '# Launch checklist\nBackups, banner, release notes.\n')
  put(n, 'drafts/Drafty.md', '# Drafty\nzzhidden draft\n')
  put(n, 'private/Secret plan.md', '# Secret plan\nzzhidden private\n')
  put(n, 'private/.talos-private', '')
  put(n, '.env', 'KEY=zzhidden\n')
  put(n, 'a/.git/config', 'zzhidden\n')
  put(n, 'x.pem', 'zzhidden\n')
  put(n, 'prod.env', 'zzhidden\n')
  put(n, 'credentials.json', '{"zzhidden":1}\n')
  put(n, 'notes.sqlite', 'zzhidden\n')
  put(n, 'a/readme.md', '# A readme\n')
  put(agent, 'outside.md', '# Outside\nzzhidden outside\n')
  symlinkSync(join(agent, 'outside.md'), join(n, 'escape.md'))
  return agent
}

const memJson = (agent: string, over: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) => ({
  version: 1,
  enabled: true,
  agent_dir: agent,
  roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*'], exclude: ['drafts/**'], ...rootOver }],
  max_file_kb: 512,
  ...over,
})

async function start(agent: string, over: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) {
  const home = tempHome()
  cleanup.push(home)
  writeFileSync(join(home, 'memory.json'), JSON.stringify(memJson(agent, over, rootOver)), { mode: 0o600 })
  h = await startHarness({ home })
  await settled()
  return h
}
const settled = async () => {
  const svc = h?.bridge.ctx.memory as unknown as MemoryBrowser | undefined
  await svc?.idle()
}

const RESP = {
  'memory.tree': 'memory.listing',
  'memory.read': 'memory.file',
  'memory.search': 'memory.results',
} as const
type Q = keyof typeof RESP
/** Sends one signed read and returns the answer frame or the error frame. */
async function call(x: Harness, type: Q, fields: Record<string, unknown>) {
  const f = await x.app.sign({ ...mkFrame(type), request_id: newUlid(), ...fields })
  x.app.send(f)
  const find = () =>
    x.app.rec.frames.find(
      (r) =>
        r.direction === 'in' &&
        ((r.raw.type === RESP[type] && r.raw.request_id === f.request_id) ||
          (r.raw.type === 'error' && r.raw.ref === f.id)),
    )
  await waitFor(() => find() !== undefined, 5000, `answer to ${type}`)
  return (find() as { raw: Record<string, any> }).raw
}
const tree = (x: Harness, path = '', root: string | null = 'notes', cursor: string | null = null) =>
  call(x, 'memory.tree', { root_id: root, path, cursor })
const read = (x: Harness, path: string, offset = 0, root = 'notes') =>
  call(x, 'memory.read', { root_id: root, path, offset })
const search = (x: Harness, q: string, root_ids: string[] = []) =>
  call(x, 'memory.search', { q, root_ids, cursor: null, limit: 20 })
const wire = (raw: unknown) => Buffer.byteLength(JSON.stringify(raw), 'utf8')

// ---- off ----------------------------------------------------------------------------------------------------------

describe('off', () => {
  test('no memory.json -> memory_off; enabled:false -> memory_off', async () => {
    h = await startHarness()
    expect((await tree(h)).code).toBe('memory_off')
    expect((await read(h, 'a.md')).code).toBe('memory_off')
    expect((await search(h, 'x')).code).toBe('memory_off')
    expect((h.bridge.ctx.memory as MemoryBrowser).enabled()).toBe(false)
    await h.stop()
    h = undefined
    const agent = makeAgent()
    await start(agent, { enabled: false })
    expect((await tree(h as unknown as Harness)).code).toBe('memory_off')
  })

  test('the phone can switch it off; `memory on` at the Mac restores it', async () => {
    const agent = makeAgent()
    const x = await start(agent)
    expect((await tree(x)).type).toBe('memory.listing')
    const cfg = x.bridge.ctx.config
    const r = cfg.applyPatch(cfg.config.rev, { memory_browser: false })
    expect(r.ok).toBe(true)
    expect((await tree(x)).code).toBe('memory_off')
    const lines: string[] = []
    const code = await cmdMemory(x.bridge.ctx.env, ['on'], { out: (l) => lines.push(l), err: (l) => lines.push(l) })
    expect(code).toBe(0)
    // the bridge's config poll picks up the CLI's write
    await waitFor(
      () => x.bridge.ctx.config.reloadIfChanged() || x.bridge.ctx.config.config.memory_browser,
      5000,
      'config reload',
    )
    expect(x.bridge.ctx.config.config.memory_browser).toBe(true)
    expect((await tree(x)).type).toBe('memory.listing')
  })

  test('the service advertises memory/1 even when off (the app says "turn it on at your Mac")', async () => {
    h = await startHarness()
    expect(h.bridge.ctx.memory?.available).toBe(true)
  })
})

// ---- hidden paths -------------------------------------------------------------------------------------------------

describe('hidden paths', () => {
  const HIDDEN = [
    '.env',
    'a/.git/config',
    'x.pem',
    'prod.env',
    'credentials.json',
    'notes.sqlite',
    'private/Secret plan.md',
    'private/.talos-private',
    'drafts/Drafty.md', // exclude glob
    'escape.md', // symlink out of the root
  ]

  test('invisible in the tree, a direct read gets memory_not_found, and search never finds them', async () => {
    const x = await start(makeAgent())
    const top = await tree(x)
    const names = top.entries.map((e: any) => e.name)
    expect(names).toEqual(['a', 'projects', 'Overview.md'])
    const all: string[] = []
    const walk = async (p: string) => {
      const t = await tree(x, p)
      for (const e of t.entries) {
        all.push(e.path)
        if (e.type === 'dir') await walk(e.path)
      }
    }
    await walk('')
    expect(all.sort()).toEqual(
      [
        'Overview.md',
        'a',
        'a/readme.md',
        'projects',
        'projects/example',
        'projects/example/Launch checklist.md',
        'projects/example/plan.md',
      ].sort(),
    )
    for (const p of HIDDEN) {
      const r = await read(x, p)
      expect([p, r.code]).toEqual([p, 'memory_not_found'])
    }
    expect((await tree(x, 'private')).code).toBe('memory_not_found')
    expect((await tree(x, 'drafts')).code).toBe('memory_not_found')
    expect((await tree(x, 'a/.git')).code).toBe('memory_not_found')
    const hits = await search(x, 'zzhidden')
    expect(hits.type).toBe('memory.results')
    expect(hits.hits).toEqual([])
    expect((await read(x, 'Overview.md')).type).toBe('memory.file')
  })

  test('../x and absolute paths fail the schema before they reach the service', async () => {
    const x = await start(makeAgent())
    for (const bad of ['../outside.md', '/etc/passwd', 'a/../../outside.md']) {
      const f = await x.app.sign({
        ...mkFrame('memory.read'),
        request_id: newUlid(),
        root_id: 'notes',
        path: bad,
        offset: 0,
      })
      x.app.send(f)
      await waitFor(
        () => x.app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === f.id),
        5000,
        bad,
      )
      const err = x.app.rec.frames.find((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === f.id)
      expect(err?.raw.code).toBe('bad_frame')
    }
  })

  test('a .talos-private file in the ROOT hides the whole root; the exclude glob applies to the tree, read and search', async () => {
    const agent = makeAgent()
    put(join(agent, 'notes'), '.talos-private', '')
    const x = await start(agent)
    expect((await tree(x)).entries).toEqual([])
    expect((await read(x, 'Overview.md')).code).toBe('memory_not_found')
    expect((await search(x, 'quarterly')).hits).toEqual([])
  })

  test('a file that becomes private after it was indexed is gone from reads and search at once', async () => {
    const agent = makeAgent()
    const x = await start(agent)
    expect((await search(x, 'quarterly')).hits.length).toBe(1)
    put(join(agent, 'notes/projects/example'), '.talos-private', '')
    expect((await read(x, 'projects/example/plan.md')).code).toBe('memory_not_found')
    expect((await search(x, 'quarterly')).hits).toEqual([])
    expect((await tree(x, 'projects/example')).code).toBe('memory_not_found')
  })
})

// ---- frame caps ---------------------------------------------------------------------------------------------------

describe('frame caps', () => {
  const CAP = MAX_FRAME_BYTES - MEMORY_FRAME_SLACK + MEMORY_FRAME_SLACK // never over MAX_FRAME_BYTES on the wire

  test('500 entries with 255-byte names and 400-byte paths page across frames and add up', async () => {
    const agent = tmp('talos-mem-big-')
    const dir = 'd'.repeat(144)
    const names: string[] = []
    for (let i = 0; i < 500; i++) {
      const name = `${String(i).padStart(4, '0')}${'n'.repeat(248)}.md`
      expect(Buffer.byteLength(name)).toBe(255)
      names.push(name)
      put(join(agent, 'notes', dir), name, '# t\n')
    }
    expect(Buffer.byteLength(`${dir}/${names[0]}`)).toBe(400)
    const x = await start(agent, {}, { include: ['**/*.md'], exclude: [] })
    const got: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const t = await tree(x, dir, 'notes', cursor)
      expect(t.type).toBe('memory.listing')
      expect(parseFrame(t).ok).toBe(true)
      expect(wire(t)).toBeLessThanOrEqual(MAX_FRAME_BYTES - MEMORY_FRAME_SLACK)
      got.push(...t.entries.map((e: any) => e.name))
      cursor = t.next_cursor
      pages++
    } while (cursor && pages < 20)
    expect(pages).toBeGreaterThan(1)
    expect(got).toEqual(names)
  })

  test('a 192 KiB note full of quotes and newlines with 200 long links is chunked; the chunks equal the file and its sha256', async () => {
    const agent = tmp('talos-mem-chunk-')
    const links = Array.from({ length: 200 }, (_, i) => `[[${'L'.repeat(150)}${i}]]`).join(' ')
    let body = `# Big\n${links}\n`
    while (Buffer.byteLength(body) < 192 * 1024) body += '"q" \\ "\n"é 日本語 "\n'
    body = body.slice(0, body.length)
    put(join(agent, 'notes'), 'big.md', body)
    const bytes = readFileSync(join(agent, 'notes/big.md'))
    const x = await start(agent, {}, { include: ['**/*.md'], exclude: [] })
    let offset = 0
    const parts: Buffer[] = []
    let first: any
    let chunks = 0
    for (;;) {
      const r = await read(x, 'big.md', offset)
      expect(r.type).toBe('memory.file')
      expect(parseFrame(r).ok).toBe(true)
      expect(wire(r)).toBeLessThanOrEqual(MAX_FRAME_BYTES - MEMORY_FRAME_SLACK)
      if (chunks === 0) first = r
      else expect(r.links).toBeUndefined()
      parts.push(Buffer.from(r.text, 'utf8'))
      chunks++
      expect(r.offset).toBe(offset)
      if (r.next_offset === null) break
      expect(r.next_offset).toBeGreaterThan(offset)
      offset = r.next_offset
      expect(chunks).toBeLessThan(10)
    }
    expect(chunks).toBeGreaterThan(1)
    expect(Buffer.concat(parts).equals(bytes)).toBe(true)
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(first.size).toBe(bytes.length)
    expect(first.links.length).toBeGreaterThan(0)
    expect(JSON.stringify(first.links).length).toBeLessThanOrEqual(MEMORY_LINKS_MAX_BYTES + 64)
    void CAP
  })

  test('a chunk never ends inside a multi-byte character', async () => {
    const agent = tmp('talos-mem-utf-')
    put(join(agent, 'notes'), 'jp.md', '日本語のノート。'.repeat(40_000))
    const x = await start(agent, { max_file_kb: 5120 }, { include: ['**/*.md'], exclude: [] })
    let offset = 0
    let out = ''
    for (let i = 0; i < 20; i++) {
      const r = await read(x, 'jp.md', offset)
      expect(r.text.includes('�')).toBe(false)
      out += r.text
      if (r.next_offset === null) break
      offset = r.next_offset
    }
    expect(out).toBe('日本語のノート。'.repeat(40_000))
  })
})

// ---- links --------------------------------------------------------------------------------------------------------

describe('links', () => {
  test('[[Overview]] resolves; a link to an excluded or private note is path:null, exactly like a missing one', async () => {
    const x = await start(makeAgent())
    const r = await read(x, 'Overview.md')
    const by = (t: string) => r.links.find((l: any) => l.text === t)
    expect(by('Launch checklist')).toEqual({
      text: 'Launch checklist',
      root_id: 'notes',
      path: 'projects/example/Launch checklist.md',
    })
    expect(by('Secret plan')).toEqual({ text: 'Secret plan', root_id: null, path: null })
    expect(by('Drafty')).toEqual({ text: 'Drafty', root_id: null, path: null })
    expect(by('Missing')).toEqual({ text: 'Missing', root_id: null, path: null })
    expect(by('the plan')).toEqual({ text: 'the plan', root_id: 'notes', path: 'projects/example/plan.md' })
    // a note that links back to Overview
    put(
      join((x.bridge.ctx.memory as any).cfg.agent_dir, 'notes/a'),
      'back.md',
      'Back to [[Overview]] and [[overview|home]].\n',
    )
    const b = await read(x, 'a/back.md')
    expect(b.links.map((l: any) => [l.text, l.path])).toEqual([
      ['Overview', 'Overview.md'],
      ['home', 'Overview.md'],
    ])
  })

  test('the nearest folder wins when two notes share a name', async () => {
    const agent = tmp('talos-mem-near-')
    put(join(agent, 'notes'), 'one/Index.md', 'x')
    put(join(agent, 'notes'), 'two/Index.md', 'x')
    put(join(agent, 'notes'), 'two/page.md', 'Go [[Index]]')
    put(join(agent, 'notes'), 'one/page.md', 'Go [[Index]]')
    const x = await start(agent, {}, { include: ['**/*.md'], exclude: [] })
    expect((await read(x, 'two/page.md')).links[0].path).toBe('two/Index.md')
    expect((await read(x, 'one/page.md')).links[0].path).toBe('one/Index.md')
  })

  test('[[../people/foo]] opens, a ../ climb out of the root is grey, and 700 distinct links all come back in one frame', async () => {
    const agent = tmp('talos-mem-rel-')
    put(join(agent, 'notes'), 'people/foo.md', '# Foo')
    const list = Array.from({ length: 700 }, (_, i) => `[[people/foo|Person number ${i} with a longer label]]`).join(
      '\n',
    )
    put(
      join(agent, 'notes'),
      'concepts/index.md',
      `[[../people/foo]] [[../../people/foo|Out]] [[../../../../etc/passwd|Etc]]\n${list}\n[[../people/foo]] [[../people/foo]]\n`,
    )
    const x = await start(agent, {}, { include: ['**/*.md'], exclude: [] })
    const r = await read(x, 'concepts/index.md')
    expect(parseFrame(r).ok).toBe(true)
    expect(wire(r)).toBeLessThanOrEqual(MAX_FRAME_BYTES - MEMORY_FRAME_SLACK)
    const by = (t: string) => r.links.find((l: any) => l.text === t)
    expect(by('../people/foo')).toEqual({ text: '../people/foo', root_id: 'notes', path: 'people/foo.md' })
    expect(by('Out')).toEqual({ text: 'Out', root_id: null, path: null })
    expect(by('Etc')).toEqual({ text: 'Etc', root_id: null, path: null })
    // each distinct link once, though the page repeats one of them: 3 + 700
    expect(r.links).toHaveLength(703)
    expect(by('Person number 699 with a longer label')?.path).toBe('people/foo.md')
  })

  test('a 512 KiB note with 128 KiB of backticks, then plain text, costs a small multiple of hashing its bytes and grows with its size', async () => {
    const agent = tmp('talos-mem-ticks-')
    const make = (size: number) =>
      `[[Overview]] ${'`'.repeat(size / 4)} [[Overview]]\n${`${'plain words '.repeat(10)}"`.repeat(Math.ceil(size / 121))}`.slice(
        0,
        size,
      )
    const size = 512 * 1024 - 64
    const small = size / 8
    // A quote every 121 characters grows the note by a byte each when it is written as JSON, so the first chunk does not
    // fit as it stands and the cutter has to look for the cut (plain text would fit at once and never exercise it).
    const body = make(size)
    put(join(agent, 'notes'), 'ticks.md', body)
    put(join(agent, 'notes'), 'small.md', make(small))
    put(join(agent, 'notes'), 'Overview.md', '# Overview\n')
    const x = await start(agent, {}, { include: ['**/*.md'], exclude: [] })
    // The link scan and the chunk cut run on the bridge's one thread, so a read that costs a lot is a read that stalls
    // every other thread. No millisecond limit anywhere: the figures are taken in this run and compared with each other, so a
    // busy machine moves them together, and a pair that misses is measured once more.
    //  1. Against a reference that is outside the read path: SHA-256 of the same bytes (one pass over the input, native).
    //     Both CPU time and elapsed time are held to it, so a read that burns CPU and one that only waits both fail.
    //  2. Against the same note at an eighth of the size: eight times the input may cost about eight times as much, not
    //     sixty-four (a scan or cut that grows with the square of the input). CPU time and elapsed time both.
    // A cut that walks down a byte at a time, a link scan that rescans the backticks, or a sleep all fail one of them.
    const sample = async (path: string, tries: number) => {
      let cpu = Number.POSITIVE_INFINITY
      let wall = Number.POSITIVE_INFINITY
      for (let i = 0; i < tries; i++) {
        const c = process.cpuUsage()
        const t = performance.now()
        await read(x, path)
        wall = Math.min(wall, performance.now() - t)
        const d = process.cpuUsage(c)
        cpu = Math.min(cpu, (d.user + d.system) / 1000)
      }
      return { cpu, wall }
    }
    const hashRef = (bytes: Buffer) => {
      let cpu = Number.POSITIVE_INFINITY
      let wall = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const c = process.cpuUsage()
        const t = performance.now()
        createHash('sha256').update(bytes).digest('hex')
        wall = Math.min(wall, performance.now() - t)
        const d = process.cpuUsage(c)
        cpu = Math.min(cpu, (d.user + d.system) / 1000)
      }
      return { cpu: Math.max(cpu, 0.05), wall: Math.max(wall, 0.05) }
    }
    const ONE_PASS_MULTIPLE = 800 // a read does a link scan, a cut and a hash of the whole note: measured near 150 here
    const GROWTH_SLACK = 4 // eight times the input may cost up to 8 x 4 times
    const attempt = async () => {
      const ref = hashRef(Buffer.from(body))
      const big = await sample('ticks.md', 5)
      const little = await sample('small.md', 5)
      const floor = 0.2 // below this a ratio is noise, not a growth rate
      const grew = {
        cpu: big.cpu / Math.max(little.cpu, floor),
        wall: big.wall / Math.max(little.wall, floor),
      }
      const why = `read ${big.cpu.toFixed(1)}/${big.wall.toFixed(1)} ms cpu/wall, hash ${ref.cpu.toFixed(2)}/${ref.wall.toFixed(2)}, 1/8 size ${little.cpu.toFixed(1)}/${little.wall.toFixed(1)}`
      return {
        ok:
          big.cpu <= ref.cpu * ONE_PASS_MULTIPLE &&
          big.wall <= ref.wall * ONE_PASS_MULTIPLE &&
          grew.cpu <= 8 * GROWTH_SLACK &&
          grew.wall <= 8 * GROWTH_SLACK,
        why,
      }
    }
    const first = await attempt()
    const verdict = first.ok ? first : await attempt()
    expect(verdict.ok, verdict.why).toBe(true)
    // and the work is done: the frame is valid and the one link in the note is found
    const r = await read(x, 'ticks.md')
    expect(r.type).toBe('memory.file')
    expect(parseFrame(r).ok).toBe(true)
    expect(r.links).toEqual([{ text: 'Overview', root_id: 'notes', path: 'Overview.md' }])
  }, 60_000)

  test('[[name]] falls through to another root', async () => {
    const agent = tmp('talos-mem-roots-')
    put(join(agent, 'a'), 'Start.md', 'See [[Elsewhere]]')
    put(join(agent, 'b'), 'Elsewhere.md', '# E')
    const home = tempHome()
    cleanup.push(home)
    writeFileSync(
      join(home, 'memory.json'),
      JSON.stringify({
        version: 1,
        enabled: true,
        agent_dir: agent,
        roots: [
          { id: 'ra', label: 'A', path: 'a' },
          { id: 'rb', label: 'B', path: 'b' },
        ],
      }),
    )
    h = await startHarness({ home })
    await settled()
    const r = await read(h, 'Start.md', 0, 'ra')
    expect(r.links[0]).toEqual({ text: 'Elsewhere', root_id: 'rb', path: 'Elsewhere.md' })
    const roots = await tree(h, '', null)
    expect(roots.roots.map((x: any) => [x.id, x.files])).toEqual([
      ['ra', 1],
      ['rb', 1],
    ])
  })
})

// ---- search + freshness -------------------------------------------------------------------------------------------

describe('search and freshness', () => {
  test('search finds titles and bodies, marks offsets into the snippet, and the root filter works', async () => {
    const x = await start(makeAgent())
    const r = await search(x, 'quarterly release')
    expect(r.hits.length).toBe(1)
    const hit = r.hits[0]
    expect(hit.path).toBe('projects/example/plan.md')
    expect(hit.title).toBe('Plan')
    expect(hit.marks.length).toBeGreaterThan(0)
    for (const [a, b] of hit.marks) expect(hit.snippet.slice(a, b).toLowerCase()).toMatch(/quarterly|release/)
    expect((await search(x, 'quarterly', ['nope'])).hits).toEqual([])
    expect((await search(x, '"unclosed')).type).toBe('memory.results')
    expect((await search(x, 'NEAR(a b) OR *')).type).toBe('memory.results')
    expect((await search(x, 'overview')).hits[0].title).toBe('Project Overview')
  })

  test('a new file becomes searchable by itself while the watch is on (no rescan is asked for)', async () => {
    // docs/V2-FEATURES.md promises "a new file is searchable within 3 s". The wait below is a hang cap, so the promise is held
    // here: the watcher waits this long after the last change before it rescans, and the rescan itself is quick.
    expect(WATCH_DEBOUNCE_MS).toBeLessThan(3000)
    const agent = makeAgent()
    const x = await start(agent)
    put(join(agent, 'notes'), 'fresh.md', '# Fresh\nzebrafish migration\n')
    // Waits on the watcher's real effect. The cap only ends a hang on a busy machine; how fast it is is not claimed.
    const t0 = Date.now()
    let found = false
    while (!found && Date.now() - t0 < 25_000) {
      found = (await search(x, 'zebrafish')).hits.length === 1
      if (!found) await new Promise((r) => setTimeout(r, 150))
    }
    expect(found).toBe(true)
  }, 30_000)

  test('with the watch off, a new file shows up on the 5-minute poll', async () => {
    const agent = makeAgent()
    const home = tempHome()
    cleanup.push(home)
    writeFileSync(join(home, 'memory.json'), JSON.stringify(memJson(agent)))
    const clock = fakeClock()
    const svc = new MemoryBrowser({ home, clock, log: nullLogger, switchOn: () => true, watch: false })
    await svc.idle()
    const q = (s: string) =>
      svc.search({
        ...mkFrame('memory.search'),
        request_id: newUlid(),
        q: s,
        root_ids: [],
        cursor: null,
        limit: 10,
      } as any)
    expect((await q('zebrafish')).hits).toEqual([])
    put(join(agent, 'notes'), 'fresh.md', '# Fresh\nzebrafish migration\n')
    clock.advance(60_000)
    await svc.idle()
    expect((await q('zebrafish')).hits).toEqual([])
    clock.advance(5 * 60_000)
    await svc.idle()
    expect((await q('zebrafish')).hits.length).toBe(1)
    // an edited file is re-indexed when its size or mtime changes
    put(join(agent, 'notes'), 'fresh.md', '# Fresh\nnarwhal migration, longer now\n')
    clock.advance(5 * 60_000)
    await svc.idle()
    expect((await q('zebrafish')).hits).toEqual([])
    expect((await q('narwhal')).hits.length).toBe(1)
    // a file that vanishes leaves the index
    rmSync(join(agent, 'notes/fresh.md'))
    clock.advance(5 * 60_000)
    await svc.idle()
    expect((await q('narwhal')).hits).toEqual([])
    svc.stop()
  })
})

// ---- refs ---------------------------------------------------------------------------------------------------------

describe('refs ([Ask agent])', () => {
  const sha = (agent: string, rel: string) =>
    createHash('sha256')
      .update(readFileSync(join(agent, 'notes', rel)))
      .digest('hex')
  const refOf = (agent: string, rel: string) => ({
    kind: 'memory',
    root_id: 'notes',
    path: rel,
    sha256: sha(agent, rel),
  })

  test('a message with refs -> memory_path (absolute); after an edit -> memory_changed; a now-excluded note is dropped with the note', async () => {
    const agent = makeAgent()
    const x = await start(agent)
    const ref = refOf(agent, 'projects/example/plan.md')
    await x.app.sendMessage('general', 'what about this?', { refs: [ref] })
    await x.waitNotes(1)
    const meta = x.notes[0]?.meta as Record<string, string>
    expect(meta.memory_root).toBe('notes')
    expect(meta.memory_path).toBe(join(require('node:fs').realpathSync(agent), 'notes/projects/example/plan.md'))
    expect(meta.memory_changed).toBeUndefined()
    // edited since the owner opened it
    put(join(agent, 'notes'), 'projects/example/plan.md', '# Plan\nChanged underneath you.\n')
    await x.app.sendMessage('general', 'again', { refs: [ref] })
    await x.waitNotes(2)
    expect((x.notes[1]!.meta as unknown as Record<string, string>).memory_changed).toBe('true')
    // excluded after the fact
    writeFileSync(
      join(x.home, 'memory.json'),
      JSON.stringify(memJson(agent, {}, { exclude: ['drafts/**', 'projects/**'] })),
    )
    await x.app.sendMessage('general', 'and now', { refs: [ref] })
    await x.waitNotes(3)
    expect((x.notes[2]!.meta as unknown as Record<string, string>).memory_path).toBeUndefined()
    expect(x.notes[2]?.content).toContain("That note isn't shared any more.")
  })

  test('a ref to a hidden note (private, .env) is dropped, never read', async () => {
    const agent = makeAgent()
    const x = await start(agent)
    for (const [i, rel] of ['private/Secret plan.md', '.env', '../outside.md'].entries()) {
      if (rel.startsWith('..')) continue
      await x.app.sendMessage('general', `try ${i}`, {
        refs: [{ kind: 'memory', root_id: 'notes', path: rel, sha256: 'a'.repeat(64) }],
      })
    }
    await x.waitNotes(2)
    for (const n of x.notes.slice(0, 2)) {
      expect((n.meta as Record<string, string>).memory_path).toBeUndefined()
      expect(n.content).toContain("That note isn't shared any more.")
    }
  })
})

// ---- read-only ----------------------------------------------------------------------------------------------------

function hashDir(dir: string): string {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const st = statSync(p)
      hash.update(`${p}\0${st.mtimeMs}\0${st.size}\0`)
      if (st.isDirectory()) walk(p)
      else hash.update(readFileSync(p))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

describe('no writes', () => {
  test("the agent dir's hash (names, sizes, mtimes, bytes) is unchanged after listing, reading, searching and refs", async () => {
    const agent = makeAgent()
    const before = hashDir(agent)
    const x = await start(agent)
    await tree(x)
    await tree(x, 'projects/example')
    await read(x, 'Overview.md')
    await search(x, 'release')
    await x.app.sendMessage('general', 'ref', { refs: [refOf2(agent)] })
    await x.waitNotes(1)
    expect(hashDir(agent)).toBe(before)
    // the index lives in the app home, not the agent dir
    expect(existsSync(join(x.home, 'memory-index.sqlite'))).toBe(true)
  })
  function refOf2(agent: string) {
    return {
      kind: 'memory',
      root_id: 'notes',
      path: 'Overview.md',
      sha256: createHash('sha256')
        .update(readFileSync(join(agent, 'notes/Overview.md')))
        .digest('hex'),
    }
  }
})

// ---- CLI ----------------------------------------------------------------------------------------------------------

describe('memory CLI', () => {
  const env = (home: string) => ({ home }) as any

  test('init asks per folder, then per subfolder, shows the hits, writes memory.json (0600) and turns both switches on', async () => {
    const agent = makeAgent()
    put(agent, 'other/x.md', 'x')
    const home = tempHome()
    cleanup.push(home)
    h = await startHarness({ home, startBridge: false })
    const answers = ['y', 'drafts, projects', 'n', 'y'] // notes: yes; exclude; other: no; write: yes
    const asked: string[] = []
    const out: string[] = []
    const code = await cmdMemory(h.bridge.ctx.env, ['init', '--agent-dir', agent], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      prompt: async (q) => {
        asked.push(q)
        return answers.shift() ?? ''
      },
    })
    expect(code).toBe(0)
    expect(asked[0]).toContain('notes')
    expect(asked.some((q) => q.includes('Exclude any?'))).toBe(true)
    const text = out.join('\n')
    expect(text).toContain('.talos-private')
    expect(text).toContain('denylist')
    const saved = JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8'))
    expect(saved.enabled).toBe(true)
    expect(saved.roots).toHaveLength(1)
    expect(saved.roots[0].path).toBe('notes')
    expect(saved.roots[0].exclude).toEqual(['drafts/**', 'projects/**'])
    expect(statSync(join(home, 'memory.json')).mode & 0o777).toBe(0o600)
    const cfg = new ConfigFile(join(home, 'config.json'))
    expect(cfg.load().memory_browser).toBe(true)
    const shown: string[] = []
    expect(await cmdMemory(h.bridge.ctx.env, ['show'], { out: (l) => shown.push(l), err: (l) => shown.push(l) })).toBe(
      0,
    )
    expect(shown.join('\n')).toContain('memory browser: ON')
    expect(shown.join('\n')).toContain('Overview.md')
    expect(shown.join('\n')).not.toContain('Launch checklist')
    expect(await cmdMemory(h.bridge.ctx.env, ['off'], { out: () => {}, err: () => {} })).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8')).enabled).toBe(false)
    expect(cfg.load().memory_browser).toBe(false)
    void env
  })

  test('agent_dir may not be /, $HOME or the app home; roots may not leave the agent dir', async () => {
    const home = tempHome()
    cleanup.push(home)
    const { parseMemoryConfig } = await import('../src/memory/config.ts')
    const base = { version: 1, enabled: true, roots: [] }
    expect(parseMemoryConfig({ ...base, agent_dir: '/' }, home).ok).toBe(false)
    expect(parseMemoryConfig({ ...base, agent_dir: require('node:os').homedir() }, home).ok).toBe(false)
    expect(parseMemoryConfig({ ...base, agent_dir: home }, home).ok).toBe(false)
    const agent = makeAgent()
    expect(
      parseMemoryConfig({ ...base, agent_dir: agent, roots: [{ id: 'x', label: 'x', path: '..' }] }, home).ok,
    ).toBe(false)
    // a symlinked root that resolves outside the agent dir
    const outside = tmp('talos-mem-outside-')
    symlinkSync(outside, join(agent, 'linked'))
    expect(
      parseMemoryConfig({ ...base, agent_dir: agent, roots: [{ id: 'x', label: 'x', path: 'linked' }] }, home).ok,
    ).toBe(false)
    expect(
      parseMemoryConfig({ ...base, agent_dir: agent, roots: [{ id: 'x', label: 'x', path: 'notes' }] }, home).ok,
    ).toBe(true)
  })

  test('on and off without a memory.json say to run init', async () => {
    const home = tempHome()
    cleanup.push(home)
    const lines: string[] = []
    expect(await cmdMemory({ home } as any, ['on'], { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('memory init')
    void utimesSync
  })
})

describe('memory reindex', () => {
  const quiet = () => {
    const lines: string[] = []
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }
  }
  const indexed = (home: string) => {
    const db = new Database(memoryIndexPath(home), { readonly: true })
    try {
      return (db.query('SELECT count(*) AS n FROM idx_files').get() as { n: number }).n
    } finally {
      db.close()
    }
  }

  test('with the memory browser off in memory.json it refuses plainly and leaves the index alone', async () => {
    const x = await start(makeAgent())
    const before = indexed(x.home)
    expect(before).toBeGreaterThan(0)
    expect(await cmdMemory(x.bridge.ctx.env, ['off'], { out: () => {}, err: () => {} })).toBe(0)
    const { lines, io } = quiet()
    expect(await cmdMemory(x.bridge.ctx.env, ['reindex'], io)).toBe(1)
    expect(lines.join('\n')).toContain('memory browser is off')
    expect(lines.join('\n')).toContain('talos-app memory on')
    expect(indexed(x.home)).toBe(before)
  })

  test('with the app switch off it refuses the same way', async () => {
    const x = await start(makeAgent())
    const before = indexed(x.home)
    new ConfigFile(join(x.home, 'config.json')).update((c) => ({ ...c, memory_browser: false }))
    const { lines, io } = quiet()
    expect(await cmdMemory(x.bridge.ctx.env, ['reindex'], io)).toBe(1)
    expect(lines.join('\n')).toContain('memory browser is off')
    expect(indexed(x.home)).toBe(before)
  })

  test('a live search never sees the index empty while it is rebuilt', async () => {
    const agent = makeAgent()
    for (let i = 0; i < 250; i++) put(agent, `notes/bulk/n${i}.md`, `# Bulk ${i}\nzzbulkword ${i}\n`)
    const x = await start(agent)
    const reader = new Database(memoryIndexPath(x.home), { readonly: true })
    const hits = () =>
      (reader.query("SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH 'zzbulkword'").get() as { n: number }).n
    expect(hits()).toBe(250)
    const { io } = quiet()
    let done = false
    const run = cmdMemory(x.bridge.ctx.env, ['reindex'], io).then((c) => {
      done = true
      return c
    })
    const seen: number[] = [hits()]
    // each turn of the loop is one yield of the rebuild (it yields every 100 notes); no clock is involved
    while (!done) {
      seen.push(hits())
      await new Promise((r) => setImmediate(r))
    }
    expect(await run).toBe(0)
    seen.push(hits())
    reader.close()
    expect(Math.min(...seen)).toBe(250)
    expect(seen.length).toBeGreaterThan(2)
  })

  describe('a rebuild that fails partway', () => {
    const bulkAgent = () => {
      const agent = makeAgent()
      for (let i = 0; i < 30; i++) put(agent, `notes/bulk/n${i}.md`, `# Bulk ${i}\nzzbulkword ${i}\n`)
      return agent
    }
    const ftsHits = (home: string) => {
      const db = new Database(memoryIndexPath(home), { readonly: true })
      try {
        return (db.query("SELECT count(*) AS n FROM mem_fts WHERE mem_fts MATCH 'zzbulkword'").get() as { n: number }).n
      } finally {
        db.close()
      }
    }
    const explode = (after: number) => ({
      afterNoteIndexed: (n: number) => {
        if (n === after) throw new Error('disk full (test)')
      },
    })

    test('the command fails with exit 1 and a plain line, and the live index is still complete', async () => {
      const x = await start(bulkAgent())
      const before = indexed(x.home)
      expect(ftsHits(x.home)).toBe(30)
      const { lines, io } = quiet()
      const code = await cmdMemory(x.bridge.ctx.env, ['reindex'], { ...io, serviceOptions: explode(10) })
      const text = lines.join('\n')
      expect(code).toBe(1)
      expect(text).toContain('The old index was kept')
      expect(text).not.toContain('Indexed')
      expect(indexed(x.home)).toBe(before)
      expect(ftsHits(x.home)).toBe(30)
      // no scratch index is left behind
      expect(existsSync(`${memoryIndexPath(x.home)}.new`)).toBe(false)
    })

    test('MemoryBrowser.reindex rejects instead of swapping in the half-built index', async () => {
      const x = await start(bulkAgent())
      const svc = new MemoryBrowser({
        home: x.home,
        clock: fakeClock(),
        log: nullLogger,
        switchOn: () => true,
        watch: false,
        ...explode(5),
      })
      await svc.idle()
      await expect(svc.reindex()).rejects.toThrow(/old index was kept/)
      svc.stop()
      expect(ftsHits(x.home)).toBe(30)
    })

    test('a scratch index that cannot be opened is said plainly, exits non-zero and changes nothing', async () => {
      const x = await start(bulkAgent())
      const before = indexed(x.home)
      // a real fault: the folder is read-only, so the new index file cannot be created beside the live one
      chmodSync(x.home, 0o500)
      try {
        const { lines, io } = quiet()
        const code = await cmdMemory(x.bridge.ctx.env, ['reindex'], io)
        const text = lines.join('\n')
        expect(code).toBe(1)
        expect(text).toContain('could not be opened')
        expect(text).not.toContain('Indexed')
      } finally {
        chmodSync(x.home, 0o700)
      }
      expect(indexed(x.home)).toBe(before)
      expect(ftsHits(x.home)).toBe(30)
    })
  })
})
