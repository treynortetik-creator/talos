// The owner's `config.patch` for a thread's MCP allow list goes through the same strict checks as the other session
// settings: a good list is written as it is, a bad one is refused in words, and a patch that leaves the list out keeps it.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const trip = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}
function file() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-allow-'))
  made.push(dir)
  const cfg = loadExampleConfig('default')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ ...cfg, threads: [...cfg.threads, trip], dedicated: { enabled: true } }),
    { mode: 0o600 },
  )
  const f = new ConfigFile(join(dir, 'config.json'), { roots: { home: dir, talosHome: dir }, log: { warn() {} } })
  f.load()
  return f
}
const threadsWith = (f: ConfigFile, session_opts: unknown) =>
  f.config.threads.map((t) => (t.id === 'trip' ? { ...t, session_opts } : t))
const tripOpts = (f: ConfigFile) => f.config.threads.find((t) => t.id === 'trip')?.session_opts

describe('config.patch with session_opts.mcp_allow', () => {
  test('a list is written as it is, including connectors, plugin servers and the empty list', () => {
    const f = file()
    for (const mcp_allow of [['github', 'claude.ai Gmail', 'plugin:zoom:zoom-mcp'], []]) {
      const r = f.applyPatch(f.config.rev, { threads: threadsWith(f, { mcp_allow }) })
      expect(r.ok, JSON.stringify(mcp_allow)).toBe(true)
      expect(tripOpts(f)?.mcp_allow).toEqual(mcp_allow)
    }
  })
  test("a bad list is refused with the Mac's words and nothing is written", () => {
    const f = file()
    const rev = f.config.rev
    for (const mcp_allow of [
      'github',
      ['a', 'a'],
      ['bad,name'],
      [''],
      Array.from({ length: 33 }, (_, i) => `s${i}`),
      ['x'.repeat(81)],
    ]) {
      const r = f.applyPatch(rev, { threads: threadsWith(f, { mcp_allow }) })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('thread_session_refused')
        expect(r.message).toMatch(/those session settings are not valid/)
      }
    }
    expect(f.config.rev).toBe(rev)
    expect(tripOpts(f)?.mcp_allow).toBeUndefined()
  })
  describe('an old client that does not know mcp_allow', () => {
    // what an older web, iOS or bridge build sends: the schema it knows strips mcp_allow from session_opts
    const oldShape = (f: ConfigFile, change: Record<string, unknown>) =>
      f.config.threads.map((t) => {
        if (t.id !== 'trip') return t
        const { mcp_allow: _m, ...opts } = (t.session_opts ?? {}) as Record<string, unknown>
        return { ...t, ...change, session_opts: opts }
      })
    const withList = () => {
      const f = file()
      expect(
        f.applyPatch(f.config.rev, { threads: threadsWith(f, { model: 'sonnet', mcp_allow: ['github'] }) }).ok,
      ).toBe(true)
      return f
    }
    for (const [what, change] of [
      ['a rename', { name: 'Trips' }],
      ['a colour change', { color: 'teal' }],
      ['a reorder', { order: 1 }],
      ['a topic', { topic: 'Planning' }],
    ] as const)
      test(`${what} keeps the list`, () => {
        const f = withList()
        expect(f.applyPatch(f.config.rev, { threads: oldShape(f, change) }).ok).toBe(true)
        expect(tripOpts(f)?.mcp_allow).toEqual(['github'])
        expect(tripOpts(f)?.model).toBe('sonnet')
      })
    test('a reorder of the whole list keeps it too', () => {
      const f = withList()
      const reordered = [...oldShape(f, {})].reverse()
      expect(f.applyPatch(f.config.rev, { threads: reordered }).ok).toBe(true)
      expect(tripOpts(f)?.mcp_allow).toEqual(['github'])
    })
    test('a client that sends no session_opts at all keeps it', () => {
      const f = withList()
      const stripped = f.config.threads.map(({ session_opts: _o, ...t }) =>
        t.id === 'trip' ? { ...t, name: 'Trips' } : t,
      )
      expect(f.applyPatch(f.config.rev, { threads: stripped }).ok).toBe(true)
      expect(tripOpts(f)?.mcp_allow).toEqual(['github'])
    })
  })
  test('a new client turns the list off with null, and only the list goes', () => {
    const f = file()
    f.applyPatch(f.config.rev, { threads: threadsWith(f, { model: 'sonnet', mcp_allow: ['github'] }) })
    expect(f.applyPatch(f.config.rev, { threads: threadsWith(f, { mcp_allow: null }) }).ok).toBe(true)
    expect(tripOpts(f)?.mcp_allow).toBeUndefined()
    expect(tripOpts(f)?.model).toBe('sonnet')
  })
  test('null also clears the folder and the effort', () => {
    const f = file()
    f.applyPatch(f.config.rev, { threads: threadsWith(f, { effort: 'high', model: 'sonnet' }) })
    expect(f.applyPatch(f.config.rev, { threads: threadsWith(f, { effort: null }) }).ok).toBe(true)
    expect(tripOpts(f)?.effort).toBeUndefined()
    expect(tripOpts(f)?.model).toBe('sonnet')
  })
  test('junk session_opts in a patch is refused', () => {
    const f = file()
    const r = f.applyPatch(f.config.rev, { threads: threadsWith(f, 'github') })
    expect(r.ok).toBe(false)
  })
})
