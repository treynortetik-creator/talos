// scripts/testflight.sh builds in a throwaway checkout that has no Local.xcconfig, so the relay host for the push and passkey
// entitlement has to come from the environment (audit gap 10). The script runs here for real inside a small temp repository
// (git is real); xcodebuild, xcodegen and pnpm are stubs that record their arguments.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, 'testflight.sh')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'tf-'))
  made.push(root)
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const keys = join(root, 'keys')
  const log = join(root, 'calls.log')
  for (const d of [repo, bin, keys]) mkdirSync(d)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'alex@example.com')
  git(repo, 'config', 'user.name', 'Alex Example')
  mkdirSync(join(repo, 'scripts'))
  copyFileSync(SCRIPT, join(repo, 'scripts', 'testflight.sh'))
  mkdirSync(join(repo, 'apps', 'mobile', 'ios', 'App'), { recursive: true })
  writeFileSync(join(repo, 'apps', 'mobile', 'ios', 'App', 'project.yml'), 'name: App\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'one')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin')
  for (const t of ['xcodebuild', 'xcodegen', 'pnpm']) {
    writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${log}"\nexit 0\n`)
    chmodSync(join(bin, t), 0o755)
  }
  writeFileSync(join(keys, 'AuthKey_TESTKEY001.p8'), 'not a real key\n')
  const run = (args: string[], env: Record<string, string>) => {
    const r = spawnSync('bash', [join(repo, 'scripts', 'testflight.sh'), ...args], {
      encoding: 'utf8',
      cwd: repo,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        TMPDIR: root,
        ASC_KEY_PATH: join(keys, 'AuthKey_TESTKEY001.p8'),
        ASC_KEY_ID: 'TESTKEY001',
        ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
        DEVELOPMENT_TEAM: 'TEAMTEST01',
        TALOS_BUNDLE_ID: 'com.example.talos',
        TALOS_RELAY_URL: 'https://relay.example.test',
        ...env,
      },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  return { run, calls }
}

describe('testflight.sh and the relay host', () => {
  it('derives TALOS_RELAY_HOST from TALOS_RELAY_URL when it is unset, and passes it', () => {
    const w = world()
    const r = w.run([], {
      TALOS_APP_ENTITLEMENTS: 'App/AppPush.entitlements',
      TALOS_RELAY_URL: 'https://Relay.Example.test:8443/',
    })
    expect(r.code, r.out).toBe(0)
    const archive = w.calls().find((c) => c.startsWith('xcodebuild archive'))
    expect(archive).toContain('TALOS_RELAY_HOST=relay.example.test')
  })

  it('refuses a TALOS_RELAY_HOST that does not match the host of TALOS_RELAY_URL, before it builds anything', () => {
    const w = world()
    const r = w.run(['--dry-run'], { TALOS_RELAY_HOST: 'other.example.test' })
    expect(r.code).toBe(64)
    expect(r.out).toContain('does not match')
    expect(w.calls()).toEqual([])
  })

  it('refuses a host that is not bare (scheme, path, port, the placeholder)', () => {
    const w = world()
    for (const bad of [
      'https://relay.example.test',
      'relay.example.test/app',
      'relay.example.test:8080',
      'unset.invalid',
      'relay example',
    ]) {
      const r = w.run(['--dry-run'], { TALOS_APP_ENTITLEMENTS: 'App/AppPush.entitlements', TALOS_RELAY_HOST: bad })
      expect(r.code, bad).toBe(64)
      expect(r.out, bad).toContain('bare host')
    }
  })

  it('a push build passes the host to xcodebuild archive (the part that was dropped before)', () => {
    const w = world()
    const r = w.run([], {
      TALOS_APP_ENTITLEMENTS: 'App/AppPush.entitlements',
      TALOS_RELAY_HOST: 'relay.example.test',
      TESTFLIGHT_REF: 'origin/main',
    })
    expect(r.code, r.out).toBe(0)
    const archive = w.calls().find((c) => c.startsWith('xcodebuild archive'))
    expect(archive).toBeTruthy()
    expect(archive).toContain('TALOS_RELAY_HOST=relay.example.test')
    expect(archive).toContain('TALOS_APP_ENTITLEMENTS=App/AppPush.entitlements')
    expect(archive).toContain('TALOS_BUNDLE_ID=com.example.talos')
  })

  it('a build without push gets the derived host too (harmless without the entitlement)', () => {
    const w = world()
    const r = w.run([], {})
    expect(r.code, r.out).toBe(0)
    const archive = w.calls().find((c) => c.startsWith('xcodebuild archive'))
    expect(archive).toContain('TALOS_RELAY_HOST=relay.example.test')
  })
})
