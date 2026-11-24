// gate-reads: apps/chronos/* scripts/*
// apps/chronos/install.sh on a Mac (stubs: uname, plutil, a launchctl that remembers what is loaded): a distinct exit code for each
// way it can fail (documented in its header), and a failed load leaves nothing loaded and nothing launchd would load at the next
// login. Linux keeps its codes.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { BUNDLED, flagOn, loaded, macSandbox, plist, put, type SB, which } from './root-install-sched-harness.ts'

const chronos = (sb: SB, args: string[] = [], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [join(BUNDLED, 'install.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: sb.bin, HOME: sb.home, CHRONOS_TEST_MODE: '1', CHRONOS_PRINT_TRIES: '1', ...env },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('apps/chronos/install.sh: exit codes and a failed load leaves nothing behind', () => {
  it('10 python3 missing, 10 python older than 3.9', () => {
    const sb = macSandbox()
    expect(chronos(sb, [], { CHRONOS_PYTHON: '/nonexistent/python3' }).code).toBe(10)
    const old = join(sb.root, 'py38.sh')
    writeFileSync(old, `#!/bin/sh\ncase " $* " in *version_info*) exit 1 ;; esac\nexec "${which('python3')}" "$@"\n`, {
      mode: 0o755,
    })
    expect(chronos(sb, [], { CHRONOS_PYTHON: old }).code).toBe(10)
  })

  it('without CHRONOS_TEST_MODE the python stand-in is ignored', () => {
    const sb = macSandbox()
    const r = chronos(sb, ['--no-load'], { CHRONOS_PYTHON: '/nonexistent/python3', CHRONOS_TEST_MODE: '' })
    expect(r.code, r.out).toBe(0)
  })

  it('11 a config step that fails (the config folder cannot be made)', () => {
    const sb = macSandbox()
    mkdirSync(join(sb.home, '.config'), { recursive: true })
    writeFileSync(join(sb.home, '.config', 'chronos'), 'a file where the folder goes')
    expect(chronos(sb).code).toBe(11)
  })

  it(
    '12 plutil refuses: no plist stays; 14 launchctl refuses; 15 loaded but not listed: nothing stays loaded',
    () => {
      const sb = macSandbox()
      put(sb, 'plutil', 'echo bad >&2; exit 1')
      expect(chronos(sb).code).toBe(12)
      expect(existsSync(plist(sb, 'tick')) || existsSync(plist(sb, 'ui'))).toBe(false)
      put(sb, 'plutil', 'exit 0')
      flagOn(sb, 'fail-bootstrap-ui')
      expect(chronos(sb).code).toBe(14)
      expect(loaded(sb)).toEqual([]) // the tick, loaded first, is unloaded again
      expect(existsSync(plist(sb, 'tick')) || existsSync(plist(sb, 'ui'))).toBe(false)
      rmFlag(sb, 'fail-bootstrap-ui')
      flagOn(sb, 'print-lies')
      expect(chronos(sb).code).toBe(15)
      expect(loaded(sb)).toEqual([])
      expect(existsSync(plist(sb, 'tick'))).toBe(false)
    },
    scaled(120_000),
  )

  it(
    'a plist that was there before is put back with its old content and loaded again',
    () => {
      const sb = macSandbox()
      expect(chronos(sb).code).toBe(0) // a first, good install: both loaded
      const old = '<?xml version="1.0"?><plist><dict><key>Old</key><true/></dict></plist>\n'
      writeFileSync(plist(sb, 'tick'), old)
      flagOn(sb, 'fail-bootstrap-ui')
      // the tick plist is rewritten and the tick re-loaded, then the ui fails: the old tick plist is back and loaded
      expect(chronos(sb).code).toBe(14)
      expect(readFileSync(plist(sb, 'tick'), 'utf8')).toBe(old)
      expect(loaded(sb)).toContain('io.github.chronos.tick')
      expect(loaded(sb)).not.toContain('io.github.chronos.ui')
    },
    scaled(120_000),
  )

  it(
    'a rerun changes nothing: one plist each, loaded once, the config kept',
    () => {
      const sb = macSandbox()
      expect(chronos(sb).code).toBe(0)
      const cfg = readFileSync(join(sb.home, '.config', 'chronos', 'config.json'), 'utf8')
      expect(chronos(sb).code).toBe(0)
      expect(readFileSync(join(sb.home, '.config', 'chronos', 'config.json'), 'utf8')).toBe(cfg)
      expect(loaded(sb)).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
    },
    scaled(120_000),
  )

  it('Linux keeps its behaviour: python missing is exit 1, and a stand-in python is not used', () => {
    const sb = macSandbox()
    put(sb, 'uname', 'echo Linux')
    rmSync(join(sb.bin, 'python3'))
    const r = chronos(sb, [], { CHRONOS_PYTHON: which('python3') as string })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('sudo apt install python3')
  })
})

describe('apps/chronos/install.sh: a rollback exists only once the plist backup is complete', () => {
  /** A working install (both loaded), then both plists given content that is easy to tell apart. */
  function working() {
    const sb = macSandbox()
    expect(chronos(sb).code).toBe(0)
    const old = (l: string) => `<?xml version="1.0"?><plist><dict><key>Old-${l}</key><true/></dict></plist>
`
    for (const l of ['tick', 'ui']) writeFileSync(plist(sb, l), old(l))
    return { sb, plistsNow: () => ['tick', 'ui'].map((l) => readFileSync(plist(sb, l), 'utf8')) }
  }

  it('a failed mktemp changes nothing: both working plists are still there, byte for byte', () => {
    const { sb, plistsNow } = working()
    const was = plistsNow()
    put(sb, 'mktemp', 'echo "mktemp: injected failure" >&2; exit 1')
    expect(chronos(sb).code).not.toBe(0)
    expect(plistsNow()).toEqual(was)
  })

  it('a failed backup copy changes nothing: no truncated plist put over the good one, no plist deleted', () => {
    const { sb, plistsNow } = working()
    const was = plistsNow()
    put(
      sb,
      'cp',
      `case "$*" in *.plist*) echo "cp: injected failure" >&2; exit 1 ;; esac
exec "${which('cp')}" "$@"`,
    )
    expect(chronos(sb).code).not.toBe(0)
    expect(plistsNow()).toEqual(was)
  })

  it('terminated after the backup and before the write: the plists are back as they were (the trap path)', () => {
    const { sb, plistsNow } = working()
    const was = plistsNow()
    put(sb, 'plutil', 'kill -TERM $PPID; sleep 5')
    const r = chronos(sb)
    expect(r.code, r.out).not.toBe(0)
    expect(plistsNow()).toEqual(was)
  })
})

function rmFlag(sb: SB, name: string) {
  spawnSync('rm', ['-f', join(sb.root, 'lc', name)])
}
