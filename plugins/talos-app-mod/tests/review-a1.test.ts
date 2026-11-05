// Regression tests for the sub-agent mod half. Each test names the bug it guards. Run: HOME="$(mktemp -d)" claude plugin test plugins/talos-app-mod
// The wiring below is a copy of tests/agents.test.ts's (a test file cannot import another without re-running it).
import { expect, mock, test } from 'claude-code/testing'
import { AgentTracker } from '../hooks/lib/agents.ts'

const SYNC = 'mcp__talos-app__talos_mod_sync' as const
const HELLO = 'mcp__talos-app__talos_mod_hello' as const
const KEY = 'k'.repeat(43)
const TEE = '/opt/talos-home/state/agents-tee/sess_test.json' // one file per session (R6)

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

function wire(on: On, o: { features?: string[]; teeText?: () => string; probeHangs?: boolean } = {}) {
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
      if (id === '__talos_probe__' && o.probeHangs) return new Promise(() => {}) as never // held, like a prompt
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
const capsOf = (h: Wired) =>
  h
    .syncs()
    .map((c) => (c.args.state as { capabilities?: string[] } | undefined)?.capabilities)
    .filter((c): c is string[] => Array.isArray(c))

// R1: the hello gate covers the `agents` member but not the two new capability strings. A bridge from before A0 parses
// state.capabilities as a strict enum of nine (A0 review #1, ran on 774acf1), so it drops EVERY state this mod sends:
// no session panel, no Stop, no controls at all, on the commonest skew (git pull, the mod reloads, the bridge has not).
test('R1 an older bridge (hello without features) never sees agents / agent_stop in state.capabilities', async ($, on) => {
  const h = wire(on) // hello answers { ok: true } only: a bridge from before A1
  h.list = [agent('a1')]
  await connect($, h)
  await tick(h)
  const all = capsOf(h).flat()
  expect(all.length).toBeGreaterThan(0)
  expect(all).not.toContain('agents')
  expect(all).not.toContain('agent_stop')
})

// R2: one out-of-range number in the tee file kills the whole panel. iso() calls toISOString() on any finite ms, which
// THROWS above 8.64e15; the throw escapes rows() and snapshot(), the link swallows it, and no agents member goes out
// for as long as the tee keeps writing that value (it rewrites every ~5 s).
test('R2 a tee startTime outside the Date range still yields a snapshot with the row', async ($, on) => {
  const now = () => h.clock.now()
  const h = wire(on, {
    features: ['agents'],
    teeText: () => JSON.stringify({ v: 1, at: now(), tasks: [{ id: 'a1', label: 'Running suites', startTime: 1e17 }] }),
  })
  h.list = [agent('a1')]
  await connect($, h)
  await tick(h)
  await tick(h)
  expect(h.last()?.rows.map((r) => r.id)).toEqual(['a1'])
})

// R2b: below that limit but past year 9999, toISOString() gives "+011476-...", which the strict IsoTs refuses. The
// bridge drops the whole snapshot (keeps the last good one) while the mod records it as sent, so it never re-sends.
test('R2b a tee startTime past year 9999 never puts an extended-year started_at in a row', async ($, on) => {
  const now = () => h.clock.now()
  const h = wire(on, {
    features: ['agents'],
    teeText: () => JSON.stringify({ v: 1, at: now(), tasks: [{ id: 'a1', label: 'Running suites', startTime: 3e14 }] }),
  })
  h.list = [agent('a1')]
  await connect($, h)
  await tick(h)
  const started = h.last()?.rows[0]?.started_at
  expect(typeof started).toBe('string')
  expect(String(started)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

// R5: spec 4.3 / SUBAGENTS.md 4.3: a Bash row without a description is "the first 80 characters of command". The
// classic.Stop path builds the title from the command clipped at 160 instead (the tool.call path does clip at 80).
test('R5 a shell first seen in classic.Stop gets at most 80 characters of its command as the title', () => {
  const t = new AgentTracker()
  t.backgroundSnapshot([{ id: 'bash_9', type: 'shell', status: 'running', command: `curl ${'x'.repeat(300)}` }], 0)
  const row = t.rows([], undefined, 0, false).rows[0]
  expect(row?.id).toBe('bash_9')
  expect((row?.title ?? '').length).toBeLessThanOrEqual(80)
})

// R3: the agent_stop probe is a REAL `$.tool.call({ tool: 'TaskStop' })`, awaited inside reportCapabilities with no
// deadline, before the link starts. Every other probe is a cheap engine method. A tool call that waits (a permission
// prompt for TaskStop outside bypass mode, a busy tool queue at session start) keeps the WHOLE mod from connecting:
// no session panel, no Stop, no C3 controls, not just no agent_stop. `$.tool.list()` (already a core probe) can show
// whether TaskStop exists without running it.
test('R3 a TaskStop probe that never answers does not keep the link from connecting', async ($, on) => {
  const h = wire(on, { features: ['agents'], probeHangs: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 5 && h.syncs().length === 0; i++) {
    await h.clock.advance(2000)
    await until(() => h.syncs().length > 0, 500)
  }
  expect(h.syncs().length).toBeGreaterThan(0)
})
