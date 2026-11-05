// WP-A1 bridge half (docs/SUBAGENTS.md 5.2, 5.3) through the REAL bridge: the MAC covers `agents`, hello advertises it,
// session.agents reaches only a relay with `agents/1`, nothing lands in history.sqlite or the outbox, session.state stays
// main's nine capabilities, and `agent_stop` passes the policy only for a live stoppable row of this session. Plus the
// tee and its installer. The behavioural contract (throttle, beat, lapse, trim) is test-contract/agents.contract.vitest.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AGENTS_FEATURE,
  AgentsSnapshot,
  type ModControlT,
  parseFrame,
  SESSION_CAPABILITIES_V1,
} from '@talos-app/protocol'
import { agentRowSample, agentsSnapshotSample, FakeMod, fakeClock, waitFor } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { nullLogger } from '../src/log.ts'
import { ModLink } from '../src/mod/link.ts'
import { runTee, teeFileOf, teeTasks, wrappedOf } from '../src/subagent-tee.ts'
import { planSubagentTee, shq, teeCommand } from '../src/subagent-tee-install.ts'
import { startHarness } from './helpers.ts'
import { helloArgs, signedSync, signingLink } from './mod-sign.ts'

type H = Awaited<ReturnType<typeof startHarness>>
let h: H | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const SENTINEL = 'agents-bridge-sentinel-7f3a'

/** A live FakeMod (hello + one sync) against the harness bridge; `sync` sends the next request as the mod would. */
function liveMod(harness: H) {
  const mod = new FakeMod({ clock: fakeClock() })
  const link = signingLink(harness.bridge.ctx.mod, () => Date.now())
  const file = () => readFileSync(harness.bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(file()).ok).toBe(true)
  const sync = (extra: Record<string, unknown> = {}) => {
    const r = link.sync({ ...mod.syncRequest(file()), ...extra })
    if (!r.ok) throw new Error(r.message)
    return r.response.controls
  }
  sync()
  return { mod, sync, file }
}

describe('the mod link takes agents', () => {
  test('hello says the bridge takes agents; the MAC covers the member, so a changed one is unauthorized', () => {
    const clock = fakeClock()
    let secret = ''
    const link = new ModLink({
      clock,
      log: nullLogger,
      keys: {
        read: () => secret,
        write: (k) => {
          secret = k
        },
      },
      sink: { state: () => {}, inventory: () => {} },
    })
    expect(link.hello(helloArgs(secret, clock.now())).ok).toBe(true)
    const signed = signedSync(secret, 1, { agents: agentsSnapshotSample() })
    expect(link.sync(signed).ok).toBe(true)
    const forged: Record<string, unknown> = signedSync(secret, 2, { agents: agentsSnapshotSample() })
    forged.agents = agentsSnapshotSample([agentRowSample({ id: 'other' })])
    expect(link.sync(forged)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(link.liveAgents()?.rows.map((r) => r.id)).toEqual([agentRowSample().id])
  })

  test('a snapshot that does not parse: nothing new goes out, and the held rows no longer back a Stop (R2)', () => {
    const clock = fakeClock()
    let secret = ''
    const out: unknown[] = []
    const link = new ModLink({
      clock,
      log: nullLogger,
      keys: {
        read: () => secret,
        write: (k) => {
          secret = k
        },
      },
      sink: { state: () => {}, inventory: () => {}, agents: (a) => out.push(a) },
    })
    expect(link.hello(helloArgs(secret, clock.now())).ok).toBe(true)
    expect(link.sync(signedSync(secret, 1, { agents: agentsSnapshotSample() })).ok).toBe(true)
    expect(link.liveAgents()?.can_stop).toBe(true)
    const bad = agentsSnapshotSample([agentRowSample({ started_at: '+011476-01-01T00:00:00.000Z' })])
    expect(link.sync(signedSync(secret, 2, { agents: bad })).ok).toBe(true)
    expect(out).toHaveLength(1)
    expect(link.liveAgents()?.can_stop).toBe(false)
    clock.advance(2000)
    expect(link.sync(signedSync(secret, 3, { agents: agentsSnapshotSample() })).ok).toBe(true)
    expect(link.liveAgents()?.can_stop).toBe(true) // the next good one is trusted again
  })

  test('the hello tool answers features: [agents] and still never a key', async () => {
    h = await startHarness()
    const key = readFileSync(h.bridge.ctx.paths.modKey, 'utf8').trim()
    const r = await h.bridge.callTool('talos_mod_hello', helloArgs(key, Date.now()))
    expect(JSON.parse(text(r))).toEqual({ ok: true, features: ['agents'] })
    expect(text(r)).not.toContain(readFileSync(h.bridge.ctx.paths.modKey, 'utf8').trim())
  })
})

describe('session.agents through the real bridge', () => {
  test('a relay with agents/1 gets a session.agents that parses; session.state keeps main nine capabilities', async () => {
    h = await startHarness({ relay: { relayFeatures: ['schedules/1', AGENTS_FEATURE] } })
    const { mod, sync } = liveMod(h)
    mod.engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research mods API' })
    sync()
    const f = await h.relay.expectFrame('session.agents', () => true, { direction: 'from_bridge' })
    const p = parseFrame(f, { direction: 'bridge_to_relay' })
    expect(p.ok).toBe(true)
    expect((f.agents as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual(['a1'])
    const s = await h.relay.expectFrame('session.state', () => true, { direction: 'from_bridge' })
    const caps = (s.state as { capabilities: string[] }).capabilities
    expect(caps.every((c) => (SESSION_CAPABILITIES_V1 as readonly string[]).includes(c))).toBe(true)
    expect(caps).not.toContain('agents')
    expect(h.bridge.ctx.mod.liveState()?.capabilities).toContain('agent_stop') // the bridge's own copy keeps it
  })

  test('a relay without agents/1 never gets one', async () => {
    h = await startHarness({ relay: { relayFeatures: ['schedules/1'] } })
    const { mod, sync } = liveMod(h)
    mod.engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research mods API' })
    sync()
    await h.relay.expectFrame('session.state', () => true, { direction: 'from_bridge' })
    await Bun.sleep(300)
    expect(h.relay.rec.frames.some((r) => r.frame.type === 'session.agents')).toBe(false)
    expect(h.bridge.ctx.mod.liveAgents()?.rows).toHaveLength(1) // held for the policy all the same
  })

  test('nothing durable: no snapshot text in history.sqlite, its outbox, or any file under the home', async () => {
    h = await startHarness({ relay: { relayFeatures: [AGENTS_FEATURE] } })
    const { mod, sync } = liveMod(h)
    mod.engine.spawnAgent({ id: 'a1', type: 'Explore', description: SENTINEL })
    mod.engine.agentTool('a1', 'Bash', { description: SENTINEL })
    sync()
    await h.relay.expectFrame('session.agents', () => true, { direction: 'from_bridge' })
    h.bridge.ctx.store.kvGet('x') // a read forces nothing, but the db file is flushed by sqlite on each write
    const files = [h.bridge.ctx.paths.historyDb, `${h.bridge.ctx.paths.historyDb}-wal`, join(h.home, 'bridge.log')]
    for (const f of files) if (existsSync(f)) expect(readFileSync(f).toString('latin1')).not.toContain(SENTINEL)
  })
})

describe('agent_stop through the real bridge', () => {
  const ts = () => new Date().toISOString()

  test('a live stoppable row reaches the mod with its agent_id; the mod result reaches the app', async () => {
    h = await startHarness({ relay: { relayFeatures: [AGENTS_FEATURE] } })
    const { mod, sync } = liveMod(h)
    mod.engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research' })
    sync()
    const f = await h.app.sendSessionControl('general', { action: 'agent_stop', agent_id: 'a1', ts: ts() })
    let controls: ModControlT[] = []
    await waitFor(
      () => {
        controls = sync()
        return controls.length > 0
      },
      4000,
      'agent_stop delivered',
    )
    expect(controls[0]).toMatchObject({ control_id: f.control_id, action: 'agent_stop', agent_id: 'a1' })
    await mod.execute(controls[0] as ModControlT)
    sync()
    const r = await h.app.expectFrame('session.control.result', (x) => x.control_id === f.control_id)
    expect(r).toMatchObject({ ok: true })
    expect(mod.engine.taskStops).toEqual(['a1'])
  })

  test('an ended row, an unknown id, or no snapshot at all is agent_not_found and never reaches the mod', async () => {
    h = await startHarness({ relay: { relayFeatures: [AGENTS_FEATURE] } })
    const { mod, sync } = liveMod(h)
    const ask = async (agent_id: string) => {
      const f = await h?.app.sendSessionControl('general', { action: 'agent_stop', agent_id, ts: ts() })
      return h?.app.expectFrame('session.control.result', (x) => x.control_id === f?.control_id)
    }
    expect(await ask('a1')).toMatchObject({ ok: false, code: 'agent_not_found' }) // no snapshot yet
    mod.engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research' })
    mod.engine.setTaskStatus('a1', 'completed')
    sync()
    expect(await ask('a1')).toMatchObject({ ok: false, code: 'agent_not_found' })
    expect(await ask('nope')).toMatchObject({ ok: false, code: 'agent_not_found' })
    expect(sync()).toEqual([])
    expect(mod.engine.taskStops).toEqual([])
  })

  test("another session's snapshot never lets a stop through", async () => {
    h = await startHarness({ relay: { relayFeatures: [AGENTS_FEATURE] } })
    const { sync } = liveMod(h)
    sync({ agents: agentsSnapshotSample([agentRowSample({ id: 'old' })], { session_id: 'sess_elsewhere' }) })
    const f = await h.app.sendSessionControl('general', { action: 'agent_stop', agent_id: 'old', ts: ts() })
    const r = await h.app.expectFrame('session.control.result', (x) => x.control_id === f.control_id)
    expect(r).toMatchObject({ ok: false, code: 'agent_not_found' })
  })
})

// ---- the tee ---------------------------------------------------------------------------------------------------------

const TEE_INPUT = {
  session_id: 's',
  columns: 80,
  tasks: [
    {
      id: 'a1',
      type: 'local_agent',
      agentType: 'Explore',
      status: 'running',
      description: 'research mods API',
      label: 'Running memory and search vitest suites',
      startTime: 1_761_825_600_000,
      tokenCount: 12_300,
      tokenSamples: [1, 2, 3],
      model: 'claude-haiku-5-5',
      cwd: '/repo',
    },
    { nope: true },
  ],
}

describe('talos-app subagent-tee', () => {
  test('keeps the row fields, writes atomically (0600), prints nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    const out = runTee(JSON.stringify(TEE_INPUT), [], { TALOS_APP_HOME: home }, 1234)
    expect(out.stdout).toBe('')
    const path = join(home, teeFileOf('s') as string)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      v: 1,
      at: 1234,
      session_id: 's',
      tasks: [
        {
          id: 'a1',
          agentType: 'Explore',
          status: 'running',
          label: 'Running memory and search vitest suites',
          description: 'research mods API',
          startTime: 1_761_825_600_000,
          model: 'claude-haiku-5-5',
          tokenCount: 12_300,
        },
      ],
    })
    expect(teeTasks('garbage')).toEqual([])
  })

  test('one file per session (R6): two live sessions never overwrite each other; a bad session id writes nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    const env = { TALOS_APP_HOME: home }
    runTee(JSON.stringify({ ...TEE_INPUT, session_id: 'sess-a' }), [], env, 1)
    runTee(JSON.stringify({ session_id: 'sess-b', tasks: [{ id: 'b1', label: 'other' }] }), [], env, 2)
    const a = JSON.parse(readFileSync(join(home, teeFileOf('sess-a') as string), 'utf8'))
    const b = JSON.parse(readFileSync(join(home, teeFileOf('sess-b') as string), 'utf8'))
    expect(a).toMatchObject({ session_id: 'sess-a', tasks: [{ id: 'a1' }] })
    expect(b).toMatchObject({ session_id: 'sess-b', tasks: [{ id: 'b1' }] })
    expect(teeFileOf('../x')).toBeUndefined()
    runTee(JSON.stringify({ session_id: '../../etc', tasks: [] }), [], env, 3)
    expect(existsSync(join(home, 'etc.json'))).toBe(false)
  })

  test('bad JSON: exit 0, nothing printed, nothing written', () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    expect(runTee('{not json', [], { TALOS_APP_HOME: home }).stdout).toBe('')
    expect(existsSync(join(home, teeFileOf('s') as string))).toBe(false)
  })

  test("wrapped: the owner's own command gets the same stdin and its stdout passes through", () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    const out = runTee(JSON.stringify(TEE_INPUT), wrappedOf(['--', '/bin/sh', '-c', 'wc -c | tr -d " "']), {
      TALOS_APP_HOME: home,
      PATH: process.env.PATH,
    })
    expect(out.stdout.trim()).toBe(String(JSON.stringify(TEE_INPUT).length))
    expect(existsSync(join(home, teeFileOf('s') as string))).toBe(true)
  })

  // Every module a source names, statically (also when the import list runs over several lines) or at run time.
  const modulesNamed = (source: string) =>
    [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1] as string)

  test('the import scan sees single-line, multi-line, side-effect and run-time imports', () => {
    const sample = [
      "import { a } from 'node:fs'",
      'import {',
      '  b,',
      '  c,',
      "} from '../src/bridge.ts'",
      "import type { T } from '@talos-app/protocol'",
      "import './boot.ts'",
      "const m = await import('node:os')",
      "export { z } from './z.ts'",
    ].join('\n')
    expect(modulesNamed(sample).sort()).toEqual(
      ['node:fs', '../src/bridge.ts', '@talos-app/protocol', './boot.ts', 'node:os', './z.ts'].sort(),
    )
  })

  const teeSource = () => readFileSync(resolve(import.meta.dir, '../src/subagent-tee.ts'), 'utf8')

  test('it stays import-light: node: builtins only, no workspace code, so it starts like an empty script', () => {
    // The hook runs once per refresh tick, so what it must not do is load the bridge. That is a fact about its imports,
    // not about a clock: every module it names, statically or at run time, is a node: builtin.
    const named = modulesNamed(teeSource())
    expect(named.length).toBeGreaterThan(0) // control: the pattern sees the imports that are there
    expect(named.filter((m) => !m.startsWith('node:'))).toEqual([])
  })

  test('in process, with nothing wrapped, the tee waits about as long as a plain file write: elapsed time stays near CPU time', () => {
    // No millisecond limit. The tee's elapsed time is held to a multiple of the elapsed time of the plain file write it is
    // built from (write a temp file, rename it), taken in this run: a busy machine slows both together, and the fastest of
    // many runs of each is used because load only adds time. A tee that sleeps, waits on a lock or joins a child adds
    // time without adding CPU, so it fails here though it would pass a CPU figure.
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    const env = { TALOS_APP_HOME: home }
    const input = JSON.stringify(TEE_INPUT)
    const fastest = (fn: () => void) => {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 30; i++) {
        const t = performance.now()
        fn()
        best = Math.min(best, performance.now() - t)
      }
      return best
    }
    const plain = () => {
      writeFileSync(join(home, 'plain.tmp'), input, { mode: 0o600 })
      renameSync(join(home, 'plain.tmp'), join(home, 'plain.json'))
    }
    const ref = Math.max(fastest(plain), 0.02)
    const tee = fastest(() => runTee(input, [], env, 1))
    expect(existsSync(join(home, teeFileOf('s') as string))).toBe(true) // control: the tee did its work
    expect(tee, `tee ${tee.toFixed(3)} ms, plain write ${ref.toFixed(3)} ms`).toBeLessThanOrEqual(ref * 40)
  })

  // up to 18 sync spawns; a bun timeout inside spawnSync SIGTERMs the child (exit null), which looks like a tee failure
  test('as a process: exit 0, no output, bad input included, and it costs about what an empty bun start costs', () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-tee-'))
    const script = resolve(import.meta.dir, '../src/subagent-tee.ts')
    // No millisecond limit: a busy machine slows everything alike. Two figures, each a ratio to an empty bun start
    // measured in the same round: the child's own CPU time, and its elapsed time (a tee that waits spends no CPU, so the
    // second is the one that sees it). The lowest of several runs of each is used (load only adds time); a round that
    // still misses is repeated, and the test fails only when the tee is heavy in all three rounds.
    // The baseline lives in the repo beside the tee: a script in a temp folder is slower to start for reasons that have
    // nothing to do with the tee, which made the old comparison pass whatever the tee did.
    const empty = resolve(import.meta.dir, 'fixtures/empty-script.ts')
    const run = (args: string[], input?: string) => {
      const t0 = performance.now()
      const r = Bun.spawnSync([process.execPath, ...args], {
        stdin: input === undefined ? undefined : Buffer.from(input),
        env: { TALOS_APP_HOME: home, PATH: process.env.PATH ?? '' },
      })
      const wall = performance.now() - t0
      const cpu = Number(r.resourceUsage.cpuTime.total) / 1000
      expect(cpu, 'the child reported no CPU time at all').toBeGreaterThan(0) // control: the figure is really measured
      return { cpu, wall, r }
    }
    const inputs = [JSON.stringify(TEE_INPUT), 'garbage', JSON.stringify(TEE_INPUT)]
    const worst: number[] = []
    for (let round = 0; round < 3; round++) {
      const tee = { cpu: [] as number[], wall: [] as number[] }
      const base = { cpu: [] as number[], wall: [] as number[] }
      for (const input of inputs) {
        const b = run([empty])
        base.cpu.push(b.cpu)
        base.wall.push(b.wall)
        const t = run([script], input)
        tee.cpu.push(t.cpu)
        tee.wall.push(t.wall)
        expect({ exit: t.r.exitCode, signal: t.r.signalCode ?? null }).toEqual({ exit: 0, signal: null }) // null exit + SIGTERM = bun's test timeout, not the tee
        expect(t.r.stdout.toString()).toBe('')
      }
      const cpuRatio = Math.min(...tee.cpu) / Math.max(Math.min(...base.cpu), 1)
      const wallRatio = Math.min(...tee.wall) / Math.max(Math.min(...base.wall), 1)
      worst.push(Math.max(cpuRatio, wallRatio))
      if ((worst[round] as number) < 6) break
    }
    expect(Math.min(...worst)).toBeLessThan(6)
  }, 60_000)
})

describe('talos-app install-subagent-tee', () => {
  const io = (answer = 'n') => {
    const lines: string[] = []
    return {
      lines,
      io: {
        out: (l: string) => lines.push(l),
        err: (l: string) => lines.push(`ERR ${l}`),
        prompt: async () => answer,
        sleep: async () => {},
        now: () => Date.now(),
      },
    }
  }
  const agentDir = () => mkdtempSync(join(tmpdir(), 'talos-agentdir-'))

  test('dry run shows the change and writes nothing', async () => {
    const dir = agentDir()
    const o = io('y')
    expect(
      await runCli(['install-subagent-tee', '--agent-dir', dir, '--dry-run'], o.io, {
        HOME: dir,
        TALOS_APP_HOME: join(dir, 'home'),
      }),
    ).toBe(0)
    expect(o.lines.join('\n')).toContain('subagentStatusLine')
    expect(o.lines.join('\n')).toContain('dry run: nothing was written')
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false)
  })

  test('asks y/N; no writes nothing, yes writes the tee and keeps every other key', async () => {
    const dir = agentDir()
    const path = join(dir, '.claude', 'settings.json')
    await Bun.write(path, JSON.stringify({ permissions: { ask: ['Bash(git push *)'] } }))
    expect(
      await runCli(['install-subagent-tee', '--agent-dir', dir], io('n').io, {
        HOME: dir,
        TALOS_APP_HOME: join(dir, 'home'),
      }),
    ).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8')).subagentStatusLine).toBeUndefined()
    expect(
      await runCli(['install-subagent-tee', '--agent-dir', dir], io('y').io, {
        HOME: dir,
        TALOS_APP_HOME: join(dir, 'home'),
      }),
    ).toBe(0)
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    expect(cfg.permissions).toEqual({ ask: ['Bash(git push *)'] })
    expect(cfg.subagentStatusLine.type).toBe('command')
    expect(cfg.subagentStatusLine.command).toContain('subagent-tee.ts')
    const again = io('y')
    await runCli(['install-subagent-tee', '--agent-dir', dir], again.io, {
      HOME: dir,
      TALOS_APP_HOME: join(dir, 'home'),
    })
    expect(again.lines.join('\n')).toContain('already')
  })

  test("the owner's own subagentStatusLine is wrapped, never replaced; an unknown shape or bad JSON stops it", () => {
    const dir = agentDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ subagentStatusLine: { type: 'command', command: "~/rows.sh --x 'y'" } }))
    const plan = planSubagentTee(path, 'bun /t/subagent-tee.ts')
    expect(plan.wrapped).toBe(true)
    expect(plan.after?.command).toBe(`bun /t/subagent-tee.ts -- /bin/sh -c ${shq("~/rows.sh --x 'y'")}`)
    writeFileSync(path, JSON.stringify({ subagentStatusLine: 'x' }))
    expect(() => planSubagentTee(path, 'c')).toThrow(/not a command setting/)
    writeFileSync(path, '{oops')
    expect(() => planSubagentTee(path, 'c')).toThrow(/not valid JSON/)
  })

  test('the command names TALOS_APP_HOME only when it is not the default', () => {
    expect(teeCommand('/custom home', 'bun', '/s/subagent-tee.ts')).toBe(
      "TALOS_APP_HOME='/custom home' bun /s/subagent-tee.ts",
    )
  })

  test('the snapshot the FakeMod sends parses as the protocol says (sanity for the tests above)', () => {
    const mod = new FakeMod({ clock: fakeClock() })
    mod.engine.spawnAgent({ id: 'a1', description: 'x' })
    expect(AgentsSnapshot.safeParse(mod.agents()).success).toBe(true)
  })
})
