// `talos-app memory set-root <name> <path>`: share one folder. Creates memory.json with only that root when there is none,
// otherwise adds or updates that one root and leaves the owner's other roots alone. A broken file is never overwritten.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'
import { cmdMemory, MEMORY_USAGE } from '../src/memory/cli.ts'
import { startHarness, tempHome } from './helpers.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  made.push(d)
  return d
}
const io = () => {
  const lines: string[] = []
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }
}
const agentWith = (...dirs: string[]) => {
  const agent = realpathSync(tmp('talos-set-root-agent-'))
  for (const d of dirs) mkdirSync(join(agent, d), { recursive: true })
  return agent
}
const cfgFile = (agent: string, roots: unknown[]) => ({
  version: 1,
  enabled: true,
  agent_dir: agent,
  roots,
  max_file_kb: 512,
})
const root = (id: string, path: string) => ({ id, label: id, path, include: ['**/*.md'], exclude: ['x/**'] })
const memoryJson = (home: string) => join(home, 'memory.json')

describe('memory set-root', () => {
  test('(a) no memory.json: it is created with exactly this root, 0600, enabled, and the switch goes on', async () => {
    const home = tempHome()
    made.push(home)
    const h = await startHarness({ home, startBridge: false })
    try {
      const agent = agentWith('memory/journal', 'wiki')
      const o = io()
      const args = ['set-root', 'journal', 'memory/journal', '--agent-dir', agent]
      expect(await cmdMemory(h.bridge.ctx.env, args, o.io)).toBe(0)
      const saved = JSON.parse(readFileSync(memoryJson(home), 'utf8'))
      expect(saved.enabled).toBe(true)
      expect(saved.roots).toHaveLength(1)
      expect(saved.roots[0]).toMatchObject({ id: 'journal', label: 'journal', path: 'memory/journal' })
      expect(statSync(memoryJson(home)).mode & 0o777).toBe(0o600)
      expect(new ConfigFile(join(home, 'config.json')).load().memory_browser).toBe(true)
      expect(o.lines.join('\n')).toContain('the only folder shared')
    } finally {
      await h.stop()
    }
  })

  test('(b) roots memory + wiki: set-root journal memory/journal adds a third and keeps both', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory/journal', 'wiki')
    const roots = [root('memory', 'memory'), root('wiki', 'wiki')]
    writeFileSync(memoryJson(home), JSON.stringify(cfgFile(agent, roots)))
    expect(await cmdMemory({ home } as never, ['set-root', 'journal', 'memory/journal'], io().io)).toBe(0)
    const saved = JSON.parse(readFileSync(memoryJson(home), 'utf8'))
    expect(saved.roots.map((r: { id: string }) => r.id)).toEqual(['memory', 'wiki', 'journal'])
    expect(saved.roots[0]).toMatchObject({ include: ['**/*.md'], exclude: ['x/**'] })
    expect(saved.roots[2].path).toBe('memory/journal')
  })

  test('(c) a root named by label is updated: id, label, include and exclude stay, the path changes', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory', 'notes')
    writeFileSync(memoryJson(home), JSON.stringify(cfgFile(agent, [root('memory', 'memory')])))
    expect(await cmdMemory({ home } as never, ['set-root', 'memory', 'notes'], io().io)).toBe(0)
    const saved = JSON.parse(readFileSync(memoryJson(home), 'utf8'))
    expect(saved.roots).toHaveLength(1)
    expect(saved.roots[0]).toEqual(root('memory', 'notes'))
  })

  test('(d) a broken memory.json: exit 1 and the bytes are untouched', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory')
    writeFileSync(memoryJson(home), '{ not json')
    const o = io()
    expect(await cmdMemory({ home } as never, ['set-root', 'memory', 'memory', '--agent-dir', agent], o.io)).toBe(1)
    expect(readFileSync(memoryJson(home), 'utf8')).toBe('{ not json')
    expect(o.lines.join('\n')).toContain('not changed')
  })

  test('(e) a path outside the agent folder, absolute or ../x: exit 1, nothing written', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory')
    const outside = realpathSync(tmp('talos-set-root-outside-'))
    mkdirSync(join(agent, '..', 'x'), { recursive: true })
    try {
      for (const p of [outside, '../x']) {
        const o = io()
        expect(await cmdMemory({ home } as never, ['set-root', 'bad', p, '--agent-dir', agent], o.io)).toBe(1)
        expect(o.lines.join('\n')).toContain('inside the agent folder')
        expect(() => statSync(memoryJson(home))).toThrow()
      }
    } finally {
      rmSync(join(agent, '..', 'x'), { recursive: true, force: true })
    }
  })

  test('(f) a path that does not exist: exit 1, nothing written', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory')
    expect(await cmdMemory({ home } as never, ['set-root', 'nope', 'nope', '--agent-dir', agent], io().io)).toBe(1)
    expect(() => statSync(memoryJson(home))).toThrow()
  })

  test('(g) missing args: exit 2 and the usage', async () => {
    const home = tempHome()
    made.push(home)
    for (const args of [['set-root'], ['set-root', 'only-name']]) {
      const o = io()
      expect(await cmdMemory({ home } as never, args, o.io)).toBe(2)
      expect(o.lines.join('\n')).toContain(MEMORY_USAGE)
    }
  })

  test('an --agent-dir that differs from the file is refused (exit 2), the file unchanged', async () => {
    const home = tempHome()
    made.push(home)
    const agent = agentWith('memory')
    const other = agentWith('memory')
    const body = JSON.stringify(cfgFile(agent, [root('memory', 'memory')]))
    writeFileSync(memoryJson(home), body)
    const o = io()
    expect(await cmdMemory({ home } as never, ['set-root', 'memory', 'memory', '--agent-dir', other], o.io)).toBe(2)
    expect(o.lines.join('\n')).toContain(agent)
    expect(readFileSync(memoryJson(home), 'utf8')).toBe(body)
  })
})
