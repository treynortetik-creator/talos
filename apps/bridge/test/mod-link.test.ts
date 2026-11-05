// WP-C2 bridge side (docs/CLAUDE-CODE.md C2.3): talos_mod_hello / talos_mod_sync. The mod is the only caller; the key is
// hygiene, the boundary is the bridge, so nothing here lets mod data allow anything (it only informs and refuses).
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MOD_BRIDGE_TOOLS,
  MOD_LIVE_WINDOW_MS,
  MOD_TOOL_DESCRIPTION,
  ModSyncResponse,
  parseFrame,
  SessionInventory,
  SessionState,
} from '@talos-app/protocol'
import { type FakeClock, FakeMod, fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { nullLogger } from '../src/log.ts'
import { type ModEventSink, ModLink } from '../src/mod/link.ts'
import { type Harness, startHarness } from './helpers.ts'
import { helloArgs, signedSync, signingLink } from './mod-sign.ts'

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const ULID = '01JBF3V7Q8K2M4N6P8R0S2T4V6'

type Rig = {
  clock: FakeClock
  link: ModLink
  /** The unwrapped link: calls go in exactly as given. */
  raw: ModLink
  states: unknown[]
  inventories: unknown[]
  events: unknown[]
  results: unknown[]
  logs: string[]
  mod: FakeMod
  /** The key file's contents: what the real mod reads with $.fs. */
  file: () => string
}

function rig(opts: { extraCommands?: Array<{ name: string; description: string; source: string }> } = {}): Rig {
  const clock = fakeClock()
  const states: unknown[] = []
  const inventories: unknown[] = []
  const events: unknown[] = []
  const results: unknown[] = []
  const logs: string[] = []
  const sink: ModEventSink = {
    state: (s) => states.push(s),
    inventory: (i) => inventories.push(i),
    event: (e) => events.push(e),
    result: (r) => results.push(r),
  }
  const log = {
    debug: (m: string, f?: object) => logs.push(JSON.stringify({ m, ...f })),
    info: (m: string, f?: object) => logs.push(JSON.stringify({ m, ...f })),
    warn: (m: string, f?: object) => logs.push(JSON.stringify({ m, ...f })),
    error: (m: string, f?: object) => logs.push(JSON.stringify({ m, ...f })),
    security: (m: string, f?: object) => logs.push(JSON.stringify({ m, ...f })),
  }
  let secret = ''
  const raw = new ModLink({
    clock,
    log,
    sink,
    keys: {
      read: () => secret,
      write: (k) => {
        secret = k
      },
    },
  })
  const link = signingLink(raw, () => clock.now())
  const mod = new FakeMod({ clock, ...opts })
  return { clock, link, raw, states, inventories, events, results, logs, mod, file: () => secret }
}

/** The mod's way in: read the key file, say hello with it, read the file again (hello rotated it). */
const keyOf = (r: Rig): string => {
  const h = r.link.hello(r.file())
  if (!h.ok) throw new Error(h.message)
  return r.file()
}

describe('hello and the key', () => {
  test('hello needs the key file as proof, returns no secret, and rotates the file', () => {
    const r = rig()
    const before = r.file()
    expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/)
    for (const bad of [undefined, null, '', 7, 'A'.repeat(43), 'short', {}, { ts: 1, proof: 'x' }]) {
      expect(r.raw.hello(bad)).toMatchObject({ ok: false })
    }
    const h = r.link.hello(before)
    expect(h).toEqual({ ok: true })
    expect(JSON.stringify(h)).not.toMatch(/[A-Za-z0-9_-]{43}/)
    expect(r.file()).not.toBe(before)
    expect(r.file()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('the file key alone cannot sync: hello must come first, and the pre-hello key is void after it', () => {
    const r = rig()
    const file = r.file()
    expect(r.link.sync(r.mod.syncRequest(file))).toMatchObject({ ok: false, code: 'unauthorized' })
    r.link.hello(file)
    expect(r.link.sync(r.mod.syncRequest(file))).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(r.link.sync(r.mod.syncRequest(r.file())).ok).toBe(true)
  })

  test('a store that cannot be written stops the bridge at startup, and a failed rotation refuses the hello', () => {
    const clock = fakeClock()
    const log = { debug() {}, info() {}, warn() {}, error() {}, security() {} }
    const sink: ModEventSink = { state() {}, inventory() {} }
    expect(
      () =>
        new ModLink({
          clock,
          log,
          sink,
          keys: {
            read: () => undefined,
            write: () => {
              throw new Error('read-only')
            },
          },
        }),
    ).toThrow()
    let n = 0
    let secret = ''
    const link = new ModLink({
      clock,
      log,
      sink,
      keys: {
        read: () => secret,
        write: (k) => {
          if (n++ > 0) throw new Error('disk full')
          secret = k
        },
      },
    })
    expect(link.hello(secret)).toMatchObject({ ok: false })
    expect(link.live).toBe(false)
  })

  test('a second hello while a mod is live is refused (the model cannot take the key)', () => {
    const r = rig()
    keyOf(r)
    expect(r.link.hello(r.file()).ok).toBe(false) // even with the right proof
    r.clock.advance(MOD_LIVE_WINDOW_MS - 1)
    expect(r.link.hello(r.file()).ok).toBe(false)
  })

  test('hello is allowed again after 30 s without a sync, rotates the key and voids the old one', () => {
    const r = rig()
    const k1 = keyOf(r)
    expect(r.link.sync(r.mod.syncRequest(k1)).ok).toBe(true)
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1)
    const k2 = keyOf(r)
    expect(k2).not.toBe(k1)
    const old = r.link.sync(r.mod.syncRequest(k1))
    expect(old).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(r.link.sync(r.mod.syncRequest(k2)).ok).toBe(true)
  })

  test('a key that has gone 30 s without a sync is dead even if nobody said hello since', () => {
    const r = rig()
    const k = keyOf(r)
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1)
    expect(r.link.sync(r.mod.syncRequest(k))).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  test('the key never reaches the log, even when a bad one is tried', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync({ ...r.mod.syncRequest(k), mod_key: 'x'.repeat(43) })
    r.link.sync({ mod_key: 'short' })
    r.link.sync(null)
    expect(r.logs.join('\n')).not.toContain(k)
    expect(r.logs.join('\n')).not.toContain('x'.repeat(43))
    expect(r.logs.some((l) => l.includes('bad mod key'))).toBe(true)
  })
})

describe('sync authentication', () => {
  test('a wrong, short, missing or non-string key is unauthorized and nothing is stored or sent', () => {
    const r = rig()
    keyOf(r)
    for (const bad of [
      { mod_key: 'A'.repeat(43) },
      { mod_key: 'short' },
      {},
      { mod_key: 7 },
      null,
      'str',
      [] as never,
    ]) {
      expect(r.link.sync({ ...(typeof bad === 'object' && bad ? bad : {}), state: r.mod.state() })).toMatchObject({
        ok: false,
        code: 'unauthorized',
      })
    }
    expect(r.link.sync(null)).toMatchObject({ ok: false })
    expect(r.states).toHaveLength(0)
    expect(r.link.snapshot().state).toBeUndefined()
  })

  test('a sync before any hello is unauthorized', () => {
    const r = rig()
    expect(r.link.sync(r.mod.syncRequest('A'.repeat(43)))).toMatchObject({ ok: false, code: 'unauthorized' })
  })
})

describe('state and inventory (the read side)', () => {
  test('a valid sync stores state and inventory and hands both to the sink as protocol-valid values', () => {
    const r = rig()
    const res = r.link.sync(r.mod.syncRequest(keyOf(r)))
    expect(res).toEqual({ ok: true, response: { controls: [] } })
    expect(r.states).toHaveLength(1)
    expect(r.inventories).toHaveLength(1)
    expect(SessionState.safeParse(r.states[0]).success).toBe(true)
    expect(SessionInventory.safeParse(r.inventories[0]).success).toBe(true)
    const snap = r.link.snapshot()
    expect(snap.live).toBe(true)
    expect(snap.state?.source).toBe('mod')
    expect(snap.inventory?.commands.length).toBeGreaterThan(0)
  })

  test('an unchanged state is not sent twice; a changed one is', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync(r.mod.syncRequest(k))
    r.clock.advance(2000)
    r.link.sync(r.mod.syncRequest(k)) // same facts, new `at`
    expect(r.states).toHaveLength(1)
    r.mod.engine.startTurn('t1')
    r.clock.advance(2000)
    r.link.sync(r.mod.syncRequest(k))
    expect(r.states).toHaveLength(2)
  })

  test('a state that does not fit is dropped alone: the inventory and events in the same sync still land', () => {
    const r = rig()
    const k = keyOf(r)
    const req = r.mod.syncRequest(k)
    const res = r.link.sync({ ...req, state: { ...req.state, context: { percent: 900 } } })
    expect(res.ok).toBe(true)
    expect(r.states).toHaveLength(0)
    expect(r.inventories).toHaveLength(1)
    expect(r.logs.some((l) => l.includes('state'))).toBe(true)
  })

  test('the state is forced to source "mod" and an unknown capability is dropped', () => {
    const r = rig()
    const k = keyOf(r)
    const req = r.mod.syncRequest(k)
    r.link.sync({ ...req, state: { ...req.state, source: 'hooks' } })
    expect(r.states).toHaveLength(0) // a mod cannot claim to be another source
    // docs/SUBAGENTS.md "Old peers": capabilities are read leniently, so a capability this build does not know is
    // dropped (never granted) instead of refusing the whole state; the known ones still count.
    r.link.sync({ ...req, state: { ...req.state, capabilities: ['stop', 'root'] } })
    expect(r.states).toHaveLength(1)
    const caps = (r.states[0] as { capabilities: string[] }).capabilities
    expect(caps).toEqual(['stop'])
    expect(r.link.liveState()?.capabilities).not.toContain('root')
  })

  test('the bridge recomputes every command route; the mod cannot grant a phone-run skill', () => {
    const r = rig({
      extraCommands: [{ name: 'context', description: 'a skill named like a built-in', source: 'user' }],
    })
    const k = keyOf(r)
    const req = r.mod.syncRequest(k)
    const inv = req.inventory
    if (!inv) throw new Error('no inventory')
    // the mod (or whoever holds the key) claims everything is a control
    const forged = { ...inv, commands: inv.commands.map((c) => ({ ...c, route: 'control' })) }
    r.link.sync({ ...req, inventory: forged })
    const stored = r.link.snapshot().inventory
    const byKey = (name: string, source: string) => stored?.commands.find((c) => c.name === name && c.source === source)
    expect(byKey('release-notes', 'user')?.route).toBe('message')
    expect(byKey('permissions', 'builtin')?.route).toBe('local_only')
    expect(byKey('model', 'builtin')?.route).toBe('control')
    // shadowed built-in fails closed (review R3)
    expect(byKey('context', 'builtin')?.route).toBe('local_only')
  })

  test('commands without a usable name or a known source are dropped, not stored', () => {
    const r = rig()
    const k = keyOf(r)
    const req = r.mod.syncRequest(k)
    const inv = req.inventory
    if (!inv) throw new Error('no inventory')
    const bad = [
      { name: '../x', description: 'd', source: 'user', route: 'message' },
      { name: 'ok-one', description: 'd', source: 'built-in', route: 'message' },
    ]
    r.link.sync({ ...req, inventory: { ...inv, commands: [...inv.commands, ...bad] } })
    const names = r.link.snapshot().inventory?.commands.map((c) => c.name) ?? []
    expect(names).not.toContain('../x')
    expect(names).not.toContain('ok-one')
  })

  test('the snapshot is not live once the mod has been quiet for 30 s: its state must not be used to allow anything', () => {
    const r = rig()
    r.link.sync(r.mod.syncRequest(keyOf(r)))
    expect(r.link.liveState()).toBeDefined()
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1)
    expect(r.link.liveState()).toBeUndefined()
    expect(r.link.snapshot().live).toBe(false)
  })
})

describe('F3: liveness (a dead mod must not look alive)', () => {
  test('when the window lapses the app is told "mod offline": a cleared state, no capabilities, no readings', () => {
    const r = rig()
    r.link.sync(r.mod.syncRequest(keyOf(r)))
    const live = r.states.length
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1000)
    expect(r.states.length).toBe(live + 1)
    const off = r.states.at(-1) as Record<string, unknown>
    expect(SessionState.safeParse(off).success).toBe(true)
    expect(off).toMatchObject({
      source: 'mod',
      session_id: 'sess_fake',
      capabilities: [],
      rate_limits: [],
      surfaces: [],
    })
    expect(off).not.toHaveProperty('model')
    expect(off).not.toHaveProperty('busy')
    // the last known state stays for the bridge, marked not live
    const snap = r.link.snapshot()
    expect(snap.live).toBe(false)
    expect(snap.state?.model).toBeDefined()
    expect(r.link.liveState()).toBeUndefined()
  })

  test('offline goes out once, and the mod coming back replaces it with a real state', () => {
    const r = rig()
    r.link.sync(r.mod.syncRequest(keyOf(r)))
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1000)
    r.clock.advance(120_000)
    expect(r.states.filter((s) => (s as { capabilities: unknown[] }).capabilities.length === 0)).toHaveLength(1)
    r.link.sync(r.mod.syncRequest(keyOf(r)))
    expect((r.states.at(-1) as { capabilities: unknown[] }).capabilities.length).toBeGreaterThan(0)
  })

  test('a mod that keeps syncing is never reported offline, however still its state is', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync(r.mod.syncRequest(k))
    for (let i = 0; i < 60; i++) {
      r.clock.advance(2000)
      r.link.sync({ mod_key: k })
    }
    expect(r.states.every((s) => (s as { capabilities: unknown[] }).capabilities.length > 0)).toBe(true)
  })

  test('heartbeat: `at` of the published state tracks the last sync, so live and last-known differ', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync(r.mod.syncRequest(k))
    r.clock.advance(11_000)
    r.link.sync({ mod_key: k })
    const last = r.states.at(-1) as { at: string }
    expect(Date.parse(last.at)).toBe(r.clock.now())
    expect(r.inventories.length).toBe(1) // inventory beats on its own slower clock
    for (let i = 0; i < 31; i++) {
      r.clock.advance(2000)
      r.link.sync({ mod_key: k })
    }
    expect(r.inventories.length).toBe(2)
  })

  test('close() cancels the lapse timer', () => {
    const r = rig()
    r.link.sync(r.mod.syncRequest(keyOf(r)))
    const n = r.states.length
    r.link.close()
    r.clock.advance(MOD_LIVE_WINDOW_MS * 2)
    expect(r.states.length).toBe(n)
  })
})

describe('events', () => {
  test('stopped_at_mac sets the flag on the held state; the next turn_start clears it', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync(r.mod.syncRequest(k))
    r.mod.engine.startTurn('t1')
    r.mod.engine.userInterrupt()
    r.clock.advance(2000)
    r.link.sync({ mod_key: k, events: r.mod.engine.events.splice(0) })
    expect(r.link.liveState()?.stopped_at_mac).toBe(true)
    expect(r.link.liveState()?.busy).toBe(false)
    r.mod.engine.userInput()
    r.mod.engine.startTurn('t2')
    r.clock.advance(2000)
    r.link.sync({ mod_key: k, events: r.mod.engine.events.splice(0) })
    expect(r.link.liveState()?.stopped_at_mac).toBe(false)
    expect(r.link.liveState()?.turn_id).toBe('t2')
  })

  test('valid events reach the sink in order; an invalid one is dropped alone', () => {
    const r = rig()
    const k = keyOf(r)
    const at = new Date(r.clock.now()).toISOString()
    const hash = `sha256:${'a'.repeat(64)}`
    r.link.sync({
      mod_key: k,
      events: [
        { type: 'prompt_open', tool_name: 'Bash', input_hash: hash, at },
        { type: 'prompt_open', tool_name: 'Bash', input_hash: 'not-a-hash', at },
        { type: 'nonsense', at },
        { type: 'prompt_closed', tool_name: 'Bash', input_hash: hash, at },
      ],
    })
    expect(r.events.map((e) => (e as { type: string }).type)).toEqual(['prompt_open', 'prompt_closed'])
  })

  test('at most 200 events per sync are read', () => {
    const r = rig()
    const k = keyOf(r)
    const at = new Date(r.clock.now()).toISOString()
    const events = Array.from({ length: 300 }, () => ({ type: 'compacting', on: true, at }))
    r.link.sync({ mod_key: k, events })
    expect(r.events.length).toBeLessThanOrEqual(200)
  })
})

describe('controls out, results in (the seam WP-C3 plugs into)', () => {
  test('a queued control is handed over once, then gone; the response parses', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.enqueue({ control_id: ULID, action: 'compact' })
    const first = r.link.sync(r.mod.syncRequest(k))
    expect(first.ok && ModSyncResponse.safeParse(first.response).success).toBe(true)
    expect(first.ok && first.response.controls).toHaveLength(1)
    const second = r.link.sync(r.mod.syncRequest(k))
    expect(second.ok && second.response.controls).toHaveLength(0)
  })

  test('results from the mod reach the sink; a malformed one is dropped', () => {
    const r = rig()
    const k = keyOf(r)
    r.link.sync({
      mod_key: k,
      results: [
        { control_id: ULID, ok: true, text: 'Compacted.' },
        { control_id: 'nope', ok: true, text: 'x' },
      ],
    })
    expect(r.results).toEqual([{ control_id: ULID, ok: true, text: 'Compacted.' }])
  })

  test('no more than 20 controls go out in one response', () => {
    const r = rig()
    const k = keyOf(r)
    for (let i = 0; i < 30; i++)
      r.link.enqueue({ control_id: `01JBF3V7Q8K2M4N6P8R0S2T4V${(i % 10).toString()}`, action: 'compact' })
    const res = r.link.sync(r.mod.syncRequest(k))
    expect(res.ok && res.response.controls.length).toBe(20)
    const rest = r.link.sync(r.mod.syncRequest(k))
    expect(rest.ok && rest.response.controls.length).toBe(10)
  })
})

describe('the tools', () => {
  let h: Harness
  afterEach(async () => h?.stop())

  test('both mod tools exist, are marked internal, and appear in the tool list', async () => {
    h = await startHarness()
    for (const n of MOD_BRIDGE_TOOLS) {
      const t = h.bridge.tools.find((x) => x.name === n)
      expect(t?.description).toContain(MOD_TOOL_DESCRIPTION)
      expect(t?.inputSchema.type).toBe('object')
    }
  })

  const fileKey = (home: string) => readFileSync(join(home, 'mod.key'), 'utf8').trim()

  test('the live bridge writes mod.key as 0600 and a hello with no proof gets nothing (no mod needed to be safe)', async () => {
    h = await startHarness()
    expect(statSync(join(h.home, 'mod.key')).mode & 0o777).toBe(0o600)
    const key = fileKey(h.home)
    for (const args of [{}, { proof: 'A'.repeat(43) }, { proof: 7 }, { ts: Date.now(), proof: 'A'.repeat(43) }]) {
      const res = await h.bridge.callTool('talos_mod_hello', args)
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res)).not.toMatch(/[A-Za-z0-9_-]{43}/)
    }
    expect(fileKey(h.home)).toBe(key) // refused hellos change nothing
  })

  test('hello with the file key succeeds, returns no key, and a second call is an error result, not a throw', async () => {
    h = await startHarness()
    const key = fileKey(h.home)
    const a = await h.bridge.callTool('talos_mod_hello', helloArgs(key, Date.now()))
    expect(a.isError).toBeFalsy()
    expect(JSON.parse(text(a))).toEqual({ ok: true, features: ['agents'] })
    expect(text(a)).not.toContain(key)
    expect(fileKey(h.home)).not.toBe(key)
    const b = await h.bridge.callTool('talos_mod_hello', helloArgs(fileKey(h.home), Date.now() + 1))
    expect(b.isError).toBe(true)
    expect(JSON.stringify(b)).not.toContain(fileKey(h.home))
  })

  test('sync through the tool sends session.state and session.inventory frames that parse', async () => {
    h = await startHarness()
    await h.bridge.callTool('talos_mod_hello', helloArgs(fileKey(h.home), Date.now()))
    const mod = new FakeMod({ clock: fakeClock() })
    const res = await h.bridge.callTool('talos_mod_sync', signedSync(fileKey(h.home), 1, mod.syncRequest('x')))
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(text(res))).toEqual({ controls: [] })
    const s = await h.relay.expectFrame('session.state', () => true, { direction: 'from_bridge' })
    expect(parseFrame(s, { direction: 'bridge_to_relay' }).ok).toBe(true)
    const i = await h.relay.expectFrame('session.inventory', () => true, { direction: 'from_bridge' })
    expect(parseFrame(i, { direction: 'bridge_to_relay' }).ok).toBe(true)
  })

  test('sync with a wrong key is an error result that says unauthorized', async () => {
    h = await startHarness()
    await h.bridge.callTool('talos_mod_hello', helloArgs(fileKey(h.home), Date.now()))
    const res = await h.bridge.callTool('talos_mod_sync', { mod_key: 'A'.repeat(43), seq: 1 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('unauthorized')
  })

  test('a headless process cannot use either tool', async () => {
    h = await startHarness({ startBridge: false })
    const b = await Bridge.create({ env: { ...h.bridge.ctx.env, live: false }, logger: nullLogger })
    for (const [name, args] of [
      ['talos_mod_hello', { ts: Date.now(), proof: 'A'.repeat(43) }],
      ['talos_mod_sync', { mod_key: 'A'.repeat(43) }],
    ] as const) {
      const res = await b.callTool(name, args)
      expect(res.isError).toBe(true)
      expect(text(res)).toContain('live session')
    }
  })
})

describe('F4: the key never travels, and a call cannot be forged or replayed', () => {
  const sync = (r: Rig, key: string, seq: number, body: Record<string, unknown>) =>
    r.raw.sync(signedSync(key, seq, body))

  test('hello and sync arguments carry a MAC, never the key', () => {
    const r = rig()
    const file = r.file()
    const hello = helloArgs(file, r.clock.now())
    expect(JSON.stringify(hello)).not.toContain(file)
    expect(r.raw.hello(hello)).toEqual({ ok: true })
    const body = r.mod.syncRequest('x')
    const args = signedSync(r.file(), 1, body)
    expect(JSON.stringify(args)).not.toContain(r.file())
    expect(sync(r, r.file(), 2, body).ok).toBe(true)
  })

  test('a hello replayed by someone who saw it is refused (ts is used once, and the key has rotated)', () => {
    const r = rig()
    const hello = helloArgs(r.file(), r.clock.now())
    expect(r.raw.hello(hello).ok).toBe(true)
    r.clock.advance(MOD_LIVE_WINDOW_MS + 1)
    expect(r.raw.hello(hello)).toMatchObject({ ok: false })
  })

  test('a hello with a stale or future ts is refused', () => {
    const r = rig()
    expect(r.raw.hello(helloArgs(r.file(), r.clock.now() - MOD_LIVE_WINDOW_MS - 1))).toMatchObject({ ok: false })
    expect(r.raw.hello(helloArgs(r.file(), r.clock.now() + MOD_LIVE_WINDOW_MS + 1))).toMatchObject({ ok: false })
    expect(r.raw.hello({ ts: 1.5, proof: 'x' })).toMatchObject({ ok: false })
  })

  test('a captured sync cannot be replayed (seq only goes up), nor its body edited (the MAC covers it)', () => {
    const r = rig()
    r.raw.hello(helloArgs(r.file(), r.clock.now()))
    const key = r.file()
    const body = r.mod.syncRequest('x')
    expect(sync(r, key, 1, body).ok).toBe(true)
    const captured = signedSync(key, 2, body)
    expect(r.raw.sync(captured).ok).toBe(true)
    expect(r.raw.sync(captured)).toMatchObject({ ok: false, code: 'unauthorized' }) // same seq again
    expect(sync(r, key, 1, body)).toMatchObject({ ok: false }) // an older seq
    const tampered = signedSync(key, 3, body) as Record<string, unknown>
    tampered.state = { ...(body.state as object), busy: true }
    expect(r.raw.sync(tampered)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(r.raw.sync({ ...signedSync(key, 4, body), seq: 5 })).toMatchObject({ ok: false }) // seq is covered too
    expect(r.raw.sync({ ...signedSync(key, 6, body), seq: '6' })).toMatchObject({ ok: false })
  })

  test('the MAC is order-independent: the same body in another key order verifies', () => {
    const r = rig()
    r.raw.hello(helloArgs(r.file(), r.clock.now()))
    const key = r.file()
    const signed = signedSync(key, 1, { events: [], state: r.mod.state() }) as Record<string, unknown>
    const reordered = { state: signed.state, events: signed.events, mod_key: signed.mod_key, seq: signed.seq }
    expect(r.raw.sync(reordered).ok).toBe(true)
  })

  test('the mod and the bridge canonicalise identically', async () => {
    const { canonicalJson: modSide } = await import('../../../plugins/talos-app-mod/hooks/lib/hash.ts')
    const { canonicalJson: bridgeSide } = await import('../src/mod/canonical.ts')
    for (const v of [
      { b: 1, a: [3, { z: null, y: undefined, x: 'é "' }], c: { d: [], e: {} } },
      [undefined, 1],
      'str',
      null,
      7.5,
      {},
    ])
      expect(modSide(v)).toBe(bridgeSide(v))
  })
})

describe("the mod's HMAC is node's HMAC (the mod environment has digest but no importKey)", () => {
  test('equal for short keys, 43-character keys, keys over the block size, and unicode messages', async () => {
    const { hmacB64url } = await import('../../../plugins/talos-app-mod/hooks/lib/hash.ts')
    const { mac } = await import('./mod-sign.ts')
    for (const key of ['k', 'k'.repeat(43), 'x'.repeat(64), 'y'.repeat(65), 'z'.repeat(200), 'é'.repeat(40)])
      for (const msg of ['', 'hello\n1', 'sync\n7\n{"a":[1,2]}', 'é\u2028"\\'.repeat(50)])
        expect(await hmacB64url(key, msg)).toBe(mac(key, msg))
  })
})
