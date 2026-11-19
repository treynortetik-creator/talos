// apps/windows/distro/kit.py (talos-wsl.sh kit-update): root's sealed copy of the kit talos built, root's record of it, and
// Claude Code's policy. Run as an ordinary user against a scratch root (TALOS_KIT_TEST_ROOT, ignored as root), with this
// user standing in for root and for talos. The supervisor's own check (apps/bridge/src/supervisor/rooted-kit.ts and
// worker-hook.ts releaseHook) is run over what kit.py leaves, so both sides are held to one another, and to the shared
// fixtures in packages/protocol/fixtures.
// gate-reads: install.sh kit/* scripts/* apps/windows/distro/*
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const KIT = join(root, 'apps/windows/distro/kit.py')
const TALOS_WSL = join(root, 'apps/windows/distro/talos-wsl.sh')
const fixture = (n: string) => readFileSync(join(root, 'packages/protocol/fixtures', n))
const VECTOR = JSON.parse(fixture('kit-content-sha.json').toString('utf8')) as {
  files: { path: string; exec?: boolean; mode?: string; text: string }[]
  content_sha256: string
}
const asRoot = process.getuid?.() === 0
// The temp folder as kit.py sees it once it resolves paths (on macOS /var is a link to /private/var): resolved once here, so
// every path the tests expect agrees with what kit.py writes
const TMP = realpathSync(tmpdir())

const dirs: string[] = []
// Each test's folders go as soon as it ends: two tests build 10,000 and 20,000 names to hit kit.py's limits, and removing every
// test's tree in one afterAll ran past the hook budget on a loaded machine. Only the sealed vendor copy (0555 folders) needs
// write access back first, so chmod walks that one folder, not the big trees.
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', join(d, 'opt')])
    rmSync(d, { recursive: true, force: true })
  }
})

/** A scratch box: a Talos distro's marker, talos's home, and a stand-in for `talos-wsl.sh isolation`. */
function box(o: { isolated?: boolean } = {}) {
  const T = mkdtempSync(join(TMP, 'kitup-'))
  dirs.push(T)
  chmodSync(T, 0o755)
  mkdirSync(join(T, 'etc/talos-wsl'), { recursive: true, mode: 0o755 })
  chmodSync(join(T, 'etc'), 0o755)
  writeFileSync(join(T, 'etc/talos-wsl/marker'), 'talos\n', { mode: 0o644 })
  const iso = join(T, 'isolation.sh')
  writeFileSync(iso, `#!/bin/sh\n[ "$1" = isolation ] && exit ${o.isolated === false ? 1 : 0}\nexit 2\n`, {
    mode: 0o755,
  })
  const kit = join(T, 'home/talos/.local/share/talos/kit')
  mkdirSync(join(kit, 'releases'), { recursive: true })
  /** talos's release <version> from `files` (default: the shared vector's), made current */
  const release = (version: string, files = VECTOR.files, current = true) => {
    const top = join(kit, 'releases', version, 'talos-kit')
    for (const f of files) {
      const p = join(top, f.path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.text)
      chmodSync(p, f.mode ? Number.parseInt(f.mode, 8) : f.exec ? 0o755 : 0o644)
    }
    if (current) {
      // a link to a folder: rmSync refuses it on Node 24 (macOS), so the link itself is unlinked
      try {
        lstatSync(join(kit, 'current'))
        unlinkSync(join(kit, 'current'))
      } catch {}
      symlinkSync(`releases/${version}`, join(kit, 'current'))
    }
    return top
  }
  const run = (env: Record<string, string> = {}, args = ['install']) => {
    const r = spawnSync('python3', ['-I', KIT, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TALOS_KIT_TEST_ROOT: T, TALOS_KIT_TEST_ISOLATION: iso, ...env },
      encoding: 'utf8',
    })
    return { code: r.status, word: r.stdout.trim(), err: r.stderr }
  }
  const vendor = join(T, 'opt/talos-app/kit')
  const record = () => JSON.parse(readFileSync(join(T, 'etc/talos/kit-release'), 'utf8'))
  /**
   * What the supervisor says about a thread session's hook on this box: its own checks (worker-hook.ts releaseHook, which
   * runs under Bun), pointed at the scratch root as rooted-kit.test.ts points them.
   */
  const supervisor = (): Record<string, unknown> => {
    const src = `
      import { ROOTED_KIT } from ${JSON.stringify(join(root, 'apps/bridge/src/supervisor/rooted-kit.ts'))}
      import { releaseHook } from ${JSON.stringify(join(root, 'apps/bridge/src/supervisor/worker-hook.ts'))}
      Object.assign(ROOTED_KIT, ${JSON.stringify({
        marker: join(T, 'etc/talos-wsl/marker'),
        etc: join(T, 'etc/talos'),
        vendor,
        root: process.getuid?.() ?? 0,
        managed: join(T, 'etc/claude-code/managed-settings.json'),
      })})
      console.log(JSON.stringify(releaseHook(${JSON.stringify(join(T, 'unused-home-kit'))})))`
    const f = join(T, 'supervisor-check.ts')
    writeFileSync(f, src)
    const r = spawnSync('bun', ['run', f], { encoding: 'utf8', cwd: root })
    if (r.status !== 0) throw new Error(`bun: ${r.stderr}`)
    return JSON.parse(r.stdout.trim().split('\n').pop() as string)
  }
  return { T, kit, release, run, vendor, record, supervisor }
}

describe.skipIf(asRoot)('kit-update installs root’s sealed copy, and the supervisor accepts exactly that', () => {
  it('copies the release, records the shared vector’s digest, seals it, and writes the policy and the marketplace', () => {
    const b = box()
    b.release('1.2.3')
    const r = b.run()
    expect(r.word, r.err).toBe('kit-updated')
    expect(r.code).toBe(0)
    expect(b.record()).toEqual({ v: 1, version: '1.2.3', content_sha256: VECTOR.content_sha256 })
    expect(readlinkSync(join(b.vendor, 'current'))).toBe('releases/1.2.3')
    const top = join(b.vendor, 'releases/1.2.3')
    // no bytecode taken over; every folder 0555; files 0555 or 0444 (the 0744 one runs for its owner: 0555)
    expect(existsSync(join(top, 'talos-kit/hooks/__pycache__'))).toBe(false)
    expect(existsSync(join(top, 'talos-kit/hooks/stray.pyc'))).toBe(false)
    const mode = (p: string) => lstatSync(join(top, p)).mode & 0o7777
    expect([mode('.'), mode('talos-kit'), mode('talos-kit/hooks')]).toEqual([0o555, 0o555, 0o555])
    expect(mode('talos-kit/hooks/permission-relay.py')).toBe(0o555)
    expect(mode('talos-kit/hooks/owner-only.sh')).toBe(0o555)
    expect(mode('talos-kit/hooks/_talos_common.py')).toBe(0o444)
    // the fixed bytes both sides pin
    expect(readFileSync(join(b.vendor, '.claude-plugin/marketplace.json'))).toEqual(fixture('kit-marketplace.json'))
    expect(lstatSync(join(b.vendor, '.claude-plugin/marketplace.json')).mode & 0o7777).toBe(0o444)
    expect(readFileSync(join(b.T, 'etc/claude-code/managed-settings.json'))).toEqual(fixture('managed-settings.json'))
    expect(lstatSync(join(b.T, 'etc/claude-code/managed-settings.json')).mode & 0o7777).toBe(0o644)
    for (const d of [
      'opt/talos-app',
      'opt/talos-app/kit',
      'opt/talos-app/kit/releases',
      'etc/talos',
      'etc/claude-code',
    ])
      expect(lstatSync(join(b.T, d)).mode & 0o7777, d).toBe(0o755)
    // the supervisor's own check, over what kit.py left: rooted, root's file, in place
    const h = b.supervisor()
    expect(h, JSON.stringify(h)).toMatchObject({
      rooted: true,
      source: join(top, 'talos-kit/hooks/permission-relay.py'),
    })
  })

  it('a second run with nothing new changes nothing: kit-current', () => {
    const b = box()
    b.release('1.2.3')
    expect(b.run().word).toBe('kit-updated')
    const before = readFileSync(join(b.T, 'etc/talos/kit-release'))
    const r = b.run()
    expect(r.word, r.err).toBe('kit-current')
    expect(readFileSync(join(b.T, 'etc/talos/kit-release'))).toEqual(before)
    expect(readdirSync(join(b.vendor, 'releases'))).toEqual(['1.2.3'])
  })

  it('a policy an earlier Talos wrote (A’, 837baefd…) is replaced with today’s; anything else stays foreign', () => {
    const b = box()
    b.release('1.2.3')
    mkdirSync(join(b.T, 'etc/claude-code'), { mode: 0o755 })
    const old = '{"strictKnownMarketplaces":[{"source":"directory","path":"/opt/talos-app/kit"}]}\n'
    writeFileSync(join(b.T, 'etc/claude-code/managed-settings.json'), old, { mode: 0o644 })
    const r = b.run()
    expect(r.word, r.err).toBe('kit-updated')
    expect(readFileSync(join(b.T, 'etc/claude-code/managed-settings.json'))).toEqual(fixture('managed-settings.json'))
    expect(b.supervisor()).toMatchObject({ rooted: true })
    // the same kit again with the old policy put back: the word says the policy changed, not "already up to date"
    writeFileSync(join(b.T, 'etc/claude-code/managed-settings.json'), old, { mode: 0o644 })
    const again = b.run()
    expect(again.word, again.err).toBe('kit-policy-updated')
    expect(readFileSync(join(b.T, 'etc/claude-code/managed-settings.json'))).toEqual(fixture('managed-settings.json'))
    expect(b.run().word).toBe('kit-current')
    // one byte off an old policy is not an old policy
    const c = box()
    c.release('1.2.3')
    mkdirSync(join(c.T, 'etc/claude-code'), { mode: 0o755 })
    writeFileSync(join(c.T, 'etc/claude-code/managed-settings.json'), old.replace('kit"', 'kit/"'), { mode: 0o644 })
    expect(c.run().word).toBe('kit-policy-foreign')
  })

  it('a release left unsealed by a stopped run (same content) is sealed again, never called another release', () => {
    const b = box()
    b.release('1.2.3')
    expect(b.run().word).toBe('kit-updated')
    const f = join(b.vendor, 'releases/1.2.3/talos-kit/hooks/_talos_common.py')
    chmodSync(join(b.vendor, 'releases/1.2.3/talos-kit/hooks'), 0o755)
    chmodSync(f, 0o644)
    const r = b.run()
    expect(r.word, r.err).toBe('kit-current')
    expect([lstatSync(f).mode & 0o7777, lstatSync(dirname(f)).mode & 0o7777]).toEqual([0o444, 0o555])
    expect(b.supervisor()).toMatchObject({ rooted: true })
  })

  it('a staging folder a stopped run left is removed at the next run, even one that changes nothing', () => {
    const b = box()
    b.release('1.2.3')
    expect(b.run().word).toBe('kit-updated')
    mkdirSync(join(b.vendor, 'releases/.staging-left/talos-kit'), { recursive: true })
    expect(b.run().word).toBe('kit-current')
    expect(readdirSync(join(b.vendor, 'releases'))).toEqual(['1.2.3'])
  })

  it('more workers than it reads (10,000): nothing is pruned that run, since what they name is not known', () => {
    const b = box()
    for (const v of ['1.0.0', '1.1.0']) {
      b.release(v, [...VECTOR.files, { path: 'VERSION', text: `${v}\n` }])
      expect(b.run().word).toBe('kit-updated')
    }
    const workers = join(b.T, 'home/talos/.config/talos/app/workers')
    for (let i = 0; i <= 10_000; i++) mkdirSync(join(workers, `w${i}`), { recursive: true })
    b.release('1.2.0', [...VECTOR.files, { path: 'VERSION', text: '1.2.0\n' }])
    expect(b.run().word).toBe('kit-updated')
    expect(readdirSync(join(b.vendor, 'releases')).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0'])
  })

  it('a link in the way to the workers’ settings is not followed: what it names keeps nothing', () => {
    const b = box()
    for (const v of ['1.0.0', '1.1.0']) {
      b.release(v, [...VECTOR.files, { path: 'VERSION', text: `${v}\n` }])
      expect(b.run().word).toBe('kit-updated')
    }
    const elsewhere = join(b.T, 'elsewhere')
    mkdirSync(join(elsewhere, 'talos/app/workers/t1'), { recursive: true })
    writeFileSync(
      join(elsewhere, 'talos/app/workers/t1/settings.json'),
      '/opt/talos-app/kit/releases/1.0.0/talos-kit/x',
    )
    symlinkSync(elsewhere, join(b.T, 'home/talos/.config'))
    b.release('1.2.0', [...VECTOR.files, { path: 'VERSION', text: '1.2.0\n' }])
    expect(b.run().word).toBe('kit-updated')
    expect(readdirSync(join(b.vendor, 'releases')).sort()).toEqual(['1.1.0', '1.2.0'])
  })

  it('a new release: current moves, the one before stays, older ones go unless a running session names them', () => {
    const b = box()
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      b.release(v, [...VECTOR.files, { path: 'VERSION', text: `${v}\n` }])
      expect(b.run().word).toBe('kit-updated')
    }
    // 1.0.0 went when 1.2.0 came (current 1.2.0, before it 1.1.0)
    expect(readdirSync(join(b.vendor, 'releases')).sort()).toEqual(['1.1.0', '1.2.0'])
    // a thread session still runs 1.1.0's hook: kept past the next update, though it is no longer the one before current
    mkdirSync(join(b.T, 'home/talos/.config/talos/app/workers/t1'), { recursive: true })
    writeFileSync(
      join(b.T, 'home/talos/.config/talos/app/workers/t1/settings.json'),
      JSON.stringify({
        hooks: { command: '/usr/bin/python3 /opt/talos-app/kit/releases/1.1.0/talos-kit/hooks/permission-relay.py' },
      }),
    )
    // a forged one names folders that do not exist, or no release at all: nothing is added or removed for it
    mkdirSync(join(b.T, 'home/talos/.config/talos/app/workers/t2'), { recursive: true })
    writeFileSync(
      join(b.T, 'home/talos/.config/talos/app/workers/t2/settings.json'),
      '/opt/talos-app/kit/releases/../../etc/ and /opt/talos-app/kit/releases/.x/',
    )
    b.release('1.3.0', [...VECTOR.files, { path: 'VERSION', text: '1.3.0\n' }])
    expect(b.run().word).toBe('kit-updated')
    expect(readdirSync(join(b.vendor, 'releases')).sort()).toEqual(['1.1.0', '1.2.0', '1.3.0'])
    expect(b.record().version).toBe('1.3.0')
    expect(b.supervisor()).toMatchObject({ rooted: true })
  })
})

describe.skipIf(asRoot)('kit-update refuses, with one word, and installs nothing', () => {
  const nothingInstalled = (b: ReturnType<typeof box>) => {
    expect(existsSync(join(b.T, 'etc/talos/kit-release'))).toBe(false)
    expect(existsSync(join(b.vendor, 'current'))).toBe(false)
    expect(existsSync(join(b.T, 'etc/claude-code/managed-settings.json'))).toBe(false)
    const rel = join(b.vendor, 'releases')
    expect(existsSync(rel) ? readdirSync(rel) : []).toEqual([])
  }

  it('a link to a file, a FIFO, a link to a folder: kit-bad-release', () => {
    for (const make of [
      (top: string) => symlinkSync('/etc/passwd', join(top, 'hooks/evil.py')),
      (top: string) => spawnSync('mkfifo', [join(top, 'hooks/pipe')]),
      (top: string) => symlinkSync('/tmp', join(top, 'linked-dir')),
    ]) {
      const b = box()
      make(b.release('1.2.3'))
      const r = b.run()
      expect([r.code, r.word], r.err).toEqual([1, 'kit-bad-release'])
      nothingInstalled(b)
    }
  })

  it('talos has no release, or current is not releases/<version>: kit-no-release / kit-bad-release', () => {
    const b = box()
    expect(b.run().word).toBe('kit-no-release')
    b.release('1.2.3')
    unlinkSync(join(b.kit, 'current'))
    symlinkSync(join(b.kit, 'releases/1.2.3'), join(b.kit, 'current')) // absolute: not how plugin-release.py writes it
    expect(b.run().word).toBe('kit-bad-release')
    unlinkSync(join(b.kit, 'current'))
    symlinkSync('releases/../../../../../../etc', join(b.kit, 'current'))
    expect(b.run().word).toBe('kit-bad-release')
    nothingInstalled(b)
  })

  it('a version already installed with other content: kit-version-taken, root’s copy and record untouched', () => {
    const b = box()
    b.release('1.2.3')
    expect(b.run().word).toBe('kit-updated')
    const rec = readFileSync(join(b.T, 'etc/talos/kit-release'))
    spawnSync('chmod', ['-R', 'u+w', join(b.kit, 'releases/1.2.3')])
    writeFileSync(join(b.kit, 'releases/1.2.3/talos-kit/hooks/permission-relay.py'), "print('changed')\n")
    const r = b.run()
    expect(r.word, r.err).toBe('kit-version-taken')
    expect(readFileSync(join(b.T, 'etc/talos/kit-release'))).toEqual(rec)
    expect(b.supervisor()).toMatchObject({ rooted: true })
    expect(readdirSync(join(b.vendor, 'releases'))).toEqual(['1.2.3']) // no staging folder left behind
  })

  it('a policy Talos did not write, or a drop-in beside it: kit-policy-foreign, before anything is copied', () => {
    for (const make of [
      (T: string) =>
        writeFileSync(join(T, 'etc/claude-code/managed-settings.json'), '{"strictKnownMarketplaces":[]}\n'),
      (T: string) => mkdirSync(join(T, 'etc/claude-code/managed-settings.d/x'), { recursive: true }),
      (T: string) => symlinkSync('/etc/hostname', join(T, 'etc/claude-code/managed-settings.json')),
      // an empty drop-in folder anyone can write: the supervisor refuses it, so kit-update does too
      (T: string) => {
        mkdirSync(join(T, 'etc/claude-code/managed-settings.d'))
        chmodSync(join(T, 'etc/claude-code/managed-settings.d'), 0o777)
      },
    ]) {
      const b = box()
      b.release('1.2.3')
      mkdirSync(join(b.T, 'etc/claude-code'), { mode: 0o755 })
      make(b.T)
      const r = b.run()
      expect([r.code, r.word], r.err).toEqual([1, 'kit-policy-foreign'])
      expect(existsSync(join(b.T, 'etc/talos/kit-release'))).toBe(false)
      expect(existsSync(join(b.vendor, 'current'))).toBe(false)
    }
    // its own policy, exactly: fine
    const b = box()
    b.release('1.2.3')
    mkdirSync(join(b.T, 'etc/claude-code'), { mode: 0o755 })
    writeFileSync(join(b.T, 'etc/claude-code/managed-settings.json'), fixture('managed-settings.json'), { mode: 0o644 })
    expect(b.run().word).toBe('kit-updated')
  })

  it('not cut off from Windows: not-isolated', () => {
    const b = box({ isolated: false })
    b.release('1.2.3')
    expect(b.run().word).toBe('not-isolated')
    nothingInstalled(b)
  })

  it('started through sudo, pkexec or doas, or as anyone but root outside a test: not-root', () => {
    const b = box()
    b.release('1.2.3')
    for (const v of ['SUDO_USER', 'SUDO_UID', 'PKEXEC_UID', 'DOAS_USER'])
      expect(b.run({ [v]: 'talos' }).word).toBe('not-root')
    const r = spawnSync('python3', ['-I', KIT, 'install'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
    expect([r.status, r.stdout.trim()]).toEqual([1, 'not-root'])
    nothingInstalled(b)
  })

  it('a file with a second name (a hard link), or folders nested past the limit: kit-bad-release', () => {
    const b = box()
    const top = b.release('1.2.3')
    spawnSync('ln', [join(top, 'hooks/_talos_common.py'), join(b.T, 'second-name')])
    expect(b.run().word).toBe('kit-bad-release')
    nothingInstalled(b)
    const c = box()
    const deep = c.release('1.2.3')
    mkdirSync(join(deep, ...Array.from({ length: 42 }, (_, i) => `d${i}`)), { recursive: true })
    expect(c.run().word).toBe('kit-bad-release')
    nothingInstalled(c)
    // more than 20,000 names, even skipped ones (.pyc), stop the copy at the limit
    const d = box()
    const wide = join(d.release('1.2.3'), 'wide')
    mkdirSync(wide)
    for (let i = 0; i <= 20_000; i++) writeFileSync(join(wide, `f${i}.pyc`), '')
    expect(d.run().word).toBe('kit-bad-release')
    nothingInstalled(d)
  })

  it('a folder it would write into is another account’s or open to others: kit-unsafe-path', () => {
    const b = box()
    b.release('1.2.3')
    mkdirSync(join(b.T, 'opt'), { mode: 0o777 })
    chmodSync(join(b.T, 'opt'), 0o777)
    expect(b.run().word).toBe('kit-unsafe-path')
    nothingInstalled(b)
  })
})

describe('nothing inside the distro can start kit-update', () => {
  const sh = readFileSync(TALOS_WSL, 'utf8')
  it('the verb runs only while the distro is cut off from Windows', () => {
    const T = mkdtempSync(join(TMP, 'kitup-iso-'))
    dirs.push(T)
    const r = spawnSync('bash', [TALOS_WSL, 'kit-update'], {
      env: { PATH: process.env.PATH ?? '', TALOS_WSL_ROOT: T, TALOS_WSL_KIT: '/nonexistent' },
      encoding: 'utf8',
    })
    expect([r.status, r.stdout.trim()]).toEqual([1, 'not-isolated'])
  })
  it('root-setup writes no sudo or polkit rule, and no unit, path or socket names kit-update', () => {
    expect(sh).not.toMatch(/sudoers|polkit|pkla/i)
    const units = spawnSync('bash', [TALOS_WSL, 'units'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    }).stdout
    expect(units.length).toBeGreaterThan(0)
    expect(units).not.toMatch(/kit-update|kit\.py/)
    // no file of the distro's gives talos a way to root: no sudo or polkit rule anywhere in them
    for (const f of readdirSync(join(root, 'apps/windows/distro'), { withFileTypes: true }))
      if (f.isFile())
        expect(readFileSync(join(root, 'apps/windows/distro', f.name), 'utf8'), f.name).not.toMatch(
          /sudoers|polkit|NOPASSWD/i,
        )
  })
  it('kit.py pins the same policy and marketplace bytes as the fixtures, and ignores its test root as root', () => {
    const load =
      'import runpy, sys; g = runpy.run_path(sys.argv[1], run_name="x"); sys.stdout.write(g["MANAGED_BYTES"].hex() + " " + g["MARKETPLACE_BYTES"].hex())'
    const r = spawnSync('python3', ['-I', '-c', load, KIT], { encoding: 'utf8' })
    const [managed, market] = r.stdout.trim().split(' ')
    expect(managed).toBe(fixture('managed-settings.json').toString('hex'))
    expect(market).toBe(fixture('kit-marketplace.json').toString('hex'))
    expect(readFileSync(KIT, 'utf8')).toContain(
      'os.environ.get("TALOS_KIT_TEST_ROOT") if os.getuid() != 0 and os.geteuid() != 0 else None',
    )
  })
})
