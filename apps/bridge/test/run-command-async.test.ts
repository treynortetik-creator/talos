// runCommandAsync: an argument vector with its own environment, stdout and stderr apart, 127 when it cannot start, and an
// abort signal that kills the command.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandAsync } from '../src/run-command.ts'

describe('runCommandAsync', () => {
  test('keeps stdout and stderr apart and passes the environment given', async () => {
    const r = await runCommandAsync(['/bin/sh', '-c', 'echo "$UNDO_PROBE"; echo warn >&2; exit 3'], tmpdir(), {
      env: { UNDO_PROBE: 'hello', PATH: '/usr/bin:/bin' },
    })
    expect(r).toEqual({ code: 3, stdout: 'hello', stderr: 'warn' })
  })
  test('127 when the command cannot start', async () => {
    const r = await runCommandAsync(['/nonexistent/cmd'], tmpdir())
    expect(r.code).toBe(127)
  })
  test('an abort kills the command', async () => {
    const ac = new AbortController()
    const p = runCommandAsync(['/bin/sleep', '30'], tmpdir(), { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.code).not.toBe(0)
  })
  test('an abort returns even when a child of the command still holds its output open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-run-'))
    const pidFile = join(dir, 'pid')
    const ac = new AbortController()
    const p = runCommandAsync(['/bin/sh', '-c', `/bin/sleep 20 & echo $! > ${pidFile}; exit 0`], dir, {
      signal: ac.signal,
    })
    let grandchild = 0
    for (let i = 0; i < 500 && !grandchild; i++) {
      await Bun.sleep(10)
      if (existsSync(pidFile)) grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    }
    await Bun.sleep(50) // the shell exits right after writing the file
    ac.abort()
    try {
      const r = await p
      expect(r.code).toBe(0) // the shell itself had finished; only its child held the pipe
    } finally {
      if (grandchild) process.kill(grandchild)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 5000)
  test('text given as input reaches the command on stdin', async () => {
    const r = await runCommandAsync(['/bin/cat'], tmpdir(), { input: 'a\0b\n' })
    expect(r).toEqual({ code: 0, stdout: 'a\0b', stderr: '' })
  })
  test('stopAt stops an endless list past the count of NULs, and says so', async () => {
    const r = await runCommandAsync(['/bin/sh', '-c', 'while :; do printf "x\\0"; done'], tmpdir(), {
      stopAt: { nuls: 1000, bytes: 1_000_000 },
    })
    expect(r.stopped).toBe(true)
    expect(r.stdout.split('\0').length).toBeGreaterThan(1000)
  }, 5000)
  test('stopAt stops past the byte cap too', async () => {
    const r = await runCommandAsync(['/bin/sh', '-c', 'while :; do printf "xxxxxxxx"; done'], tmpdir(), {
      stopAt: { nuls: 1000, bytes: 10_000 },
    })
    expect(r.stopped).toBe(true)
  }, 5000)
  test('a list at the cap is whole, and not marked stopped', async () => {
    const r = await runCommandAsync(['/bin/sh', '-c', 'printf "a\\0b\\0"'], tmpdir(), {
      stopAt: { nuls: 2, bytes: 100 },
    })
    expect(r).toEqual({ code: 0, stdout: 'a\0b\0', stderr: '' })
  })
})
