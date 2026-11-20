// The thread's AGENTS.md through the real Bridge: a signed `agents_md.read` / `agents_md.write` from a (fake) app over the
// (fake) relay reaches the service and the file comes back for the same request_id; a save over a changed file is the one
// conflict sentence; the same signed save sent again is refused. At a thread session's start, a change made outside
// Settings is one quiet system line in that thread, once.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS_MD_WORDING, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { pgidOf } from '../src/hub/server.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

// /tmp, not TMPDIR: a CI run's TMPDIR is under ~/.cache, and a folder inside a hidden folder is refused by design
const fresh = () => {
  const top = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'talos-agentsmd-bridge-')))
  const folder = join(top, 'trip')
  mkdirSync(folder)
  return folder
}
const trip = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}

async function start(folder: string) {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, { ...trip, session_opts: { cwd: folder } }],
      dedicated: { enabled: true },
    })) as never,
    bridge: {
      files: { rootFor: (id) => (id === 'trip' ? folder : null) },
      agentsMd: { ownFolder: (id) => (id === 'trip' ? folder : null) },
    },
  })
  return h
}
const ask = async (x: Harness, type: 'agents_md.read' | 'agents_md.write', body: Record<string, unknown> = {}) => {
  const f = await x.app.sign({ ...mkFrame(type), request_id: newUlid(), thread_id: 'trip', ...body })
  x.app.send(f)
  return f
}
const answer = async (x: Harness, f: Record<string, unknown>) => {
  await waitFor(
    () => x.app.rec.frames.some((r) => r.direction === 'in' && r.raw.request_id === f.request_id),
    5000,
    'agents_md.file',
  )
  return x.app.rec.frames.find((r) => r.direction === 'in' && r.raw.request_id === f.request_id)?.raw as Record<
    string,
    unknown
  >
}
const errorFor = async (x: Harness, f: Record<string, unknown>) => {
  await waitFor(
    () => x.app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === f.id),
    5000,
    'error',
  )
  return x.app.rec.frames.find((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === f.id)
    ?.raw as Record<string, unknown>
}

describe('agents_md.* through the real Bridge', () => {
  test('a signed read and save come back for the same request; a save over a changed file is refused', async () => {
    const folder = fresh()
    const x = await start(folder)
    const r = await answer(x, await ask(x, 'agents_md.read'))
    expect(r).toMatchObject({ type: 'agents_md.file', thread_id: 'trip', exists: false, sha: null })
    const w = await answer(x, await ask(x, 'agents_md.write', { text: '# Trip\n', base_sha: null }))
    expect(w).toMatchObject({ type: 'agents_md.file', exists: true, text: '# Trip\n', saved: true })
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe('# Trip\n')
    // the editor still holds "none": the file it would overwrite is not that any more
    const stale = await ask(x, 'agents_md.write', { text: 'other\n', base_sha: null })
    expect((await errorFor(x, stale)).message).toBe(AGENTS_MD_WORDING.conflict)
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe('# Trip\n')
  })

  test('the same signed save sent twice is refused the second time, and saves nothing more', async () => {
    const folder = fresh()
    const x = await start(folder)
    const f = await ask(x, 'agents_md.write', { text: 'one\n', base_sha: null })
    await answer(x, f)
    writeFileSync(join(folder, 'AGENTS.md'), 'changed at the Mac\n')
    x.app.send(f)
    expect((await errorFor(x, f)).message).toBe('That request was already used.')
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe('changed at the Mac\n')
  })

  test('a thread session that starts after a change made outside Settings gets one quiet line, once', async () => {
    const folder = fresh()
    const x = await start(folder)
    await answer(x, await ask(x, 'agents_md.write', { text: 'from settings\n', base_sha: null }))
    writeFileSync(join(folder, 'AGENTS.md'), 'from settings\nand a line the agent added\n')
    const lines = () =>
      x.bridge.ctx.store
        .page({ thread_id: 'trip', limit: 50 })
        .messages.filter((m) => m.author === 'system' && m.text === AGENTS_MD_WORDING.changedOutside)
    const session = (id: string, startedAt = new Date().toISOString(), over: Record<string, unknown> = {}) =>
      writeFileSync(
        join(x.home, 'workers.json'),
        JSON.stringify({
          v: 1,
          supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
          threads: {
            trip: {
              state: 'live',
              session_id: id,
              started_at: startedAt,
              tmux: 't-trip',
              pane_pid: pgidOf(process.pid),
              cwd: folder,
              ...over,
            },
          },
        }),
      )
    // a parked session (no pane) is no start: nothing is said, and the real start below still says it
    session('6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41', undefined, { state: 'parked', pane_pid: 0 })
    x.bridge.optionCTick()
    await Bun.sleep(50)
    expect(lines()).toHaveLength(0)
    session('6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41')
    x.bridge.optionCTick()
    await waitFor(() => lines().length === 1, 5000, 'the start line')
    // the same session again, and a new one with the file unchanged: nothing more
    x.bridge.optionCTick()
    session('7a2d3b0f-5c4e-4d9f-8b82-3e6f9a1c4d52')
    x.bridge.optionCTick()
    await Bun.sleep(50)
    expect(lines()).toHaveLength(1)
    // the agent changes it again, and the same session id is started again (an idle session woken with --resume)
    writeFileSync(join(folder, 'AGENTS.md'), 'from settings\nand another line\n')
    session('7a2d3b0f-5c4e-4d9f-8b82-3e6f9a1c4d52', new Date(Date.now() + 60_000).toISOString())
    x.bridge.optionCTick()
    await waitFor(() => lines().length === 2, 5000, 'the line at the resumed start')
  })
})
