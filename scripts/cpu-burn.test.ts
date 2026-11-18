// scripts/cpu-burn.sh: the one sanctioned load for flake hunting. It burns only inside the heavy lock (re-running itself
// through it, or refusing with 75), and its burners never outlive it. A fake heavy-lock.sh and sleeping burners
// (CPU_BURN_IDLE=1): no real lock, no real CPU load.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const CB = join(here, 'cpu-burn.sh')
// macOS's own bash 3.2 where there is one, so a newer-bash-only construct goes red here
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
vi.setConfig({ testTimeout: scaled(30_000), hookTimeout: scaled(30_000) })
const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0))
    if (k.pid && k.exitCode === null && k.signalCode === null) spawnSync('kill', ['-KILL', String(k.pid)])
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// the fake lock: `held` answers from FAKE_HELD; `run` logs its argv, then refuses (FAKE_REFUSE) or runs the command as holder
const FAKE = `#!/usr/bin/env bash
case "$1" in
  held) [ "\${FAKE_HELD:-}" = 1 ] ;;
  run) shift; printf '%s\\n' "$*" >> "$FAKE_LOG"; [ -z "\${FAKE_REFUSE:-}" ] || exit 75
    shift; [ "$1" = -- ] && shift; FAKE_HELD=1 exec "$@" ;;
  *) exit 64 ;;
esac
`
function machine(extra: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'cpuburn-'))
  dirs.push(d)
  const lock = join(d, 'heavy-lock.sh')
  writeFileSync(lock, FAKE)
  chmodSync(lock, 0o755)
  const log = join(d, 'lock.log')
  const env = {
    PATH: process.env.PATH ?? '',
    TMPDIR: d,
    CPU_BURN_LOCK: lock,
    CPU_BURN_IDLE: '1',
    FAKE_LOG: log,
    ...extra,
  }
  const run = (args: string[]) => spawnSync(BASH, [CB, ...args], { env, encoding: 'utf8', timeout: 20_000 })
  const start = (args: string[]) => {
    const k = spawn(BASH, [CB, ...args], { env })
    kids.push(k)
    let err = ''
    k.stderr?.on('data', (b) => {
      err += String(b)
    })
    const done = new Promise<number | null>((r) => k.on('exit', (c) => r(c)))
    return { k, err: () => err, done }
  }
  const lockLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  return { d, run, start, lockLog }
}
const group = (stderr: string) => stderr.match(/burners \(group (\d+)\)/)?.[1]
// every process still in the group (none once the burners are stopped)
const inGroup = (g: string) =>
  spawnSync('ps', ['-Ao', 'pgid='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l.trim() === g).length
const until = async (f: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return f()
}

describe('cpu-burn.sh: the heavy lock', () => {
  it('not inside the lock: re-runs itself through heavy-lock.sh run cpu-burn, and exits with the command', () => {
    const m = machine()
    const out = join(m.d, 'ran')
    const r = m.run(['--cores', '2', '--', BASH, '-c', `echo yes > ${out}; exit 3`])
    expect(r.status).toBe(3)
    expect(m.lockLog()).toBe(`cpu-burn -- ${CB} --cores 2 --seconds 600 -- ${BASH} -c echo yes > ${out}; exit 3\n`)
    expect(readFileSync(out, 'utf8')).toBe('yes\n')
    expect(r.stderr).toContain('cpu-burn: 2 burners')
  })

  it('already inside the lock: runs directly, no second hold', () => {
    const m = machine({ FAKE_HELD: '1' })
    const r = m.run(['--cores', '1', '--', 'true'])
    expect(r.status).toBe(0)
    expect(m.lockLog()).toBe('')
    expect(r.stderr).toContain('cpu-burn: 1 burners')
  })

  it('the lock not had: one plain line, exit 75, no burners, no command', () => {
    const m = machine({ FAKE_REFUSE: '1' })
    const out = join(m.d, 'ran')
    const r = m.run(['--cores', '1', '--', BASH, '-c', `touch ${out}`])
    expect(r.status).toBe(75)
    expect(r.stderr.trim().split('\n')).toEqual([
      'cpu-burn: refused: could not get the heavy lock (scripts/heavy-lock.sh status shows who holds it); nothing burned',
    ])
    expect(existsSync(out)).toBe(false)
  })

  it('a lock that runs it without holding: refuses, never burns', () => {
    const m = machine()
    writeFileSync(join(m.d, 'heavy-lock.sh'), FAKE.replace('FAKE_HELD=1 exec', 'exec'))
    const r = m.run(['--cores', '1', '--', 'true'])
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('cpu-burn: refused: not inside the heavy lock')
    expect(r.stderr).not.toContain('burners')
  })

  it("a command's own 75 through the lock is not called a refusal", () => {
    const m = machine()
    const r = m.run(['--cores', '1', '--', BASH, '-c', 'exit 75'])
    expect(r.status).toBe(75)
    expect(r.stderr).not.toContain('refused')
  })
})

describe('cpu-burn.sh: burners never outlive it', () => {
  it('a normal end and a failing command both stop every burner', () => {
    for (const [cmd, code] of [
      ['exit 0', 0],
      ['exit 7', 7],
    ] as const) {
      const r = machine({ FAKE_HELD: '1' }).run(['--cores', '3', '--', BASH, '-c', `sleep 0.3; ${cmd}`])
      expect(r.status).toBe(code)
      const g = group(r.stderr)
      expect(g).toBeTruthy()
      expect(inGroup(g as string)).toBe(0)
    }
  })

  it('a TERM stops the command and every burner (exit 143)', async () => {
    const m = machine({ FAKE_HELD: '1' })
    const p = m.start(['--cores', '2', '--', 'sleep', '30'])
    expect(await until(() => !!group(p.err()))).toBe(true)
    const g = group(p.err()) as string
    expect(inGroup(g)).toBeGreaterThan(0)
    p.k.kill('SIGTERM')
    expect(await p.done).toBe(143)
    expect(inGroup(g)).toBe(0)
  })

  it('a TERM to the outer run (through the lock) stops the burners too', async () => {
    const m = machine()
    const p = m.start(['--cores', '2', '--', 'sleep', '30'])
    expect(await until(() => !!group(p.err()))).toBe(true)
    const g = group(p.err()) as string
    p.k.kill('SIGTERM')
    await p.done
    expect(await until(() => inGroup(g) === 0)).toBe(true)
  })

  it('--seconds is capped at 600, and the limit stops the command and burners (exit 142)', () => {
    const m = machine({ FAKE_HELD: '1' })
    const capped = m.run(['--cores', '1', '--seconds', '9999', '--', 'true'])
    expect(capped.status).toBe(0)
    expect(capped.stderr).toContain('--seconds 9999 is over the cap; using 600')
    expect(capped.stderr).toContain('up to 600 s')
    const t0 = Date.now()
    const r = m.run(['--cores', '1', '--seconds', '1', '--', 'sleep', '30'])
    expect(r.status).toBe(142)
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(inGroup(group(r.stderr) as string)).toBe(0)
  })

  it('bad usage exits 64', () => {
    const m = machine({ FAKE_HELD: '1' })
    expect(m.run(['--cores', 'x', '--', 'true']).status).toBe(64)
    expect(m.run(['--cores', '1']).status).toBe(64)
  })
})
