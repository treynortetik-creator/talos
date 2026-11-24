// A checkout set up from a release's own source tarball (the Mac app's first setup; no .git) carries `.talos-source.json`.
// Version, `talos-app update` and `talos-app rollback` read it instead of failing on git: the version and commit come from the
// stamp, update asks the Talos app to look for the next release, and rollback says the app keeps the previous version.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { recordHealthyStart } from '../src/good-starts.ts'
import { OWNER_HOST_TEST } from '../src/platform.ts'
import { readSourceStamp, SOURCE_STAMP } from '../src/source-stamp.ts'
import { UPDATER_GIT_OPTS_LEN } from '../src/updater-git.ts'
import { resolveVersion } from '../src/version.ts'
import { tempHome } from './helpers.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const good = { v: 1, tag: 'v1.4.2', version: '1.4.2', gitSha: SHA }

/** A stand-in release checkout: the bridge's package.json (what update and rollback look for) and, as given, a stamp. */
function checkout(stamp?: unknown): string {
  const dir = tempHome('talos-release-')
  mkdirSync(join(dir, 'apps', 'bridge'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'bridge', 'package.json'), '{"name":"x","version":"0.0.0"}')
  if (stamp !== undefined)
    writeFileSync(join(dir, SOURCE_STAMP), typeof stamp === 'string' ? stamp : JSON.stringify(stamp))
  return dir
}

/** git that fails as it does outside any repository (the release checkout has no .git). */
const noGit = (cmd: string[]) =>
  cmd[0] === 'git' ? { code: 128, out: 'fatal: not a git repository' } : { code: 0, out: '' }

function io() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

describe('readSourceStamp', () => {
  test('reads a well-formed stamp; a tag without the v also counts; unknown keys are ignored', () => {
    expect(readSourceStamp(checkout(good))).toEqual({ tag: 'v1.4.2', version: '1.4.2', gitSha: SHA })
    expect(readSourceStamp(checkout({ ...good, tag: '1.4.2', extra: [1] }))?.tag).toBe('1.4.2')
  })

  test('the real release tag, mac-v<version> (what the public repo tags), counts too; only for that version', () => {
    expect(readSourceStamp(checkout({ ...good, tag: 'mac-v1.4.2' }))).toEqual({
      tag: 'mac-v1.4.2',
      version: '1.4.2',
      gitSha: SHA,
    })
    for (const tag of ['mac-v1.4.3', 'mac-1.4.2', 'mac-vv1.4.2', 'Mac-v1.4.2', 'mac-v', 'xmac-v1.4.2', 'mac-v1.4.2 '])
      expect(readSourceStamp(checkout({ ...good, tag })), tag).toBeUndefined()
  })

  test('anything that does not check out is no stamp', () => {
    for (const bad of [
      { ...good, v: 2 },
      { ...good, gitSha: SHA.slice(0, 7) },
      { ...good, gitSha: SHA.toUpperCase() },
      { ...good, version: '1.4' },
      { ...good, version: '01.4.2' },
      { ...good, tag: 'v1.4.3' },
      { tag: good.tag, version: good.version },
      [good],
      'not json',
    ])
      expect(readSourceStamp(checkout(bad)), JSON.stringify(bad)).toBeUndefined()
    expect(readSourceStamp(checkout())).toBeUndefined()
    expect(readSourceStamp(join(tempHome(), 'missing'))).toBeUndefined()
  })

  test('never through a link, never a huge file, never a folder', () => {
    const real = checkout(good)
    const linked = checkout()
    symlinkSync(join(real, SOURCE_STAMP), join(linked, SOURCE_STAMP))
    expect(readSourceStamp(linked)).toBeUndefined()
    expect(readSourceStamp(checkout(JSON.stringify({ ...good, pad: 'x'.repeat(70_000) })))).toBeUndefined()
    const folder = checkout()
    mkdirSync(join(folder, SOURCE_STAMP))
    expect(readSourceStamp(folder)).toBeUndefined()
  })
})

describe('resolveVersion on a release checkout', () => {
  // git is never run there: on a Mac without the developer tools /usr/bin/git is Apple's stub, which opens an install dialog
  const gitMustNotRun = (c: string, a: string[]): string | undefined => {
    throw new Error(`ran ${c} ${a.join(' ')}`)
  }

  test('no .git: the version and the 7-character commit come from the stamp, git is not run; APP_VERSION still names the version', () => {
    const dir = checkout(good)
    expect(resolveVersion(dir, { env: {}, run: gitMustNotRun })).toEqual({ version: '1.4.2', commit: '0123456' })
    expect(resolveVersion(dir, { env: { APP_VERSION: '9.9.9' }, run: gitMustNotRun })).toEqual({
      version: '9.9.9',
      commit: '0123456',
    })
  })

  test('a tarball unpacked inside a clone (no .git at its own root) is a release checkout, not the clone', () => {
    const clone = tempHome('talos-clone-')
    mkdirSync(join(clone, '.git'))
    const inner = join(clone, 'unpacked')
    mkdirSync(inner)
    writeFileSync(join(inner, SOURCE_STAMP), JSON.stringify(good))
    expect(resolveVersion(inner, { env: {}, run: gitMustNotRun }).commit).toBe('0123456')
  })

  test('a clone (a .git folder, or a worktree .git file) wins over a stamp lying in it', () => {
    for (const kind of ['folder', 'file'] as const) {
      const dir = checkout(good)
      if (kind === 'folder') mkdirSync(join(dir, '.git'))
      else writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
      const run = (_c: string, all: string[]) => {
        const a = all.slice(UPDATER_GIT_OPTS_LEN) // after the hardening options
        return (
          {
            'rev-parse --show-toplevel': dir,
            'rev-parse --short=7 HEAD': 'abc1234',
            'describe --tags --exclude=archive/* --always --dirty': 'abc1234',
          } as Record<string, string>
        )[a.join(' ')]
      }
      expect(resolveVersion(dir, { env: {}, run, exists: () => true }), kind).toEqual({
        version: 'abc1234',
        commit: 'abc1234',
      })
    }
  })
})

describe('good starts on a release checkout', () => {
  test('records nothing and runs no git', () => {
    const home = tempHome()
    const r = recordHealthyStart({
      file: join(home, 'good-starts.json'),
      repoDir: checkout(good),
      started: '0123456',
      run: (cmd) => {
        throw new Error(`ran ${cmd.join(' ')}`)
      },
    })
    expect(r).toEqual({ ok: false, why: 'set up from a release, not a git clone' })
    expect(() => statSync(join(home, 'good-starts.json'))).toThrow()
  })
})

// test/preload.ts pins the owner host to 'mac', so the first test is the Mac's path; the second sets another host.
describe('talos-app update on a release checkout', () => {
  test('on a Mac: asks the Talos app to look for a newer release (a 0600 request with no release in it), runs no git pull', async () => {
    const dir = checkout(good)
    const home = tempHome()
    const calls: string[][] = []
    const c = io()
    const code = await runCli(
      ['update'],
      c.io,
      { TALOS_APP_HOME: home },
      {
        update: {
          repoDir: dir,
          run: (cmd) => {
            calls.push(cmd)
            return noGit(cmd)
          },
        },
      },
    )
    expect(code).toBe(0)
    expect(c.out[0]).toBe(
      'This Talos was set up from release v1.4.2 (commit 0123456), not from a git clone, so the Talos app updates it.',
    )
    const file = join(home, 'auto-update', 'check-now.json')
    const req = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(req).sort()).toEqual(['action', 'ts', 'v'])
    expect(req).toMatchObject({ v: 1, action: 'check' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // made by us before the app ever ran its updater: the app's own folder mode (0700)
    expect(statSync(join(home, 'auto-update')).mode & 0o777).toBe(0o700)
    expect(c.out.join('\n')).toContain('asked the Mac app to check for a new version')
    expect(calls).toEqual([]) // no git at all (Apple's stub would open a dialog), no pull, no pnpm
  })

  test('on another computer: says how, writes nothing', async () => {
    const before = OWNER_HOST_TEST.host
    OWNER_HOST_TEST.host = 'linux'
    try {
      const home = tempHome()
      const c = io()
      const code = await runCli(
        ['update'],
        c.io,
        { TALOS_APP_HOME: home },
        {
          update: { repoDir: checkout(good), run: noGit },
        },
      )
      expect(code).toBe(0)
      expect(c.out.join('\n')).toContain('set it up again from the newer release')
      expect(() => statSync(join(home, 'auto-update', 'check-now.json'))).toThrow()
    } finally {
      OWNER_HOST_TEST.host = before
    }
  })

  test('no git and no stamp: the refusal it always gave', async () => {
    const c = io()
    const code = await runCli(
      ['update'],
      c.io,
      { TALOS_APP_HOME: tempHome() },
      {
        update: { repoDir: checkout(), run: noGit },
      },
    )
    expect(code).toBe(1)
    expect(c.err.join('\n')).toContain('not running from its own git checkout')
  })
})

describe('talos-app rollback on a release checkout', () => {
  test('says the app keeps the previous version, and changes nothing', async () => {
    const c = io()
    const dir = checkout(good)
    const code = await runCli(
      ['rollback', '--yes'],
      c.io,
      { TALOS_APP_HOME: tempHome() },
      {
        rollback: { repoDir: dir, run: noGit },
      },
    )
    expect(code).toBe(1)
    const err = c.err.join('\n')
    expect(err).toContain('set up from release v1.4.2 (commit 0123456), not from a git clone')
    expect(err).toContain('The Talos app keeps the release before its last update')
    // where it keeps it, and who puts it back
    expect(err).toContain(`beside this folder as ${dir}.previous`)
    expect(err).toContain('restores it by itself')
  })
})
