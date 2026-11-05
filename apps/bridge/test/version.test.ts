// D61: the bridge's version comes from git (cached at start), not from package.json's 0.0.0.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRIDGE_COMMIT, BRIDGE_VERSION, REPO_DIR, resolveVersion, shaOf, versionSkew } from '../src/version.ts'

const fake = (answers: Record<string, string | undefined>) => (cmd: string, args: string[]) =>
  answers[`${cmd} ${args.join(' ')}`]
const ours = () => true

describe('resolveVersion', () => {
  test('reads git describe and the 7-character commit', () => {
    const r = resolveVersion('/x', {
      env: {},
      exists: ours,
      run: fake({
        'git rev-parse --show-toplevel': '/x',
        'git rev-parse --short=7 HEAD': 'abc1234',
        'git describe --tags --always --dirty': 'abc1234-dirty',
      }),
    })
    expect(r).toEqual({ version: 'abc1234-dirty', commit: 'abc1234' })
  })
  test('APP_VERSION wins, the commit is still read', () => {
    const r = resolveVersion('/x', {
      env: { APP_VERSION: ' 1.2.3 ' },
      exists: ours,
      run: fake({ 'git rev-parse --show-toplevel': '/x', 'git rev-parse --short=7 HEAD': 'abc1234' }),
    })
    expect(r).toEqual({ version: '1.2.3', commit: 'abc1234' })
  })
  test('no git falls back to the package value', () => {
    const r = resolveVersion('/x', { env: {}, run: () => undefined })
    expect(r.version).toBe('0.0.0')
    expect(r.commit).toBeUndefined()
  })
  test("a git repository that is not talos-app is ignored (someone else's commit must not be reported)", () => {
    const r = resolveVersion('/x', {
      env: {},
      exists: () => false,
      run: fake({
        'git rev-parse --show-toplevel': '/other',
        'git rev-parse --short=7 HEAD': 'ffff000',
        'git describe --tags --always --dirty': 'ffff000',
      }),
    })
    expect(r).toEqual({ version: '0.0.0', commit: undefined })
  })
  test('against a real throwaway repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-ver-'))
    mkdirSync(join(dir, 'apps', 'bridge', 'src'), { recursive: true })
    writeFileSync(join(dir, 'apps', 'bridge', 'src', 'version.ts'), '')
    const g = (...a: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@e.x', '-c', 'user.name=t', ...a])
    g('init', '-q')
    g('add', '.')
    g('commit', '-q', '-m', 'one')
    const sha = g('rev-parse', '--short=7', 'HEAD').stdout.toString().trim()
    const r = resolveVersion(dir, { env: {} })
    expect(r.commit).toBe(sha)
    expect(r.version).toBe(sha)
  })
})

describe('the bridge in this checkout', () => {
  test('BRIDGE_VERSION is not the package placeholder', () => {
    expect(BRIDGE_VERSION).not.toBe('0.0.0')
    expect(BRIDGE_COMMIT).toMatch(/^[0-9a-f]{7}$/)
    expect(existsSync(join(REPO_DIR, 'apps', 'bridge', 'src', 'version.ts'))).toBe(true)
  })
})

describe('versionSkew', () => {
  test('same commit is fine, different commit warns, dev/unknown says nothing', () => {
    expect(versionSkew('abc1234', 'abc1234')?.level).toBe('ok')
    expect(versionSkew('abc1234', 'abc1234-dirty')?.level).toBe('ok')
    expect(versionSkew('abc1234', 'def5678')?.level).toBe('warn')
    expect(versionSkew('abc1234', 'dev')).toBeUndefined()
    expect(versionSkew(undefined, 'abc1234')).toBeUndefined()
    expect(versionSkew('abc1234', undefined)).toBeUndefined()
    expect(versionSkew('abc1234', 'unknown version')).toBeUndefined()
  })
  test('shaOf only accepts hex shas', () => {
    expect(shaOf('abc1234567890')).toBe('abc1234')
    expect(shaOf('v1.2.3')).toBeUndefined()
  })
})

describe('status and doctor compare the bridge and the relay', () => {
  async function withRelay(version: string, fn: (url: string) => Promise<void>) {
    const srv = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/healthz'
          ? Response.json({ ok: true, version })
          : new Response('no', { status: 404 }),
    })
    try {
      await fn(`http://127.0.0.1:${srv.port}`)
    } finally {
      await srv.stop(true)
    }
  }
  const io = () => {
    const out: string[] = []
    return {
      out,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => Date.now(),
      },
    }
  }

  test('a relay on another commit warns in status (text and json) and in doctor', async () => {
    const { runCli } = await import('../src/cli.ts')
    const { tempHome } = await import('./helpers.ts')
    await withRelay('0123456', async (url) => {
      const env = { TALOS_APP_HOME: tempHome(), TALOS_APP_RELAY_URL: url }
      const a = io()
      expect(await runCli(['status'], a.io, env)).toBe(0)
      expect(a.out.join('\n')).toContain(`bridge version: ${BRIDGE_VERSION}`)
      expect(a.out.join('\n')).toContain(`WARNING: this Mac runs ${BRIDGE_COMMIT} and the relay runs 0123456`)
      const j = io()
      await runCli(['status', '--json'], j.io, env)
      const parsed = JSON.parse(j.out.join('\n'))
      expect(parsed).toMatchObject({ bridge_commit: BRIDGE_COMMIT, relay_version: '0123456', version_skew: true })
      const d = io()
      await runCli(['doctor'], d.io, env)
      expect(d.out.some((l) => l.startsWith('warn') && l.includes('bridge and relay versions'))).toBe(true)
    })
  })

  test('the same commit, or a relay that says dev, gives no warning', async () => {
    const { runCli } = await import('../src/cli.ts')
    const { tempHome } = await import('./helpers.ts')
    for (const v of [BRIDGE_COMMIT as string, 'dev']) {
      await withRelay(v, async (url) => {
        const a = io()
        await runCli(['status'], a.io, { TALOS_APP_HOME: tempHome(), TALOS_APP_RELAY_URL: url })
        expect(a.out.join('\n')).not.toContain('WARNING')
        const d = io()
        await runCli(['doctor'], d.io, { TALOS_APP_HOME: tempHome(), TALOS_APP_RELAY_URL: url })
        expect(d.out.some((l) => l.startsWith('warn') && l.includes('bridge and relay versions'))).toBe(false)
      })
    }
  })

  // D61 review: status and doctor are short-lived; the code ON DISK is not the code RUNNING after `talos-app update`.
  describe('against a running bridge that started from another commit', () => {
    const live = (home: string, commit: string | null | undefined) => {
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, 'status.json'),
        JSON.stringify({
          v: 1,
          pid: process.pid,
          instance: 'i',
          started_at: new Date().toISOString(),
          mode: 'live',
          relay: { connected: true, last_connect_at: null, last_close_code: null },
          queue_depth: 0,
          permission_relay: false,
          ...(commit === undefined ? {} : { bridge_commit: commit }),
          updated_at: new Date().toISOString(),
        }),
      )
    }
    test('an update without a restart is not reported as "both at the new commit"', async () => {
      const { runCli } = await import('../src/cli.ts')
      const { tempHome } = await import('./helpers.ts')
      await withRelay(BRIDGE_COMMIT as string, async (url) => {
        const home = tempHome()
        live(home, 'aaaaaaa')
        const env = { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: url }
        const a = io()
        await runCli(['status'], a.io, env)
        const text = a.out.join('\n')
        expect(text).toContain('started from aaaaaaa')
        expect(text).toContain('Restart the agent')
        expect(text).toContain('bridge version: aaaaaaa (running)')
        expect(text).not.toContain('are both at')
        const j = io()
        await runCli(['status', '--json'], j.io, env)
        expect(JSON.parse(j.out.join('\n'))).toMatchObject({
          bridge_commit: 'aaaaaaa',
          disk_commit: BRIDGE_COMMIT,
          needs_restart: true,
          version_skew: true,
        })
        const d = io()
        await runCli(['doctor'], d.io, env)
        expect(d.out.some((l) => l.startsWith('warn') && l.includes('running code'))).toBe(true)
        expect(d.out.join('\n')).not.toContain(`both at ${BRIDGE_COMMIT}`)
      })
    })
    test('a running bridge from before this field says nothing about itself, so nothing is claimed', async () => {
      const { runCli } = await import('../src/cli.ts')
      const { tempHome } = await import('./helpers.ts')
      await withRelay(BRIDGE_COMMIT as string, async (url) => {
        const home = tempHome()
        live(home, undefined)
        const env = { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: url }
        const d = io()
        await runCli(['doctor'], d.io, env)
        expect(d.out.some((l) => l.includes('bridge and relay versions'))).toBe(false)
        const a = io()
        await runCli(['status'], a.io, env)
        expect(a.out.join('\n')).toContain('bridge version: unknown')
      })
    })
    test('the status file a bridge writes carries the commit it started from', async () => {
      const { commitReport } = await import('../src/version.ts')
      expect(commitReport({ running: true, startedFrom: 'aaaaaaa' }, 'bbbbbbb').commit).toBe('aaaaaaa')
      expect(commitReport({ running: true, startedFrom: 'aaaaaaa' }, 'bbbbbbb').note).toContain('Restart')
      expect(commitReport({ running: true, startedFrom: 'aaaaaaa' }, 'aaaaaaa').note).toBeUndefined()
      expect(commitReport({ running: true, startedFrom: null }, 'bbbbbbb')).toEqual({
        commit: undefined,
        note: undefined,
      })
      expect(commitReport({ running: false, startedFrom: null }, 'bbbbbbb').commit).toBe('bbbbbbb')
    })
  })
})
