// `talos-app memory init --defaults`: what the installers run so a new owner's phone can browse their memory with no
// questions. It shares memory/ and wiki/ when they are real folders, never replaces an owner's memory.json (even a broken
// one), never follows a link out of the agent folder, and turns the app's switch on only when the app's config exists.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'
import { cmdMemory } from '../src/memory/cli.ts'
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
const put = (root: string, rel: string, body = `# ${rel}\n`) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body)
}
const io = () => {
  const lines: string[] = []
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }
}
/** A new agent folder the way the kit leaves it: memory/ and wiki/ side by side, plus things that are not memory. */
function newAgent() {
  const agent = tmp('talos-mem-defaults-agent-')
  put(agent, 'memory/HANDOFF.md')
  put(agent, 'memory/2026-11-15.md')
  put(agent, 'wiki/README.md')
  put(agent, 'scripts/recall.py', 'print(1)\n')
  return agent
}

describe('memory init --defaults', () => {
  test('no questions: memory and wiki are shared, memory.json is 0600, and the browser switch goes on', async () => {
    const home = tempHome()
    made.push(home)
    // the app's config exists (the bridge was set up), so the switch can be turned on
    const h = await startHarness({ home, startBridge: false })
    try {
      const agent = newAgent()
      const o = io()
      // no prompt at all: an installer has no terminal to ask on
      expect(await cmdMemory(h.bridge.ctx.env, ['init', '--defaults', '--agent-dir', agent], o.io)).toBe(0)
      const saved = JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8'))
      expect(saved.enabled).toBe(true)
      expect(saved.roots.map((r: { path: string }) => r.path)).toEqual(['memory', 'wiki'])
      expect(statSync(join(home, 'memory.json')).mode & 0o777).toBe(0o600)
      expect(new ConfigFile(join(home, 'config.json')).load().memory_browser).toBe(true)
      expect(o.lines.join('\n')).toContain('memory and wiki shared with the app, and the browser is on')
    } finally {
      await h.stop()
    }
  })

  test('only the folders that are there: an agent with memory/ and no wiki/ shares memory/ alone', async () => {
    const home = tempHome()
    made.push(home)
    const agent = tmp('talos-mem-defaults-agent-')
    put(agent, 'memory/HANDOFF.md')
    const o = io()
    expect(await cmdMemory({ home } as never, ['init', '--defaults', '--agent-dir', agent], o.io)).toBe(0)
    const saved = JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8'))
    expect(saved.roots.map((r: { path: string }) => r.path)).toEqual(['memory'])
    // no config.json in this home: the file is written, and the output says when the switch turns on
    expect(o.lines.join('\n')).toContain('the browser turns on after `talos-app init`')
  })

  test("an owner's memory.json is never replaced: a working one and a broken one are left byte for byte", async () => {
    const home = tempHome()
    made.push(home)
    const agent = newAgent()
    const own = JSON.stringify({ version: 1, enabled: false, agent_dir: agent, roots: [] })
    writeFileSync(join(home, 'memory.json'), own)
    let o = io()
    expect(await cmdMemory({ home } as never, ['init', '--defaults', '--agent-dir', agent], o.io)).toBe(0)
    expect(readFileSync(join(home, 'memory.json'), 'utf8')).toBe(own)
    expect(o.lines.join('\n')).toContain('already set up; nothing changed')

    writeFileSync(join(home, 'memory.json'), '{ not json')
    o = io()
    expect(await cmdMemory({ home } as never, ['init', '--defaults', '--agent-dir', agent], o.io)).toBe(1)
    expect(readFileSync(join(home, 'memory.json'), 'utf8')).toBe('{ not json')
    expect(o.lines.join('\n')).toContain('nothing changed')
  })

  test('a wiki that is a link out of the agent folder is not shared', async () => {
    const home = tempHome()
    made.push(home)
    const agent = tmp('talos-mem-defaults-agent-')
    put(agent, 'memory/HANDOFF.md')
    const outside = tmp('talos-mem-defaults-outside-')
    put(outside, 'secret.md')
    symlinkSync(outside, join(agent, 'wiki'))
    expect(await cmdMemory({ home } as never, ['init', '--defaults', '--agent-dir', agent], io().io)).toBe(0)
    const saved = JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8'))
    expect(saved.roots.map((r: { path: string }) => r.path)).toEqual(['memory'])
  })

  test('a folder with neither memory/ nor wiki/ writes nothing and says why (exit 1)', async () => {
    const home = tempHome()
    made.push(home)
    const agent = tmp('talos-mem-defaults-agent-')
    put(agent, 'notes/a.md')
    const o = io()
    expect(await cmdMemory({ home } as never, ['init', '--defaults', '--agent-dir', agent], o.io)).toBe(1)
    expect(existsSync(join(home, 'memory.json'))).toBe(false)
    expect(o.lines.join('\n')).toContain('has no memory or wiki folder')
  })

  test('without --defaults and with no terminal, init still refuses to guess (exit 2)', async () => {
    const home = tempHome()
    made.push(home)
    const o = io()
    expect(await cmdMemory({ home } as never, ['init', '--agent-dir', newAgent()], o.io)).toBe(2)
    expect(o.lines.join('\n')).toContain('run it in a terminal')
    expect(existsSync(join(home, 'memory.json'))).toBe(false)
  })
})
