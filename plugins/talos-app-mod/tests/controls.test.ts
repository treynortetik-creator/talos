// WP-C3: the mod EXECUTES the controls the bridge hands it in `talos_mod_sync` responses. Mirrors the behavioural contract
// in packages/testkit/src/contract/mod-control.ts (that file is vitest and stays untouched). The bridge is mocked beneath
// the mod through `on('mcp.call')`: the first sync after connecting hands over whatever `h.queue` holds.
import { expect, mock, test } from 'claude-code/testing'
import type { Capability } from '../hooks/lib/capabilities.ts'
import { ControlRunner, ticketMatches } from '../hooks/lib/controls.ts'
import type { EngineLike } from '../hooks/lib/engine.ts'
import { EventQueue, SessionFlags } from '../hooks/lib/events.ts'
import type { ControlResult } from '../hooks/lib/link.ts'

const SYNC = 'mcp__talos-app__talos_mod_sync' as const
const HELLO = 'mcp__talos-app__talos_mod_hello' as const
const KEY = 'k'.repeat(43)
const STOPPED = 'the session was stopped and nobody has sent input since'
const PROBE = '__talos_probe__'

type On = Parameters<typeof mock.clock>[0]
type Json = Record<string, unknown>
const ID = (n: number) => `01JBF3V7Q8K2M4N6P8R0S2T4${n.toString(36).toUpperCase().padStart(2, '0')}`
const text = (value: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
})
const until = async (done: () => boolean, ms = 5000) => {
  for (let waited = 0; !done() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}

/** Boots the mod against a fake engine. `h.abort/run/compact` are the engine methods the test swaps per case. */
function wire(on: On, o: { commands?: Array<{ name: string; description: string; source: string }> } = {}) {
  const clock = mock.clock(on)
  const calls: Array<{ tool: string; args: Json }> = []
  const queue: unknown[][] = []
  const h = {
    clock,
    calls,
    queue,
    aborted: [] as string[],
    ran: [] as Array<{ command: string; args: string }>,
    compacted: [] as Array<string | undefined>,
    // A hook beneath the mod answers for the engine. A throw would only skip the hook, so a REFUSAL is `{ deny: reason }`
    // (the call then rejects with the reason); success is the engine's own result shape.
    abort: (_turnId: string): { deny: string } | Record<string, never> => ({}),
    run: async (_command: string, _args: string): Promise<{ text?: string } | { deny: string }> => ({ text: 'ok' }),
    compact: async (
      _instructions?: string,
    ): Promise<{ messages: Array<{ role: 'user'; text: string; toolUses: never[] }> } | { skip: string }> => ({
      messages: [{ role: 'user', text: 'summary', toolUses: [] }],
    }),
    syncs: () => calls.filter((c) => c.tool === 'talos_mod_sync'),
    results: () => h.syncs().flatMap((c) => (c.args.results as Json[] | undefined) ?? []),
    events: () => h.syncs().flatMap((c) => (c.args.events as Json[] | undefined) ?? []),
    resultFor: (id: string) => h.results().find((r) => r.control_id === id),
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: [
      { name: HELLO, description: '', mcp: true },
      { name: SYNC, description: '', mcp: true },
    ],
  }))
  on('command.list', () => ({
    value:
      o.commands ??
      ['context', 'model', 'effort', 'usage'].map((name) => ({ name, description: '', source: 'builtin' })),
  }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: '2.1.312' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/opt/talos-home' }))
  on('fs.read', () => ({ value: `${KEY}\n` }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PreModelSwitch', () => ({}))
  on('turn.abort', (_$, e) => {
    if (e.turnId === PROBE) return { deny: `turn ${PROBE} is not the running turn` }
    h.aborted.push(e.turnId)
    const r = h.abort(e.turnId)
    return 'deny' in r ? r : { value: undefined }
  })
  on('command.run', async (_$, e) => {
    if (e.command === PROBE) return { deny: `unknown command ${PROBE}` }
    h.ran.push({ command: e.command, args: e.args })
    return h.run(e.command, e.args)
  })
  on('session.compact', async (_$, e) => {
    h.compacted.push((e as { instructions?: string }).instructions)
    return h.compact((e as { instructions?: string }).instructions)
  })
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, args: e.args ?? {} })
    if (e.tool === 'talos_mod_hello') return text({ ok: true })
    return text({ controls: queue.shift() ?? [] })
  })
  return h
}

type Wired = ReturnType<typeof wire>
const done = { answer: '', text: '', durationMs: 1, isAborted: false, reason: 'answer' as const }
const caps = (h: Wired): string[] =>
  (h.syncs()[0]?.args.state as { capabilities?: string[] } | undefined)?.capabilities ?? []
const connect = async ($: { session: { start(a: Json): Promise<unknown> } }, h: Wired) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await until(() => h.syncs().length > 0)
}
const deliver = async (h: Wired, id: string, ...controls: Json[]) => {
  h.queue.push(controls)
  const before = h.syncs().length
  await h.clock.advance(2000)
  await until(() => h.syncs().length > before)
  await h.clock.advance(2000) // the next sync carries the results
  await until(() => h.resultFor(id) !== undefined, 1500)
}

test('the capability report names the control capabilities', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  expect(caps(h)).toEqual(expect.arrayContaining(['stop', 'compact', 'command', 'clear', 'model', 'effort']))
})

test('stop aborts the named turn and is not reported as stopped_at_mac', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await $.turn.start({ turnId: 't1' })
  await deliver(h, ID(1), { control_id: ID(1), action: 'stop', turn_id: 't1' })
  expect(h.aborted).toEqual(['t1'])
  expect(h.resultFor(ID(1))).toMatchObject({ ok: true })
  await $.turn.complete({ turnId: 't1', ...done, isAborted: true, reason: 'aborted' })
  await h.clock.advance(2000)
  await until(() => h.events().some((e) => e.type === 'turn_complete'))
  expect(h.events().map((e) => e.type)).not.toContain('stopped_at_mac')
})

test('a stop for a turn that is not running is turn_mismatch', async ($, on) => {
  const h = wire(on)
  h.abort = () => ({ deny: 'turn t1 is not the running turn t2' })
  await connect($, h)
  await deliver(h, ID(2), { control_id: ID(2), action: 'stop', turn_id: 't1' })
  expect(h.resultFor(ID(2))).toMatchObject({
    ok: false,
    code: 'turn_mismatch',
    text: 'That turn already ended. Nothing was stopped.',
  })
})

test('a refusal that names the stop at the Mac is stopped_at_mac', async ($, on) => {
  const h = wire(on)
  h.abort = () => ({ deny: `refused: ${STOPPED}` })
  await connect($, h)
  await deliver(h, ID(3), { control_id: ID(3), action: 'stop', turn_id: 't1' })
  expect(h.resultFor(ID(3))).toMatchObject({ ok: false, code: 'stopped_at_mac' })
})

test('compact mid-turn waits, then runs once the 2 s tick sees the session idle', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await $.turn.start({ turnId: 't1' })
  await deliver(h, ID(4), { control_id: ID(4), action: 'compact', args: 'keep the plan' })
  expect(h.resultFor(ID(4))).toMatchObject({ ok: true, text: 'Compacts after this turn.' })
  expect(h.compacted).toEqual([])
  await $.turn.complete({ turnId: 't1', ...done })
  await h.clock.advance(2000)
  await until(() => h.compacted.length > 0)
  expect(h.compacted).toEqual(['keep the plan'])
  await h.clock.advance(6000)
  expect(h.compacted.length).toBe(1)
})

test('compact while idle runs now; a vetoed compact says so', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await deliver(h, ID(5), { control_id: ID(5), action: 'compact' })
  expect(h.compacted.length).toBe(1)
  expect(h.resultFor(ID(5))).toMatchObject({ ok: true })
  h.compact = async () => ({ skip: 'vetoed' })
  await deliver(h, ID(6), { control_id: ID(6), action: 'compact' })
  expect(h.resultFor(ID(6))).toMatchObject({ ok: false, text: 'Another plugin stopped the compact.' })
})

test('clear runs the clear command', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await deliver(h, ID(7), { control_id: ID(7), action: 'clear' })
  expect(h.ran).toEqual([{ command: 'clear', args: '' }])
  expect(h.resultFor(ID(7))).toMatchObject({ ok: true })
})

test('a shadowed or non-allowlisted built-in is command_not_allowed and never run', async ($, on) => {
  const h = wire(on, {
    commands: [
      { name: 'context', description: '', source: 'builtin' },
      { name: 'context', description: 'a skill', source: 'user' },
      { name: 'permissions', description: '', source: 'builtin' },
    ],
  })
  await connect($, h)
  await deliver(h, ID(8), { control_id: ID(8), action: 'command', command: 'context', source: 'builtin' })
  await deliver(h, ID(9), { control_id: ID(9), action: 'command', command: 'permissions', source: 'builtin' })
  expect(h.resultFor(ID(8))).toMatchObject({ ok: false, code: 'command_not_allowed' })
  expect(h.resultFor(ID(9))).toMatchObject({ ok: false, code: 'command_not_allowed' })
  expect(h.ran).toEqual([])
})

test('an allowed built-in runs with its arguments', async ($, on) => {
  const h = wire(on)
  h.run = async () => ({ text: 'Context: 10%' })
  await connect($, h)
  await deliver(h, ID(10), { control_id: ID(10), action: 'command', command: 'usage', source: 'builtin' })
  expect(h.ran).toEqual([{ command: 'usage', args: '' }])
  expect(h.resultFor(ID(10))).toMatchObject({ ok: true, text: 'Context: 10%' })
})

const modelControl = (n: number, to: string, expires = '2999-01-01T00:00:00.000Z') => ({
  control_id: ID(n),
  action: 'command',
  command: 'model',
  source: 'builtin',
  args: to,
  model_ticket: { to_model: to, expires_at: expires },
})
const sw = (to: string, requested = to) => ({
  from_model: 'claude-opus-5-5',
  to_model: to,
  requested_model: requested,
  source: 'command' as const,
})

/** A `command.run` that stays in flight until `release()`. */
function gate(h: Wired) {
  let release = () => {}
  let started = false
  h.run = () => {
    started = true
    return new Promise((r) => {
      release = () => r({ text: 'done' })
    })
  }
  return { release: () => release(), started: () => started }
}

test('a model ticket allows exactly one matching switch made while the mod runs /model', async ($, on) => {
  on('classic.PostModelSwitch', () => ({}))
  const h = wire(on)
  const g = gate(h)
  await connect($, h)
  h.queue.push([modelControl(11, 'sonnet')])
  await h.clock.advance(2000)
  await until(g.started)
  const first = await $.classic.PreModelSwitch(sw('claude-sonnet-5-5', 'sonnet'))
  expect(first.permissionDecision).toBe('allow')
  const second = await $.classic.PreModelSwitch(sw('claude-sonnet-5-5', 'sonnet'))
  expect(second.permissionDecision).toBeUndefined()
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' } as never) // R2: the engine confirms
  g.release()
  await h.clock.advance(2000)
  await until(() => h.resultFor(ID(11)) !== undefined)
  expect(h.resultFor(ID(11))).toMatchObject({ ok: true, text: 'Switched.' })
})

test('a switch to another model, or with no ticket, gets no opinion', async ($, on) => {
  const h = wire(on)
  const g = gate(h)
  await connect($, h)
  expect((await $.classic.PreModelSwitch(sw('claude-sonnet-5-5', 'sonnet'))).permissionDecision).toBeUndefined()
  h.queue.push([modelControl(12, 'sonnet')])
  await h.clock.advance(2000)
  await until(g.started)
  expect((await $.classic.PreModelSwitch(sw('claude-haiku-5-5'))).permissionDecision).toBeUndefined()
  g.release()
})

test('a ticket that was never answered expires into model_switch_pending, with no second result', async ($, on) => {
  const h = wire(on)
  const g = gate(h)
  await connect($, h)
  h.queue.push([modelControl(13, 'sonnet')])
  await h.clock.advance(2000)
  await until(g.started)
  await h.clock.advance(16_000)
  await until(() => h.resultFor(ID(13)) !== undefined)
  expect(h.resultFor(ID(13))).toMatchObject({
    ok: false,
    code: 'model_switch_pending',
    text: 'Waiting for confirmation at the Mac.',
  })
  expect((await $.classic.PreModelSwitch(sw('claude-sonnet-5-5', 'sonnet'))).permissionDecision).toBeUndefined()
  g.release()
  await h.clock.advance(6000)
  expect(h.results().filter((r) => r.control_id === ID(13)).length).toBe(1)
})

test('a model control whose ticket names another model, or has expired, is args_invalid', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await deliver(h, ID(14), {
    ...modelControl(14, 'sonnet'),
    model_ticket: { to_model: 'haiku', expires_at: '2999-01-01T00:00:00.000Z' },
  })
  await deliver(h, ID(15), modelControl(15, 'sonnet', '1970-01-01T00:00:01.000Z'))
  expect(h.resultFor(ID(14))).toMatchObject({ ok: false, code: 'args_invalid' })
  expect(h.resultFor(ID(15))).toMatchObject({ ok: false, code: 'args_invalid' })
  expect(h.ran).toEqual([])
})

test('effort runs the command and reports effort_changed', async ($, on) => {
  const h = wire(on)
  await connect($, h)
  await deliver(h, ID(17), {
    control_id: ID(17),
    action: 'command',
    command: 'effort',
    source: 'builtin',
    args: 'high',
  })
  expect(h.ran).toEqual([{ command: 'effort', args: 'high' }])
  expect(h.resultFor(ID(17))).toMatchObject({ ok: true })
  await until(() => h.events().some((e) => e.type === 'effort_changed'))
  expect(h.events().find((e) => e.type === 'effort_changed')).toMatchObject({ effort: 'high' })
})

test('an effort change nobody confirms in 15 s is effort_change_pending', async ($, on) => {
  const h = wire(on)
  const g = gate(h)
  await connect($, h)
  h.queue.push([{ control_id: ID(18), action: 'command', command: 'effort', source: 'builtin', args: 'high' }])
  await h.clock.advance(2000)
  await until(g.started)
  await h.clock.advance(16_000)
  await until(() => h.resultFor(ID(18)) !== undefined)
  expect(h.resultFor(ID(18))).toMatchObject({ ok: false, code: 'effort_change_pending' })
  g.release()
  await h.clock.advance(6000)
  expect(h.results().filter((r) => r.control_id === ID(18)).length).toBe(1)
})

// Pure unit tests of the executor against a hand-made engine: the cases the kit cannot raise (a method that is missing,
// an engine call that throws something odd).
const stubEngine = (over: Partial<EngineLike['command']> = {}): EngineLike =>
  ({
    plugin: { name: 'talos-app-mod' },
    clock: { now: async () => 1_000_000, every: () => undefined, after: () => undefined },
    command: { list: async () => [], run: async () => ({}), ...over },
    turn: { abort: async () => undefined },
    session: { compact: async () => ({}) },
  }) as unknown as EngineLike

const runnerFor = (caps: Capability[], engine = stubEngine()) => {
  const late: ControlResult[] = []
  const events = new EventQueue(() => 0)
  const flags = new SessionFlags(events)
  return { late, flags, runner: new ControlRunner(engine, flags, events, new Set(caps), (r) => late.push(r)) }
}

test('a control for a capability that was not reported gets capability_missing', async () => {
  const { runner } = runnerFor(['command'])
  const out = await runner.handle([{ control_id: ID(19), action: 'stop', turn_id: 't1' }])
  expect(out).toEqual([
    { control_id: ID(19), ok: false, code: 'capability_missing', text: 'This Claude Code cannot do that.' },
  ])
})

test('an unknown action, a malformed control and a stray source each get a result', async () => {
  const { runner } = runnerFor(['stop', 'command'])
  const out = await runner.handle([
    { control_id: ID(20), action: 'reboot' },
    { control_id: ID(21), action: 'command', source: 'builtin' },
    { control_id: ID(22), action: 'stop' },
    { control_id: ID(23), action: 'command', command: 'usage', source: 'user' },
    { action: 'stop', turn_id: 't1' }, // no id: nobody to answer, and no throw
  ])
  expect(out.map((r) => [r.control_id, r.ok, r.code])).toEqual([
    [ID(20), false, 'capability_missing'],
    [ID(21), false, 'args_invalid'],
    [ID(22), false, 'args_invalid'],
    [ID(23), false, 'args_invalid'],
  ])
})

test('an engine call that throws something odd still yields one plain result', async () => {
  const { runner, late } = runnerFor(['command', 'clear'], stubEngine({ run: () => Promise.reject(42) }))
  expect(await runner.handle([{ control_id: ID(24), action: 'clear' }])).toEqual([])
  await until(() => late.length > 0)
  expect(late).toEqual([
    { control_id: ID(24), ok: false, code: 'command_not_allowed', text: 'That command was refused.' },
  ])
})

test('command output is plain text: escape codes and control characters are stripped', async () => {
  const { runner, late } = runnerFor(
    ['command'],
    stubEngine({
      list: async () => [{ name: 'usage', source: 'builtin' }],
      run: async () => ({ text: '\u001b[1mUsage\u001b[0m\u0007 12%' }),
    }),
  )
  await runner.handle([{ control_id: ID(25), action: 'command', command: 'usage', source: 'builtin' }])
  await until(() => late.length > 0)
  expect(late[0]).toMatchObject({ ok: true, text: 'Usage 12%' })
})

test("the user's own deny hook wins and its reason reaches the result", async () => {
  const engine = stubEngine({
    list: async () => [{ name: 'model', source: 'builtin' }],
    run: () => Promise.reject(new Error('Blocked by a PreModelSwitch hook: policy: stay on opus')),
  })
  const { runner, late } = runnerFor(['model'], engine)
  await runner.handle([
    {
      control_id: ID(26),
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'sonnet',
      model_ticket: { to_model: 'sonnet', expires_at: new Date(1_005_000).toISOString() },
    },
  ])
  await until(() => late.length > 0)
  expect(late[0]).toMatchObject({ ok: false, code: 'model_switch_denied' })
  expect(late[0]?.text).toContain('policy: stay on opus')
  expect(await runner.allowsSwitch({ to_model: 'claude-sonnet-5-5' })).toBe(false) // burned when the run ended
})

test('ticket matching: equal, or an alias whose word the resolved id contains; default matches anything', () => {
  expect(ticketMatches('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true)
  expect(ticketMatches('sonnet', 'claude-sonnet-5-5')).toBe(true)
  expect(ticketMatches('opus[1m]', 'claude-opus-5-5[1m]')).toBe(true)
  expect(ticketMatches('sonnet', 'claude-haiku-5-5')).toBe(false)
  expect(ticketMatches('default', 'claude-haiku-5-5')).toBe(true)
  expect(ticketMatches('claude-sonnet-5-5', 'claude-haiku-5-5')).toBe(false)
})

// ---- review fixes (CC-C3-REVIEW R2, R6, R7), on ControlRunner with a stub engine ----------------------------------
const stubRunner = (over: {
  rows?: Array<{ name: string; source: string }>
  effort?: string
  run?: () => Promise<unknown>
}) => {
  const ran: string[] = []
  const late: Array<{ control_id: string; ok: boolean; code?: string; text: string }> = []
  const engine = {
    plugin: { name: 'talos-app-mod' },
    clock: { now: async () => 1_000_000, every: () => undefined, after: () => undefined },
    command: {
      list: async () =>
        over.rows ?? [
          { name: 'clear', source: 'builtin', description: '' },
          { name: 'effort', source: 'builtin', description: '' },
        ],
      run: async (i: { command: string }) => {
        ran.push(i.command)
        return over.run ? over.run() : { text: 'ok' }
      },
    },
    config: { list: async () => [{ key: 'effort', value: over.effort }] },
    turn: { abort: async () => undefined },
    session: { compact: async () => ({}), model: async () => 'claude-opus-5-5' },
  } as never
  const events = new EventQueue(() => 0)
  const runner = new ControlRunner(
    engine,
    new SessionFlags(events),
    events,
    new Set(['clear', 'effort', 'model']),
    (r) => late.push(r),
  )
  return { runner, ran, late, events }
}

test('R6: a clear that a skill or plugin also names is refused and never run', async () => {
  const s = stubRunner({
    rows: [
      { name: 'clear', source: 'builtin' },
      { name: 'clear', source: 'user' },
    ],
  })
  await s.runner.handle([{ control_id: ID(30), action: 'clear' }])
  await until(() => s.late.length > 0)
  expect(s.late[0]).toMatchObject({ ok: false, code: 'command_not_allowed' })
  expect(s.ran).toEqual([])
})

test('R2: an /effort that resolves without taking is reported as refused, and pushes no effort_changed', async () => {
  const s = stubRunner({ effort: 'high', run: async () => ({ text: 'Effort max is not available on this model' }) })
  await s.runner.handle([{ control_id: ID(31), action: 'command', command: 'effort', source: 'builtin', args: 'max' }])
  await until(() => s.late.length > 0)
  expect(s.late[0]).toMatchObject({ ok: false })
  expect(s.events.drain().some((e) => e.type === 'effort_changed')).toBe(false)
})

test('R7: a ticket for opus does not allow a switch that asked for sonnet, whatever it resolved to', async () => {
  const s = stubRunner({ rows: [{ name: 'model', source: 'builtin' }], run: () => new Promise(() => {}) })
  await s.runner.handle([modelControl(32, 'opus')])
  await until(() => s.ran.length > 0)
  expect(
    await s.runner.allowsSwitch({ to_model: 'claude-opus-5-5', source: 'command', requested_model: 'sonnet' }),
  ).toBe(false)
  expect(await s.runner.allowsSwitch({ to_model: 'claude-opus-5-5', source: 'command', requested_model: 'opus' })).toBe(
    true,
  )
})
