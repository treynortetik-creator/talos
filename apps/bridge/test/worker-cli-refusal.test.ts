// A lead (a thread's own session) must not run the owner-level mailbox commands from its shell: `digest`, `post` and
// `inbox*` read or write across threads. The supervisor sets TALOS_APP_WORKER_THREAD and TALOS_SESSION_ROLE=worker, and
// a `.talos-lead` marker in the current folder or any parent refuses too, so unsetting the variables does not help.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { problemDirs } from '../src/problems/store.ts'
import { COMMANDS, runTalos } from '../src/talos.ts'
import { refusedForWorkers, WORKER_COMMANDS_OK, WORKER_READ_OK, workerCliRefusal } from '../src/worker/cli-refusal.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
// a folder with no marker in it or above it (a fresh temp folder)
function plain() {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'wc-cwd-'))
  made.push(d)
  return d
}
function run(argv: string[], env: Record<string, string>, cwd = plain()) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'wc-'))
  made.push(home)
  const err: string[] = []
  const io = {
    out: () => {},
    err: (l: string) => err.push(l),
    prompt: async () => 'n',
    sleep: async () => {},
    now: () => Date.now(),
  }
  return runCli(argv, io, { TALOS_APP_HOME: home, ...env }, { cwd }).then((code) => ({ code, err: err.join('\n') }))
}

describe('digest, post and inbox from a worker thread', () => {
  for (const argv of [['digest'], ['post', 'general', 'hi'], ['inbox'], ['inbox-list']])
    test(`talos-app ${argv[0]} is refused when TALOS_APP_WORKER_THREAD is set`, async () => {
      const r = await run(argv, { TALOS_APP_WORKER_THREAD: 'trip' })
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/thread session|worker/i)
    })
  test('the worker role alone is enough', async () => {
    const r = await run(['digest'], { TALOS_SESSION_ROLE: 'worker' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/worker|thread session/i)
  })
  test('the same commands are not refused for that reason in the main session', async () => {
    const r = await run(['digest'], {})
    expect(r.err).not.toMatch(/thread session|worker/i)
  })
  test('other commands still run for a worker', async () => {
    const r = await run(['lead', 'check', '/nonexistent'], { TALOS_APP_WORKER_THREAD: 'trip' })
    expect(r.err).not.toMatch(/thread session/i)
  })

  describe('a .talos-lead marker in the current folder or a parent', () => {
    const lead = (depth: number) => {
      const root = plain()
      writeFileSync(join(root, '.talos-lead'), '{}')
      let cwd = root
      for (let i = 0; i < depth; i++) {
        cwd = join(cwd, `d${i}`)
        mkdirSync(cwd)
      }
      return cwd
    }
    for (const argv of [['digest'], ['post', 'general', 'hi'], ['inbox'], ['inbox-list']])
      for (const depth of [0, 3])
        test(`talos-app ${argv[0]} is refused ${depth ? 'from a subfolder' : 'in the lead folder'} with no env vars set`, async () => {
          const r = await run(argv, {}, lead(depth))
          expect(r.code).toBe(1)
          expect(r.err).toMatch(/lead|thread session/i)
        })
    test('other commands still run there', async () => {
      const r = await run(['lead', 'check', '/nonexistent'], {}, lead(1))
      expect(r.err).not.toMatch(/thread session|lead folder/i)
    })
    test('no marker and no env vars: not refused', async () => {
      for (const argv of [['digest'], ['inbox']]) {
        const r = await run(argv, {})
        expect(r.err).not.toMatch(/thread session|worker|lead folder/i)
      }
    })
  })
})

// Every command that reads the log, the history, the schedules, the search or memory index, the error reports, the app
// registry or the config, or posts into a thread it is given, is refused to a thread session. One test per command.
// (status, doctor and logs are a thread session's own since 2026-11-15: see "status, doctor and logs from a lead" below)
const READS_ACROSS_THREADS: string[][] = [
  ['report'],
  ['errors', 'list'],
  ['search', 'reindex'],
  ['memory'],
  ['memory', 'show'],
  ['memory', 'reindex'],
  ['share', 'revoke', 'x'],
  ['schedules'],
  ['apps', 'list'],
  ['trust'],
  ['theme'],
  ['codex', 'run', '--thread', 'garden', '--', 'hi'],
]
describe('commands that read across threads or the Talos home, from a thread session', () => {
  for (const argv of READS_ACROSS_THREADS) {
    const name = argv.slice(0, 2).join(' ')
    test(`talos-app ${name} is refused when the supervisor's variables are set`, async () => {
      const r = await run(argv, { TALOS_APP_WORKER_THREAD: 'trip', TALOS_SESSION_ROLE: 'worker' })
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/not available in a thread session/)
    })
    test(`talos-app ${name} is refused in a lead folder with no variables set`, async () => {
      const root = plain()
      writeFileSync(join(root, '.talos-lead'), '{}')
      const r = await run(argv, {}, root)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/not available in a lead's folder/)
    })
    test(`talos-app ${name} is not refused in the main session (no variables, no marker above)`, () => {
      expect(workerCliRefusal(argv, {}, plain())).toBeUndefined()
    })
  }
  test('the talos front door refuses them too, including `doctor --json`, which it answers itself', async () => {
    for (const argv of [['report'], ['codex', 'run', '--thread', 'g', '--', 'x']]) {
      const err: string[] = []
      const io = {
        out: () => {},
        err: (l: string) => err.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => 0,
      }
      const code = await runTalos(argv, io, { TALOS_APP_HOME: plain(), TALOS_SESSION_ROLE: 'worker' }, { cwd: plain() })
      expect(code, argv.join(' ')).toBe(1)
      expect(err.join('\n'), argv.join(' ')).toMatch(/not available in a thread session/)
    }
  })
  test('the commands a thread session may run are not refused', () => {
    for (const argv of [
      ['commands'],
      ['lead', 'check', '/x'],
      ['codex', 'check'],
      ['subagent-tee'],
      ['hook', 'pre-tool-use'],
      ['guard-hook'],
      [],
      ['help'],
      ['--help'],
    ])
      expect(refusedForWorkers(argv), argv.join(' ')).toBe(false)
  })
  test('everything else is refused to a thread session: the mutators and the owner commands too', () => {
    for (const argv of [
      ['restore-last-good'],
      ['rollback'],
      ['rollback', 'app'],
      ['update'],
      ['install-guards'],
      ['install-mcp'],
      ['install-ask-rules'],
      ['install-app-hooks'],
      ['install-subagent-tee'],
      ['start'],
      ['init'],
      ['adopt'],
      ['enroll'],
      ['devices'],
      ['rotate'],
      ['lead'],
      ['lead', 'init', 'trip'],
      ['codex'],
      ['codex', 'run'],
      ['a-command-that-does-not-exist-yet'],
    ])
      expect(refusedForWorkers(argv), argv.join(' ')).toBe(true)
  })
  test('the early-dispatch commands are refused too: rollback and restore-last-good run before the rest of the CLI loads', async () => {
    for (const argv of [['rollback'], ['restore-last-good'], ['rollback', 'app']]) {
      const r = await run(argv, { TALOS_SESSION_ROLE: 'worker' })
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.err).toMatch(/not available in a thread session/)
    }
  })
  test('every command in the list of commands is refused or named as safe for a thread session', () => {
    for (const c of COMMANDS) {
      const refused = refusedForWorkers(c.name.split(' '))
      expect(
        refused,
        `talos-app ${c.name}: ${refused ? 'refused, but named safe' : 'allowed, but not named safe'}`,
      ).toBe(!WORKER_COMMANDS_OK.includes(c.name) && !WORKER_READ_OK.includes(c.name))
    }
    // the safe names are real commands (guard-hook is the one hook entry the list of commands does not carry)
    const known = new Set(COMMANDS.map((c) => c.name))
    for (const n of WORKER_COMMANDS_OK) expect(known.has(n) || n === 'guard-hook', n).toBe(true)
  })
  test('the marker and the variables are a backstop only: with neither, nothing is known (cd /tmp && env -u ... gets past it)', () => {
    expect(workerCliRefusal(['logs'], {}, plain())).toBeUndefined()
  })
})

// Pantheon 2026-11-15: a lead reads status, doctor and logs; `logs` shows it only the lines of its own thread.
describe('status, doctor and logs from a lead', () => {
  const LINES = [
    { level: 'info', time: 1, msg: 'trip line', thread: 'trip' },
    { level: 'info', time: 2, msg: 'garden line', thread: 'garden' },
    { level: 'info', time: 3, msg: 'no thread line' },
    { level: 'info', time: 4, msg: 'trip card', thread_id: 'trip' },
  ]
  function logs(env: Record<string, string>, cwd = plain(), args: string[] = []) {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'wc-'))
    made.push(home)
    writeFileSync(join(home, 'bridge.log'), `${LINES.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`)
    const out: string[] = []
    const err: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    return runCli(['logs', ...args], io, { TALOS_APP_HOME: home, ...env }, { cwd }).then((code) => ({
      code,
      out: out.join('\n'),
      err: err.join('\n'),
    }))
  }
  test('status, doctor and logs are not refused to a thread session', () => {
    for (const argv of [
      ['status'],
      ['status', '--json'],
      ['doctor'],
      ['doctor', '--json'],
      ['logs'],
      ['logs', '-n', '5'],
    ])
      expect(workerCliRefusal(argv, { TALOS_APP_WORKER_THREAD: 'trip', TALOS_SESSION_ROLE: 'worker' }, plain())).toBe(
        undefined,
      )
  })
  test("a thread session's logs show its own thread's lines and nothing else", async () => {
    const r = await logs({ TALOS_APP_WORKER_THREAD: 'trip', TALOS_SESSION_ROLE: 'worker' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('trip line')
    expect(r.out).toContain('trip card')
    expect(r.out).not.toContain('garden line')
    expect(r.out).not.toContain('no thread line')
    expect(r.out).not.toContain('not json')
  })
  test("-n counts the thread's own lines", async () => {
    const r = await logs({ TALOS_APP_WORKER_THREAD: 'trip' }, plain(), ['-n', '1'])
    expect(r.out).toContain('trip card')
    expect(r.out).not.toContain('trip line')
  })
  test("a lead folder's marker names the thread", async () => {
    const root = plain()
    writeFileSync(join(root, '.talos-lead'), JSON.stringify({ thread: 'garden' }))
    const r = await logs({}, root)
    expect(r.out).toContain('garden line')
    expect(r.out).not.toContain('trip')
  })
  test("a thread session whose thread can't be told is shown nothing", async () => {
    const root = plain()
    writeFileSync(join(root, '.talos-lead'), '{}')
    const r = await logs({}, root)
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/can't be told/)
    // the variable and the marker disagree: no thread
    writeFileSync(join(root, '.talos-lead'), JSON.stringify({ thread: 'garden' }))
    const d = await logs({ TALOS_APP_WORKER_THREAD: 'trip' }, root)
    expect(d.code).toBe(1)
    expect(d.out).toBe('')
  })
  test('the main session still sees every line', async () => {
    const r = await logs({})
    for (const l of ['trip line', 'garden line', 'no thread line', 'trip card']) expect(r.out).toContain(l)
  })
})

// Owner 2026-11-16: with the developer thread fence off (`dev.thread_fence: false`), a thread session reads the problem
// reports exactly as Main does; `errors close` and every other refused command stay refused.
describe('the thread fence off: a thread reads the problem reports as Main does', () => {
  const FP = '56'.repeat(16)
  const NOTE = 'owner typed this note about a private message'
  const asThread = { TALOS_APP_WORKER_THREAD: 't1', TALOS_SESSION_ROLE: 'worker' }
  /** A Talos home with config `cfg` (a string is written as is), thread t1 (ops_read as given) and one stored report. */
  function fenceHome(cfg: unknown, opsRead?: boolean) {
    const h = mkdtempSync(join(realpathSync(tmpdir()), 'fo-home-'))
    made.push(h)
    const body =
      typeof cfg === 'string'
        ? cfg
        : JSON.stringify({
            ...(cfg as object),
            threads: [{ id: 't1', session_opts: opsRead === undefined ? {} : { ops_read: opsRead } }],
          })
    writeFileSync(join(h, 'config.json'), body)
    const d = problemDirs(h)
    mkdirSync(d.open, { recursive: true })
    writeFileSync(join(d.open, 'shot.png'), 'x')
    writeFileSync(
      join(d.open, `${FP}.json`),
      JSON.stringify({
        v: 1,
        trust: 'external',
        fingerprint: FP,
        source: 'install',
        kind: 'owner',
        name: 'TypeError',
        message: 'another install said this',
        frames: [{ fn: 'f', file: `${h}/a.ts`, line: 1 }],
        device: 'browser',
        routes: [],
        steps: NOTE,
        screenshot_file: 'shot.png',
        versions_seen: [],
        count: 1,
        first_seen: 'x',
        last_seen: 'x',
        truncated: false,
        ids: [],
      }),
    )
    return h
  }
  async function go(argv: string[], env: Record<string, string>, h: string, cwd = plain()) {
    const out: string[] = []
    const err: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    const code = await runCli(argv, io, { TALOS_APP_HOME: h, ...env }, { cwd })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const OFF = { dev: { thread_fence: false } }
  const REFUSED = /not available in/

  test('errors list and errors show print what Main gets, byte for byte', async () => {
    const h = fenceHome(OFF)
    for (const argv of [
      ['errors', 'list'],
      ['errors', 'show', '5656'],
    ]) {
      const t = await go(argv, asThread, h)
      const m = await go(argv, {}, h)
      expect(t.code, argv.join(' ')).toBe(0)
      expect(t.out).toBe(m.out)
    }
    const shown = (await go(['errors', 'show', '5656'], asThread, h)).out
    expect(shown).toContain(NOTE)
    expect(shown).toContain('another install said this')
    expect(shown).toContain('screenshot_path')
    expect(shown).toContain(h)
    expect(shown).not.toContain('[withheld')
  })
  test('the same through a .talos-lead marker, with no variables', async () => {
    const h = fenceHome(OFF)
    const root = plain()
    writeFileSync(join(root, '.talos-lead'), '{"thread":"t1"}')
    const r = await go(['errors', 'show', '5656'], {}, h, root)
    expect(r.code).toBe(0)
    expect(r.out).toContain(NOTE)
    expect(r.out).not.toContain('[withheld')
    expect((await go(['errors', 'list'], {}, h, root)).code).toBe(0)
  })
  test('errors close is refused to a thread, by the variables and by the marker, and the report stays open', async () => {
    const h = fenceHome(OFF)
    const root = plain()
    writeFileSync(join(root, '.talos-lead'), '{"thread":"t1"}')
    for (const [env, cwd] of [
      [asThread, plain()],
      [{}, root],
    ] as const) {
      const r = await go(['errors', 'close', '5656'], env, h, cwd)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(REFUSED)
    }
    expect(readdirSync(problemDirs(h).open)).toContain(`${FP}.json`)
    expect((await go(['errors', 'list'], asThread, h)).out).toContain('open')
  })
  test('a thread that reaches cmdErrors close any other way is still told no (the case guard in cli-main)', async () => {
    const h = fenceHome(OFF)
    const r = await go(['errors', 'close', '5656'], asThread, h)
    expect(r.code).toBe(1)
    expect(readdirSync(problemDirs(h).open)).toContain(`${FP}.json`)
  })
  test('logs and status are unchanged; a command that was refused is still refused', async () => {
    const h = fenceHome(OFF)
    for (const argv of [['logs'], ['status']]) expect(workerCliRefusal(argv, asThread, plain())).toBeUndefined()
    for (const argv of [['report'], ['trust'], ['schedules'], ['memory'], ['errors', 'purge'], ['errors']]) {
      const r = await go(argv, asThread, h)
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.err, argv.join(' ')).toMatch(REFUSED)
    }
  })
  test('the fence on in any form (true, a string, missing, junk, no file) refuses errors list as before', async () => {
    for (const cfg of [{ dev: { thread_fence: true } }, { dev: { thread_fence: 'false' } }, {}, '{ nope']) {
      const h = fenceHome(cfg)
      for (const argv of [
        ['errors', 'list'],
        ['errors', 'show', '5656'],
      ]) {
        const r = await go(argv, asThread, h)
        expect(r.code, JSON.stringify(cfg)).toBe(1)
        expect(r.err).toMatch(REFUSED)
      }
    }
    const bare = mkdtempSync(join(realpathSync(tmpdir()), 'fo-none-'))
    made.push(bare)
    expect((await go(['errors', 'list'], asThread, bare)).code).toBe(1)
  })
  test('ops_read on with the fence on: the reduced output, unchanged', async () => {
    const h = fenceHome({ dev: { thread_fence: true } }, true)
    const r = await go(['errors', 'show', '5656'], asThread, h)
    expect(r.code).toBe(0)
    expect(r.out).toContain('[withheld')
    expect(r.out).not.toContain(NOTE)
    expect(r.out).not.toContain('screenshot_path')
  })
})
