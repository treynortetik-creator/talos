// Audit O3 on the hub: one workers.json entry the bridge cannot read used to make the whole file unreadable, so every
// dedicated thread fell back to main as if the Mac app were down. Now that entry's thread alone is unavailable (falls back,
// controls refused), and so is a thread the Mac set aside under `unreadable_threads` (workers-unreadable.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKERS_UNREADABLE_KEY } from '@talos-app/protocol'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const thread = (id: string, name: string) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
})

async function hub() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip'), thread('garden', 'Garden')],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  return h
}

const entry = (home: string, id: string, state: string, extra: Record<string, unknown> = {}) => ({
  state,
  session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
  tmux: `t-${id}`,
  cwd: home,
  ...extra,
})
function writeWorkers(home: string, threads: Record<string, unknown>, aside?: Record<string, string>) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads,
      ...(aside ? { [WORKERS_UNREADABLE_KEY]: aside } : {}),
    }),
  )
}

describe('workers.json: one entry the hub cannot read', () => {
  test('costs that thread only: it falls back to main, the other thread still goes to its session', async () => {
    const hh = await hub()
    writeWorkers(hh.home, {
      trip: entry(hh.home, 'trip', 'live'),
      garden: entry(hh.home, 'garden', 'parked', { cwd: 'not/absolute' }), // outside the grammar
    })
    await hh.app.sendMessage('garden', 'for the garden')
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ thread_id: 'garden', routed: 'fallback', reason: 'worker_unavailable' })
    await hh.app.sendMessage('trip', 'for the trip')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')), 5000, 'the trip session is woken')
    expect(hh.notes.map((n) => n.meta.thread_id)).toEqual(['garden'])
  })

  test(`a thread set aside under ${WORKERS_UNREADABLE_KEY} is unavailable, even with a readable entry`, async () => {
    const hh = await hub()
    writeWorkers(
      hh.home,
      { trip: entry(hh.home, 'trip', 'live'), garden: entry(hh.home, 'garden', 'parked') },
      { garden: '{"state":"from_a_newer_mac"}' },
    )
    await hh.app.sendMessage('garden', 'for the garden')
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ thread_id: 'garden', routed: 'fallback', reason: 'worker_unavailable' })
    expect(existsSync(join(hh.home, 'workers', 'garden', 'wake'))).toBe(false) // never started on a guess
    const f = await hh.app.sendThreadSessionControl('garden', 'restart')
    const res = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res).toMatchObject({ ok: false, code: 'worker_unavailable' })
    expect(existsSync(join(hh.home, 'workers', 'garden', 'wake'))).toBe(false)
  })
})
