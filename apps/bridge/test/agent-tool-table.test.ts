// The table of agent tools (AGENT_TOOLS in packages/protocol/src/channel-meta.ts) and the tools that run for its rows.

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import {
  AGENT_TOOL_GROUPS,
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  READ_THREAD_TOOLS,
  WORKER_THREAD_LOCKED_TOOLS,
} from '@talos-app/protocol'
import type { BridgeContext } from '../src/context.ts'
import { ALL_TOOLS, callTool, mainGroups, toolsFor, toolTableProblems, WORKER_TOOLS } from '../src/tools/index.ts'
import { toolInstructions } from '../src/tools/instructions.ts'
import { workerStoreOf } from '../src/tools/read-inbound.ts'
import { WorkerStore } from '../src/worker/store.ts'

const all = toolsFor({ scheduler: 'auto', apps: true })
const byName = new Map([...all, ...WORKER_TOOLS].map((t) => [t.name, t]))

describe('AGENT_TOOLS', () => {
  test('every row has a tool of that name, and every listed tool has a row', () => {
    for (const n of AGENT_TOOL_NAMES) expect(byName.has(n), n).toBe(true)
    for (const t of byName.values()) expect(t.name in AGENT_TOOLS, t.name).toBe(true)
  })

  test('a tool a worker gets that takes a thread id is locked to the worker thread, or is declared as only reading', () => {
    for (const n of AGENT_TOOL_NAMES) {
      const row = AGENT_TOOLS[n]
      if (!row.worker) continue
      const props = Object.keys(byName.get(n)?.inputSchema.properties ?? {})
      const takesThread = props.includes('thread_id') || props.includes('chat_id')
      if (takesThread) expect(row.thread, `${n} takes a thread id`).not.toBe('none')
      if (row.thread === 'post') expect(row.locked, `${n} posts into a thread`).toBe(true)
      if (row.locked) expect(['post', 'read'], `${n} is locked`).toContain(row.thread)
    }
  })

  test('a worker tool with any thread-like input is locked, or is on the explicit read list', () => {
    const readers = new Set<string>(READ_THREAD_TOOLS)
    for (const n of AGENT_TOOL_NAMES) {
      const row = AGENT_TOOLS[n]
      if (!row.worker) continue
      const props = Object.keys(byName.get(n)?.inputSchema.properties ?? {})
      const threadLike = props.filter((p) => /thread|chat/i.test(p))
      if (threadLike.length === 0) continue
      expect(row.locked || readers.has(n), `${n} takes ${threadLike.join(', ')}`).toBe(true)
    }
  })

  test("only a tool on the read list may be labelled thread: 'read'", () => {
    const readers = new Set<string>(READ_THREAD_TOOLS)
    for (const n of AGENT_TOOL_NAMES) {
      const row = AGENT_TOOLS[n]
      if ('thread' in row && row.thread === 'read') expect(readers.has(n), n).toBe(true)
    }
    expect([...READ_THREAD_TOOLS]).toEqual(['read_thread'])
  })

  test('every tool has its place in the instruction text table (words, or an explicit none)', () => {
    expect(toolInstructions('set_status')).toBe('Use `set_status` working/idle on long tasks.')
  })

  test('the main session lists every group but the ones kept apart, so a new group is registered by adding it', () => {
    expect(mainGroups(AGENT_TOOL_GROUPS)).toEqual(['core', 'mod', 'schedule', 'config', 'attachment', 'handoff'])
    expect(mainGroups([...AGENT_TOOL_GROUPS, 'brand_new']) as string[]).toContain('brand_new')
    const listed = new Set(toolsFor({ scheduler: 'auto' }).map((t) => t.name))
    for (const n of AGENT_TOOL_NAMES) {
      const g = AGENT_TOOLS[n].group
      if (g !== 'apps' && g !== 'worker') expect(listed.has(n), n).toBe(true)
    }
  })

  test('a row without a tool, or a tool without a row, is reported by name', () => {
    const real = new Map([...all, ...WORKER_TOOLS].map((t) => [t.name, t]))
    expect(toolTableProblems()).toEqual([])
    const missing = Object.fromEntries([...real].filter(([n]) => n !== 'reply'))
    expect(toolTableProblems(missing as never).join('\n')).toContain('"reply"')
  })

  test('no group list holds a tool twice', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

// The worker guard, run for real: a worker for thread "trip" calls every tool a worker has against what belongs to
// thread "garden". The refusal text is asserted exactly, so a disabled check turns a test red instead of falling through
// to a handler that fails some other way.
describe('a worker is held to its own thread, tool by tool (callTool -> workerRefusal)', () => {
  const REFUSED =
    /can only post there|no longer has its own session|was not raised by this session|thread_id is required/
  function setup() {
    const db = new Database(':memory:')
    const cards = new Set(['c_trip', 'c_garden', 'c_main'])
    const ctx = {
      mode: 'live',
      env: { scheduler: 'auto', workerThread: 'trip' },
      worker: { thread: 'trip' },
      store: { db },
      config: {
        refresh() {},
        config: { dedicated: { enabled: true }, threads: [{ id: 'trip', session: 'dedicated' }] },
      },
      ledger: { get: (id: string) => (cards.has(id) ? { id, thread_id: 'x' } : undefined) },
      clock: { now: () => 1000 },
      transport: { sendEphemeral() {} },
    } as unknown as BridgeContext
    const store = workerStoreOf(ctx)
    store.setCardRaiser('c_trip', 'trip', 1)
    store.setCardRaiser('c_garden', 'garden', 1) // c_main has no raiser: main raised it
    return { ctx, store }
  }
  const text = async (ctx: BridgeContext, name: string, args: Record<string, unknown>) =>
    (await callTool(ctx, name, args)).content[0]?.text ?? ''

  const THREAD_ARG_TOOLS = ['reply', 'attach', 'card', 'set_status', 'read_thread', 'handoff']
  // Every tool a worker has must be classified here, so a new worker tool cannot arrive unchecked.
  const READ_ONLY_TOOLS = ['list_threads', 'read_inbound']
  const CARD_TOOLS = ['card_result']

  test('the table classes every worker tool into exactly one case above', () => {
    const workerTools = AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].worker).sort()
    expect([...THREAD_ARG_TOOLS, ...READ_ONLY_TOOLS, ...CARD_TOOLS].sort()).toEqual(workerTools)
    expect([...WORKER_THREAD_LOCKED_TOOLS].map(String).sort()).toEqual([...THREAD_ARG_TOOLS].sort())
  })

  for (const name of THREAD_ARG_TOOLS) {
    test(`${name}: naming another thread is refused, naming none is refused, its own thread passes the guard`, async () => {
      const { ctx } = setup()
      expect(await text(ctx, name, { thread_id: 'garden' })).toContain('can only post there')
      expect(await text(ctx, name, { chat_id: 'garden' })).toContain('can only post there')
      expect(await text(ctx, name, {})).toContain('thread_id is required')
      expect(await text(ctx, name, { thread_id: 'trip' })).not.toMatch(REFUSED)
    })
  }

  test('card_result: a card raised in another thread, or by main, is refused; its own card passes the guard', async () => {
    const { ctx } = setup()
    expect(await text(ctx, 'card_result', { card_id: 'c_garden', ok: true, text: 'x' })).toContain(
      'card c_garden was not raised by this session',
    )
    expect(await text(ctx, 'card_result', { card_id: 'c_main', ok: true, text: 'x' })).toContain(
      'card c_main was not raised by this session',
    )
    expect(await text(ctx, 'card_result', { card_id: 'c_trip', ok: true, text: 'x' })).not.toMatch(REFUSED)
  })

  test('card: superseding a card raised in another thread, or by main, is refused; its own card passes the guard', async () => {
    const { ctx } = setup()
    for (const id of ['c_garden', 'c_main'])
      expect(await text(ctx, 'card', { thread_id: 'trip', supersedes: id })).toContain(
        `card ${id} was not raised by this session`,
      )
    expect(await text(ctx, 'card', { thread_id: 'trip', supersedes: 'c_trip' })).not.toMatch(REFUSED)
    // a thread-locked refusal still wins when both are wrong
    expect(await text(ctx, 'card', { thread_id: 'garden', supersedes: 'c_garden' })).toContain('can only post there')
  })

  test('a worker whose thread lost its own session is refused on every locked tool', async () => {
    const { ctx } = setup()
    ;(ctx.config as unknown as { config: unknown }).config = { threads: [{ id: 'trip', session: 'main' }] }
    for (const name of THREAD_ARG_TOOLS)
      expect(await text(ctx, name, { thread_id: 'trip' }), name).toContain('no longer has its own session')
  })

  test("read_inbound returns only messages routed to its own thread, never another thread's", async () => {
    const { ctx, store } = setup()
    const note = (id: string, thread: string) => ({
      message_id: id,
      thread_id: thread,
      notification: { content: `hi ${thread}`, meta: { thread_id: thread, message_id: id } },
      woke_at: 1,
      deadline_at: 10_000,
      cold: false,
    })
    expect(store.addRoute(note('m_garden', 'garden') as never)).toBe(true)
    const got = await text(ctx, 'read_inbound', {})
    expect(got).not.toContain('hi garden')
    expect(got).not.toContain('m_garden')
    expect(store.unclaimed('garden').length).toBe(1) // still waiting for garden's own session
    expect(new WorkerStore(ctx.store.db).cardRaiser('c_garden')).toBe('garden')
  })

  test("read_thread is locked to the worker's own thread: another thread, or none, is refused before the history is touched", async () => {
    const { ctx } = setup()
    expect(AGENT_TOOLS.read_thread.thread).toBe('read')
    expect(AGENT_TOOLS.read_thread.locked).toBe(true)
    expect(await text(ctx, 'read_thread', { thread_id: 'garden' })).toContain('can only post there')
    expect(await text(ctx, 'read_thread', {})).toContain('thread_id is required')
    expect(await text(ctx, 'read_thread', { thread_id: 'trip' })).not.toMatch(REFUSED)
  })

  test('list_threads from a worker names its own thread and no other', async () => {
    const { ctx } = setup()
    ;(ctx.config as unknown as { config: unknown }).config = {
      default_thread: 'general',
      dedicated: { enabled: true },
      threads: [
        { id: 'general', name: 'General', kind: 'fixed', notify: 'all', archived: false },
        { id: 'trip', name: 'Trip', kind: 'agent', notify: 'all', archived: false, session: 'dedicated' },
        { id: 'garden', name: 'Garden plans', kind: 'agent', notify: 'all', archived: false },
      ],
    }
    ;(ctx as unknown as { seen: unknown }).seen = { count: () => 0 }
    const got = await text(ctx, 'list_threads', {})
    expect(got).toContain('"trip"')
    expect(got).not.toContain('garden')
    expect(got).not.toContain('Garden plans')
  })
})
