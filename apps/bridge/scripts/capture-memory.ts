#!/usr/bin/env bun
// `bun run capture:memory [--check]` (docs/V2-FEATURES.md V5.4, V8). Runs the REAL memory service over a SYNTHETIC notes
// folder made in a temp dir (nothing from anyone's real notes) and writes the answers it gives as frames, with fixed
// ids and times, to packages/testkit/fixtures/captured/memory/. The web specs replay them; the relay suite replays the
// near-cap ones through the real relay to prove it never hangs up on them. `--check` re-runs and fails on any difference.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_FRAME_BYTES, MEMORY_FRAME_SLACK, parseFrame } from '@talos-app/protocol'
import { realClock } from '../src/clock.ts'
import { nullLogger } from '../src/log.ts'
import { MemoryBrowser } from '../src/memory/service.ts'
import { ReadError } from '../src/v2-seams.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const MEMORY_CAPTURE_DIR = join(REPO, 'packages', 'testkit', 'fixtures', 'captured', 'memory')
const FIXED = Date.parse('2026-10-20T12:00:00.000Z')
const ENV = (type: string, rid: string, n: number) => ({
  v: 1,
  id: `01J0000000000000000000${String(n).padStart(4, '0')}`,
  ts: '2026-10-29T12:00:00.000Z',
  type,
  request_id: rid,
})
const rid = (n: number) => `01J1000000000000000000${String(n).padStart(4, '0')}`

function put(root: string, rel: string, body: string) {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, body)
  utimesSync(f, FIXED / 1000, FIXED / 1000)
}

function world() {
  const agent = mkdtempSync(join(tmpdir(), 'talos-capture-mem-'))
  const n = join(agent, 'notes')
  put(
    n,
    'Overview.md',
    '---\ntitle: Project Overview\nstatus: draft\ntags: [alpha, beta]\n---\n# Overview\nSee [[Launch checklist]], [[Secret plan]], [[Missing note]] and [the plan](projects/example/plan.md).\n\n<script>alert(1)</script>\n\n```\n[[Not a link]]\n```\n',
  )
  put(n, 'projects/example/plan.md', '# Plan\nShip the quarterly release on Friday. Back to [[Overview]].\n')
  put(n, 'projects/example/Launch checklist.md', '# Launch checklist\n- backups\n- banner\n- release notes\n')
  put(n, 'drafts/Drafty.md', '# Drafty\nexcluded draft\n')
  put(n, 'private/Secret plan.md', '# Secret plan\nprivate\n')
  put(n, 'private/.talos-private', '')
  put(n, 'page.html', '<h1>Source</h1><script>alert(1)</script>\n')
  // 500 long names in one folder (listing paging)
  const dir = 'd'.repeat(144)
  for (let i = 0; i < 500; i++) put(n, `${dir}/${String(i).padStart(4, '0')}${'n'.repeat(248)}.md`, '# t\n')
  // a 192 KiB note of quotes and newlines with 200 long links
  let big = `# Big note\n${Array.from({ length: 200 }, (_, i) => `[[${'L'.repeat(150)}${i}]]`).join(' ')}\n`
  while (Buffer.byteLength(big) < 192 * 1024) big += '"q" \\ "\n"é "\n'
  put(n, 'big/Big note.md', big)
  const home = mkdtempSync(join(tmpdir(), 'talos-capture-home-'))
  writeFileSync(
    join(home, 'memory.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      agent_dir: agent,
      roots: [
        { id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md', '**/*.html'], exclude: ['drafts/**'] },
      ],
      max_file_kb: 512,
    }),
  )
  return { agent, home, dir }
}

const FRAME_CAP = MAX_FRAME_BYTES - MEMORY_FRAME_SLACK

export async function capture(): Promise<Record<string, unknown>> {
  const w = world()
  const svc = new MemoryBrowser({ home: w.home, clock: realClock, log: nullLogger, switchOn: () => true, watch: false })
  await svc.idle()
  const files: Record<string, unknown> = {}
  let n = 0
  const frames: Array<Record<string, unknown>> = []
  const ok = async (type: string, answer: string, fn: () => Promise<Record<string, unknown>>) => {
    const r = rid(++n)
    const body = await fn()
    const f = { ...ENV(answer, r, n), ...body }
    const p = parseFrame(f, { direction: 'bridge_to_relay' } as never)
    if (!p.ok) throw new Error(`${answer} does not parse: ${JSON.stringify((p as { error?: unknown }).error ?? p)}`)
    frames.push({ asked: type, frame: f })
  }
  const q = (type: string, extra: Record<string, unknown>) => ({ ...ENV(type, rid(n + 1), n + 1), ...extra }) as never
  const scenario = async (name: string, run: () => Promise<void>) => {
    frames.length = 0
    await run()
    files[`${name}.json`] = { scenario: name, frames: [...frames] }
  }
  await scenario('01-roots-and-top', async () => {
    await ok(
      'memory.tree',
      'memory.listing',
      () => svc.tree(q('memory.tree', { root_id: null, path: '', cursor: null })) as never,
    )
    await ok(
      'memory.tree',
      'memory.listing',
      () => svc.tree(q('memory.tree', { root_id: 'notes', path: '', cursor: null })) as never,
    )
    await ok(
      'memory.tree',
      'memory.listing',
      () => svc.tree(q('memory.tree', { root_id: 'notes', path: 'projects/example', cursor: null })) as never,
    )
  })
  await scenario('02-note-links-frontmatter', async () => {
    await ok(
      'memory.read',
      'memory.file',
      () => svc.read(q('memory.read', { root_id: 'notes', path: 'Overview.md', offset: 0 })) as never,
    )
    await ok(
      'memory.read',
      'memory.file',
      () => svc.read(q('memory.read', { root_id: 'notes', path: 'page.html', offset: 0 })) as never,
    )
  })
  await scenario('03-search', async () => {
    await ok(
      'memory.search',
      'memory.results',
      () => svc.search(q('memory.search', { q: 'quarterly release', root_ids: [], cursor: null, limit: 20 })) as never,
    )
    await ok(
      'memory.search',
      'memory.results',
      () => svc.search(q('memory.search', { q: 'zzznothing', root_ids: [], cursor: null, limit: 20 })) as never,
    )
  })
  await scenario('04-listing-pages', async () => {
    let cursor: string | null = null
    for (let i = 0; i < 6; i++) {
      const c = cursor
      let next: string | null = null
      await ok('memory.tree', 'memory.listing', async () => {
        const b = await svc.tree(q('memory.tree', { root_id: 'notes', path: w.dir, cursor: c }))
        next = b.next_cursor
        return b as never
      })
      cursor = next
      if (!cursor) break
    }
  })
  await scenario('05-big-note-chunks', async () => {
    let offset = 0
    for (let i = 0; i < 8; i++) {
      const o = offset
      let next: number | null = null
      await ok('memory.read', 'memory.file', async () => {
        const b = await svc.read(q('memory.read', { root_id: 'notes', path: 'big/Big note.md', offset: o }))
        next = b.next_offset
        return b as never
      })
      if (next === null) break
      offset = next
    }
  })
  await scenario('06-refusals', async () => {
    for (const [type, fields] of [
      ['memory.read', { root_id: 'notes', path: 'private/Secret plan.md', offset: 0 }],
      ['memory.read', { root_id: 'notes', path: 'drafts/Drafty.md', offset: 0 }],
      ['memory.tree', { root_id: 'notes', path: 'private', cursor: null }],
    ] as const) {
      try {
        if (type === 'memory.read') await svc.read(q(type, fields))
        else await svc.tree(q(type, fields))
        throw new Error('hidden path was readable')
      } catch (e) {
        if (!(e instanceof ReadError)) throw e
        frames.push({ asked: type, error: { code: e.code } })
      }
    }
  })
  // every answer frame stays under the cap the relay enforces
  for (const [name, f] of Object.entries(files))
    for (const x of (f as { frames: Array<{ frame?: unknown }> }).frames)
      if (x.frame && Buffer.byteLength(JSON.stringify(x.frame)) > FRAME_CAP)
        throw new Error(`${name}: a frame is over the cap`)
  svc.stop()
  rmSync(w.agent, { recursive: true, force: true })
  rmSync(w.home, { recursive: true, force: true })
  const index = {
    about:
      'Captured by `bun run capture:memory` (apps/bridge/scripts/capture-memory.ts): the REAL memory service over a synthetic notes folder. Do not edit by hand: re-run the capture.',
    scenarios: Object.entries(files).map(([file, f]) => ({ file, frames: (f as { frames: unknown[] }).frames.length })),
  }
  return { ...files, 'index.json': index }
}

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

if (import.meta.main) {
  const files = await capture()
  if (process.argv.includes('--check')) {
    const diff: string[] = []
    for (const [name, v] of Object.entries(files)) {
      const p = join(MEMORY_CAPTURE_DIR, name)
      if (!existsSync(p) || readFileSync(p, 'utf8') !== text(v)) diff.push(name)
    }
    for (const name of existsSync(MEMORY_CAPTURE_DIR) ? readdirSync(MEMORY_CAPTURE_DIR) : [])
      if (!(name in files) && name !== 'review-xss.json') diff.push(`${name} (stale)`)
    if (diff.length) {
      console.error(`capture:memory --check: out of date:\n- ${diff.join('\n- ')}`)
      process.exit(1)
    }
    console.log(`capture:memory --check: ${Object.keys(files).length} files match.`)
  } else {
    mkdirSync(MEMORY_CAPTURE_DIR, { recursive: true })
    for (const [name, v] of Object.entries(files)) writeFileSync(join(MEMORY_CAPTURE_DIR, name), text(v))
    console.log(`capture:memory: wrote ${Object.keys(files).length} files to ${MEMORY_CAPTURE_DIR}`)
  }
}
void symlinkSync
