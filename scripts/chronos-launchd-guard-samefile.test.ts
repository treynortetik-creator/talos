// gate-reads: apps/chronos/*
// apps/chronos/launchd-guard.sh compares files, not spellings: the launchctl that would run against the system one, and HOME against
// the user's real home, by `-ef` (same device and inode). A link, a hard link, and a case-insensitive volume compare equal when they
// are the same file or folder. It needs no python. Test knobs (CHRONOS_TEST_MODE=1): CHRONOS_SYSTEM_LAUNCHCTL, CHRONOS_REAL_HOME.
import { spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const GUARD = resolve(__dirname, '..', 'apps', 'chronos', 'launchd-guard.sh')
// an absolute bash: the child's PATH holds only the stubs, and a command name is looked up there
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
function world() {
  const root = mkdtempSync(join(tmpdir(), 'talos-guard-samefile-'))
  made.push(root)
  const bin = join(root, 'bin')
  for (const d of [bin, join(root, 'home'), join(root, 'other')]) mkdirSync(d)
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'launchctl'), 0o755)
  // the guard needs only bash and id: a PATH with the stub and nothing else (no python3 there)
  for (const t of ['id', 'dirname', 'basename', 'cat']) {
    const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
    if (p) symlinkSync(p, join(bin, t))
  }
  const refused = (env: Record<string, string>) => {
    const r = spawnSync(BASH, ['-c', `. "${GUARD}"; chronos_launchd_refused`], {
      encoding: 'utf8',
      env: { PATH: bin, CHRONOS_TEST_MODE: '1', ...env },
    })
    return r.status === 0
  }
  return { root, bin, home: join(root, 'home'), other: join(root, 'other'), refused }
}

describe('launchd-guard.sh compares files, not spellings', () => {
  it('a system launchctl reached by another name (a hard link) is still the system one', () => {
    const w = world()
    const alias = join(w.root, 'system-launchctl')
    linkSync(join(w.bin, 'launchctl'), alias)
    expect(w.refused({ HOME: w.home, CHRONOS_SYSTEM_LAUNCHCTL: alias, CHRONOS_REAL_HOME: w.other })).toBe(true)
  })

  it('a launchctl that is not the system one is never refused', () => {
    const w = world()
    const system = join(w.root, 'system-launchctl')
    writeFileSync(system, '#!/bin/sh\nexit 0\n')
    expect(w.refused({ HOME: w.home, CHRONOS_SYSTEM_LAUNCHCTL: system, CHRONOS_REAL_HOME: w.other })).toBe(false)
  })

  it('a HOME that is the real home by another name (a link) is not refused; another folder is', () => {
    const w = world()
    const same = { CHRONOS_SYSTEM_LAUNCHCTL: join(w.bin, 'launchctl') }
    const via = join(w.root, 'home-link')
    symlinkSync(w.home, via)
    expect(w.refused({ ...same, HOME: via, CHRONOS_REAL_HOME: w.home })).toBe(false)
    expect(w.refused({ ...same, HOME: w.home, CHRONOS_REAL_HOME: via })).toBe(false)
    expect(w.refused({ ...same, HOME: w.home, CHRONOS_REAL_HOME: w.other })).toBe(true)
  })

  it('anything unreadable counts as "no guard": an empty or missing real home, a missing HOME folder', () => {
    const w = world()
    const same = { CHRONOS_SYSTEM_LAUNCHCTL: join(w.bin, 'launchctl') }
    expect(w.refused({ ...same, HOME: w.home, CHRONOS_REAL_HOME: '' })).toBe(false)
    expect(w.refused({ ...same, HOME: w.home, CHRONOS_REAL_HOME: join(w.root, 'gone') })).toBe(false)
    expect(w.refused({ ...same, HOME: join(w.root, 'gone'), CHRONOS_REAL_HOME: w.other })).toBe(false)
  })

  it('the guard needs no python', () => {
    expect(readFileSync(GUARD, 'utf8').replace(/^#.*$/gm, '')).not.toMatch(/python/)
  })
})
