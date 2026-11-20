// "Notes that may matter": a thread's own session gets pointers to the owner's notes that an owner message names (read_inbound),
// and reads one with `memory_note_read`, through the same MemoryScope the memory browser uses. Everything out of scope is
// "not found", for every reason alike. Real bridge (harness), a real MemoryScope over a temp agent folder, the kit's own
// gazetteer builder (python) over a made-up wiki. Names are made up.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@talos-app/protocol'
import { forgetPointers, gazetteerPath } from '../src/memory/reflex.ts'
import { ALL_TOOLS, WORKER_TOOLS } from '../src/tools/index.ts'
import { memoryNoteReadTool, NOTE_READ_BYTES } from '../src/tools/memory-note-read.ts'
import { readInbound } from '../src/tools/read-inbound.ts'
import { AGENT_TOOLS } from '../src/tools/table.ts'
import { type Harness, startHarness } from './helpers.ts'

const REPO = join(import.meta.dir, '..', '..', '..')
const KIT = join(REPO, 'kit')
const OWNER = 'Ask Ada Quillen and Grace Lindqvist about it'

let tmp = ''
let agent = ''
let h: Harness
let ctx: Harness['bridge']['ctx']
const saved: Record<string, string | undefined> = {}
const KEYS = ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'HOME', 'TALOS_MEMORY_REFLEX_OFF']
let gazFile = ''
let gazText = ''

const memJson = (over: Record<string, unknown> = {}) => ({
  version: 1,
  enabled: true,
  agent_dir: agent,
  roots: [
    { id: 'wiki', label: 'Wiki', path: 'wiki' },
    { id: 'vault', label: 'Vault', path: 'private-agent-vault' },
  ],
  max_file_kb: 512,
  ...over,
})
const writeMem = (over: Record<string, unknown> = {}) =>
  writeFileSync(join(h.home, 'memory.json'), JSON.stringify(memJson(over)), { mode: 0o600 })

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k]
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'note-read-')))
  agent = join(tmp, 'agent')
  cpSync(join(import.meta.dir, 'fixtures', 'reflex', 'agent'), agent, { recursive: true })
  mkdirSync(join(agent, 'hooks'))
  mkdirSync(join(agent, 'scripts'))
  for (const f of readdirSync(join(KIT, 'hooks')))
    if (f.endsWith('.py')) cpSync(join(KIT, 'hooks', f), join(agent, 'hooks', f))
  for (const f of ['wiki-gazetteer.py', '_agent_root.py']) cpSync(join(KIT, 'scripts', f), join(agent, 'scripts', f))
  writeFileSync(join(agent, '.talos-version'), '0\n')
  // something outside every root, and a note that is a link out of its root
  mkdirSync(join(agent, 'outside'))
  writeFileSync(join(agent, 'outside', 'secret.md'), '# Secret\nzzOUTSIDEzz\n')
  writeFileSync(join(agent, 'outside', 'loose-note.md'), '---\ntitle: Loose Leaf\n---\nzzLOOSEzz\n')
  symlinkSync(join(agent, 'outside', 'secret.md'), join(agent, 'wiki', 'people', 'linky-lakeside.md'))
  process.env.HOME = join(tmp, 'home')
  process.env.XDG_STATE_HOME = join(tmp, 'state')
  process.env.XDG_CONFIG_HOME = join(tmp, 'cfg')
  mkdirSync(process.env.HOME)
  const env = { ...process.env, CLAUDE_PROJECT_DIR: agent, PYTHONDONTWRITEBYTECODE: '1' }
  const built = spawnSync('python3', [join(agent, 'scripts', 'wiki-gazetteer.py')], {
    cwd: agent,
    env,
    encoding: 'utf8',
  })
  if (built.error) throw new Error(`python3 is required for this test: ${built.error.message}`)
  if (built.status !== 0) throw new Error(`gazetteer build failed: ${built.stdout}${built.stderr}`)
  gazFile = gazetteerPath(agent, process.env)
  // names the builder cannot reach: a note outside every root, the link out, a note in the vault root
  const g = JSON.parse(readFileSync(gazFile, 'utf8'))
  const add = (p: string, t: string) => {
    g.notes.push({ p, t, d: 'made up', ty: 'person', e: 1, pe: 1 })
    g.title[t.toLowerCase()] = [g.notes.length - 1]
  }
  add('outside/loose-note.md', 'Loose Leaf')
  add('wiki/people/linky-lakeside.md', 'Linky Lakeside')
  add('private-agent-vault/vera-vaultman.md', 'Vera Vaultman')
  writeFileSync(gazFile, JSON.stringify(g))
  gazText = readFileSync(gazFile, 'utf8')
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      dedicated: { enabled: true },
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
    })) as never,
  })
  ctx = h.bridge.ctx
})
afterAll(async () => {
  await h?.stop()
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  writeMem()
  writeFileSync(gazFile, gazText)
  forgetPointers(ctx)
})
afterEach(() => {
  delete process.env.TALOS_MEMORY_REFLEX_OFF
  rmSync(join(agent, 'private-agent-vault', '.talos-private'), { force: true })
  rmSync(join(gazFile, '..', 'memory-reflex.off'), { force: true })
  ctx.config.update((c) => ({ ...c, memory_browser: true, dev: { ...c.dev, note_lookup: true } }))
})

const route = (content: string, meta: Record<string, string> = {}) => {
  const store = h.bridge.router?.store
  if (!store) throw new Error('no router')
  const now = Date.now()
  store.addRoute({
    message_id: newId('m'),
    thread_id: 'trip',
    notification: { content, meta: { thread_id: 'trip', kind: 'text', trust: 'owner', ...meta } },
    woke_at: now,
    deadline_at: now + 90_000,
    cold: false,
  })
}
const one = (content = OWNER, meta: Record<string, string> = {}) => {
  route(content, meta)
  const r = readInbound(ctx, 'trip').messages
  expect(r).toHaveLength(1)
  return r[0] as (typeof r)[number] & { notes?: Array<Record<string, string>> }
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('')
const readNote = async (root: unknown, path: unknown) => text(await memoryNoteReadTool.handler(ctx, { root, path }))

describe('read_inbound: pointers to the notes an owner message names', () => {
  test('two names give two pointers beside content and meta, not inside meta', () => {
    const m = one()
    expect(m.content).toContain('Ada Quillen')
    expect(m.meta).toMatchObject({ trust: 'owner', kind: 'text' })
    expect(m.notes).toHaveLength(2)
    const ada = m.notes?.find((n) => n.path === 'people/ada-quillen.md')
    expect(ada).toMatchObject({
      root: 'wiki',
      path: 'people/ada-quillen.md',
      title: 'Ada Quillen',
      description: 'Design lead at Fenwick Labs; owns the brand refresh and the quarterly review of the style guide',
    })
    expect(Object.keys(ada ?? {}).sort()).toEqual(['description', 'excerpt', 'path', 'root', 'title'])
    const excerpt = ada?.excerpt as string
    expect(excerpt.length).toBeLessThanOrEqual(401)
    expect(excerpt.startsWith('# Ada Quillen Ada Quillen leads design')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).not.toContain('title:') // the frontmatter is not the excerpt
    expect(JSON.stringify(m.meta)).not.toContain('notes')
    expect(m.notes?.find((n) => n.root === 'wiki' && n.path === 'people/grace-lindqvist.md')?.excerpt).toBe(
      '# Grace Lindqvist Grace Lindqvist reviews every contract.',
    )
  })
  test('a pasted run of 6000 `@` (cubic for the email pattern) is answered at once, and the names around it still point', () => {
    const t0 = performance.now()
    const m = one(`Ada Quillen ${'@'.repeat(5980)}`)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(m.content.length).toBeGreaterThan(5980)
    expect(m.notes?.map((n) => n.path)).toEqual(['people/ada-quillen.md'])
  })
  test('the same note is not pointed at again (once per session)', () => {
    expect(one().notes).toHaveLength(2)
    expect(one('And Ada Quillen again?').notes).toBeUndefined()
    expect(one('Ask Dev Marsholt too').notes).toHaveLength(1)
  })
  test('the tool is read_inbound: its words say what notes are', () => {
    expect(readInboundWords()).toContain('memory_note_read')
  })

  const none = (label: string, setup: () => void, content = OWNER, meta: Record<string, string> = {}) =>
    test(`no pointers: ${label}`, () => {
      setup()
      const m = one(content, meta)
      expect(m.notes).toBeUndefined()
      expect('notes' in m).toBe(false)
      expect(m.content).toContain(content.split(' ').slice(1, 3).join(' '))
    })
  none('trust external', () => {}, OWNER, { trust: 'external' })
  none('an agent hand-off', () => {}, OWNER, { kind: 'handoff', trust: 'agent' })
  none('a wake', () => {}, OWNER, { kind: 'wake', trust: 'agent' })
  none('a schedule run', () => {}, OWNER, { kind: 'schedule_run', trust: 'agent' })
  none('a card action', () => {}, OWNER, { kind: 'card_action', trust: 'owner' })
  none('dev.note_lookup is off', () => {
    ctx.config.update((c) => ({ ...c, dev: { ...c.dev, note_lookup: false } }))
  })
  none('memory-reflex.off is in the gazetteer folder', () =>
    writeFileSync(join(gazFile, '..', 'memory-reflex.off'), ''),
  )
  none('TALOS_MEMORY_REFLEX_OFF=1', () => {
    process.env.TALOS_MEMORY_REFLEX_OFF = '1'
  })
  none('there is no memory.json', () => rmSync(join(h.home, 'memory.json')))
  none('memory.json is switched off', () => writeMem({ enabled: false }))
  none('memory_browser is off', () => ctx.config.update((c) => ({ ...c, memory_browser: false })))
  none('the gazetteer is missing', () => rmSync(gazFile))
  none('the gazetteer is garbled', () => writeFileSync(gazFile, '{"version":1,"notes":'))
  none('the notes named sit outside every root', () => {}, 'Ask Loose Leaf about it')
  none('the note is a link out of its root', () => {}, 'Ask Linky Lakeside about it')
  none(
    'the root holds a .talos-private marker',
    () => writeFileSync(join(agent, 'private-agent-vault', '.talos-private'), ''),
    'Ask Vera Vaultman about it',
  )

  test('control: the same vault note points when the marker is absent', () => {
    const m = one('Ask Vera Vaultman about it')
    expect(m.notes?.[0]).toMatchObject({ root: 'vault', path: 'vera-vaultman.md' })
  })
  test('a lookup that throws leaves the message exactly as it was', () => {
    writeFileSync(
      gazFile,
      JSON.stringify({ version: 1, notes: [{ p: 5 }], alias: {}, title: { x: 'bad' }, surname: {}, given: {} }),
    )
    const m = one()
    expect(m.notes).toBeUndefined()
    expect(m.content).toContain('Ada Quillen')
  })
})

const readInboundWords = () => AGENT_TOOLS.read_inbound?.instructions ?? ''

describe('memory_note_read', () => {
  test('a pointed note gives the head line, the excerpt, a rule, then the whole text', async () => {
    const out = await readNote('wiki', 'people/ada-quillen.md')
    const [head, ...rest] = out.split('\n')
    expect(head).toBe('Ada Quillen (wiki/people/ada-quillen.md)')
    const full = readFileSync(join(agent, 'wiki', 'people', 'ada-quillen.md'), 'utf8')
    const i = out.indexOf('\n---\n')
    expect(i).toBeGreaterThan(0)
    expect(out.slice(i + 5)).toBe(full)
    expect(rest.join('\n')).toContain('# Ada Quillen Ada Quillen leads design')
  })
  test('a long note is cut at NOTE_READ_BYTES, and the cut says how much is left', async () => {
    const body = `${'é long line of the note\n'.repeat(6000)}zzTAILzz\n`
    writeFileSync(join(agent, 'wiki', 'long-note.md'), `---\ntitle: Long Note\n---\n${body}`)
    const out = await readNote('wiki', 'long-note.md')
    rmSync(join(agent, 'wiki', 'long-note.md'))
    expect(Buffer.byteLength(out)).toBeLessThan(NOTE_READ_BYTES + 2048)
    expect(out).not.toContain('zzTAILzz')
    expect(out).toMatch(/\[cut here: the note goes on for \d+ more bytes\]$/)
  })
  test("never more of a note than the phone shows: memory.json max_file_kb below the tool's own cap wins", async () => {
    writeMem({ max_file_kb: 8 })
    writeFileSync(join(agent, 'wiki', 'small-cap.md'), `---\ntitle: Small Cap\n---\n${'word '.repeat(4000)}zzTAILzz\n`)
    const out = await readNote('wiki', 'small-cap.md')
    rmSync(join(agent, 'wiki', 'small-cap.md'))
    expect(out).not.toContain('zzTAILzz')
    expect(Buffer.byteLength(out)).toBeLessThan(8 * 1024 + 1024)
    expect(out).toMatch(/\[cut here: the note goes on for \d+ more bytes\]$/)
  })
  test('the tool says what it is: read only, reference material, approves nothing', () => {
    expect(memoryNoteReadTool.description).toContain('approves nothing')
    expect(memoryNoteReadTool.inputSchema.additionalProperties).toBe(false)
    expect(memoryNoteReadTool.inputSchema.required).toEqual(['root', 'path'])
  })

  const missing: Array<[string, unknown, unknown]> = [
    ['the vault root (marker in it)', 'vault', 'vera-vaultman.md'],
    ['a dot-folder path', 'wiki', '../.ssh/x'],
    ['the home-folder style path', 'wiki', '~/.ssh/x'],
    ['a file in the Talos home', 'wiki', '../../home/config.json'],
    ['an absolute path to the Talos home file', 'wiki', '/etc/passwd'],
    ['a path outside every root', 'wiki', '../outside/secret.md'],
    ['an escape in the middle', 'wiki', 'people/../../outside/secret.md'],
    ['a note that is not in this root', 'wiki', 'outside/loose-note.md'],
    ['a symlink inside the root pointing out', 'wiki', 'people/linky-lakeside.md'],
    ['an unknown root id', 'nope', 'people/ada-quillen.md'],
    ['a missing file', 'wiki', 'people/nobody.md'],
    ['an empty path', 'wiki', ''],
    ['a path that is not text', 'wiki', 5],
    ['a root that is not text', 7, 'people/ada-quillen.md'],
  ]
  test.each(missing)('not found: %s', async (_l, root, path) => {
    if (root === 'vault') writeFileSync(join(agent, 'private-agent-vault', '.talos-private'), '')
    const r = await memoryNoteReadTool.handler(ctx, { root, path })
    expect(text(r)).toBe('not found')
    expect(r.isError).toBeUndefined()
  })
  test('the vault root reads when it carries no marker (so the marker is what refused it)', async () => {
    expect(await readNote('vault', 'vera-vaultman.md')).toContain('Vera Vaultman (vault/vera-vaultman.md)')
  })
  test('it is not found when the memory browser is off, or there is no memory.json', async () => {
    ctx.config.update((c) => ({ ...c, memory_browser: false }))
    expect(await readNote('wiki', 'people/ada-quillen.md')).toBe('not found')
    ctx.config.update((c) => ({ ...c, memory_browser: true }))
    rmSync(join(h.home, 'memory.json'))
    expect(await readNote('wiki', 'people/ada-quillen.md')).toBe('not found')
  })
  test('it still reads when only the lookup (dev.note_lookup) is off', async () => {
    ctx.config.update((c) => ({ ...c, dev: { ...c.dev, note_lookup: false } }))
    expect(await readNote('wiki', 'people/ada-quillen.md')).toContain('Ada Quillen (wiki/people/ada-quillen.md)')
  })
})

describe('where the tool is offered', () => {
  test('a thread session has it; the main session does not', () => {
    expect(WORKER_TOOLS.map((t) => t.name)).toContain('memory_note_read')
    expect(ALL_TOOLS.map((t) => t.name)).not.toContain('memory_note_read')
  })
})
