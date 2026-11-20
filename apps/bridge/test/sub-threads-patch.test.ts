// Sub-threads on the Mac: a thread gets a parent only once the Mac app reports it checks a sub-thread's folder, through
// either write path (the app's config.patch and the bridge's own update), the parent survives a patch that leaves it out,
// taking it away is never refused, and the bridge advertises sub-threads only while the Mac app supports them.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUBTHREADS_FEATURE } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'
import { bridgeFeatures } from '../src/handshake.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

function file(supported: { on: boolean }, threads = [thread('project'), thread('docs')]) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sub-threads-'))
  made.push(dir)
  const cfg = loadExampleConfig('default')
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ ...cfg, threads: [...cfg.threads, ...threads] }), { mode: 0o600 })
  const f = new ConfigFile(path, {
    roots: { home: dir, talosHome: dir },
    log: { warn() {} },
    subthreadsSupported: () => supported.on,
  })
  f.load()
  return { f, onDisk: () => JSON.parse(readFileSync(path, 'utf8')) as { threads: Array<Record<string, unknown>> } }
}
const withParent = (f: ConfigFile, id: string, parent_id: string | null) =>
  f.config.threads.map((t) => (t.id === id ? { ...t, parent_id } : t))
const docsOf = (threads: Array<Record<string, unknown>>) => threads.find((t) => t.id === 'docs')

describe('config.patch with parent_id', () => {
  test('is refused in words, and nothing written, until the Mac app supports sub-threads', () => {
    const supported = { on: false }
    const { f, onDisk } = file(supported)
    const rev = f.config.rev
    const r = f.applyPatch(rev, { threads: withParent(f, 'docs', 'project') })
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/updated/) })
    expect(f.config.rev).toBe(rev)
    expect(docsOf(onDisk().threads)).not.toHaveProperty('parent_id')

    supported.on = true
    expect(f.applyPatch(rev, { threads: withParent(f, 'docs', 'project') }).ok).toBe(true)
    expect(docsOf(onDisk().threads)?.parent_id).toBe('project')
  })

  test('keeps the parent when a patch leaves it out, and clears it on null even without Mac support', () => {
    const supported = { on: true }
    const { f, onDisk } = file(supported, [thread('project'), thread('docs', { parent_id: 'project' })])
    supported.on = false
    const renamed = f.config.threads.map(({ parent_id: _p, ...t }) =>
      t.id === 'docs' ? { ...t, name: 'Docs site' } : t,
    )
    expect(f.applyPatch(f.config.rev, { threads: renamed }).ok).toBe(true)
    expect(docsOf(onDisk().threads)).toMatchObject({ name: 'Docs site', parent_id: 'project' })

    expect(f.applyPatch(f.config.rev, { threads: withParent(f, 'docs', null) }).ok).toBe(true)
    expect(docsOf(onDisk().threads)).not.toHaveProperty('parent_id')
  })

  test('refuses two levels', () => {
    const { f } = file({ on: true }, [thread('project'), thread('docs', { parent_id: 'project' }), thread('notes')])
    const r = f.applyPatch(f.config.rev, { threads: withParent(f, 'notes', 'docs') })
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/one level/) })
  })
})

describe("the bridge's own writes", () => {
  test('update() applies the same rule, so a tool cannot skip it', () => {
    const supported = { on: false }
    const { f } = file(supported)
    expect(() =>
      f.update((c) => ({
        ...c,
        threads: c.threads.map((t) => (t.id === 'docs' ? { ...t, parent_id: 'project' } : t)),
      })),
    ).toThrow(/updated/)
    supported.on = true
    f.update((c) => ({ ...c, threads: c.threads.map((t) => (t.id === 'docs' ? { ...t, parent_id: 'project' } : t)) }))
    expect(f.thread('docs')?.parent_id).toBe('project')
  })

  test('a support check that throws counts as no support', () => {
    const { f } = file({ on: true })
    const g = new ConfigFile((f as unknown as { path: string }).path, {
      log: { warn() {} },
      subthreadsSupported: () => {
        throw new Error('workers.json unreadable')
      },
    })
    g.load()
    expect(g.subthreadsSupported()).toBe(false)
  })
})

describe('hello.client.features', () => {
  test(`lists ${SUBTHREADS_FEATURE} only while the Mac app supports sub-threads`, () => {
    expect(bridgeFeatures({ config: { subthreadsSupported: () => true } })).toContain(SUBTHREADS_FEATURE)
    expect(bridgeFeatures({ config: { subthreadsSupported: () => false } })).not.toContain(SUBTHREADS_FEATURE)
    expect(bridgeFeatures({})).not.toContain(SUBTHREADS_FEATURE)
  })
})
