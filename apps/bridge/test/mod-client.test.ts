// WP-C2, the mod's own logic (plugins/talos-app-mod/hooks/lib) driven against the REAL bridge end (ModLink + the two
// tools). The mod is plain files, so these tests import it by path. The engine is a fake that speaks the documented
// shapes only: `$.session.usage()` is `{ context: {tokens, window, percent}, rateLimits: [{kind, percentUsed,
// resetsAt}], cost: {usd} }`, `$.command.list()` rows are `{name, description, source, plugin?}`.
import { describe, expect, test } from 'bun:test'
import {
  MOD_LIVE_WINDOW_MS,
  type ModEventT,
  ModSyncRequest,
  SessionInventory,
  SessionState,
  type SessionStateT,
} from '@talos-app/protocol'
import { type FakeClock, fakeClock, permissionFixture } from '@talos-app/testkit'
import {
  CORE_PROBES,
  IMPLEMENTED,
  MIN_VERSION,
  methodExists,
  reportCapabilities,
  versionAtLeast,
} from '../../../plugins/talos-app-mod/hooks/lib/capabilities.ts'
import type { EngineLike, UsageLike } from '../../../plugins/talos-app-mod/hooks/lib/engine.ts'
import {
  EventQueue,
  PromptTracker,
  SessionFlags,
  STOPPED_AT_MAC_REASON,
  TimeSource,
} from '../../../plugins/talos-app-mod/hooks/lib/events.ts'
import {
  GUARD_REASON,
  isModTool,
  MOD_BARE_TOOL_RE,
  shouldDenyModCall,
  shouldDenyModTool,
} from '../../../plugins/talos-app-mod/hooks/lib/guard.ts'
import { foldedJson, inputHash, sha256Hex } from '../../../plugins/talos-app-mod/hooks/lib/hash.ts'
import { bridgeServerOf, buildInventory } from '../../../plugins/talos-app-mod/hooks/lib/inventory.ts'
import { BridgeLink, type ControlHandler } from '../../../plugins/talos-app-mod/hooks/lib/link.ts'
import { buildState, isoOrUndefined, usageToState } from '../../../plugins/talos-app-mod/hooks/lib/state.ts'
import { ModLink } from '../src/mod/link.ts'
import { talosModHello, talosModSync } from '../src/tools/mod.ts'

const SERVER = 'talos-app'
const HELLO = `mcp__${SERVER}__talos_mod_hello`
const SYNC = `mcp__${SERVER}__talos_mod_sync`

type Sinks = {
  states: SessionStateT[]
  inventories: unknown[]
  events: ModEventT[]
  results: unknown[]
  logs: string[]
}

function bridgeEnd(clock: FakeClock) {
  const sinks: Sinks = { states: [], inventories: [], events: [], results: [], logs: [] }
  const rec = (m: string, f?: object) => sinks.logs.push(JSON.stringify({ m, ...f }))
  const log = { debug: rec, info: rec, warn: rec, error: rec, security: rec }
  const secret = { value: '' }
  const make = () =>
    new ModLink({
      clock,
      log,
      keys: {
        read: () => secret.value,
        write: (k) => {
          secret.value = k
        },
      },
      sink: {
        state: (s) => sinks.states.push(s),
        inventory: (i) => sinks.inventories.push(i),
        event: (e) => sinks.events.push(e),
        result: (r) => sinks.results.push(r),
      },
    })
  return { sinks, make, secret }
}

type Rig = ReturnType<typeof rig>
function rig(
  opts: {
    commands?: Array<{ name: string; description?: string; source?: string; plugin?: string }>
    usage?: UsageLike
    version?: string
    bridgeTools?: string[]
    handleControls?: ControlHandler
  } = {},
) {
  const clock = fakeClock()
  const bridge = bridgeEnd(clock)
  let link = bridge.make()
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = []
  const eng = {
    toolNames: opts.bridgeTools ?? [HELLO, SYNC, 'mcp__other__thing', 'Read'],
    commands: opts.commands ?? [
      { name: 'model', description: 'Switch model', source: 'builtin' },
      { name: 'permissions', description: 'Rules', source: 'builtin' },
      { name: 'release-notes', description: 'Draft notes', source: 'user' },
      { name: 'review', description: 'Review', source: 'plugin', plugin: 'quality' },
    ],
    usage: (opts.usage ?? {
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-29T20:00:00Z' }],
      cost: { usd: 1.25 },
    }) as UsageLike,
    model: 'claude-opus-5-5',
    throwOnMcp: undefined as Error | undefined,
  }
  const engine: EngineLike = {
    plugin: { name: 'talos-app-mod' },
    // the bridge's key file, as the mod reads it with $.fs
    secret: { read: async () => bridge.secret.value },
    turn: { abort: async () => undefined },
    clock: { now: async () => clock.now(), every: () => 1, after: () => 1 },
    mcp: {
      async call(server, tool, args = {}) {
        calls.push({ server, tool, args })
        if (eng.throwOnMcp) throw eng.throwOnMcp
        const handler = tool === 'talos_mod_hello' ? talosModHello : talosModSync
        // the real tool handlers; only the context is thin
        return handler.handler({ mod: link } as never, args)
      },
    },
    tool: { list: async () => eng.toolNames.map((name) => ({ name, mcp: name.startsWith('mcp__') })) },
    command: { list: async () => eng.commands, run: async () => ({}) },
    config: {
      list: async () => [
        { key: 'model', value: 'opus', options: ['default', 'opus', 'sonnet'], provider: { plugin: 'engine' } },
        { key: 'effort', value: 'high', options: ['low', 'high'], provider: { plugin: 'engine' } },
        { key: 'quality.strict', value: true, provider: { plugin: 'quality' } },
      ],
    },
    session: {
      id: async () => 'sess_1',
      model: async () => eng.model,
      version: async () => ({ version: opts.version ?? '2.1.312' }),
      usage: async () => eng.usage,
      surfaces: async () => ['terminal'],
      compact: async () => ({}),
    },
  }
  const time = new TimeSource()
  const events = new EventQueue(time.now)
  const flags = new SessionFlags(events)
  const prompts = new PromptTracker(events)
  const client = () =>
    new BridgeLink(
      engine,
      flags,
      events,
      { capabilities: ['inventory', 'permission_close'], version: '2.1.312' },
      time,
      opts.handleControls,
    )
  return {
    clock,
    bridge,
    eng,
    engine,
    calls,
    time,
    events,
    flags,
    prompts,
    client,
    get link() {
      return link
    },
    restartBridge() {
      link = bridge.make()
    },
  }
}

const tick = async (r: Rig, link: BridgeLink, advance = 2000) => {
  r.clock.advance(advance)
  await link.tick()
}

describe('connecting', () => {
  test('retries while the bridge server is not connected yet, then says hello once and syncs', async () => {
    const r = rig({ bridgeTools: ['Read'] })
    const c = r.client()
    await tick(r, c) // no talos_mod_hello tool yet: nothing called, nothing thrown
    expect(r.calls).toHaveLength(0)
    expect(c.status).toBe('backoff')
    r.eng.toolNames = [HELLO, SYNC, 'Read']
    await tick(r, c, 1000) // 1 s backoff has passed
    expect(r.calls.map((x) => x.tool)).toEqual(['talos_mod_hello', 'talos_mod_sync'])
    expect(r.calls[0]?.server).toBe(SERVER) // found by its tool, not hard-coded
    expect(c.status).toBe('connected')
    expect(r.link.live).toBe(true)
  })

  test('the server is found by the hello tool whatever it is named', async () => {
    expect(bridgeServerOf([{ name: 'mcp__my-agent__talos_mod_hello' }, { name: 'mcp__x__y' }])).toBe('my-agent')
    expect(bridgeServerOf([{ name: 'mcp__x__hello' }])).toBeUndefined()
  })

  test('a mod that reloads while the bridge still counts the old one live waits out the 30 s, then connects', async () => {
    const r = rig()
    const first = r.client()
    await tick(r, first)
    expect(r.link.live).toBe(true)
    const second = r.client() // /reload-plugins: module variables start over
    await tick(r, second)
    expect(second.status).toBe('backoff')
    for (let i = 0; i < 16; i++) await tick(r, second, 2000)
    expect(second.status).toBe('connected')
    // and the first instance, holding a voided key, is told unauthorized and finds the new one live
    await tick(r, first)
    expect(r.link.liveState()).toBeDefined()
  })

  test('a bridge restart (new ModLink, no key) is unauthorized once, then the mod says hello and resends everything', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    expect(r.bridge.sinks.states).toHaveLength(1)
    r.restartBridge()
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1)
    await tick(r, c) // unauthorized -> key forgotten, no backoff
    expect(c.status).toBe('idle')
    await tick(r, c) // hello + full sync
    expect(c.status).toBe('connected')
    expect(r.link.liveState()?.session_id).toBe('sess_1')
    expect(r.link.liveInventory()?.commands.length).toBeGreaterThan(0)
  })

  test('an MCP call that throws never escapes tick; the mod backs off and recovers', async () => {
    const r = rig()
    const c = r.client()
    r.eng.throwOnMcp = new Error('server not connected')
    await tick(r, c)
    expect(c.status).toBe('backoff')
    r.eng.throwOnMcp = undefined
    await tick(r, c, 1000)
    expect(c.status).toBe('connected')
  })
})

describe('what it reports (documented field names)', () => {
  test('state: context.percent, rateLimits[].percentUsed, cost.usd become protocol-valid values', async () => {
    const r = rig()
    await tick(r, r.client())
    const sent = r.calls.find((c) => c.tool === 'talos_mod_sync')?.args
    const { seq, ...body } = sent as { seq: number }
    expect(seq).toBeGreaterThan(0)
    expect(ModSyncRequest.safeParse(body).success).toBe(true) // the strict contract the testkit's FakeMod also meets (plus seq)
    const s = r.link.liveState()
    expect(s).toMatchObject({
      session_id: 'sess_1',
      source: 'mod',
      version: '2.1.312',
      model: { id: 'claude-opus-5-5' },
      effort: 'high',
      busy: false,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      cost_usd: 1.25,
      surfaces: ['terminal'],
      capabilities: ['inventory', 'permission_close'],
    })
    expect(s?.rate_limits).toEqual([{ kind: 'five_hour', percent: 23.5, resets_at: '2026-10-29T20:00:00Z' }])
    expect(SessionState.safeParse(s).success).toBe(true)
  })

  test('odd engine readings are clamped or dropped, never the whole state', async () => {
    const u = usageToState({
      context: { tokens: 1.9, window: -5, percent: 140 },
      rateLimits: [
        { kind: 'spend_limit', percentUsed: 180, resetsAt: 'not a date' },
        { kind: 'x'.repeat(40), percentUsed: 1 },
        { percentUsed: 3 },
      ],
      cost: { usd: Number.NaN },
    })
    expect(u.context).toEqual({ tokens: 2, percent: 100 })
    expect(u.rate_limits).toEqual([{ kind: 'spend_limit', percent: 100 }])
    expect(u.cost_usd).toBeUndefined()
    expect(isoOrUndefined('2026-10-29T20:00:00.000+00:00')).toBe('2026-10-29T20:00:00.000+00:00')
    expect(isoOrUndefined(12345)).toBeUndefined()
    const none = usageToState(undefined)
    expect(none).toEqual({ rate_limits: [] }) // absent stays absent, never zeroed
  })

  test('state is sent when it changes, not every tick', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    await tick(r, c)
    await tick(r, c)
    expect(r.calls.filter((x) => 'state' in x.args)).toHaveLength(1)
    r.flags.turnStart('t1')
    await tick(r, c)
    expect(r.calls.filter((x) => 'state' in x.args)).toHaveLength(2)
    expect(r.link.liveState()).toMatchObject({ busy: true, turn_id: 't1' })
  })

  test('inventory: commands with source, plugins and MCP servers; the bridge sets every route', async () => {
    const r = rig({
      commands: [
        { name: 'model', description: 'Switch model', source: 'builtin' },
        { name: 'context', description: 'builtin', source: 'builtin' },
        { name: 'context', description: 'a skill with the same name', source: 'user' },
        { name: 'review', description: 'Review', source: 'plugin', plugin: 'quality' },
        { name: 'bad-source', source: 'weird' },
        { name: 'no-source' },
      ],
    })
    await tick(r, r.client())
    const inv = r.link.liveInventory()
    expect(SessionInventory.safeParse(inv).success).toBe(true)
    const route = (n: string, s: string) => inv?.commands.find((c) => c.name === n && c.source === s)?.route
    expect(route('model', 'builtin')).toBe('control')
    expect(route('review', 'plugin')).toBe('message')
    expect(route('context', 'builtin')).toBe('local_only') // shadowed: fails closed
    expect(inv?.commands.map((c) => c.name)).not.toContain('bad-source')
    expect(inv?.commands.map((c) => c.name)).not.toContain('no-source')
    expect(inv?.plugins.map((p) => p.name).sort()).toEqual(['quality', 'talos-app-mod'])
    expect(inv?.mcp_servers).toEqual(
      expect.arrayContaining([
        { name: 'talos-app', tools: 2, status: 'connected' },
        { name: 'other', tools: 1, status: 'connected' },
      ]),
    )
    expect(inv?.models.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet'])
    expect(inv?.efforts).toEqual(['low', 'high'])
  })

  test('every inventory entry has a name, a source and a hash; the hash changes with the description', async () => {
    const e = rig()
    const a = await buildInventory(e.engine)
    expect(a?.entries.length).toBeGreaterThan(0)
    for (const x of a?.entries ?? []) {
      expect(x.name).toBeTruthy()
      expect(x.source).toBeTruthy()
      expect(x.hash).toMatch(/^[0-9a-f]{64}$/)
    }
    e.eng.commands = e.eng.commands.map((c) => (c.name === 'release-notes' ? { ...c, description: 'Changed' } : c))
    const b = await buildInventory(e.engine)
    expect(b?.digest).not.toBe(a?.digest)
  })

  test('inventory is resent only when it changed, and every 30 s it is rechecked', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    for (let i = 0; i < 20; i++) await tick(r, c)
    expect(r.calls.filter((x) => 'inventory' in x.args)).toHaveLength(1)
    r.eng.commands = [...r.eng.commands, { name: 'newskill', description: 'x', source: 'user' }]
    for (let i = 0; i < 16; i++) await tick(r, c)
    expect(r.calls.filter((x) => 'inventory' in x.args)).toHaveLength(2)
    expect(r.link.liveInventory()?.commands.map((x) => x.name)).toContain('newskill')
  })

  test('no command list, no inventory (the app greys the palette), but state still goes', async () => {
    const r = rig()
    r.engine.command.list = async () => {
      throw new TypeError('x is not a function')
    }
    await tick(r, r.client())
    expect(r.link.liveState()).toBeDefined()
    expect(r.link.liveInventory()).toBeUndefined()
  })

  test('buildState leaves out what the engine does not give', async () => {
    const r = rig({ usage: {} })
    const s = await buildState(r.engine, r.flags, [], undefined)
    expect(s).not.toHaveProperty('context')
    expect(s).not.toHaveProperty('cost_usd')
    expect(s?.rate_limits).toEqual([])
  })
})

describe('events', () => {
  test('turn facts reach the bridge; an abort the mod did not start is "stopped at the Mac" until the next turn', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    r.flags.turnStart('t1')
    r.flags.turnComplete('t1', true)
    await tick(r, c)
    expect(r.bridge.sinks.events.map((e) => e.type)).toEqual(['turn_start', 'turn_complete', 'stopped_at_mac'])
    expect(r.link.liveState()?.stopped_at_mac).toBe(true)
    r.flags.turnStart('t2')
    await tick(r, c)
    expect(r.link.liveState()).toMatchObject({ stopped_at_mac: false, busy: true, turn_id: 't2' })
  })

  test('an abort the mod started itself is not reported as the Mac', () => {
    const q = new EventQueue(() => Date.UTC(2026, 9, 29))
    const f = new SessionFlags(q)
    f.turnStart('t1')
    f.modAbortTurnId = 't1'
    f.turnComplete('t1', true)
    expect(f.stoppedAtMac).toBe(false)
    expect(q.drain().map((e) => e.type)).toEqual(['turn_start', 'turn_complete'])
  })

  test('a refusal that says nobody has sent input since marks stopped at the Mac', () => {
    const q = new EventQueue(() => 0)
    const f = new SessionFlags(q)
    f.noteRefusal(`Refused: ${STOPPED_AT_MAC_REASON}.`)
    expect(f.stoppedAtMac).toBe(true)
    f.noteRefusal(42)
    expect(q.drain().map((e) => e.type)).toEqual(['stopped_at_mac'])
  })

  test('events survive a failed sync (requeued in order) and are delivered after the retry', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    r.flags.turnStart('t1')
    r.eng.throwOnMcp = new Error('down')
    await tick(r, c)
    r.eng.throwOnMcp = undefined
    await tick(r, c, 1000)
    expect(r.bridge.sinks.events.map((e) => e.type)).toEqual(['turn_start'])
  })

  test('the queue is capped at 200', () => {
    const q = new EventQueue(() => 0)
    for (let i = 0; i < 500; i++) q.push('compacting', { on: true })
    expect(q.size).toBe(200)
  })
})

describe('the C3.4 closer', () => {
  test('prompt_open then prompt_closed carry the same (tool_name, input_hash); the hash is of the folded input', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    const input = { command: 'pnpm test', description: 'Run the test suite' }
    const hash = await inputHash(input)
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    r.prompts.opened('toolu_1', 'Bash', hash as string)
    await tick(r, c)
    r.prompts.closed('toolu_1')
    await tick(r, c)
    const [open, closed] = r.bridge.sinks.events as Array<Extract<ModEventT, { type: 'prompt_open' | 'prompt_closed' }>>
    expect(open).toMatchObject({ type: 'prompt_open', tool_name: 'Bash', input_hash: hash, tool_use_id: 'toolu_1' })
    expect(closed).toMatchObject({ type: 'prompt_closed', tool_name: 'Bash', input_hash: hash, tool_use_id: 'toolu_1' })
  })

  test('the hash the bridge can recompute from a relayed input_preview matches (whitespace-folded fixture)', async () => {
    const f = permissionFixture('plain_bash')
    const fromPreview = `sha256:${await sha256Hex(f.params.input_preview.replace(/\s+/g, ''))}`
    expect(await inputHash({ command: 'pnpm test', description: 'Run the test suite' })).toBe(fromPreview)
    // different input, different hash; key order matters only as the preview shows it
    expect(await inputHash({ command: 'pnpm build', description: 'Run the test suite' })).not.toBe(fromPreview)
    expect(foldedJson(undefined)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(await inputHash(cyclic)).toBeUndefined() // unserializable: no hash, so the bridge never matches it
  })

  test('closing an unknown or missing id does nothing; a turn ending closes whatever is still open', async () => {
    const q = new EventQueue(() => 0)
    const p = new PromptTracker(q)
    p.closed('nope')
    p.closed(undefined)
    p.opened(undefined, 'Bash', `sha256:${'a'.repeat(64)}`) // a $.tool.check query: no real call, no prompt
    expect(q.size).toBe(0)
    p.opened('a', 'Bash', `sha256:${'a'.repeat(64)}`)
    p.opened('a', 'Bash', `sha256:${'a'.repeat(64)}`) // repeated: one prompt
    p.opened('b', 'Write', `sha256:${'b'.repeat(64)}`)
    p.closeAll()
    expect(q.drain().map((e) => e.type)).toEqual(['prompt_open', 'prompt_open', 'prompt_closed', 'prompt_closed'])
    expect(p.size).toBe(0)
  })
})

describe('controls before WP-C3', () => {
  test('a control the bridge hands over gets a capability_missing result, so the phone never hangs', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    r.link.enqueue({ control_id: '01JBF3V7Q8K2M4N6P8R0S2T4V6', action: 'compact' })
    await tick(r, c) // control arrives
    await tick(r, c) // result goes back
    expect(r.bridge.sinks.results).toEqual([
      {
        control_id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
        ok: false,
        code: 'capability_missing',
        text: 'This Talos mod cannot do that.',
      },
    ])
  })

  test('with a handler plugged in (WP-C3), its results are the ones reported', async () => {
    const r = rig({
      handleControls: async (cs) => cs.map((x) => ({ control_id: String(x.control_id), ok: true, text: 'Compacted.' })),
    })
    const c = r.client()
    await tick(r, c)
    r.link.enqueue({ control_id: '01JBF3V7Q8K2M4N6P8R0S2T4V6', action: 'compact' })
    await tick(r, c)
    await tick(r, c)
    expect(r.bridge.sinks.results).toEqual([{ control_id: '01JBF3V7Q8K2M4N6P8R0S2T4V6', ok: true, text: 'Compacted.' }])
  })
})

describe('the key', () => {
  test('never appears in a state, an event, an inventory, a result or a bridge log line', async () => {
    const r = rig()
    const c = r.client()
    await tick(r, c)
    r.flags.turnStart('t1')
    r.prompts.opened('x', 'Bash', `sha256:${'c'.repeat(64)}`)
    await tick(r, c)
    const key = r.bridge.secret.value
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // not even in the arguments another plugin's mcp.call hook would see
    expect(JSON.stringify(r.calls)).not.toContain(key)
    expect(JSON.stringify(r.calls.find((x) => x.tool === 'talos_mod_sync')?.args)).toContain('mod_key')
    const everything = JSON.stringify([
      r.bridge.sinks.states,
      r.bridge.sinks.inventories,
      r.bridge.sinks.events,
      r.bridge.sinks.results,
      r.bridge.sinks.logs,
      r.link.snapshot(),
    ])
    expect(everything).not.toContain(key)
  })

  test('the mod does not sync unless hello answered ok:true, and sends the key file as its proof', async () => {
    const r = rig()
    const c = r.client()
    const real = r.engine.mcp.call
    r.engine.mcp.call = async (s, t, a) =>
      t === 'talos_mod_hello' ? { content: [{ type: 'text', text: '{"mod_key":"short"}' }] } : real(s, t, a)
    await tick(r, c)
    expect(c.status).toBe('backoff')
    expect(r.calls.filter((x) => x.tool === 'talos_mod_sync')).toHaveLength(0)
    r.engine.mcp.call = real
    const c2 = r.client()
    await tick(r, c2, 40_000)
    const hello = r.calls.find((x) => x.tool === 'talos_mod_hello')
    expect(hello?.args).toEqual({ ts: expect.any(Number), proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
    expect(JSON.stringify(hello?.args)).not.toContain(r.bridge.secret.value) // a MAC, never the key
  })

  test('a key file that is missing or malformed keeps the mod from saying hello at all', async () => {
    const r = rig()
    const c = r.client()
    r.engine.secret.read = async () => {
      throw new Error('ENOENT')
    }
    await tick(r, c)
    expect(r.calls).toHaveLength(0)
    expect(c.status).toBe('backoff')
  })
})

describe('the capability report and version check', () => {
  const ok = async () => ({})
  const core = (version: string | null = '2.1.312') => ({
    'tool.list': ok,
    'command.list': ok,
    'config.list': ok,
    'session.id': ok,
    'session.usage': ok,
    'session.version': async () => (version === null ? {} : { version }),
  })
  const allMethods = {
    'command.list': ok,
    'tool.check': ok,
    'agent.list': ok,
    'turn.abort': ok,
    'command.run': ok,
    'session.compact': ok,
  }

  test('versions compare numerically, dev builds count by their base, junk is too old', () => {
    expect(versionAtLeast('2.1.304', MIN_VERSION)).toBe(true)
    expect(versionAtLeast('2.1.312', MIN_VERSION)).toBe(true)
    expect(versionAtLeast('2.1.1000', MIN_VERSION)).toBe(true)
    expect(versionAtLeast('2.1.303', MIN_VERSION)).toBe(false)
    expect(versionAtLeast('2.1.304-dev', MIN_VERSION)).toBe(true)
    expect(versionAtLeast('3.0.0', MIN_VERSION)).toBe(true)
    expect(versionAtLeast('garbage', MIN_VERSION)).toBe(false)
    expect(versionAtLeast('2.1', MIN_VERSION)).toBe(false)
  })

  test('reports only what this build implements, and only what the engine has', async () => {
    const r = await reportCapabilities({ core: core(), methods: allMethods })
    expect(r).toMatchObject({ ok: true, version: '2.1.312' })
    // WP-C3 added the control capabilities; WP-A1 `agents` (from agent.list); `sessions` (WP-C7) is still not
    // implemented; `agent_stop` needs the TaskStop probe (tool.call), which this set has not
    if (r.ok)
      expect([...r.capabilities].sort()).toEqual([
        'agents',
        'clear',
        'command',
        'compact',
        'effort',
        'inventory',
        'model',
        'permission_close',
        'stop',
      ] as typeof r.capabilities)
    expect(IMPLEMENTED.has('sessions')).toBe(false)
  })

  test('a missing method takes its capability with it', async () => {
    const methods = {
      ...allMethods,
      'tool.check': async () => {
        throw new TypeError('$.tool.check is not a function')
      },
    }
    const r = await reportCapabilities({ core: core(), methods })
    expect(r.ok && [...r.capabilities].sort()).toEqual([
      'agents',
      'clear',
      'command',
      'compact',
      'effort',
      'inventory',
      'model',
      'stop',
    ] as never)
    expect(r.ok && r.missing).toContain('tool.check')
  })

  test('WP-A1: the TaskStop probe (tool.call) gives agent_stop; without it, no agent_stop', async () => {
    const withStop = await reportCapabilities({ core: core(), methods: { ...allMethods, 'tool.call': ok } })
    expect(withStop.ok && withStop.capabilities).toEqual(expect.arrayContaining(['agents', 'agent_stop']))
    const denied = await reportCapabilities({
      core: core(),
      methods: {
        ...allMethods,
        'tool.call': async () => {
          throw new TypeError('TaskStop is not a function for this plugin')
        },
      },
    })
    expect(denied.ok && denied.capabilities).not.toContain('agent_stop')
  })

  test('a method with no probe is not reported (turn.abort, command.run, session.compact have no safe probe)', async () => {
    const r = await reportCapabilities({ core: core(), methods: {} })
    expect(r.ok && r.capabilities).toEqual([])
  })

  test('below the floor, with an unknown version, or with a core call missing: nothing at all', async () => {
    expect(await reportCapabilities({ core: core('2.1.303'), methods: allMethods })).toMatchObject({
      ok: false,
      reason: 'version_too_old',
    })
    expect(await reportCapabilities({ core: core(null), methods: allMethods })).toMatchObject({
      ok: false,
      reason: 'version_unknown',
    })
    for (const name of CORE_PROBES) {
      const broken = {
        ...core(),
        [name]: async () => {
          throw new TypeError(`${name} is not a function`)
        },
      }
      expect(await reportCapabilities({ core: broken, methods: allMethods })).toMatchObject({
        ok: false,
        reason: 'core_missing',
        missing: [name],
      })
    }
    expect(await reportCapabilities({ core: {}, methods: allMethods })).toMatchObject({
      ok: false,
      reason: 'core_missing',
    })
  })

  test('a probe that fails for another reason found the method; "not a function" did not', async () => {
    expect(
      await methodExists(async () => {
        throw new Error('bad argument')
      }),
    ).toBe(true)
    expect(
      await methodExists(async () => {
        throw new TypeError('$.x.y is not a function')
      }),
    ).toBe(false)
    expect(await methodExists(undefined)).toBe(false)
  })
})

describe('the guard', () => {
  const self = 'talos-app-mod'
  test('tool.check and tool.call deny every caller of a bridge mod tool, with no exception (F5)', () => {
    for (const t of ['mcp__talos-app__talos_mod_sync', 'mcp__talos-app__talos_mod_hello', 'mcp__x__talos_mod_future'])
      expect(shouldDenyModTool(t)).toBe(true)
    expect(shouldDenyModTool(7)).toBe(true) // unreadable: denied
    expect(shouldDenyModTool(undefined)).toBe(true)
  })
  test("anything else is not the guard's business", () => {
    for (const t of ['Bash', 'Read', 'mcp__talos-app__reply', 'mcp__x__not_talos_mod_sync'])
      expect(shouldDenyModTool(t)).toBe(false)
  })
  test('mcp.call: only this plugin may call a bridge mod tool; another plugin, the engine or an unknown origin is denied (F1)', () => {
    for (const tool of ['talos_mod_hello', 'talos_mod_sync']) {
      expect(shouldDenyModCall(tool, self, self)).toBe(false)
      expect(shouldDenyModCall(tool, 'other-plugin', self)).toBe(true)
      expect(shouldDenyModCall(tool, 'engine', self)).toBe(true)
      expect(shouldDenyModCall(tool, undefined, self)).toBe(true)
    }
    expect(shouldDenyModCall(undefined, self, self)).toBe(true)
    // other tools on any server are none of its business
    expect(shouldDenyModCall('reply', 'other-plugin', self)).toBe(false)
    expect(MOD_BARE_TOOL_RE.test('talos_mod_x')).toBe(true)
    expect(MOD_BARE_TOOL_RE.test('xtalos_mod_x')).toBe(false)
  })
  test('the matcher covers any server name and both tools, and nothing else', () => {
    for (const n of ['mcp__talos-app__talos_mod_hello', 'mcp__a_b__talos_mod_sync', 'mcp__x__talos_mod_future'])
      expect(isModTool(n)).toBe(true)
    for (const n of ['talos_mod_sync', 'mcp__talos-app__reply', 'Bash', 'mcp__x__not_talos_mod_sync', 7, undefined])
      expect(isModTool(n)).toBe(false)
    expect(GUARD_REASON).toContain('Never call')
  })
})

describe('F8: one missing non-core method loses itself, not the whole link', () => {
  test('state still goes when $.session.model throws synchronously', async () => {
    const r = rig()
    r.engine.session.model = () => {
      throw new TypeError('$.session.model is not a function')
    }
    r.engine.session.surfaces = () => {
      throw new TypeError('x')
    }
    await tick(r, r.client())
    expect(r.link.liveState()).toMatchObject({ session_id: 'sess_1' })
    expect(r.link.liveState()?.model).toBeUndefined()
  })
})
