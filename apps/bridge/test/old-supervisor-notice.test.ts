// A sub-thread with no folder (or its parent's own) that an older supervisor refuses gets ONE plain line in its thread, once per
// bridge run; not while the capability is on, not for a thread whose folder was refused for the old reason, not on every retry.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const LINE = "this thread can't start: the Talos app on this computer is older than its settings; update it"
const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
  ...extra,
})

async function start() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      dedicated: { enabled: true },
      threads: [
        ...c.threads,
        thread('boss', { session_opts: { cwd: '/home/alex/agent' } }),
        thread('none', { parent_id: 'boss' }),
        thread('same', { parent_id: 'boss', session_opts: { cwd: '/home/alex/agent/' } }),
        thread('inside', { parent_id: 'boss', session_opts: { cwd: '/home/alex/agent/x' } }),
      ],
    })) as never,
  })
  return h
}
const OLD_TEXT =
  "a sub-thread's own session needs a folder of its own inside its parent's folder: it has none, and a session never shares its parent's folder"
function workers(x: Harness, detail: Record<string, string>, shared = false) {
  const entry = (d: string) => ({
    state: 'failed',
    session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
    tmux: 't-x',
    pane_pid: 0,
    cwd: '/home/alex/agent',
    error: { code: 'start_failed', detail: d, at: new Date().toISOString() },
  })
  writeFileSync(
    join(x.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date().toISOString(),
        workers_supported: true,
        subthreads_supported: true,
        ...(shared ? { subthreads_shared_folder: true } : {}),
      },
      threads: Object.fromEntries(Object.entries(detail).map(([id, d]) => [id, entry(d)])),
    }),
  )
}
const lines = (x: Harness, id: string) =>
  x.bridge.ctx.store.page({ thread_id: id, limit: 50 }).messages.filter((m) => m.author === 'system' && m.text === LINE)

describe('an older supervisor refuses a sub-thread in its parent’s folder', () => {
  test('one plain line in that thread, once, however often the start fails again', async () => {
    const x = await start()
    workers(x, {
      none: OLD_TEXT,
      same: "sub-thread folder: the sub-thread's folder must be inside its parent thread's folder",
    })
    x.bridge.optionCTick()
    await waitFor(() => lines(x, 'none').length === 1 && lines(x, 'same').length === 1, 5000, 'the lines')
    for (let i = 0; i < 3; i++) {
      workers(x, { none: OLD_TEXT, same: OLD_TEXT })
      x.bridge.optionCTick()
    }
    await Bun.sleep(100)
    expect(lines(x, 'none')).toHaveLength(1)
    expect(lines(x, 'same')).toHaveLength(1)
  })

  test('not when the supervisor has the capability, not for a folder inside the parent’s, not for another failure', async () => {
    const x = await start()
    workers(x, { none: OLD_TEXT }, true)
    x.bridge.optionCTick()
    workers(x, { inside: OLD_TEXT, none: 'no claude program on the login PATH' })
    x.bridge.optionCTick()
    await Bun.sleep(150)
    for (const id of ['none', 'same', 'inside']) expect(lines(x, id)).toHaveLength(0)
  })
})
