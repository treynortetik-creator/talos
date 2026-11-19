import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { COMMANDS, terminalOnly } from '../src/talos.ts'

/** The terminal-only refusal, from a CLI this test spawns: it speaks for the computer it runs on (owner-words.ts), a Mac or not. */
const TERMINAL_ONLY = /only runs in (?:Terminal|a terminal)/

const home = mkdtempSync('/tmp/tg')
afterAll(() => rmSync(home, { recursive: true, force: true }))

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

/** Runs the real entry point with stdin and stdout both pipes, the way an agent's shell tool runs it. */
async function piped(args: string[], stdin = 'y\n') {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: new Response(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: 'http://127.0.0.1:9',
      TALOS_APP_CHRONOS_AUTODISCOVER: 'off',
    },
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}

const GATED: [string, string[]][] = [
  ['enroll', ['enroll', '--no-qr']],
  ['enroll --confirm', ['enroll', '--confirm']],
  ['devices bogus', ['devices', 'bogus']],
  ['rotate', ['rotate']],
  ['trust on', ['trust', 'on']],
]

describe('human-only commands refuse when stdio is not a terminal', () => {
  // `devices list|revoke` and `peer ...` are the agent's unless the lock is on (agent-cli.test.ts); with no config.json to read the lock
  // from, the agent is refused for that reason
  test('devices and devices revoke, piped, are refused (no readable config: the lock cannot be read)', async () => {
    for (const args of [['devices'], ['devices', 'revoke', 'd_aaaaaaaaaaaaaaaaaaaa']]) {
      const r = await piped(args)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/config\.json/)
    }
  })

  test('printf y | talos-app enroll --confirm refuses', async () => {
    const r = await piped(['enroll', '--confirm'], 'y')
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/[Tt]erminal/)
    expect(r.out).not.toContain('nothing is waiting')
  })

  for (const [name, args] of GATED) {
    test(`${name} refuses with piped stdio`, async () => {
      const r = await piped(args)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(TERMINAL_ONLY)
      expect(existsSync(join(home, 'enroll-pending'))).toBe(false)
    })
  }

  test('trust off and trust show stay open; trust on does not change the file when refused', async () => {
    const off = await piped(['trust', 'show'])
    expect(off.err).not.toMatch(TERMINAL_ONLY)
    const off2 = await piped(['trust', 'off'])
    expect(off2.err).not.toMatch(TERMINAL_ONLY)
    const on = await piped(['trust', 'on'])
    expect(on.code).toBe(1)
    expect(on.err).toMatch(TERMINAL_ONLY)
    expect(existsSync(join(home, 'config.json'))).toBe(false)
  })

  test('theme reset and memory init are no longer terminal-only (the agent runs them when asked, on-request-cli.test.ts); unasked they still write nothing', async () => {
    for (const args of [
      ['theme', 'reset'],
      ['memory', 'init', '--agent-dir', home],
    ]) {
      const r = await piped(args)
      expect(r.err).not.toMatch(TERMINAL_ONLY)
      expect(r.code).toBe(1)
    }
    expect(existsSync(join(home, 'config.json'))).toBe(false)
  })

  test('a command the agent may run is not gated', async () => {
    const r = await piped(['--help'])
    expect(r.err).not.toMatch(TERMINAL_ONLY)
  })
})

describe('one table drives the gate and agent_may_run', () => {
  test("install-guards is the agent's; --remove, wherever it is in the arguments, is the owner's at a terminal", () => {
    expect(terminalOnly(['install-guards'])).toBeUndefined()
    expect(terminalOnly(['install-guards', '--remove'])).toBe('install-guards --remove')
    expect(terminalOnly(['install-guards', '--dry-run', '--remove'])).toBe('install-guards --remove')
  })

  test("only the four that wait for the owner's word on adding devices, and linking another Talos (peer), still need a terminal (2026-11-14)", () => {
    const gated = COMMANDS.filter((c) => c.needs_terminal)
    // plus turning the guards off (2026-11-14: a lock the agent may turn on, never off)
    expect(gated.map((c) => c.name).sort()).toEqual([
      'devices',
      'enroll',
      'install-guards --remove',
      'peer',
      'rotate',
      'trust on',
    ])
    for (const c of gated) expect(c.who).toBeUndefined()
  })

  test('runCli refuses when the io says it is not a terminal, and lets a terminal through', async () => {
    const out: string[] = []
    const err: string[] = []
    const io = (isTerminal: boolean) => ({
      isTerminal,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    })
    const env = { TALOS_APP_HOME: home }
    expect(await runCli(['devices', 'bogus'], io(false), env)).toBe(1)
    expect(err.join('\n')).toMatch(TERMINAL_ONLY)
    expect(await runCli(['devices'], io(true), env)).toBe(0)
  })
})
