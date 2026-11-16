// The root ./install.sh and a new owner's memory: a NEW agent gets semantic memory search by default (the kit's
// --with-memory-search, model chosen by memory) and the phone's memory browser set up with no questions; an agent that
// already exists is never changed by those defaults. Harness: root-install-harness.ts (which turns the search default
// off for every other test, since it downloads a venv and a model).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run, sandbox } from './root-install-harness.ts'

const ON = { TALOS_INSTALL_MEMSEARCH_DEFAULT: 'on' }
const memoryJson = (home: string) => join(home, '.config', 'talos', 'app', 'memory.json')

describe('root install.sh: memory for a new agent', () => {
  it('a new agent: the plan carries --with-memory-search and the memory browser step', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/kit\/install\.sh --agent-dir \S+ --no-chronos --with-memory-search/)
    expect(r.out).toContain('talos-app memory init --defaults)')
    // the kit's own dry run of the search: the model is chosen by this computer's memory
    expect(r.out).toMatch(/\(auto: (\d+ GiB of memory here|this computer's memory could not be read)/)
  })

  it('--no-memory-search leaves it out; both flags at once are refused (exit 2)', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--no-memory-search'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('--with-memory-search')
    const both = run(sandbox(), ['--dry-run', '--no-app', '--no-memory-search', '--with-memory-search'], ON)
    expect(both.code).toBe(2)
    expect(both.out).toContain('contradict')
  })

  it('an explicit --with-memory-search is passed once, not twice', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--with-memory-search', '--embed-model', 'small'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out.match(/--with-memory-search/g)?.length).toBeGreaterThan(0)
    expect(r.out).not.toMatch(/--with-memory-search.*--with-memory-search/)
  })

  it('a new agent: the plan carries --reranker-auto after --with-memory-search', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/kit\/install\.sh --agent-dir \S+ --no-chronos --with-memory-search --reranker-auto/)
  })

  it('an explicit --with-memory-search on a new agent still carries --reranker-auto', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--with-memory-search'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('--reranker-auto')
  })

  it('--no-reranker leaves out both --reranker-auto and --with-reranker', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--no-reranker'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('--with-memory-search')
    expect(r.out).not.toContain('--reranker-auto')
    expect(r.out).not.toContain('--with-reranker')
  })

  it('--no-memory-search: no search, so no reranker either', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--no-memory-search'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('--reranker-auto')
  })

  it('--no-reranker with --with-reranker is refused (exit 2), nothing changed', () => {
    const sb = sandbox()
    const r = run(sb, ['--dry-run', '--no-app', '--no-reranker', '--with-reranker'], ON)
    expect(r.code).toBe(2)
    expect(r.out).toContain('contradict')
    expect(existsSync(sb.agent)).toBe(false)
  })

  it('an explicit --with-reranker is passed once, with no --reranker-auto', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app', '--with-reranker'], ON)
    expect(r.code, r.out).toBe(0)
    expect(r.out.match(/--with-reranker/g)?.length).toBe(1)
    expect(r.out).not.toContain('--reranker-auto')
  })

  it('TALOS_INSTALL_MEMSEARCH_DEFAULT=off keeps the reranker off too', () => {
    const r = run(sandbox(), ['--dry-run', '--no-app'], { TALOS_INSTALL_MEMSEARCH_DEFAULT: 'off' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('--reranker-auto')
  })

  it('a real install writes the memory browser for memory/ and wiki/; a rerun over the agent changes neither', () => {
    const sb = sandbox()
    const first = run(sb, ['--no-app', '--yes'])
    expect(first.code, first.out).toBe(0)
    const cfg = JSON.parse(readFileSync(memoryJson(sb.home), 'utf8'))
    expect(cfg.agent_dir).toBe(require('node:fs').realpathSync(sb.agent))
    expect(cfg.roots.map((x: { path: string }) => x.path)).toEqual(['memory', 'wiki'])
    const before = readFileSync(memoryJson(sb.home), 'utf8')
    // the agent exists now: neither default touches it, even with the search default on
    const again = run(sb, ['--no-app', '--yes'], ON)
    expect(again.code, again.out).toBe(0)
    expect(again.out).not.toContain('--with-memory-search')
    expect(again.out).not.toContain('--reranker-auto')
    expect(again.out).not.toContain('memory browser')
    expect(readFileSync(memoryJson(sb.home), 'utf8')).toBe(before)
    expect(existsSync(join(sb.agent, '.index'))).toBe(false)
  }, 180_000)
})
