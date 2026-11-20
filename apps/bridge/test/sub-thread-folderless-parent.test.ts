// The owner, 2026-11-19: a sub-thread given its own folder (~/Desktop/<x>) under a parent with no folder was refused with
// 'give "<parent>" a folder first; a sub-thread's folder goes inside it'. A parent with no folder runs in the agent folder; with
// the supervisor's `subthreads_folderless_parent` the child may have a folder of its own, and without it the refusal says so in
// plain words.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'

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

function file(folderlessParent: boolean) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'folderless-parent-'))
  made.push(dir)
  const cfg = loadExampleConfig('default') as Record<string, unknown> & { threads: unknown[] }
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({
      ...cfg,
      dedicated: { enabled: true },
      threads: [...cfg.threads, thread('dash', { session: 'dedicated' }), thread('well', { parent_id: 'dash' })],
    }),
    { mode: 0o600 },
  )
  const f = new ConfigFile(path, {
    roots: { home: dir, talosHome: join(dir, '.talos') },
    log: { warn() {} },
    subthreadsSupported: () => true,
    subthreadsOwnFolder: () => true,
    subthreadsSharedFolder: () => true,
    subthreadsFolderlessParent: () => folderlessParent,
  })
  f.load()
  const reports = join(dir, 'Desktop', 'reports')
  mkdirSync(reports, { recursive: true })
  return { f, reports }
}
const own = (f: ConfigFile, cwd: string) =>
  f.config.threads.map((t) => ({
    id: t.id,
    order: t.order,
    ...(t.id === 'well' ? { session: 'dedicated', session_opts: { cwd } } : {}),
  }))

describe('a sub-thread with a folder of its own under a parent with none', () => {
  test('is saved when the supervisor can run it', () => {
    const { f, reports } = file(true)
    const r = f.applyPatch(f.config.rev, { threads: own(f, reports) })
    expect(r).toMatchObject({ ok: true })
    expect(f.config.threads.find((t) => t.id === 'well')?.session_opts?.cwd).toBe(reports)
  })

  test('is refused in plain words when it cannot (an older Mac app)', () => {
    const { f, reports } = file(false)
    const r = f.applyPatch(f.config.rev, { threads: own(f, reports) })
    expect(r).toMatchObject({
      ok: false,
      message:
        'thread "well" can\'t have a folder of its own while "dash" has none until the Talos app on your Mac is updated; update it, or give "dash" a folder first',
    })
  })

  test('a folder that does not exist is still refused', () => {
    const { f, reports } = file(true)
    expect(f.applyPatch(f.config.rev, { threads: own(f, join(reports, '..', 'missing-x')) }).ok).toBe(false)
    expect(f.applyPatch(f.config.rev, { threads: own(f, `${reports}-missing`) }).ok).toBe(false)
  })
})
