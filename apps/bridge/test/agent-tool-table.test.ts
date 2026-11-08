// The table of agent tools (tools/table.ts): one record per tool, and every list and instruction text read from it.

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { BridgeContext } from '../src/context.ts'
import { AGENT_TOOL_GROUPS, READ_THREAD_TOOLS, type ToolMembership, type ToolRecord } from '../src/tools/define.ts'
import { ALL_TOOLS, callTool, mainGroups, toolsFor, toolTableProblems, WORKER_TOOLS } from '../src/tools/index.ts'
import { toolInstructions } from '../src/tools/instructions.ts'
import { workerStoreOf } from '../src/tools/read-inbound.ts'
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  HEADLESS_BRIDGE_TOOLS,
  TOOL_RECORDS,
  tableProblems,
  WORKER_THREAD_LOCKED_TOOLS,
} from '../src/tools/table.ts'
import { WorkerStore } from '../src/worker/store.ts'

const all = toolsFor({ scheduler: 'auto', apps: true })
const byName = new Map([...all, ...WORKER_TOOLS].map((t) => [t.name, t]))

describe('AGENT_TOOLS', () => {
  test('every record is listed by some session, and every listed tool is a record', () => {
    for (const n of AGENT_TOOL_NAMES) expect(byName.has(n), n).toBe(true)
    for (const t of byName.values()) expect(t.name in AGENT_TOOLS, t.name).toBe(true)
  })

  test('does not allow a tool that posts into a thread to go to workers unlocked', () => {
    // @ts-expect-error a worker tool that posts into a thread must be locked to the worker's own
    const unlocked: ToolMembership = { group: 'core', headless: false, worker: true, locked: false, thread: 'post' }
    expect(unlocked.worker).toBe(true)
  })

  test('derives the headless list from the records', () => {
    expect(HEADLESS_BRIDGE_TOOLS.every((n) => AGENT_TOOLS[n]?.headless)).toBe(true)
  })

  test('puts the instruction text on the record, a string or an explicit null', () => {
    for (const t of TOOL_RECORDS)
      expect(typeof t.instructions === 'string' || t.instructions === null, t.name).toBe(true)
    expect(() => toolInstructions('attach')).toThrow('has no instruction text')
    expect(() => toolInstructions('no_such_tool')).toThrow('has no instruction text')
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

  test('a duplicate name, or a thread-read label outside READ_THREAD_TOOLS, is reported by name', () => {
    expect(tableProblems()).toEqual([])
    const reply = AGENT_TOOLS.reply as ToolRecord
    expect(tableProblems([...TOOL_RECORDS, reply]).join('\n')).toContain('"reply" is in the table twice')
    const stray = { ...reply, name: 'stray', worker: true, locked: true, thread: 'read' } as ToolRecord
    expect(tableProblems([...TOOL_RECORDS, stray]).join('\n')).toContain('"stray" is labelled as reading a thread')
    expect(tableProblems(TOOL_RECORDS.filter((t) => t.name !== 'read_thread')).join('\n')).toContain('"read_thread"')
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

  const THREAD_ARG_TOOLS = ['reply', 'attach', 'card', 'set_status', 'read_thread', 'handoff', 'schedule_propose']
  // Every tool a worker has must be classified here, so a new worker tool cannot arrive unchecked.
  const READ_ONLY_TOOLS = ['list_threads', 'read_inbound']
  const CARD_TOOLS = ['card_result']
  // main's Schedules service answers these over the hub, as the thread the connection proved (thread-schedules.test.ts)
  const HUB_SCHEDULE_TOOLS = ['schedules_list', 'schedule_run_start', 'schedule_run_done']

  test('the table classes every worker tool into exactly one case above', () => {
    const workerTools = AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].worker).sort()
    expect([...THREAD_ARG_TOOLS, ...READ_ONLY_TOOLS, ...CARD_TOOLS, ...HUB_SCHEDULE_TOOLS].sort()).toEqual(workerTools)
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
    expect((AGENT_TOOLS.read_thread as { thread?: string }).thread).toBe('read')
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
