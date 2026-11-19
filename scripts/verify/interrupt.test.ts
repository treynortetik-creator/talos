// The harness scripts leave nothing behind when they are interrupted (SIGTERM, as a time limit or a closing session sends it):
// every process group they started is gone and their temp folders are removed, and a second "@stop-relay" is a no-op. These run the
// REAL scripts as child processes, in a group of their own so a bug that signals "its own group" cannot take the test runner with it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../../packages/testkit/src/time-factor.ts'
import { fakeTool } from '../fake-tool'

vi.setConfig({ testTimeout: scaled(120_000), hookTimeout: scaled(120_000) })
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../..')
const dirs: string[] = []
const pids: number[] = []
afterAll(() => {
  for (const p of pids) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Stopped: no such process, or a zombie no one has reaped yet (its group was SIGKILLed; on a busy Linux runner the reaper can lag,
 * and `kill(pid, 0)` still succeeds on a zombie). Waits a moment for it, as the kill itself is not instant. */
const zombie = (pid: number) =>
  /^Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
const expectGone = async (pid: number) => {
  await until(`process ${pid} to be gone`, () => !alive(pid) || zombie(pid), scaled(5000)).catch(() => {})
  expect(!alive(pid) || zombie(pid)).toBe(true)
}
const until = async (what: string, f: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function world() {
  const T = mkdtempSync(join(tmpdir(), 'vi-'))
  dirs.push(T)
  const tmp = join(T, 'tmp')
  mkdirSync(tmp)
  const env = {
    ...process.env,
    TMPDIR: tmp,
    TALOS_VERIFY_EVIDENCE_ROOT: join(T, 'ev'),
  } as Record<string, string>
  const start = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const child = spawn('node', [join(here, script), ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid) pids.push(child.pid)
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', (d) => {
      out += d
    })
    const done = new Promise<number | null>((r) => child.on('close', (code) => r(code)))
    return { child, done, output: () => out }
  }
  return { T, tmp, env, start, leftovers: (prefix: string) => readdirSync(tmp).filter((n) => n.startsWith(prefix)) }
}

describe('SIGTERM mid-run', () => {
  it('bridge-run: the step it runs and its temp folder are gone, and it exits 143', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await until('the step to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(step)).toBe(true)
    expect(w.leftovers('talos-verify-bridge-')).toHaveLength(1)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })

  it('bridge-run: the REAL relay it started is stopped too', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--cli',
      '0::errors list',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await until(
      'the step to start (after the relay is up)',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '',
    )
    const [tempName] = w.leftovers('talos-verify-bridge-')
    const relay = Number(readFileSync(join(w.tmp, tempName as string, 'relay.pid'), 'utf8').trim())
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(relay)).toBe(true)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(relay)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })

  it('capture: the web build it started is gone, the temp build folder too, and it exits 143', async () => {
    const w = world()
    const bin = join(w.T, 'bin')
    mkdirSync(bin)
    const pidFile = join(w.T, 'build.pid')
    // the stand-in "pnpm" is the build: it hangs, so the interrupt arrives mid-build
    fakeTool(bin, 'pnpm', `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`)
    const r = w.start(
      'capture.mjs',
      ['web', '--worktree', repo, '--label', 'before', '--routes', 'home', '--themes', 'talos'],
      { PATH: `${bin}:${process.env.PATH}` },
    )
    await until('the build to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const build = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(build)).toBe(true)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(build)
    expect(w.leftovers('talos-verify-web-')).toEqual([])
  })

  it('SIGINT exits 130 the same way', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await until('the step to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    r.child.kill('SIGINT')
    expect(await r.done).toBe(130)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })
})

describe('@stop-relay twice', () => {
  it('the second one is a no-op with a line in the transcript, never a signal to its own group', async () => {
    const w = world()
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'stoptwice',
      '--sha',
      'stoptwice',
      '--cli',
      '0::errors list',
      '--cli',
      '@stop-relay',
      '--cli',
      '@stop-relay',
    ])
    expect(await r.done, r.output()).toBe(0)
    const t = readFileSync(join(w.T, 'ev/stoptwice/cli-stoptwice-na-before.txt'), 'utf8')
    expect(t).toContain('# relay stopped (pid')
    expect(t).toMatch(/# no relay running: nothing to stop/)
  })
})

describe('sim only drives a device it booted', () => {
  // an xcrun that knows one booted device and one shut down, and writes down every call
  function shim() {
    const w = world()
    const bin = join(w.T, 'bin')
    mkdirSync(bin)
    const log = join(w.T, 'xcrun.log')
    const json = JSON.stringify({
      devices: {
        rt: [
          { udid: 'U-BOOTED', name: 'iPhone Booted', state: 'Booted' },
          { udid: 'U-OFF', name: 'iPhone Off', state: 'Shutdown' },
        ],
      },
    })
    writeFileSync(join(w.T, 'devices.json'), json)
    fakeTool(
      bin,
      'xcrun',
      `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *"list devices"*) cat ${join(w.T, 'devices.json')} ;; esac\nexit 0\n`,
    )
    const run = (args: string[]) =>
      spawnSync('node', [join(here, 'capture.mjs'), 'sim', '--worktree', repo, '--routes', 'home', ...args], {
        cwd: repo,
        env: { ...w.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    return { run, calls }
  }

  it('an "after" run without --route-list is refused before anything is touched', () => {
    const s = shim()
    const r = s.run(['--label', 'after', '--udid', 'U-OFF'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--route-list')
    expect(s.calls()).toBe('')
  })

  it('no --udid and no --use-booted: refused (a device nobody named is not ours)', () => {
    const s = shim()
    const r = s.run(['--label', 'before'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--udid/)
    expect(s.calls()).not.toMatch(/openurl|screenshot|boot /)
  })

  it('a device that is already booted is refused unless --use-booted says it is yours', () => {
    const s = shim()
    const r = s.run(['--label', 'before', '--udid', 'U-BOOTED'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('already booted')
    expect(s.calls()).not.toMatch(/openurl|screenshot|boot U/)
  })

  it('--udid of a device that does not exist is refused', () => {
    const s = shim()
    const r = s.run(['--label', 'before', '--udid', 'U-NOPE'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('no simulator')
  })
})
