// Bug hunt 2026-11-10 (docs/audits/2026-11-10-bughunt-cli-docs.md), package P-C3: each test states the behaviour the CLI should
// have. The finding id is the report's CLI one (C2-C4, C6, C7, C9 are routed to other packages). Nothing here reaches a real relay: the relay URL is a
// closed local port, so a call that should never have been made fails fast.
import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { tempHome } from './helpers.ts'

const DEAD_RELAY = 'http://127.0.0.1:9'

function cliIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    all: () => [...out, ...err].join('\n'),
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

async function freshHome(): Promise<string> {
  const home = join(tempHome(), 'app')
  expect(await runCli(['init', '--relay-url', DEAD_RELAY], cliIO().io, { TALOS_APP_HOME: home })).toBe(0)
  return home
}

describe('bug hunt: talos-app CLI', () => {
  test('C1: `rotate --help` does not start a key rotation', async () => {
    const home = await freshHome()
    const c = cliIO()
    await runCli(['rotate', '--help'], c.io, { TALOS_APP_HOME: home })
    // today: a new key pair is written to bridge.key.next and the relay is called
    expect(existsSync(`${paths(home).bridgeKey}.next`)).toBe(false)
    expect(c.all()).not.toContain('rotation failed')
  })

  test('C5: `errors list` refuses a flag it does not know', async () => {
    const home = await freshHome()
    const c = cliIO()
    expect(await runCli(['errors', 'list', '--close'], c.io, { TALOS_APP_HOME: home })).not.toBe(0)
    expect(await runCli(['errors', 'list', '--help'], cliIO().io, { TALOS_APP_HOME: home })).toBe(0)
  })

  test('C8: bare `search` points at `search reindex` instead of saying the command is not in this build', async () => {
    const home = await freshHome()
    const c = cliIO()
    await runCli(['search'], c.io, { TALOS_APP_HOME: home })
    expect(c.all()).not.toContain('not available in this build')
    expect(c.all()).toContain('reindex')
  })

  test('C10: `logs -n` takes a plain whole number only', async () => {
    const home = await freshHome()
    writeFileSync(paths(home).log, '')
    appendFileSync(paths(home).log, '{"ts":"2026-01-01T00:00:00.000Z","level":"info","msg":"one"}\n')
    for (const bad of ['0x10', '1e1', ' 7 ']) {
      const c = cliIO()
      expect(await runCli(['logs', '-n', bad], c.io, { TALOS_APP_HOME: home })).toBe(1)
    }
  })

  test('C11: a command group typed with no subcommand is a usage error everywhere (errors, apps exit 0 today)', async () => {
    const home = await freshHome()
    const codes: Record<string, number> = {}
    for (const cmd of ['trust', 'theme', 'memory', 'errors', 'apps'])
      codes[cmd] = await runCli([cmd], cliIO().io, { TALOS_APP_HOME: home })
    expect(codes).toEqual({ trust: 2, theme: 2, memory: 2, errors: 2, apps: 2 })
  })

  test('C12: `report --out <a folder>` says the path is a folder, not a rename of a temp file', async () => {
    const home = await freshHome()
    const dir = join(tempHome(), 'reports')
    mkdirSync(dir)
    const c = cliIO()
    expect(await runCli(['report', '--out', dir], c.io, { TALOS_APP_HOME: home, PATH: '/usr/bin:/bin' })).toBe(1)
    expect(c.err.join('\n')).not.toContain('.tmp')
  })

  // C14: SETUP.md's Upgrading says six things are left and the command lists them; it printed five, and named only the kit
  // updater the doc calls the older way. The plugin layout's updater is named by its path (no `talos` is on PATH).
  test('C14: `update` lists the six follow-ups of docs/SETUP.md and the kit updater for the plugin layout', () => {
    const cli = readFileSync(join(import.meta.dir, '..', 'src', 'cli-main.ts'), 'utf8')
    const body = cli.slice(cli.indexOf('async function cmdUpdate'), cli.indexOf('const CODEX_USAGE'))
    const steps = [...body.matchAll(/["'`] {2}(\d)\. /g)].map((x) => x[1])
    // steps 2 and 3 are written for a Mac and for any other computer (owner-words: "this Mac" / "this computer", the Mac app
    // / the supervisor's restart); one of each is printed
    expect(steps).toEqual(['0', '1', '2', '2', '3', '3', '4', '5'])
    expect([...new Set(steps)]).toEqual(['0', '1', '2', '3', '4', '5'])
    const setup = readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'SETUP.md'), 'utf8')
    expect(setup).toContain('Six things are still yours to do. The command lists them')
    const step4 = body.split('\n').find((l) => /['`] {2}4\. /.test(l)) ?? ''
    expect(step4).toContain('kitUpdater(')
    expect(step4).toContain('upgrade.sh')
  })
})
