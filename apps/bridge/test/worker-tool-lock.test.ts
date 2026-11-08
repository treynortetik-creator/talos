// A thread's own session (a worker, a lead) can read and act on its own thread only. Every tool a worker is given is named
// in the table below with HOW it is held to its thread; the first test fails when a worker-visible tool is missing from it,
// so a new tool cannot reach workers without a decision. The rest check each way of being held against the real tool code.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { BridgeContext } from '../src/context.ts'
import { workerScheduleTool } from '../src/schedules/worker-scope.ts'
import { callTool, toolsFor } from '../src/tools/index.ts'
import { AGENT_TOOLS, TOOL_RECORDS, WORKER_BRIDGE_TOOLS, WORKER_THREAD_LOCKED_TOOLS } from '../src/tools/table.ts'
import { WorkerStore } from '../src/worker/store.ts'

/**
 * locked: the tool takes a thread id and `callTool` refuses any id but the session's own, and a missing one.
 * card: acts on a card id, refused unless this session raised the card.
 * own-lane: takes no thread id; its handler answers from the session's own thread only.
 * own-inbox: takes no thread id; returns this thread's routed messages only.
 * via-main: takes no thread id; forwarded to the main bridge over the socket, which scopes it to the thread it proved.
 */
const HOW = {
  reply: 'locked',
  attach: 'locked',
  card: 'locked',
  set_status: 'locked',
  schedule_propose: 'locked',
  handoff: 'locked',
  read_thread: 'locked',
  card_result: 'card',
  list_threads: 'own-lane',
  read_inbound: 'own-inbox',
  schedules_list: 'via-main',
  schedule_run_start: 'via-main',
  schedule_run_done: 'via-main',
} as const satisfies Record<string, 'locked' | 'card' | 'own-lane' | 'own-inbox' | 'via-main'>
const named = (how: string) =>
  Object.entries(HOW)
    .filter(([, h]) => h === how)
    .map(([n]) => n)

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  kind: 'fixed',
  order: 3,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

function fakeCtx() {
  const db = new Database(':memory:')
  const store = new WorkerStore(db)
  const config = {
    default_thread: 'general',
    threads: [thread('general'), thread('trip', { session: 'dedicated' }), thread('garden', { session: 'dedicated' })],
    dedicated: { enabled: true },
  }
  const rpcs: Array<{ tool: string; args: unknown }> = []
  const touched: string[] = []
  const ctx = {
    env: { scheduler: 'on', workerThread: 'trip' },
    mode: 'live',
    worker: {
      thread: 'trip',
      hub: {
        rpc: async (tool: string, args: unknown) => {
          rpcs.push({ tool, args })
          return { ok: true, text: 'forwarded' }
        },
      },
    },
    config: { refresh() {}, config, thread: (id: string) => config.threads.find((t) => t.id === id) },
    ledger: { get: () => ({ thread_id: 'garden' }) },
    store: { db },
    clock: { now: () => Date.now() },
    seen: { count: () => 0 },
    transport: { sendEphemeral: () => {} },
    // a handler that touches the main bridge's own scheduler from a worker is a hole
    get schedules() {
      touched.push('schedules')
      return undefined
    },
  } as unknown as BridgeContext
  return { ctx, store, rpcs, touched }
}
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

describe('every tool a worker is given is held to its own thread', () => {
  test('the table names exactly the worker tools (a new worker tool must be added here with its lock)', () => {
    expect([...WORKER_BRIDGE_TOOLS].sort()).toEqual(Object.keys(HOW).sort())
  })
  test('a worker never sees a tool the table does not list', () => {
    const { ctx } = fakeCtx()
    expect(
      toolsFor(ctx.env)
        .map((t) => t.name)
        .sort(),
    ).toEqual(Object.keys(HOW).sort())
  })
  test('the records agree with the table: locked tools are locked, the others take no thread id', () => {
    expect([...WORKER_THREAD_LOCKED_TOOLS].sort()).toEqual(named('locked').sort())
    for (const t of TOOL_RECORDS.filter((r) => r.worker && !r.locked)) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {})
      expect(props, t.name).not.toContain('thread_id')
      expect(props, t.name).not.toContain('chat_id')
    }
  })
  test('a tool a worker is not given is refused by name', async () => {
    const { ctx } = fakeCtx()
    for (const t of TOOL_RECORDS.filter((r) => !r.worker)) {
      const r = await callTool(ctx, t.name, { thread_id: 'trip' })
      expect(r.isError, t.name).toBe(true)
      expect(text(r), t.name).toBe(`unknown tool ${t.name}`)
    }
  })
  test('the worker flag on every record is the one the table expects', () => {
    for (const n of Object.keys(HOW)) expect(AGENT_TOOLS[n]?.worker, n).toBe(true)
  })

  describe('locked tools', () => {
    for (const name of named('locked')) {
      test(`${name}: another thread is refused naming only the session's own`, async () => {
        const { ctx } = fakeCtx()
        for (const key of ['thread_id', 'chat_id']) {
          const r = await callTool(ctx, name, { [key]: 'garden', text: 'x', path: '/x', title: 'x', state: 'working' })
          expect(r.isError, `${name} ${key}`).toBe(true)
          expect(text(r)).toContain('Valid thread ids: trip')
          expect(text(r)).not.toContain('general')
        }
      })
      test(`${name}: no thread id is refused too`, async () => {
        const { ctx } = fakeCtx()
        const r = await callTool(ctx, name, { text: 'x' })
        expect(r.isError).toBe(true)
        expect(text(r)).toBe('thread_id is required. Valid thread ids: trip')
      })
      test(`${name}: refused once the thread is back to shared`, async () => {
        const { ctx } = fakeCtx()
        const c = (ctx.config as unknown as { config: { threads: Array<{ id: string; session?: string }> } }).config
        c.threads = c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'shared' } : t))
        const r = await callTool(ctx, name, { thread_id: 'trip', text: 'x' })
        expect(r.isError).toBe(true)
        expect(text(r)).toContain('no longer has its own session')
      })
    }
  })

  describe('card tools', () => {
    test("card_result on a card another thread's session raised is refused", async () => {
      const { ctx, store } = fakeCtx()
      store.setCardRaiser('c_other', 'garden', Date.now())
      const r = await callTool(ctx, 'card_result', { card_id: 'c_other', ok: true })
      expect(r.isError).toBe(true)
      expect(text(r)).toBe('card c_other was not raised by this session')
    })
    test('card cannot supersede a card another session raised, or one main raised', async () => {
      const { ctx, store } = fakeCtx()
      store.setCardRaiser('c_other', 'garden', Date.now())
      for (const supersedes of ['c_other', 'c_main']) {
        const r = await callTool(ctx, 'card', { thread_id: 'trip', title: 't', supersedes })
        expect(r.isError, supersedes).toBe(true)
        expect(text(r)).toBe(`card ${supersedes} was not raised by this session`)
      }
    })
  })

  test('list_threads shows the session its own thread only', async () => {
    const { ctx } = fakeCtx()
    const r = JSON.parse(text(await callTool(ctx, 'list_threads', {})))
    expect(r.threads.map((t: { id: string }) => t.id)).toEqual(['trip'])
    expect(r.default_thread).toBe('trip')
    expect(JSON.stringify(r)).not.toMatch(/garden|general/i)
  })

  test("read_inbound returns this thread's messages only, whatever it is asked", async () => {
    const { ctx, store } = fakeCtx()
    const now = Date.now()
    for (const [id, thread_id] of [
      ['m_trip', 'trip'],
      ['m_garden', 'garden'],
    ] as const)
      store.addRoute({
        message_id: id,
        thread_id,
        notification: {
          content: `for ${thread_id}`,
          meta: { thread_id, message_id: id, kind: 'text', trust: 'owner' },
        },
        woke_at: now,
        deadline_at: now + 60_000,
        cold: false,
      })
    const r = JSON.parse(text(await callTool(ctx, 'read_inbound', { thread_id: 'garden' })))
    expect(r.messages.map((m: { content: string }) => m.content)).toEqual(['for trip'])
    expect(store.unclaimed('garden').map((x) => x.message_id)).toEqual(['m_garden']) // untouched
  })

  describe('scheduler tools', () => {
    for (const name of named('via-main')) {
      test(`${name} is forwarded to the main bridge over the socket, with no thread in it (the scoping is the next describe)`, async () => {
        const { ctx, rpcs, touched } = fakeCtx()
        const r = await callTool(ctx, name, { run_id: 'r1', ok: true, summary: 's', id: 'job' })
        expect(r.isError).toBeFalsy()
        expect(rpcs).toHaveLength(1)
        expect(rpcs[0]?.tool).toBe(name)
        expect(JSON.stringify(rpcs[0]?.args)).not.toMatch(/thread/)
        expect(touched).toEqual([]) // the worker never opened the scheduler itself
      })
    }
  })
})

// The other half of "via-main": what the main bridge (the hub, `onRpc`) does with a forwarded call. It runs the call for the
// thread the connection proved at hello, never one named in the arguments. More of this is in schedules/thread-schedules.test.ts.
describe("the main bridge limits a forwarded scheduler call to the caller's own thread", () => {
  function main() {
    const store = new WorkerStore(new Database(':memory:'))
    const calls: string[] = []
    const scopes: unknown[] = []
    const schedules = {
      toolList: async (_id: unknown, scope: unknown) => {
        scopes.push(scope)
        return { ok: true, text: 'list' }
      },
      toolPropose: async () => {
        calls.push('propose')
        return { ok: true, text: 'proposed' }
      },
      toolRunStart: async () => {
        calls.push('run_start')
        return { ok: true, text: 'GO' }
      },
      toolRunDone: async () => {
        calls.push('run_done')
        return { ok: true, text: 'recorded' }
      },
      sidecar: { inflightOf: () => undefined },
    }
    const kv = new Map<string, string>()
    const deps = {
      schedules: schedules as never,
      store,
      thread: 'trip',
      now: () => Date.now(),
      kv: { get: (k: string) => kv.get(k), set: (k: string, v: string) => void kv.set(k, v) },
    }
    return { store, calls, scopes, deps }
  }
  test('schedules_list runs with the proven thread as its scope, whatever the arguments say', async () => {
    const m = main()
    await workerScheduleTool(m.deps, 'schedules_list', { thread_id: 'garden', id: 'job' })
    expect(m.scopes).toEqual([{ thread: 'trip' }])
  })
  test('schedule_propose naming another thread is refused before the service sees it', async () => {
    const m = main()
    for (const args of [{ thread_id: 'garden' }, { chat_id: 'garden' }, { result_thread_id: 'garden' }]) {
      const r = await workerScheduleTool(m.deps, 'schedule_propose', { title: 't', ...args })
      expect(r.ok, JSON.stringify(args)).toBe(false)
    }
    expect(m.calls).toEqual([])
  })
  test("a run that was handed to another thread's session is not this session's to start or finish", async () => {
    const m = main()
    const now = Date.now()
    m.store.addRoute({
      message_id: 'run_garden',
      thread_id: 'garden',
      notification: { content: 'job', meta: { thread_id: 'garden', kind: 'schedule_run', trust: 'owner' } },
      woke_at: now,
      deadline_at: now + 60_000,
      cold: false,
    })
    m.store.claim('run_garden', 'worker:garden', now)
    const start = await workerScheduleTool(m.deps, 'schedule_run_start', { run_id: 'run_garden' })
    expect(start.text).toMatch(/^SKIP: that run was not handed to this thread session/)
    const done = await workerScheduleTool(m.deps, 'schedule_run_done', { run_id: 'run_garden', ok: true, summary: 's' })
    expect(done.text).toMatch(/^not yours:/)
    expect(m.calls).toEqual([])
  })
})
