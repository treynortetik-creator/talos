// A lead (a thread's own session) must not run the owner-level mailbox commands from its shell: `digest`, `post` and
// `inbox*` read or write across threads. The supervisor sets TALOS_APP_WORKER_THREAD and TALOS_SESSION_ROLE=worker, and
// a `.talos-lead` marker in the current folder or any parent refuses too, so unsetting the variables does not help.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { COMMANDS, runTalos } from '../src/talos.ts'
import { refusedForWorkers, WORKER_COMMANDS_OK, workerCliRefusal } from '../src/worker/cli-refusal.ts'

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
const READS_ACROSS_THREADS: string[][] = [
  ['status'],
  ['doctor'],
  ['logs'],
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
    for (const argv of [['status'], ['doctor', '--json'], ['logs'], ['codex', 'run', '--thread', 'g', '--', 'x']]) {
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
      ).toBe(!WORKER_COMMANDS_OK.includes(c.name))
    }
    // the safe names are real commands (guard-hook is the one hook entry the list of commands does not carry)
    const known = new Set(COMMANDS.map((c) => c.name))
    for (const n of WORKER_COMMANDS_OK) expect(known.has(n) || n === 'guard-hook', n).toBe(true)
  })
  test('the marker and the variables are a backstop only: with neither, nothing is known (cd /tmp && env -u ... gets past it)', () => {
    expect(workerCliRefusal(['logs'], {}, plain())).toBeUndefined()
  })
})
