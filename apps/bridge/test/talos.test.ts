import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { COMMANDS, runTalos, terminalOnly } from '../src/talos.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
/** Temp folders a test made. A real release folder is read-only by design, so each is made writable before it is removed. */
const madeDirs: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of madeDirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', d])
    rmSync(d, { recursive: true, force: true })
  }
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
    // `update`, `rollback` and `restore` are the agent kit's (no kit is installed in a probe's empty home); `... app` are the app's
    update: { argv: ['update', '--no-such-flag'], says: /no Talos kit release is installed/, code: 1 },
    'update app': { argv: ['update', 'app', '--no-such-flag'], says: unknown, code: 1 },
    rollback: { argv: ['rollback', '--no-such-flag'], says: /no Talos kit release is installed/, code: 1 },
    'rollback app': { argv: ['rollback', 'app', '--no-such-flag'], says: unknown, code: 1 },
    restore: { argv: ['restore', 'CLAUDE.md'], says: /no Talos kit release is installed/, code: 1 },
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
      if (name === 'restore') continue // the kit updater's, run by talos.ts itself (talos-app has no such command)
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

// `talos update`, `talos rollback` and `talos restore` run the agent kit's updater (kit/bin/talos-update). The one real thing here:
// a real kit installed into a temp home, a real signed release, the real front door as a program with a terminal (a pty) for its
// stdin and stdout; nothing stands in for the updater.
const REPO = resolve(import.meta.dir, '..', '..', '..')
const FIXTURE = join(REPO, 'kit', 'scripts', 'fixtures', 'update-fixture.py')
const TTY_RUN = join(REPO, 'kit', 'scripts', 'fixtures', 'tty-run.py')

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v === undefined ||
      k === 'CLAUDECODE' ||
      k === 'CLAUDE_PROJECT_DIR' ||
      k.startsWith('TALOS_') ||
      k.startsWith('XDG_')
    )
      continue
    out[k] = v
  }
  return { ...out, ...extra }
}

function sh(cmd: string, args: string[], env: Record<string, string>, cwd?: string) {
  const r = spawnSync(cmd, args, { env, cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('talos update, rollback and restore', () => {
  const fakeKit = (marker: string) => {
    const vendor = mkdtempSync(join(tmpdir(), 'talos-fakekit-'))
    const bin = join(vendor, 'current', 'talos-kit', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'talos-update'), `#!/bin/sh\necho "$@" > "${marker}"\n`)
    chmodSync(join(bin, 'talos-update'), 0o755)
    return vendor
  }

  test('the five commands are owner terminal commands, listed with that', async () => {
    const { out, io } = cliIO()
    expect(await runTalos(['commands', '--json'], io, {})).toBe(0)
    const byName = new Map(
      (JSON.parse(out.join('\n')) as { commands: (Row & { needs_terminal?: boolean })[] }).commands.map((c) => [
        c.name,
        c,
      ]),
    )
    for (const n of ['update', 'rollback', 'restore']) {
      expect(byName.get(n)?.agent_may_run, n).toBe(false)
      expect(byName.get(n)?.needs_terminal, n).toBe(true)
    }
    // the app's own pull and rollback stay what they were: not for the agent to choose, but ask-gated rather than terminal-only
    for (const n of ['update app', 'rollback app']) {
      expect(byName.get(n)?.agent_may_run, n).toBe(false)
      expect(byName.get(n)?.needs_terminal, n).toBeUndefined()
    }
    // talos-app's own update (the app checkout) is not terminal-gated; talos's is the kit's
    expect(terminalOnly(['update'], 'talos-app')).toBeUndefined()
    expect(terminalOnly(['rollback'], 'talos-app')).toBeUndefined()
    expect(terminalOnly(['update'], 'talos')).toBe('update')
    expect(terminalOnly(['update', 'app'], 'talos')).toBeUndefined()
    const app = cliIO()
    expect(await runCli(['update', '--no-such-flag'], { ...app.io, isTerminal: false }, {})).toBe(1)
    expect(app.err.join('\n')).toMatch(/Unknown option/)
  })

  test('without a terminal each one is refused and the updater is never started', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'talos-marker-')), 'ran')
    const vendor = fakeKit(marker)
    for (const argv of [
      ['update'],
      ['update', '--dry-run'],
      ['rollback'],
      ['rollback', '1.2.0'],
      ['restore', 'CLAUDE.md'],
    ]) {
      const { err, io } = cliIO()
      const code = await runTalos(argv, { ...io, isTerminal: false }, { TALOS_KIT_HOME: vendor })
      expect(code, argv.join(' ')).toBe(2)
      expect(err.join('\n')).toContain('only runs in Terminal')
    }
    // the app's own update and rollback are not the kit's: they reach the app handler (behind the ask card), never the updater
    for (const argv of [
      ['update', 'app'],
      ['rollback', 'app'],
    ]) {
      const { io } = cliIO()
      let ran = false
      const run = async () => {
        ran = true
        return 0
      }
      expect(await runTalos(argv, { ...io, isTerminal: false }, { TALOS_KIT_HOME: vendor }, { run })).toBe(0)
      expect(ran, argv.join(' ')).toBe(true)
    }
    expect(existsSync(marker)).toBe(false)
  })

  test('with a terminal the kit verbs go to the kit updater, with every argument; update app and rollback app go to the app', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'talos-marker-')), 'ran')
    const vendor = fakeKit(marker)
    const env = { TALOS_KIT_HOME: vendor }
    for (const argv of [
      ['update', '--dry-run'],
      ['rollback', '1.2.0'],
      ['restore', 'memory/a b.md'],
    ]) {
      const { io } = cliIO()
      let handed = false
      const run = async () => {
        handed = true
        return 0
      }
      expect(await runTalos(argv, io, env, { run }), argv.join(' ')).toBe(0)
      expect(readFileSync(marker, 'utf8').trim()).toBe(argv.join(' '))
      expect(handed, 'the app handler was not used').toBe(false)
      writeFileSync(marker, '')
    }
    const seen: string[][] = []
    const run = async (a: string[]) => {
      seen.push(a)
      return 0
    }
    for (const argv of [
      ['update', 'app', '--x'],
      ['rollback', 'app', '--dry-run'],
    ]) {
      expect(await runTalos(argv, cliIO().io, env, { run })).toBe(0)
    }
    expect(seen).toEqual([
      ['update', '--x'],
      ['rollback', '--dry-run'],
    ])
    expect(readFileSync(marker, 'utf8')).toBe('') // the kit updater was not started for either
  })

  test('with no kit installed it says so, with the folder it looked in, and exits 1', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'talos-nokit-'))
    const { err, io } = cliIO()
    expect(await runTalos(['update'], io, { TALOS_KIT_HOME: empty })).toBe(1)
    expect(err.join('\n')).toMatch(/no Talos kit release is installed here \(looked for .*talos-update\)/)
  })

  test('the real front door as a program, in a terminal: dry run, update, restore, rollback against a real signed release', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'talos-k8b-')))
    madeDirs.push(tmp)
    const home = join(tmp, 'h')
    mkdirSync(home)
    const env = cleanEnv({
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      TALOS_VENDOR_DIR: join(home, '.local', 'share', 'talos'),
      TALOS_APP_HOME: join(home, 'app'),
      TALOS_TEST_LOG: join(tmp, 'migrations.log'),
      GIT_CONFIG_GLOBAL: '/dev/null',
    })
    const vendor = join(env.TALOS_VENDOR_DIR as string, 'kit')
    const agent = join(home, 'agent')
    const keys = join(tmp, 'keys')
    const src = join(tmp, 'src')
    const v1 = readFileSync(join(REPO, 'kit', 'VERSION'), 'utf8').trim()
    const v2 = '1.3.0-front'
    expect(sh('python3', [FIXTURE, 'keys', keys], env).code).toBe(0)
    expect(
      sh(
        'python3',
        [
          FIXTURE,
          'make-kit',
          join(REPO, 'kit'),
          join(tmp, 'kit1'),
          '--version',
          v1,
          '--allowed',
          join(keys, 'allowed1'),
        ],
        env,
      ).code,
    ).toBe(0)
    const inst = sh('bash', [join(tmp, 'kit1', 'install.sh'), '--agent-dir', agent, '--no-chronos'], env)
    expect(inst.code, inst.out).toBe(0)
    mkdirSync(join(home, 'app', 'last-good'), { recursive: true })
    expect(
      sh(
        'python3',
        [
          FIXTURE,
          'make-kit',
          join(REPO, 'kit'),
          join(tmp, 'kit2'),
          '--version',
          v2,
          '--allowed',
          join(keys, 'allowed1'),
          '--migration',
          '202611050001:front:plain',
          '--hook',
          'UserPromptSubmit||front-guard.py',
          '--notes',
          'Front door test notes.',
        ],
        env,
      ).code,
    ).toBe(0)
    const rel = join(tmp, 'kit2', 'scripts', 'plugin-release.py')
    expect(sh('python3', [rel, 'build', '--source', join(tmp, 'kit2'), '--vendor', join(tmp, 'pub')], env).code).toBe(0)
    expect(
      sh(
        'python3',
        [rel, 'pack', '--vendor', join(tmp, 'pub'), '--version', v2, '--key', join(keys, 'key1'), '--out', src],
        env,
      ).code,
    ).toBe(0)

    // the front door, as the program the owner runs, with a terminal as stdin and stdout
    const talos = (...args: string[]) =>
      sh('python3', [TTY_RUN, '--', 'bun', join(REPO, 'apps', 'bridge', 'src', 'talos.ts'), ...args], env)
    const cur = () => readlinkSync(join(vendor, 'current'))

    const dry = talos('update', '--dry-run', '--agent-dir', agent, '--source', src)
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toContain(v2)
    expect(dry.out).toContain('Front door test notes.')
    expect(dry.out).toContain('202611050001-front')
    expect(cur()).toBe(`releases/${v1}`)

    const up = talos('update', '--agent-dir', agent, '--source', src)
    expect(up.code, up.out).toBe(0)
    expect(up.out).toContain(`updated ${v1} -> ${v2}`)
    expect(cur()).toBe(`releases/${v2}`)
    expect(readFileSync(join(agent, '.talos-version'), 'utf8')).toContain('migration=202611050001-front')
    const req = JSON.parse(readFileSync(join(home, 'app', 'agent-request.json'), 'utf8')) as Record<string, unknown>
    expect(req.action).toBe('restart')

    writeFileSync(join(agent, '.claude', 'settings.json'), '{"broken": true}')
    const rest = talos('restore', '--agent-dir', agent, '.claude/settings.json')
    expect(rest.code, rest.out).toBe(0)
    expect(JSON.parse(readFileSync(join(agent, '.claude', 'settings.json'), 'utf8')).enabledPlugins).toEqual({
      'talos@talos-local': true,
    })

    const back = talos('rollback', '--agent-dir', agent)
    expect(back.code, back.out).toBe(0)
    expect(back.out).toContain(`rolled back to ${v1}`)
    expect(cur()).toBe(`releases/${v1}`)
    // the migration the update ran was undone by the rollback
    expect(readFileSync(join(tmp, 'migrations.log'), 'utf8')).toBe('up 202611050001\ndown 202611050001\n')

    // refused from a script: no terminal
    const piped = spawnSync(
      'bun',
      [join(REPO, 'apps', 'bridge', 'src', 'talos.ts'), 'update', '--agent-dir', agent, '--source', src],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    expect(piped.status).toBe(2)
    expect(piped.stderr).toContain('only runs in Terminal')
    expect(cur()).toBe(`releases/${v1}`)
  }, 240_000)
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
    for (const args of [
      ['rollback', 'app', '--dry-run'],
      ['update'],
      ['rollback'],
      ['restore', 'x'],
      ['subagent-tee'],
      ['commands'],
      ['--version'],
    ]) {
      const r = run(...args)
      expect(r.err, args.join(' ')).not.toContain('TRAP')
      expect(r.err, args.join(' ')).not.toContain('Cannot find module')
    }
    // the kit verbs from a script (no terminal) are refused before anything else loads
    expect(run('update').err).toContain('only runs in Terminal')
    expect(run('update').code).toBe(2)
    expect(run('subagent-tee').code).toBe(0)
    expect(run('commands').out).toContain('rollback')
  })

  test('rollback app gets its own arguments, without the words rollback app in front of them', () => {
    const { run } = copyWithTrap()
    // A flag only rollback knows is accepted; handed `rollback --dry-run` instead, it would call the word an unexpected argument.
    const r = run('rollback', 'app', '--dry-run')
    expect(r.err).not.toContain('Unexpected argument')
    expect(r.err).not.toContain('Unknown option')
    // And a bad flag is reported as the flag, which is the first thing rollback itself looks at.
    const bad = run('rollback', 'app', '--no-such-flag')
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
