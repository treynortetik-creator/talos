// WP-A1 (docs/SUBAGENTS.md 5.1): the agents collector, its observe-only hooks, and agent_stop. Run by `claude plugin test`.
// The engine is mocked beneath the mod with `on(...)`; the bridge through `on('mcp.call')`, whose hello says whether it
// takes `agents` (an older bridge MACs only the members it knows).
import { expect, mock, test } from 'claude-code/testing'
import { AGENTS, AgentTracker, parseTee, taskNotificationOf } from '../hooks/lib/agents.ts'

const SYNC = 'mcp__talos-app__talos_mod_sync' as const
const HELLO = 'mcp__talos-app__talos_mod_hello' as const
const KEY = 'k'.repeat(43)
const TEE = '/opt/talos-home/state/agents-tee/sess_test.json' // one file per session (R6)
const ID = (n: number) => `01JBF3V7Q8K2M4N6P8R0S2T4${n.toString(36).toUpperCase().padStart(2, '0')}`

type On = Parameters<typeof mock.clock>[0]
type Json = Record<string, unknown>
type Row = Json & { id: string; status: string; activity?: string; recent: Array<{ text: string }> }
type Snap = { session_id: string; source: string; can_stop: boolean; rows: Row[] }

const text = (value: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
})
const until = async (done: () => boolean, ms = 5000) => {
  for (let waited = 0; !done() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}

function wire(on: On, o: { features?: string[]; teeText?: () => string; noTaskStop?: boolean } = {}) {
  const clock = mock.clock(on)
  const calls: Array<{ tool: string; args: Json }> = []
  const queue: unknown[][] = []
  const h = {
    clock,
    queue,
    list: [] as Json[],
    taskStops: [] as unknown[],
    stopAnswer: (_id: string): Json => ({ result: { message: 'stopped' }, text: 'Stopped task' }),
    /** Replaces the engine's tool answer for every tool but TaskStop. */
    toolAnswer: undefined as undefined | (() => Json),
    teeWrites: [] as string[],
    syncs: () => calls.filter((c) => c.tool === 'talos_mod_sync'),
    agents: () =>
      h
        .syncs()
        .map((c) => c.args.agents as Snap | undefined)
        .filter((a): a is Snap => a !== undefined),
    last: () => h.agents().at(-1),
    results: () => h.syncs().flatMap((c) => (c.args.results as Json[] | undefined) ?? []),
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: [
      { name: HELLO, description: '', mcp: true },
      { name: SYNC, description: '', mcp: true },
      ...(o.noTaskStop ? [] : [{ name: 'TaskStop', description: '', mcp: false }]),
    ],
  }))
  on('command.list', () => ({ value: [{ name: 'model', description: '', source: 'builtin' }] }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: '2.1.312' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/opt/talos-home' }))
  on('fs.read', (_$, e) => {
    if (e.path === TEE) return o.teeText ? { value: o.teeText() } : { deny: 'no such file' }
    return { value: `${KEY}\n` }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    h.teeWrites.push(`${e.path}=${e.text}`)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: h.list }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskStop') {
      const id = (e as { task_id?: string }).task_id ?? ''
      if (id === '__talos_probe__')
        return { result: { message: 'No task found' }, text: 'No task found', isError: true }
      h.taskStops.push(id)
      return h.stopAnswer(id)
    }
    if (h.toolAnswer) return h.toolAnswer() as never
    if (e.tool === 'Bash' && (e as { run_in_background?: boolean }).run_in_background)
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_1' } }
    if (e.tool === 'Monitor') return { result: { taskId: 'mon_1', timeoutMs: 300000 } }
    return { result: { stdout: 'ok' } }
  })
  on('classic.Stop', () => ({}))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, args: e.args ?? {} })
    if (e.tool === 'talos_mod_hello') return text({ ok: true, ...(o.features ? { features: o.features } : {}) })
    return text({ controls: queue.shift() ?? [] })
  })
  return h
}
type Wired = ReturnType<typeof wire>
const connect = async ($: { session: { start(a: Json): Promise<unknown> } }, h: Wired) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => h.syncs().length > 0)
}
/** One more sync, and wait for it. */
const tick = async (h: Wired) => {
  const before = h.syncs().length
  await h.clock.advance(2000)
  await until(() => h.syncs().length > before)
}
const agent = (id: string, over: Json = {}) => ({
  id,
  description: 'research mods API',
  type: 'Explore',
  status: 'running',
  ...over,
})

test('agent.list becomes rows; agents and agent_stop are reported; the snapshot goes only when it changed', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.list = [agent('a1'), agent('t1', { teammateId: 'rev@team', type: 'teammate', status: 'idle', name: 'rev' })]
  await connect($, h)
  const caps = (h.syncs()[0]?.args.state as { capabilities?: string[] } | undefined)?.capabilities ?? []
  expect(caps).toEqual(expect.arrayContaining(['agents', 'agent_stop']))
  const s = h.last() as Snap
  expect(s).toMatchObject({ session_id: 'sess_test', source: 'mod', can_stop: true })
  expect(s.rows.map((r) => [r.id, r.kind, r.status, r.stoppable, r.title])).toEqual([
    ['a1', 'subagent', 'running', true, 'research mods API'],
    ['t1', 'teammate', 'idle', true, 'research mods API'],
  ])
  const before = h.agents().length
  await tick(h)
  await tick(h)
  expect(h.agents().length).toBe(before) // nothing changed: no agents member
  h.list = [agent('a1', { status: 'completed' })]
  await tick(h)
  const done = h.last()?.rows.find((r) => r.id === 'a1')
  expect(done).toMatchObject({ status: 'completed', stoppable: false })
  expect(typeof done?.ended_at).toBe('string')
})

test('agent_stop comes from the tool list (TaskStop is never called to probe); without TaskStop listed, no Stop', async ($, on) => {
  const h = wire(on, { features: ['agents'], noTaskStop: true })
  h.list = [agent('a1')]
  await connect($, h)
  const caps = (h.syncs()[0]?.args.state as { capabilities?: string[] } | undefined)?.capabilities ?? []
  expect(caps).toContain('agents')
  expect(caps).not.toContain('agent_stop')
  expect(h.last()).toMatchObject({ can_stop: false })
  expect(h.last()?.rows[0]).toMatchObject({ stoppable: false })
  expect(h.taskStops).toEqual([])
})

test('an older bridge (no agents in hello) never gets an agents member', async ($, on) => {
  const h = wire(on)
  h.list = [agent('a1')]
  await connect($, h)
  await tick(h)
  expect(h.syncs().length).toBeGreaterThan(1)
  expect(h.agents()).toHaveLength(0)
})

test("a subagent's tool calls become its activity line and recent lines; a main-loop call adds nothing", async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.list = [agent('a1')]
  await connect($, h)
  await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/register.ts', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Run vitest suites', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'secret', agentId: undefined } as never)
  await tick(h)
  const row = h.last()?.rows[0] as Row
  expect(row).toMatchObject({ activity: 'Run vitest suites', activity_source: 'tool' })
  expect(row.recent.map((l) => l.text)).toEqual(['Read register.ts', 'Run vitest suites'])
  expect(h.last()?.rows).toHaveLength(1)
})

test('turn.step passes every chunk through in order and a subagent step sets its token count', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.list = [agent('a1')]
  const chunks = [
    { kind: 'text', index: 0, text: 'one' },
    { kind: 'text', index: 0, text: 'two' },
    { kind: 'text', index: 0, text: 'three' },
  ]
  on('turn.step', async function* (_$, e) {
    for (const c of chunks) yield c as never
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'onetwothree',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 12_000,
        cache_creation_input_tokens: 150,
        model: 'claude-haiku-5-5',
      },
    } as never
  })
  await connect($, h)
  const seen: string[] = []
  const stream = $.turn.step({
    turnId: 'x',
    index: 0,
    model: 'claude-haiku-5-5',
    messageCount: 1,
    agentId: 'a1',
  } as never)
  for await (const c of stream as AsyncIterable<{ text?: string }>) seen.push(c.text ?? '')
  expect(seen).toEqual(['one', 'two', 'three'])
  await tick(h)
  expect(h.last()?.rows[0]?.tokens).toBe(12_300)
})

test('background Bash and Monitor are tracked, ended by a task notification, corrected by classic.Stop', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  await connect($, h)
  await $.tool.call({
    tool: 'Bash',
    command: 'pnpm dev',
    description: 'Run the dev server',
    run_in_background: true,
  } as never)
  await $.tool.call({
    tool: 'Monitor',
    description: 'Watch the build',
    timeout_ms: 1000,
    command: 'tail -f x',
  } as never)
  await tick(h)
  const rows = () => h.last()?.rows ?? []
  expect(rows().map((r) => [r.id, r.kind, r.status, r.title, r.background])).toEqual([
    ['bash_1', 'shell', 'running', 'Run the dev server', true],
    ['mon_1', 'monitor', 'running', 'Watch the build', true],
  ])
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification><task-id>bash_1</task-id><status>completed</status></task-notification>',
        },
      ],
    },
    door: 'delivery',
    origin: { kind: 'task-notification' },
  } as never)
  await tick(h)
  expect(rows().find((r) => r.id === 'bash_1')?.status).toBe('completed')
  // the engine's own in-flight list: the monitor is gone, a shell the mod never saw is there
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'bash_9', type: 'shell', status: 'running', description: 'Started at the Mac' }],
  } as never)
  await tick(h)
  expect(rows().map((r) => [r.id, r.status])).toEqual([
    ['bash_1', 'completed'],
    ['mon_1', 'completed'],
    ['bash_9', 'running'],
  ])
})

test('a fresh tee file wins on activity, tokens and start; a stale one is ignored', async ($, on) => {
  let teeAt = 0
  const tee = (label: string) =>
    JSON.stringify({
      v: 1,
      at: teeAt,
      tasks: [
        {
          id: 'a1',
          label,
          status: 'running',
          startTime: 1_700_000_000_000,
          tokenCount: 4242,
          model: 'claude-haiku-5-5',
        },
      ],
    })
  let label = 'Running memory and search vitest suites'
  const h = wire(on, { features: ['agents'], teeText: () => tee(label) })
  h.list = [agent('a1')]
  await $.tool.call({ tool: 'Read', file_path: '/x/y.ts', agentId: 'a1' } as never)
  await h.clock.advance(60_000) // the mocked clock starts at 0
  let now = 60_000 // the mocked clock's time, tracked here (each tick advances it 2 s)
  teeAt = now - AGENTS.teeFreshMs - 1 // stale
  await connect($, h)
  expect(h.last()).toMatchObject({ source: 'mod' })
  expect(h.last()?.rows[0]).toMatchObject({ activity: 'Read y.ts', activity_source: 'tool' })
  now += 2000
  teeAt = now + 100_000 // far future: also refused
  await tick(h)
  expect(h.last()?.source).toBe('mod')
  now += 2000
  teeAt = now
  await tick(h)
  expect(h.last()).toMatchObject({ source: 'mod+tee' })
  expect(h.last()?.rows[0]).toMatchObject({
    activity: 'Running memory and search vitest suites',
    activity_source: 'summary',
    tokens: 4242,
    model: 'claude-haiku-5-5',
    started_at: new Date(1_700_000_000_000).toISOString(),
  })
  label = 'research mods API' // the CLI's label equals the description when it has no summary: the tool line shows
  now += 2000
  teeAt = now
  await tick(h)
  expect(h.last()?.rows[0]).toMatchObject({ activity: 'Read y.ts', activity_source: 'tool' })
})

test('agent.spawn records the model and start; a hook beneath that refuses passes through untouched', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  let deny = false
  on('agent.spawn', () => (deny ? { deny: 'no' } : { model: 'claude-sonnet-5-5', agentId: 'a1' }) as never)
  const spawnInput = {
    prompt: 'go',
    description: 'research mods API',
    subagentType: 'Explore',
    background: true,
  }
  const got = await $.agent.spawn(spawnInput as never)
  expect(got).toEqual({ model: 'claude-sonnet-5-5', agentId: 'a1' })
  deny = true
  expect(await $.agent.spawn(spawnInput as never)).toEqual({ deny: 'no' })
  h.list = [agent('a1')]
  await connect($, h)
  expect(h.last()?.rows[0]).toMatchObject({ model: 'claude-sonnet-5-5', background: true })
})

test('a tool result the collector cannot read never changes it', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.toolAnswer = () => ({ result: 'weird', text: 'weird' })
  await connect($, h)
  const r = await $.tool.call({ tool: 'Bash', command: 'x', run_in_background: true, agentId: 'a1' } as never)
  expect(r).toMatchObject({ result: 'weird', text: 'weird' })
  const r2 = await $.tool.call({ tool: 'Monitor', description: 'm', timeout_ms: 1, agentId: 7 } as never)
  expect(r2).toMatchObject({ result: 'weird' })
})

test('agent_stop calls TaskStop with the id; a refusal is agent_not_found', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.list = [agent('a1'), agent('a2')]
  await connect($, h)
  h.queue.push([{ control_id: ID(1), action: 'agent_stop', agent_id: 'a1' }])
  await tick(h)
  await tick(h)
  await until(() => h.results().some((r) => r.control_id === ID(1)))
  expect(h.taskStops).toEqual(['a1'])
  expect(h.results().find((r) => r.control_id === ID(1))).toMatchObject({ ok: true, text: 'Stopped task' })
  h.stopAnswer = () => ({ result: { message: 'No task' }, text: 'No task a2', isError: true })
  h.queue.push([
    { control_id: ID(2), action: 'agent_stop', agent_id: 'a2' },
    { control_id: ID(3), action: 'agent_stop', agent_id: 'bad\nid' },
  ])
  await tick(h)
  await tick(h)
  await until(() => h.results().some((r) => r.control_id === ID(2)))
  expect(h.results().find((r) => r.control_id === ID(2))).toMatchObject({ ok: false, code: 'agent_not_found' })
  expect(h.results().find((r) => r.control_id === ID(3))).toMatchObject({ ok: false, code: 'args_invalid' })
  expect(h.taskStops).toEqual(['a1', 'a2'])
})

test('session.end: the next snapshot is empty and the tee file is blanked', async ($, on) => {
  const h = wire(on, { features: ['agents'] })
  h.list = [agent('a1')]
  await connect($, h)
  expect(h.last()?.rows).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: 'sess_test', resume: {} } as never)
  await tick(h)
  expect(h.last()).toMatchObject({ session_id: 'sess_test', rows: [] })
  expect(h.teeWrites).toEqual([`${TEE}=`])
})

// ---- the pure tracker ---------------------------------------------------------------------------------------------

test('the tracker holds at most 100 ids, ended ones go first', () => {
  const t = new AgentTracker()
  for (let i = 0; i < 150; i++) t.shellStarted(`s${i}`, 'shell', 'x', i)
  expect(t.size).toBe(AGENTS.maxIds)
  t.taskEnded('s60', 'completed', 200)
  t.shellStarted('s_new', 'shell', 'y', 201)
  expect(t.size).toBe(AGENTS.maxIds)
  const rows = t.rows([], undefined, 202, false).rows
  expect(rows).toHaveLength(AGENTS.rows) // the snapshot's own cap, live rows first
  expect(rows.some((r) => r.id === 's60')).toBe(false) // the ended one went first
  expect(rows[0]?.id).toBe('s50') // s0..s49 were the oldest and went when the 101st arrived
})

test('ended rows leave after keepEndedMs', () => {
  const t = new AgentTracker()
  t.shellStarted('s1', 'shell', 'x', 0)
  t.taskEnded('s1', 'killed', 1000)
  expect(t.rows([], undefined, 1000 + AGENTS.keepEndedMs, false).rows.map((r) => r.status)).toEqual(['killed'])
  expect(t.rows([], undefined, 1001 + AGENTS.keepEndedMs, false).rows).toEqual([])
})

test('a tee file that names another session is ignored (one file per session, R6)', () => {
  const file = JSON.stringify({ v: 1, at: 1000, session_id: 'sess_other', tasks: [{ id: 'a' }] })
  expect(parseTee(file, 1000, 'sess_test')).toBeUndefined()
  expect(parseTee(file, 1000, 'sess_other')).toEqual([{ id: 'a' }])
})

test('tee parsing and task notifications are lenient', () => {
  expect(parseTee('not json', 0)).toBeUndefined()
  expect(parseTee(JSON.stringify({ at: 1000, tasks: [{ id: 'a' }] }), 1000 + AGENTS.teeFreshMs + 1)).toBeUndefined()
  expect(parseTee(JSON.stringify({ at: 1000, tasks: [{ id: 'a' }, 7] }), 2000)).toEqual([{ id: 'a' }])
  expect(taskNotificationOf({ message: { task: { id: 'b1', status: 'failed', durationMs: 5 } } })).toEqual({
    id: 'b1',
    status: 'failed',
    durationMs: 5,
  })
  expect(
    taskNotificationOf({ origin: { kind: 'prompt' }, message: { content: '<task-id>x</task-id>' } }),
  ).toBeUndefined()
})
