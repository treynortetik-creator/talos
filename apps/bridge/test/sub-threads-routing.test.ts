// Sub-threads on the live bridge: an owner message in a sub-thread without a lead of its own goes to its parent's lead; that
// lead may answer there (reply, attach, card, status) and read every sub-thread under it, but never post in a sub-thread that
// has a lead of its own, and its other locked tools stay on its own thread. Real hub over the FakeRelay; no real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeContext } from '../src/context.ts'
import { pgidOf } from '../src/hub/server.ts'
import { callTool } from '../src/tools/index.ts'
import { readInbound } from '../src/tools/read-inbound.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
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
const LANES = [
  thread('trip', { session: 'dedicated', session_opts: { cwd: '/home/alex/trip' } }),
  thread('packing', { parent_id: 'trip' }),
  thread('visas', { parent_id: 'trip', session: 'dedicated' }),
  thread('notes'),
  thread('drafts', { parent_id: 'notes' }),
]

function writeWorkers(home: string, live: string[]) {
  const t: Record<string, unknown> = {}
  for (const id of live)
    t[id] = {
      state: 'live',
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: pgidOf(process.pid),
      cwd: home,
    }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date().toISOString(),
        workers_supported: true,
        subthreads_supported: true,
      },
      threads: t,
    }),
  )
}

async function hub() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, ...LANES],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  writeWorkers(h.home, ['trip', 'visas'])
  return h
}

const owner = (thread_id: string, kind = 'text') => ({
  content: 'x',
  meta: { thread_id, chat_id: thread_id, message_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T401', kind, trust: 'owner' },
})
const status = (thread_id: string) => ({
  v: 1,
  type: 'status',
  id: '01JBF3V7Q8K2M4N6P8R0S2T4A1',
  ts: new Date().toISOString(),
  thread_id,
  state: 'working',
  since: new Date().toISOString(),
})

describe('routing an owner message', () => {
  test("a sub-thread without its own lead goes to its parent's lead; one with a lead, or under a parent without one, does not", async () => {
    const hh = await hub()
    const r = hh.bridge.router
    expect(r?.decide(owner('packing'))).toEqual({ to: 'worker', thread: 'trip', cold: false })
    expect(r?.decide(owner('visas'))).toEqual({ to: 'worker', thread: 'visas', cold: false })
    expect(r?.decide(owner('drafts'))).toEqual({ to: 'main' })
    expect(r?.decide(owner('notes'))).toEqual({ to: 'main' })
  })

  test("the parent's lead not reachable: the sub-thread's message falls back to main", async () => {
    const hh = await hub()
    writeWorkers(hh.home, ['visas'])
    const d = hh.bridge.router?.decide(owner('packing'))
    expect(d).toMatchObject({ to: 'worker', thread: 'trip', cold: true })
    writeFileSync(join(hh.home, 'workers.json'), '{ torn')
    expect(hh.bridge.router?.decide(owner('packing'))).toMatchObject({ to: 'fallback', thread: 'trip' })
  })
})

describe('a message held for the parent lead', () => {
  test('goes to main, with the notice in the sub-thread, once the sub-thread gets a lead of its own', async () => {
    const hh = await hub()
    const r = hh.bridge.router
    await r?.route(owner('packing'))
    expect(r?.store.unclaimed('trip').map((x) => x.message_id)).toEqual(['m_01JBF3V7Q8K2M4N6P8R0S2T401'])
    hh.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) =>
        t.id === 'packing'
          ? {
              ...t,
              session: 'dedicated' as const,
              session_opts: { cwd: '/home/alex/trip/packing', model: 'inherit', idle_park_min: 30 },
            }
          : t,
      ),
    }))
    hh.bridge.optionCTick()
    await waitFor(() => hh.notes.some((n) => n.meta.routed === 'fallback' && n.meta.thread_id === 'packing'))
    expect(r?.store.unclaimed('trip')).toEqual([])
    await hh.relay.expectFrame(
      'reply',
      (f) => f.message.thread_id === 'packing' && /Main answered/.test(f.message.text ?? ''),
      {
        direction: 'from_bridge',
      },
    )
  })
})

describe('what the review found', () => {
  const ownLead = (hh: Harness, id: string, extra: Record<string, unknown>) =>
    hh.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === id ? { ...t, ...extra } : t)),
    }))

  test("a card a sub-thread's lead raised goes to main once that sub-thread loses its lead, never to the parent's lead", async () => {
    const hh = await hub()
    const r = hh.bridge.router
    const card = 'c_01JBF3V7Q8K2M4N6P8R0S2T401'
    r?.store.setCardRaiser(card, 'visas', Date.now())
    const tap = { content: 'x', meta: { ...owner('visas', 'card_action').meta, card_id: card } }
    expect(r?.decide(tap)).toEqual({ to: 'worker', thread: 'visas', cold: false })
    ownLead(hh, 'visas', { session: 'shared' })
    expect(r?.decide(tap)).toEqual({ to: 'main' })
  })

  test("main's front doors stay main's even under a parent with a lead", async () => {
    const hh = await hub()
    // a hand edit (or an older bridge) put general under trip
    ownLead(hh, 'general', { parent_id: 'trip' })
    expect(hh.bridge.router?.decide(owner('general'))).toEqual({ to: 'main' })
    expect(await hh.bridge.hub?.onOut('trip', status('general'))).toMatchObject({ ok: false, code: 'not_owner' })
  })

  test('read_inbound leaves a message its lead no longer answers, and the next tick gives it to main', async () => {
    const hh = await hub()
    const r = hh.bridge.router
    await r?.route(owner('packing'))
    ownLead(hh, 'packing', {
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/trip/packing', model: 'inherit', idle_park_min: 30 },
    })
    expect(readInbound(hh.bridge.ctx, 'trip').messages).toEqual([])
    expect(r?.store.unclaimed('trip').map((x) => x.message_id)).toEqual(['m_01JBF3V7Q8K2M4N6P8R0S2T401'])
    hh.bridge.optionCTick()
    await waitFor(() => hh.notes.some((n) => n.meta.routed === 'fallback' && n.meta.thread_id === 'packing'))
  })

  test("a sub-thread's message counts as answered only by an answer in that sub-thread", async () => {
    const hh = await hub()
    const store = hh.bridge.router?.store
    const at = Date.now() - 1000
    const post = (thread: string, id: string) =>
      hh.bridge.ctx.store.db
        .query("INSERT INTO messages (id, thread_id, created_at, author, json) VALUES (?, ?, ?, 'agent', '{}')")
        .run(id, thread, new Date().toISOString())
    post('trip', 'm_01JBF3V7Q8K2M4N6P8R0S2T4B1')
    expect(store?.answeredIn('trip', 'packing', at)).toBe(false) // a post in the lead's own thread is not an answer there
    expect(store?.answeredIn('trip', 'trip', at)).toBe(true)
    post('packing', 'm_01JBF3V7Q8K2M4N6P8R0S2T4B2')
    expect(store?.answeredIn('trip', 'packing', at)).toBe(true)
  })
})

describe("the hub: where a lead's frames may land", () => {
  test('its own thread and the sub-threads it answers; never a sub-thread with a lead of its own', async () => {
    const hh = await hub()
    expect(await hh.bridge.hub?.onOut('trip', status('trip'))).toMatchObject({ ok: true })
    expect(await hh.bridge.hub?.onOut('trip', status('packing'))).toMatchObject({ ok: true })
    expect(await hh.bridge.hub?.onOut('trip', status('visas'))).toMatchObject({ ok: false, code: 'not_owner' })
    expect(await hh.bridge.hub?.onOut('trip', status('drafts'))).toMatchObject({ ok: false, code: 'not_owner' })
    // a sub-thread's own lead posts only in its own thread, never its parent's
    expect(await hh.bridge.hub?.onOut('visas', status('trip'))).toMatchObject({ ok: false, code: 'not_owner' })
    expect(await hh.bridge.hub?.onOut('visas', status('packing'))).toMatchObject({ ok: false, code: 'not_owner' })
  })

  test('a sub-thread that gets a lead of its own is no longer the parent lead to post in', async () => {
    const hh = await hub()
    hh.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) =>
        t.id === 'packing'
          ? {
              ...t,
              session: 'dedicated' as const,
              session_opts: { cwd: '/home/alex/trip/packing', model: 'inherit', idle_park_min: 30 },
            }
          : t,
      ),
    }))
    expect(await hh.bridge.hub?.onOut('trip', status('packing'))).toMatchObject({ ok: false, code: 'not_owner' })
  })
})

describe("the parent lead's tools", () => {
  const lead = (thread: string) =>
    ({
      mode: 'live',
      env: { scheduler: 'auto', workerThread: thread },
      worker: { thread },
      config: {
        refresh() {},
        config: {
          dedicated: { enabled: true },
          default_thread: 'general',
          threads: [
            { id: 'general', kind: 'fixed' },
            { id: 'trip', kind: 'fixed', session: 'dedicated' },
            { id: 'packing', kind: 'fixed', parent_id: 'trip' },
            { id: 'visas', kind: 'fixed', parent_id: 'trip', session: 'dedicated' },
          ],
        },
      },
      ledger: { get: () => undefined },
    }) as unknown as BridgeContext
  const refused = async (ctx: BridgeContext, name: string, thread_id: string) => {
    const r = await callTool(ctx, name, { thread_id, chat_id: thread_id, text: 'x' })
    return /can only post there/.test(r.content[0]?.text ?? '')
  }

  test('answer the owner in a sub-thread it answers, and nowhere a sub-thread lead answers', async () => {
    for (const name of ['reply', 'attach', 'card', 'set_status']) {
      expect(await refused(lead('trip'), name, 'packing'), name).toBe(false)
      expect(await refused(lead('trip'), name, 'visas'), name).toBe(true)
      expect(await refused(lead('visas'), name, 'trip'), name).toBe(true)
    }
  })

  test('read every sub-thread under it; a sub-thread lead reads only its own', async () => {
    expect(await refused(lead('trip'), 'read_thread', 'visas')).toBe(false)
    expect(await refused(lead('trip'), 'read_thread', 'packing')).toBe(false)
    expect(await refused(lead('visas'), 'read_thread', 'trip')).toBe(true)
  })

  test('settings and schedule proposals and hand-offs stay on its own thread', async () => {
    for (const name of ['config_propose', 'schedule_propose', 'handoff'])
      expect(await refused(lead('trip'), name, 'packing'), name).toBe(true)
  })
})
