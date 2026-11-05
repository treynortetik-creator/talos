// Review of PR #81 (d8c01f1). These fail on that commit; each one is a bug found by breaking ci-local.sh for real.
// Same approach as ci-local-slots.test.ts: source the script for its lock functions, or run it against a local origin.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
const base = { CI_MAX_LOAD: '0', CI_POLL: '0.05', CI_LOCK_TIMEOUT: '2', TALOS_CI_NESTED: '0', CI_SLOTS: '1' }
// Real shells beside two other CI runs: a slow machine takes longer, it does not fail (see ci-local-slots.test.ts).
vi.setConfig({ testTimeout: 120_000 })
const scratchDirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'cilr-'))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const src = (code: string) => `. "${script}"\n${code}`
function sh(code: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', src(code)], { env: { ...cleanEnv(), ...base, ...env }, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
function deadLock(L: string) {
  expect(sh(`ci_lock_try "${L}" dead`).code).toBe(0) // that shell exits: the owner is dead
  return sh(`ci_owner_key "$(ci_owner "${L}")"`).out.trim()
}
function holder(L: string) {
  const child = spawn('bash', ['-c', src(`ci_lock_try "${L}" holder && echo HELD; sleep 30`)], {
    env: { ...cleanEnv(), ...base },
  })
  const held = new Promise<void>((r) => child.stdout.on('data', () => r()))
  return { child, held }
}
const longAgo = new Date('2020-01-01T00:00:00Z')

describe('review #81: a takeover that did not finish', () => {
  // ci_lock_takeover makes the marker, then writes the owner. SIGTERM or SIGKILL between the two (8 of 150 rounds in an
  // unstubbed fuzz) leaves owner = the dead run plus a marker nobody removes, and every later mkdir of it fails.
  it('a slot whose takeover died part way is taken over again, not lost for good', () => {
    const L = join(scratch(), 'locks', 'slot-1')
    mkdirSync(dirname(L))
    const key = deadLock(L)
    const marker = join(L, `takeover-${key}`)
    mkdirSync(marker)
    utimesSync(marker, longAgo, longAgo)
    const r = sh(`ci_acquire_slot "${dirname(L)}" healthy && echo GOT`)
    expect(r.out).toContain('GOT')
  })

  it('same for a mutex: one stuck marker must not turn every desktop job red', () => {
    const T = scratch()
    const L = join(T, 'locks', 'mutex-desktop')
    mkdirSync(dirname(L))
    const key = deadLock(L)
    const marker = join(L, `takeover-${key}`)
    mkdirSync(marker)
    utimesSync(marker, longAgo, longAgo)
    const r = sh(`ci_mutex "${dirname(L)}" desktop echo RAN; echo "rc=$?"`)
    expect(r.out).toContain('RAN')
    expect(r.out).toContain('rc=0')
  })

  it('an owner write that fails (disk full) does not leave the marker behind', () => {
    const L = join(scratch(), 'slot-1')
    deadLock(L)
    const r = sh(`real="$(declare -f ci_write_owner)"
      ci_write_owner() { return 1; }
      ci_lock_try "${L}" first && echo FIRST
      eval "$real"
      ci_lock_try "${L}" second && echo GOT || echo STUCK`)
    expect(r.out).toContain('GOT')
  })
})

describe('review #81: a live holder is never judged dead', () => {
  it('one failed ps does not steal the slot', async () => {
    const T = scratch()
    const L = join(T, 'slot-1')
    const h = holder(L)
    await h.held
    const bin = join(T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'ps'), 0o755)
    const r = sh(`ci_lock_try "${L}" thief && echo STOLEN || echo BUSY`, { PATH: `${bin}:${process.env.PATH}` })
    h.child.kill('SIGKILL')
    expect(r.out).toContain('BUSY')
  })

  it('a waiter in another time zone sees the same start time', async () => {
    const L = join(scratch(), 'slot-1')
    const h = holder(L)
    await h.held
    const r = sh(`ci_lock_try "${L}" thief && echo STOLEN || echo BUSY`, { TZ: 'Asia/Tokyo' })
    h.child.kill('SIGKILL')
    expect(r.out).toContain('BUSY')
  })
})

describe('review #81: two runs of one commit', () => {
  // Routine now: one run queued for A, a push, one run queued for B, and both test B at the same time. The second result
  // overwrites the first, so a red commit goes green with no retry anyone asked for. merge-when-green reads newest per context.
  it('a failure is not overwritten by another run of the same commit finishing later', async () => {
    const T = scratch()
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        cwd,
        encoding: 'utf8',
      }).trim()
    const srcDir = join(T, 'src')
    mkdirSync(srcDir)
    git(srcDir, 'init', '-q', '-b', 'main')
    writeFileSync(join(srcDir, 'a.txt'), 'a\n')
    git(srcDir, 'add', '-A')
    git(srcDir, 'commit', '-qm', 'a')
    const A = git(srcDir, 'rev-parse', 'HEAD')
    const origin = join(T, 'origin.git')
    git(T, 'clone', '-q', '--bare', srcDir, origin)
    git(origin, 'update-ref', 'refs/pull/7/head', A)
    const clone = join(T, 'clone')
    git(T, 'clone', '-q', origin, clone)
    mkdirSync(join(clone, 'scripts'))
    const copy = join(clone, 'scripts', 'ci-local.sh')
    // The first run to get here fails, the second passes later: a flake, or a real race, in one commit's tests.
    writeFileSync(
      copy,
      readFileSync(script, 'utf8').replace(
        '\ncd "$WT"\n',
        '\njob_flaky() { if mkdir "$HOME/first" 2>/dev/null; then sleep 0.3; return 1; fi; sleep 1.5; }\ncd "$WT"\n',
      ),
    )
    const bin = join(T, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\ncase "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG" ;; esac\n',
    )
    chmodSync(join(bin, 'gh'), 0o755)
    const home = join(T, 'home')
    mkdirSync(home)
    const log = join(T, 'gh.log')
    const env = {
      ...cleanEnv(),
      ...base,
      CI_SLOTS: '3',
      CI_LOCK_TIMEOUT: '20',
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: log,
    }
    const run = () =>
      new Promise<number>((r) => {
        const c = spawn('bash', [copy, '--pr', '7', '--jobs', 'flaky'], { env, cwd: clone, stdio: 'ignore' })
        c.on('exit', (code) => r(code ?? -1))
      })
    const codes = await Promise.all([run(), run()])
    expect(codes).toContain(1) // one of them did fail
    const states = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.match(/state=(\w+)/)?.[1])
    expect(states.at(-1)).not.toBe('success')
  }, 30_000)
})

describe('review #81: cut-over from the old single-lock script', () => {
  it('waits while an old run holds <cache>/lock, goes ahead when it is gone', () => {
    const T = scratch()
    mkdirSync(join(T, 'locks'))
    const old = join(T, 'lock')
    mkdirSync(old)
    const live = spawn('sleep', ['30'])
    writeFileSync(join(old, 'pid'), String(live.pid))
    const busy = sh(`ci_acquire_slot "${join(T, 'locks')}" x && echo GOT`, { CI_LOCK_TIMEOUT: '1' })
    live.kill('SIGKILL')
    expect(busy.out).not.toContain('GOT')
    writeFileSync(join(old, 'pid'), String(spawnSync('true').pid)) // a pid that has exited and been reaped
    const free = sh(`ci_acquire_slot "${join(T, 'locks')}" x && echo GOT`)
    expect(free.out).toContain('GOT') // pid is dead now: the old lock is ignored, never deleted
  })
})
