import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { COMMANDS, runTalos } from '../src/talos.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

function cliIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
/** What a doctor run is given so it reads neither the machine's process list nor its own ~/.claude. */
const hermetic = () => ({
  claudeDir: mkdtempSync(join(tmpdir(), 'talos-claude-')),
  deps: { processes: () => [] as string[] },
})
const envOf = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })

type Row = { name: string; summary: string; agent_may_run: boolean }

describe('talos commands', () => {
  test('--json lists each command with what it does and agent_may_run, and says which are enforced', async () => {
    const { out, io } = cliIO()
    expect(await runTalos(['commands', '--json'], io, {})).toBe(0)
    const parsed = JSON.parse(out.join('\n')) as { enforced: string; note: string; commands: Row[] }
    expect(parsed.enforced).toBe('terminal')
    expect(parsed.note).toContain('refuse when stdin or stdout is not one')
    expect(parsed.commands.length).toBeGreaterThan(10)
    for (const c of parsed.commands) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(typeof c.agent_may_run).toBe('boolean')
    }
    const byName = new Map(parsed.commands.map((c) => [c.name, c]))
    for (const name of [
      'enroll',
      'devices',
      'rotate',
      'memory init',
      'apps scan',
      'install-ask-rules',
      'rollback',
      'trust',
    ]) {
      expect(byName.get(name)?.agent_may_run, name).toBe(false)
    }
    for (const name of ['status', 'doctor', 'commands']) expect(byName.get(name)?.agent_may_run, name).toBe(true)
  })

  test('every subcommand that changes approvals, keys, tokens, settings or sign-ins is marked owner only', async () => {
    const { out, io } = cliIO()
    expect(await runTalos(['commands', '--json'], io, {})).toBe(0)
    const byName = new Map((JSON.parse(out.join('\n')) as { commands: Row[] }).commands.map((c) => [c.name, c]))
    for (const name of [
      'hook',
      'report',
      'schedules',
      'apps strict',
      'apps revoke',
      'apps login',
      'apps logout',
      'apps scan',
      'schedules adopt',
      'share shortcut',
      'share revoke',
      'memory on',
      'memory off',
      'memory init',
      // A parent that only holds sensitive subcommands is owner only too.
      'apps',
      'share',
      'memory',
    ]) {
      expect(byName.get(name), `${name} is listed`).toBeDefined()
      expect(byName.get(name)?.agent_may_run, name).toBe(false)
    }
    // The read-only subcommands stay open to the agent.
    for (const name of [
      'apps list',
      'memory show',
      'memory reindex',
      'search reindex',
      'codex',
      'codex check',
      'codex run',
    ])
      expect(byName.get(name)?.agent_may_run, name).toBe(true)
  })

  test('the plain listing lines up its columns, and a name is never cut', async () => {
    const { out, io } = cliIO()
    expect(await runTalos(['commands'], io, {})).toBe(0)
    const rows = out.slice(0, out.indexOf(''))
    expect(rows).toHaveLength(COMMANDS.length)
    const width = Math.max(...COMMANDS.map((c) => c.name.length))
    rows.forEach((line, i) => {
      const c = COMMANDS[i] as (typeof COMMANDS)[number]
      const mark = c.agent_may_run ? 'agent ok' : 'owner only'
      expect(line, c.name).toBe(`${c.name.padEnd(width)}  ${mark.padEnd(10)}  ${c.summary}`)
    })
    // Every row has its summary starting in the same column.
    expect(new Set(rows.map((l, i) => l.indexOf((COMMANDS[i] as { summary: string }).summary))).size).toBe(1)
  })

  test('the plain listing also says what is enforced', async () => {
    const { out, io } = cliIO()
    expect(await runTalos(['commands'], io, {})).toBe(0)
    expect(out.join('\n')).toContain('refuse when stdin or stdout is not one')
  })

  // One harmless call per listed name, through the real front door and the real CLI behind it. Each one is a form that
  // changes nothing (a bad flag, a missing argument, an empty temp home) and still gets a reply only that handler gives.
  const AGENT = '<agent>'
  type Probe = { argv: string[]; says?: RegExp; code: number }
  const unknown = /Unknown option/
  const PROBES: Record<string, Probe> = {
    status: { argv: ['status', '--no-such-flag'], says: unknown, code: 1 },
    doctor: { argv: ['doctor', '--no-such-flag'], says: unknown, code: 1 },
    logs: { argv: ['logs', '--no-such-flag'], says: unknown, code: 1 },
    report: { argv: ['report', '--no-such-flag'], says: unknown, code: 1 },
    errors: { argv: ['errors', '--no-such-flag'], says: /usage: talos-app errors list/, code: 2 },
    'search reindex': { argv: ['search', 'reindex'], says: /no history on this Mac yet/, code: 1 },
    schedules: { argv: ['schedules', '--no-such-flag'], says: /usage: talos-app schedules/, code: 1 },
    // Answers N to every question, so nothing is approved whatever scheduler the machine has.
    'schedules adopt': { argv: ['schedules', 'adopt'], says: /nothing to adopt|Chronos/, code: -1 },
    codex: { argv: ['codex', '--no-such-flag'], says: /usage: talos-app codex/, code: 1 },
    'codex check': { argv: ['codex', 'check'], says: /codex|Codex/, code: -1 },
    'codex run': { argv: ['codex', 'run'], says: /usage: talos-app codex/, code: 1 },
    digest: { argv: ['digest', '--no-such-flag'], says: unknown, code: 1 },
    post: { argv: ['post'], says: /usage: talos-app post <thread>/, code: 1 },
    hook: { argv: ['hook', '--no-such-flag'], code: 0 }, // Claude Code's entry: silent unless run by the bridge
    memory: { argv: ['memory', '--no-such-flag'], says: /usage: talos-app memory/, code: 2 },
    'memory init': { argv: ['memory', 'init', '--agent-dir', AGENT], says: /has no folders to share/, code: 1 },
    'memory on': { argv: ['memory', 'on'], says: /memory browser is not set up/, code: 1 },
    'memory off': { argv: ['memory', 'off'], says: /memory browser is not set up/, code: 1 },
    'memory show': { argv: ['memory', 'show'], says: /memory browser is not set up/, code: 0 },
    'memory reindex': { argv: ['memory', 'reindex'], says: /memory browser is not set up/, code: 1 },
    apps: { argv: ['apps', '--no-such-flag'], says: /usage: talos-app apps scan/, code: 2 },
    'apps scan': { argv: ['apps', 'scan', '--no-such-flag'], says: unknown, code: 1 },
    'apps list': { argv: ['apps', 'list'], says: /No apps/, code: 0 },
    'apps strict': { argv: ['apps', 'strict'], says: /usage: talos-app apps strict/, code: 2 },
    'apps revoke': { argv: ['apps', 'revoke'], says: /usage: talos-app apps revoke/, code: 2 },
    'apps login': { argv: ['apps', 'login'], says: /usage: talos-app apps login/, code: 2 },
    'apps logout': { argv: ['apps', 'logout'], says: /usage: talos-app apps logout/, code: 2 },
    share: { argv: ['share'], says: /talos-app share: unknown/, code: 2 },
    'share revoke': { argv: ['share', 'revoke'], says: /need one share link id/, code: 2 },
    'share shortcut': { argv: ['share', 'shortcut', '--no-such-flag'], says: unknown, code: 2 },
    init: { argv: ['init', '--no-such-flag'], says: unknown, code: 1 },
    enroll: { argv: ['enroll', '--no-such-flag'], says: unknown, code: 1 },
    devices: { argv: ['devices'], says: /no devices pinned/, code: 0 },
    rotate: { argv: ['rotate'], says: /no bridge key/, code: 1 },
    start: { argv: ['start', '--no-such-flag'], says: unknown, code: 1 },
    update: { argv: ['update', '--no-such-flag'], says: unknown, code: 1 },
    rollback: { argv: ['rollback', '--no-such-flag'], says: unknown, code: 1 },
    'restore-last-good': { argv: ['restore-last-good', '--no-such-flag'], says: unknown, code: 1 },
    theme: { argv: ['theme', '--no-such-flag'], says: /usage: talos-app theme/, code: 2 },
    'theme reset': { argv: ['theme', 'reset'], says: /cannot read .*config\.json/, code: 1 },
    lead: { argv: ['lead'], says: /usage: talos-app lead/, code: 2 },
    'lead init': { argv: ['lead', 'init'], says: /usage: talos-app lead/, code: 2 },
    'lead check': { argv: ['lead', 'check'], says: /usage: talos-app lead/, code: 2 },
    trust: { argv: ['trust', '--no-such-flag'], says: /usage: talos-app trust/, code: 2 },
    'trust on': { argv: ['trust', 'on', 'extra'], says: /usage: talos-app trust/, code: 2 },
    'install-mcp': { argv: ['install-mcp', '--no-such-flag'], says: unknown, code: 1 },
    adopt: { argv: ['adopt', '--no-such-flag'], says: unknown, code: 1 },
    'install-app-hooks': { argv: ['install-app-hooks', '--no-such-flag'], says: unknown, code: 1 },
    'install-ask-rules': { argv: ['install-ask-rules', '--no-such-flag'], says: unknown, code: 1 },
    'install-guards': { argv: ['install-guards', '--no-such-flag'], says: unknown, code: 1 },
    'install-subagent-tee': { argv: ['install-subagent-tee', '--no-such-flag'], says: unknown, code: 1 },
  }
  // Answered by talos itself, or too tied to stdin to run in this process; the next tests drive these two for real.
  const NOT_PROBED = new Set(['commands', 'subagent-tee'])

  test('every listed name has exactly one probe, and every probe is a listed name', () => {
    const listed = COMMANDS.map((c) => c.name).filter((n) => !NOT_PROBED.has(n))
    expect(Object.keys(PROBES).sort()).toEqual([...listed].sort())
  })

  test('every listed command, subwords included, reaches its own handler through the real CLI', async () => {
    for (const c of COMMANDS) {
      const probe = PROBES[c.name]
      if (!probe) continue
      const home = mkdtempSync(join(tmpdir(), 'talos-probe-'))
      const agent = mkdtempSync(join(tmpdir(), 'talos-probe-agent-'))
      const argv = probe.argv.map((a) => (a === AGENT ? agent : a))
      const { out, err, io } = cliIO()
      // No relay and an empty home: a probe cannot reach anything real, and HOME is not the developer's.
      const env = { TALOS_APP_HOME: home, HOME: home, TALOS_APP_RELAY_URL: 'http://127.0.0.1:1' }
      const code = await runTalos(argv, io, env, { processes: () => [] })
      const said = [...out, ...err].join('\n')
      // Falling through the dispatcher prints the whole usage text and exits 2; an unlisted name is refused by talos.
      expect(said, c.name).not.toContain('init --relay-url <url> [--config')
      expect(said, c.name).not.toContain('Run `talos commands` for the list')
      if (probe.code >= 0) expect(code, `${c.name}: ${said}`).toBe(probe.code)
      if (probe.says) expect(said, c.name).toMatch(probe.says)
      else expect(said, c.name).toBe('')
    }
  })

  test('every listed command has a case in the CLI it forwards to', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli-main.ts'), 'utf8')
    const top = new Set(COMMANDS.map((c) => c.name.split(' ')[0] as string))
    for (const name of top) {
      if (name === 'commands' || name === 'hook') continue // talos' own command, and cli.ts' per-call hook entry
      expect(source, name).toContain(`case '${name}':`)
    }
  })

  test('an unknown command exits 2 and runs nothing', async () => {
    const { io } = cliIO()
    let ran = false
    const run = async () => {
      ran = true
      return 0
    }
    expect(await runTalos(['bogus'], io, {}, { run })).toBe(2)
    expect(ran).toBe(false)
  })
})

describe('talos help and version', () => {
  test('-h, --help and help print the same usage, and --version prints the bridge version, all exit 0', async () => {
    const outs: string[][] = []
    for (const flag of ['-h', '--help', 'help']) {
      const { out, err, io } = cliIO()
      expect(await runTalos([flag], io, {}), flag).toBe(0)
      expect(err, flag).toEqual([])
      outs.push(out)
    }
    expect(outs[0]?.length).toBeGreaterThan(0)
    expect(outs[1]).toEqual(outs[0] as string[])
    expect(outs[2]).toEqual(outs[0] as string[])
    const v = cliIO()
    expect(await runTalos(['--version'], v.io, {})).toBe(0)
    const { BRIDGE_VERSION } = await import('../src/version.ts')
    expect(v.out).toEqual([`talos ${BRIDGE_VERSION}`])
  })
})

describe('talos doctor and status', () => {
  test('doctor --json with a bad flag says so on stderr, prints no JSON and exits 1', async () => {
    const { out, err, io } = cliIO()
    expect(await runTalos(['doctor', '--json', '--no-such-flag'], io, {})).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toMatch(/^talos: .*Unknown option '--no-such-flag'/)
  })

  test('doctor --json returns the same checks as talos-app doctor, as rows', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    await runCli(['install-mcp', '--agent-dir', agent], cliIO().io, envOf(h))
    const { claudeDir, deps } = hermetic()
    const text = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent, '--claude-dir', claudeDir], text.io, envOf(h), deps)).toBe(0)
    const json = cliIO()
    expect(
      await runTalos(['doctor', '--json', '--agent-dir', agent, '--claude-dir', claudeDir], json.io, envOf(h), deps),
    ).toBe(0)
    const parsed = JSON.parse(json.out.join('\n')) as {
      ok: boolean
      rows: { level: string; name: string; detail: string }[]
    }
    expect(parsed.ok).toBe(true)
    const rendered = parsed.rows.map((r) => `${r.level.padEnd(4)}  ${r.name}: ${r.detail}`)
    // The text form is exactly these rows followed by the BRIDGE_PUBKEY help lines.
    expect(text.out.slice(0, rendered.length)).toEqual(rendered)
    expect(parsed.rows.some((r) => r.name === 'relay /healthz' && r.level === 'ok')).toBe(true)
    // Neither the machine's process list nor its own ~/.claude is read: the row sees the empty ones it was given.
    expect(parsed.rows.find((r) => r.name === 'other relaying channels')).toEqual({
      level: 'ok',
      name: 'other relaying channels',
      detail: 'none found',
    })
  })

  test('doctor --json exits 1 and marks ok false when a check fails', async () => {
    h = await startHarness({ startBridge: false })
    const empty = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const { claudeDir, deps } = hermetic()
    const { out, io } = cliIO()
    expect(
      await runTalos(['doctor', '--json', '--agent-dir', empty, '--claude-dir', claudeDir], io, envOf(h), deps),
    ).toBe(1)
    const parsed = JSON.parse(out.join('\n')) as {
      ok: boolean
      rows: { level: string; name: string; detail: string }[]
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.rows.some((r) => r.level === 'FAIL' && r.name === '.mcp.json entry')).toBe(true)
    expect(parsed.rows.find((r) => r.name === 'other relaying channels')?.detail).toBe('none found')
  })

  test('status works', async () => {
    h = await startHarness()
    const { out, io } = cliIO()
    expect(await runTalos(['status'], io, envOf(h))).toBe(0)
    expect(out.join('\n')).toContain('relay reachable: yes')
    const j = cliIO()
    expect(await runTalos(['status', '--json'], j.io, envOf(h))).toBe(0)
    expect((JSON.parse(j.out.join('\n')) as { relay_reachable: boolean }).relay_reachable).toBe(true)
  })
})

// `talos` run as a program, from a copy of src/ with no node_modules next to it, the state of a clone after a bad update.
describe('talos as a program: the early exits never load the full CLI', () => {
  function copyWithTrap() {
    const root = mkdtempSync(join(tmpdir(), 'talos-clone-'))
    const src = join(root, 'apps', 'bridge', 'src')
    cpSync(resolve(import.meta.dir, '..', 'src'), src, { recursive: true })
    cpSync(resolve(import.meta.dir, '..', 'package.json'), join(root, 'apps', 'bridge', 'package.json'))
    // Any load of cli-main.ts, the file that pulls in the relay, sqlite and the MCP SDK, now throws a recognisable error.
    writeFileSync(join(src, 'cli-main.ts'), "throw new Error('TRAP: cli-main.ts was loaded')\n")
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(['bun', join(src, 'talos.ts'), ...args], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: root, TALOS_APP_HOME: join(root, 'home') },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }
    return { run }
  }

  test('rollback, subagent-tee and commands run with cli-main.ts unloadable', () => {
    const { run } = copyWithTrap()
    for (const args of [['rollback', '--dry-run'], ['subagent-tee'], ['commands'], ['--version']]) {
      const r = run(...args)
      expect(r.err, args.join(' ')).not.toContain('TRAP')
      expect(r.err, args.join(' ')).not.toContain('Cannot find module')
    }
    expect(run('subagent-tee').code).toBe(0)
    expect(run('commands').out).toContain('rollback')
  })

  test('rollback gets its own arguments, without the word rollback in front of them', () => {
    const { run } = copyWithTrap()
    // A flag only rollback knows is accepted; handed `rollback --dry-run` instead, it would call the word an unexpected argument.
    const r = run('rollback', '--dry-run')
    expect(r.err).not.toContain('Unexpected argument')
    expect(r.err).not.toContain('Unknown option')
    // And a bad flag is reported as the flag, which is the first thing rollback itself looks at.
    const bad = run('rollback', '--no-such-flag')
    expect(bad.err).toContain("Unknown option '--no-such-flag'")
    expect(bad.code).toBe(1)
  })

  test('restore-last-good gets its own arguments, without the word restore-last-good in front of them', () => {
    const { run } = copyWithTrap()
    // A flag only restore-last-good knows is accepted: with nothing saved it reports that, not the word as an extra argument.
    const ok = run('restore-last-good', '--list')
    expect(ok.err).not.toContain('Unexpected argument')
    expect(ok.err).toContain('nothing saved yet')
    expect(ok.err).not.toContain('TRAP')
    // And a bad flag is reported as the flag, which is the first thing it looks at.
    const bad = run('restore-last-good', '--no-such-flag')
    expect(bad.err).toContain("Unknown option '--no-such-flag'")
    expect(bad.err).not.toContain('Unexpected argument')
    expect(bad.code).toBe(1)
  })

  test('hook does not load cli-main.ts either (it needs the protocol package, as it does under talos-app)', () => {
    expect(copyWithTrap().run('hook', 'bogus').err).not.toContain('TRAP')
  })

  test('control: a command that needs the full CLI does load it (so the trap above can fire)', () => {
    const { run } = copyWithTrap()
    expect(run('status').err).toContain('TRAP')
  })
})
