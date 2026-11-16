// Which folders Memory's Notes show, picked in Settings (src/memory/roots.ts). The Mac lists the agent folder's own folders
// by name, writes memory.json the way `talos-app memory init` does, and takes only names from its own listing: a path, "..",
// a look-alike or a folder that is not there is refused before anything is joined or written. Roots it cannot show (a nested
// path) are kept on a save, and a memory.json with a mistake is never overwritten. Neutral folder names only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_ROOTS_WORDING } from '@talos-app/protocol'
import { memoryJsonPath } from '../src/memory/config.ts'
import { MemoryRoots } from '../src/memory/roots.ts'

let dir: string
let home: string
let agent: string
let switchOn = false
let roots: MemoryRoots

const note = (rel: string) => {
  mkdirSync(join(agent, rel, '..'), { recursive: true })
  writeFileSync(join(agent, rel), '# a note\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memroots-'))
  home = join(dir, 'home')
  agent = join(dir, 'agent')
  mkdirSync(home)
  mkdirSync(agent)
  note('notes/one.md')
  note('notes/two.md')
  note('journal/day.md')
  mkdirSync(join(agent, '.git'))
  mkdirSync(join(agent, 'empty'))
  switchOn = false
  roots = new MemoryRoots({
    home,
    agentDir: () => agent,
    switchIsOn: () => switchOn,
    switchOn: () => {
      switchOn = true
    },
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const written = () => JSON.parse(readFileSync(memoryJsonPath(home), 'utf8'))

describe('the folder list', () => {
  test('names and note counts of the agent folder’s own folders; hidden folders left out; no path', () => {
    const b = roots.list()
    expect(b.folders).toEqual([
      { name: 'empty', notes: 0 },
      { name: 'journal', notes: 1 },
      { name: 'notes', notes: 2 },
    ])
    expect(b.chosen).toEqual([])
    expect(b.enabled).toBe(false)
    expect(JSON.stringify(b)).not.toContain(dir)
  })

  test('no agent folder known: says so, lists nothing', () => {
    const none = new MemoryRoots({ home, agentDir: () => undefined, switchIsOn: () => false, switchOn: () => {} })
    expect(none.list()).toMatchObject({ folders: [], error: MEMORY_ROOTS_WORDING.notSetUp })
  })
})

describe('saving a choice', () => {
  test('writes memory.json like memory init and turns Memory on', async () => {
    const b = await roots.set(['notes', 'journal'])
    expect(b).toMatchObject({ saved: true, chosen: ['notes', 'journal'], enabled: true })
    const cfg = written()
    expect(cfg).toMatchObject({ version: 1, enabled: true, max_file_kb: 512 })
    expect(cfg.roots.map((r: { path: string; id: string }) => [r.path, r.id])).toEqual([
      ['notes', 'notes'],
      ['journal', 'journal'],
    ])
    expect(switchOn).toBe(true)
  })

  test('a folder kept keeps its id and excludes; a new one is added', async () => {
    await roots.set(['notes'])
    const cfg = written()
    cfg.roots[0].exclude = ['drafts/**']
    writeFileSync(memoryJsonPath(home), JSON.stringify(cfg))
    await roots.set(['journal', 'notes'])
    const again = written()
    expect(again.roots.find((r: { path: string }) => r.path === 'notes').exclude).toEqual(['drafts/**'])
  })

  test('an empty choice turns Notes off and leaves the switch alone', async () => {
    await roots.set(['notes'])
    switchOn = true
    const b = await roots.set([])
    expect(b).toMatchObject({ saved: true, chosen: [] })
    expect(written().enabled).toBe(false)
  })

  test.each([
    ['a parent', '..'],
    ['a path', 'notes/../..'],
    ['an absolute path', '/etc'],
    ['a hidden folder', '.git'],
    ['a folder that is not there', 'missing'],
    ['a look-alike of a real one', 'nоtes'], // Cyrillic o
  ])('%s is refused and nothing is written', async (_why, name) => {
    const b = await roots.set(['notes', name])
    expect(b).toMatchObject({ error: MEMORY_ROOTS_WORDING.unknown })
    expect(b.saved).toBeUndefined()
    expect(existsSync(memoryJsonPath(home))).toBe(false)
    expect(switchOn).toBe(false)
  })

  test('a folder that is a link out of the agent folder is not offered and cannot be picked', async () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(agent, 'linked'))
    expect(roots.list().folders.map((f) => f.name)).not.toContain('linked')
    expect(await roots.set(['linked'])).toMatchObject({ error: MEMORY_ROOTS_WORDING.unknown })
  })

  test('a nested root from a hand-written memory.json is kept on a save, and never shown as picked', async () => {
    note('notes/deep/inner.md')
    await roots.set(['notes'])
    const cfg = written()
    cfg.roots.push({ id: 'deep', label: 'deep', path: 'notes/deep', include: ['**/*.md'], exclude: [] })
    writeFileSync(memoryJsonPath(home), JSON.stringify(cfg))
    expect(roots.list().chosen).toEqual(['notes'])
    await roots.set(['journal'])
    const after = written().roots.map((r: { path: string }) => r.path)
    expect(after).toEqual(['notes/deep', 'journal'])
  })

  test('a memory.json with a mistake is never overwritten: the owner is told to fix it at the Mac', async () => {
    writeFileSync(memoryJsonPath(home), JSON.stringify({ version: 1, enabled: true, agent_dir: agent, roots: 'x' }))
    expect(roots.list()).toMatchObject({ error: MEMORY_ROOTS_WORDING.broken, folders: [] })
    expect(await roots.set(['notes'])).toMatchObject({ error: MEMORY_ROOTS_WORDING.broken })
    expect(JSON.parse(readFileSync(memoryJsonPath(home), 'utf8')).roots).toBe('x')
  })

  test('an agent folder that is the home folder lists nothing (the same check a save makes)', () => {
    const atHome = new MemoryRoots({
      home,
      agentDir: () => process.env.HOME,
      switchIsOn: () => false,
      switchOn: () => {},
    })
    expect(atHome.list()).toMatchObject({ folders: [], error: MEMORY_ROOTS_WORDING.notSetUp })
  })
})
