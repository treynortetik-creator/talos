// Independent re-review of PR #63 (Option C WP-OC0) at b6d3ff8: do the round-1 fixes hold through the real bridge
// (signed config.patch via FakeRelay)? Every test here asserts the fixed behaviour; they pass on b6d3ff8 and back the
// "what holds" list. The config on disk is hand-edited into states the patch path itself would never write.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { threadSessionMode } from '@talos-app/protocol'
import type { loadExampleConfig } from '@talos-app/testkit'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

type Cfg = ReturnType<typeof loadExampleConfig>
const H = () => h as Harness
const onDisk = () => JSON.parse(readFileSync(join(H().home, 'config.json'), 'utf8'))
const syncAt = (rev: number) => H().relay.expectFrame('config.sync', (f) => f.rev === rev, { direction: 'from_bridge' })
const errFor = async (id: string) =>
  (await H().relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })).code
async function outcome(baseRev: number, patch: Record<string, unknown>): Promise<string> {
  const f = await H().app.sendConfigPatch(baseRev, patch)
  return Promise.race([syncAt(baseRev + 1).then(() => 'synced'), errFor(f.id).then((c) => `error:${c}`)])
}

const thread = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    kind: 'agent',
    order: 9,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
    ...extra,
  }) as Cfg['threads'][number]

/** A hand-edited config: master on, an archived dedicated thread, `general` dedicated, a dedicated thread whose folder is gone. */
function handEdited(home: string) {
  const gone = join(home, 'gone-project')
  return (c: Cfg): Cfg => ({
    ...c,
    dedicated: { enabled: true, max_live: 3, governor: { five_hour: 80, weekly: 85, park_all: 95, off: false } },
    threads: [
      ...c.threads.map((t) => (t.id === 'general' ? { ...t, session: 'dedicated' as const } : t)),
      thread('old', { archived: true, session: 'dedicated' }),
      thread('proj', {
        session: 'dedicated',
        session_opts: { cwd: gone, model: 'inherit', idle_park_min: 30, worktree: true },
      }),
    ],
  })
}

async function startHandEdited() {
  const home = join(process.env.TMPDIR ?? '/tmp', `rv63r-${process.pid}-${Date.now()}`)
  mkdirSync(home, { recursive: true })
  h = await startHarness({ home, config: handEdited(home) })
  await syncAt(0)
}

describe('recheck OC0: switching off is never refused, whatever is on disk', () => {
  test('holds: dedicated:{enabled:false} is accepted with an archived+dedicated, a dedicated general and a missing folder on disk', async () => {
    await startHandEdited()
    expect(await outcome(0, { dedicated: { enabled: false } })).toBe('synced')
    expect(onDisk().dedicated.enabled).toBe(false)
    expect(threadSessionMode(H().bridge.ctx.config.config, 'proj')).toBe('shared')
  })

  test('holds: dedicated:null (drop the whole section) is accepted and reads as off', async () => {
    await startHandEdited()
    expect(await outcome(0, { dedicated: null })).toBe('synced')
    expect(onDisk().dedicated).toBeUndefined()
    expect(threadSessionMode(H().bridge.ctx.config.config, 'proj')).toBe('shared')
  })

  test('holds: an unrelated owner edit (rename another thread) is accepted on the same hand-edited config', async () => {
    await startHandEdited()
    const threads = onDisk().threads.map((t: { id: string }) => (t.id === 'inbox' ? { ...t, name: 'Mailbox' } : t))
    expect(await outcome(0, { threads })).toBe('synced')
    // and the archived thread was turned back to shared on that write
    expect(onDisk().threads.find((t: { id: string }) => t.id === 'old').session).toBeUndefined()
  })

  test('holds: a thread back to shared (session: null) is accepted even though its folder no longer exists', async () => {
    await startHandEdited()
    rmSync(join(H().home, 'gone-project'), { recursive: true, force: true })
    const threads = onDisk().threads.map((t: { id: string }) => (t.id === 'proj' ? { id: 'proj', session: null } : t))
    expect(await outcome(0, { threads })).toBe('synced')
    expect(onDisk().threads.find((t: { id: string }) => t.id === 'proj').session).toBeUndefined()
  })
})

describe('recheck OC0: an older web build cannot wipe the switch', () => {
  test('holds: an old app (schema strips session/session_opts/dedicated) editing every thread keeps the switch', async () => {
    await startHandEdited()
    const old = onDisk().threads.map(({ session: _s, session_opts: _o, ...t }: Record<string, unknown>) => ({
      ...t,
      notify: 'needs_you',
    }))
    expect(await outcome(0, { threads: old })).toBe('synced')
    const proj = onDisk().threads.find((t: { id: string }) => t.id === 'proj')
    expect(proj.session).toBe('dedicated')
    expect(proj.session_opts.cwd).toContain('gone-project')
    expect(onDisk().dedicated.enabled).toBe(true)
  })
})
