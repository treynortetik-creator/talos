import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { COMMANDS } from '../src/talos.ts'

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
  ['devices', ['devices']],
  ['devices revoke', ['devices', 'revoke', 'd_aaaaaaaaaaaaaaaaaaaa']],
  ['rotate', ['rotate']],
  ['memory init', ['memory', 'init', '--agent-dir', home]],
  ['apps scan', ['apps', 'scan', '--agent-dir', home]],
  ['install-ask-rules', ['install-ask-rules', '--agent-dir', home, '--dry-run']],
  ['install-guards', ['install-guards']],
  ['trust on', ['trust', 'on']],
  ['theme reset', ['theme', 'reset']],
  ['adopt', ['adopt', '--agent-dir', home, '--yes']],
]

describe('human-only commands refuse when stdio is not a terminal', () => {
  test('printf y | talos-app enroll --confirm refuses', async () => {
    const r = await piped(['enroll', '--confirm'], 'y')
    expect(r.code).toBe(1)
    expect(r.err).toContain('Terminal')
    expect(r.out).not.toContain('nothing is waiting')
  })

  for (const [name, args] of GATED) {
    test(`${name} refuses with piped stdio`, async () => {
      const r = await piped(args)
      expect(r.code).toBe(1)
      expect(r.err).toContain('only runs in Terminal')
      expect(existsSync(join(home, 'enroll-pending'))).toBe(false)
    })
  }

  test('trust off and trust show stay open; trust on does not change the file when refused', async () => {
    const off = await piped(['trust', 'show'])
    expect(off.err).not.toContain('only runs in Terminal')
    const off2 = await piped(['trust', 'off'])
    expect(off2.err).not.toContain('only runs in Terminal')
    const on = await piped(['trust', 'on'])
    expect(on.code).toBe(1)
    expect(on.err).toContain('only runs in Terminal')
    expect(existsSync(join(home, 'config.json'))).toBe(false)
  })

  test('theme show stays open; theme reset leaves config.json alone when refused', async () => {
    const show = await piped(['theme', 'show'])
    expect(show.err).not.toContain('only runs in Terminal')
    const reset = await piped(['theme', 'reset'])
    expect(reset.code).toBe(1)
    expect(reset.err).toContain('only runs in Terminal')
    expect(existsSync(join(home, 'config.json'))).toBe(false)
  })

  test('a command the agent may run is not gated', async () => {
    const r = await piped(['--help'])
    expect(r.err).not.toContain('only runs in Terminal')
  })
})

describe('one table drives the gate and agent_may_run', () => {
  test('every gated command is marked owner only', () => {
    const gated = COMMANDS.filter((c) => c.needs_terminal)
    expect(gated.map((c) => c.name).sort()).toEqual(
      [
        'adopt',
        'apps scan',
        'devices',
        'enroll',
        'install-ask-rules',
        'install-guards',
        'lead init',
        'memory init',
        'rotate',
        'theme reset',
        'trust on',
      ].sort(),
    )
    for (const c of gated) expect(c.agent_may_run).toBe(false)
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
    expect(await runCli(['devices'], io(false), env)).toBe(1)
    expect(err.join('\n')).toContain('only runs in Terminal')
    expect(await runCli(['devices'], io(true), env)).toBe(0)
  })
})
