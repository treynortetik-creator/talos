// The login environment for thread-session starts (P3d2): read in the background, never blocking the supervisor's queue,
// the last good one kept, a failed read never cached in its place. Fake reader and clock: no shell runs here.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LOGIN_ENV_REFRESH_S, LoginEnvCache, loginShellEnvAsync } from '../../src/supervisor/login-env.ts'

function setup() {
  let t = 1000
  const pending: Array<(v: Record<string, string> | null) => void> = []
  let reads = 0
  const cache = new LoginEnvCache(
    () =>
      new Promise((res) => {
        reads++
        pending.push(res)
      }),
    () => t,
  )
  return {
    cache,
    reads: () => reads,
    answer: async (v: Record<string, string> | null) => {
      const r = pending.shift()
      if (!r) throw new Error('no read in flight')
      r(v)
      await new Promise((x) => setTimeout(x, 0))
    },
    advance: (s: number) => {
      t += s
    },
  }
}

describe('the login environment cache', () => {
  it('has nothing until the first read answers, and a start asked for meanwhile is told to hold (never a bare PATH)', async () => {
    const x = setup()
    expect(x.cache.current()).toBeNull()
    x.cache.refreshIfDue()
    x.cache.refreshIfDue() // one read at a time
    expect(x.reads()).toBe(1)
    expect(x.cache.current()).toBeNull()
    await x.answer({ PATH: '/opt/bin:/usr/bin', HOME: '/home/alex' })
    expect(x.cache.current()).toEqual({ PATH: '/opt/bin:/usr/bin', HOME: '/home/alex' })
  })
  it('a failed read keeps the last good one, and is tried again sooner than a normal refresh', async () => {
    const x = setup()
    x.cache.refreshIfDue()
    await x.answer({ PATH: '/a' })
    x.cache.refreshIfDue()
    expect(x.reads()).toBe(1) // fresh: nothing to do
    x.advance(LOGIN_ENV_REFRESH_S + 1)
    x.cache.refreshIfDue()
    await x.answer(null)
    expect(x.cache.current()).toEqual({ PATH: '/a' })
    x.advance(60)
    x.cache.refreshIfDue()
    expect(x.reads()).toBe(3) // retried well before another LOGIN_ENV_REFRESH_S
    await x.answer({ PATH: '/b' })
    expect(x.cache.current()).toEqual({ PATH: '/b' })
  })
  it('the retries back off while the shell keeps failing', async () => {
    const x = setup()
    x.cache.refreshIfDue()
    await x.answer(null)
    const gaps: number[] = []
    for (let i = 0; i < 4; i++) {
      let waited = 0
      while (x.reads() === i + 1) {
        x.advance(10)
        waited += 10
        x.cache.refreshIfDue()
      }
      gaps.push(waited)
      await x.answer(null)
    }
    for (let i = 1; i < gaps.length; i++) expect(gaps[i] as number).toBeGreaterThanOrEqual(gaps[i - 1] as number)
    expect(x.cache.current()).toBeNull()
  })
  it('a reader that throws is a failed read, not a crash', async () => {
    const cache = new LoginEnvCache(
      () => Promise.reject(new Error('boom')),
      () => 0,
    )
    cache.refreshIfDue()
    await new Promise((x) => setTimeout(x, 0))
    expect(cache.current()).toBeNull()
  })
})

describe('the async login shell read', () => {
  it('reads a real shell without blocking, and a shell that is not there is null', async () => {
    const env = await loginShellEnvAsync('/bin/sh', { PATH: '/usr/bin:/bin', HOME: '/tmp', LOGIN_ENV_PROBE: 'yes' })
    expect(env?.LOGIN_ENV_PROBE).toBe('yes')
    expect(await loginShellEnvAsync('/nonexistent/shell', { PATH: '/usr/bin:/bin' })).toBeNull()
  })
  it('a profile that leaves something holding stdout does not keep the read open', async () => {
    const t0 = Date.now()
    const env = await loginShellEnvAsync('/bin/sh', { PATH: '/usr/bin:/bin' }, 400, ['-c', '(sleep 5 &) ; exit 0'])
    expect(env).toBeNull()
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  it('a shell that hangs is given up on', async () => {
    const t0 = Date.now()
    expect(
      await loginShellEnvAsync('/bin/sh', { PATH: '/usr/bin:/bin', ENV: '/dev/null' }, 300, ['-c', 'sleep 5']),
    ).toBeNull()
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

// A supervisor started by hand from a terminal runs in a background process group that has a controlling terminal. An
// interactive login shell started from there takes the terminal, and job control stops the whole group with SIGTTIN/SIGTTOU:
// the supervisor stops too, so no time limit ever fires (Titan, 2026-11-11). The shell now runs in a session of its own.
describe.skipIf(process.platform !== 'linux' || Bun.which('python3') === null || Bun.which('bash') === null)(
  'the login shell read, from a background job of a terminal (a supervisor started by hand)',
  () => {
    const SRC = resolve(import.meta.dir, '../../src/supervisor')
    const run = (code: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'talos-pty-'))
      try {
        const probe = join(dir, 'probe.ts')
        writeFileSync(probe, code)
        const r = Bun.spawnSync(
          ['python3', resolve(import.meta.dir, 'fixtures/pty-background.py'), process.execPath, probe, '20'],
          { stdout: 'pipe', stderr: 'pipe', timeout: 40_000 },
        )
        return r.stdout.toString()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const env = `{ PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? '/tmp' }`
    it('loginShellEnvAsync reads the environment and the job is never stopped', () => {
      const out = run(
        `import { loginShellEnvAsync } from '${SRC}/login-env.ts'\nconst a = await loginShellEnvAsync('/bin/bash', ${env}, 5000)\nconsole.log(a && a.PATH ? 'ASYNC read' : 'ASYNC null')\n`,
      )
      expect(out).not.toContain('Stopped')
      expect(out).not.toContain('HUNG')
      expect(out).toContain('ASYNC read')
    }, 60_000)
    it('loginShellEnv (the blocking one, read at the supervisor’s start) too', () => {
      const out = run(
        `import { loginShellEnv } from '${SRC}/cli.ts'\nconst s = loginShellEnv('/bin/bash', ${env})\nconsole.log(s && s.PATH ? 'SYNC read' : 'SYNC null')\n`,
      )
      expect(out).not.toContain('Stopped')
      expect(out).not.toContain('HUNG')
      expect(out).toContain('SYNC read')
    }, 60_000)
  },
)
