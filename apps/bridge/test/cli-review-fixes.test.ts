// Review fixes on the setup-and-recovery PR (#125): a missing `uqr` must not break other commands, a clock that is off must
// not send the owner to Railway, and the bridge CLI must never load the current folder's .env.
import { describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { keyRefusedHint, renderQr } from '../src/cli-main.ts'
import { type BridgeEnv, loadEnv } from '../src/config.ts'
import { RelayHttpError } from '../src/relay-http.ts'
import { tempHome } from './helpers.ts'

const SRC = resolve(import.meta.dir, '..', 'src')

describe('uqr is optional at runtime', () => {
  test('a copy of the bridge whose node_modules has no uqr still runs help and status', () => {
    // what an install looks like after pulling this PR and restarting, but before `pnpm install`
    const root = tempHome('talos-nouqr-')
    cpSync(SRC, join(root, 'src'), { recursive: true })
    cpSync(join(SRC, '..', 'package.json'), join(root, 'package.json'))
    const nm = join(SRC, '..', 'node_modules')
    mkdirSync(join(root, 'node_modules'))
    for (const name of readdirSync(nm)) {
      if (name === 'uqr' || name === '.bin') continue
      symlinkSync(realpathSync(join(nm, name)), join(root, 'node_modules', name))
    }
    expect(existsSync(join(root, 'node_modules', 'uqr'))).toBe(false)
    const home = join(tempHome(), 'app')
    const run = (args: string[]) =>
      Bun.spawnSync(['bun', '--no-env-file', 'run', '--no-install', join(root, 'src', 'cli.ts'), ...args], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: home, TALOS_APP_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    // control: the copy really cannot load uqr
    writeFileSync(join(root, 'probe.ts'), "await import('uqr')\n")
    expect(
      Bun.spawnSync(['bun', 'run', '--no-install', join(root, 'probe.ts')], { cwd: root, stderr: 'pipe' }).exitCode,
    ).not.toBe(0)
    // cli-main.ts itself must load without uqr (an import split over lines or a top-level import would break this).
    writeFileSync(join(root, 'probe-main.ts'), "await import('./src/cli-main.ts')\n")
    const loaded = Bun.spawnSync(['bun', 'run', '--no-install', join(root, 'probe-main.ts')], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: home, TALOS_APP_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(loaded.stderr.toString()).not.toContain('Cannot find package')
    expect(loaded.exitCode).toBe(0)
    for (const args of [['help'], ['status']]) {
      const r = run(args)
      const out = r.stdout.toString() + r.stderr.toString()
      expect(out).not.toContain('Cannot find package')
      expect(r.exitCode).toBe(0)
    }
    expect(run(['help']).stdout.toString()).toContain('start [--agent-dir')
  })

  test('renderQr falls back to undefined when the library cannot load, and draws when it can', async () => {
    expect(
      await renderQr('https://x.example/enroll#abc', async () => {
        throw new Error('Cannot find package')
      }),
    ).toBeUndefined()
    const lines = await renderQr('https://x.example/enroll#abc')
    expect(lines?.length).toBeGreaterThan(5)
  })
})

describe('a 401 is not always the key', () => {
  const env = (): BridgeEnv => loadEnv({ TALOS_APP_HOME: join(tempHome(), 'app') })
  const now = Date.parse('2026-11-01T12:00:00Z')

  test('a Mac clock 10 minutes ahead of the relay gets the clock fix, not the Railway fix', async () => {
    const e = new RelayHttpError(401, 'GET /bridge/digest -> 401', undefined, now - 10 * 60_000)
    const hint = await keyRefusedHint(env(), e, now)
    expect(hint).toContain('10 minutes ahead of')
    expect(hint).toContain('Date & Time')
    expect(hint).not.toContain('BRIDGE_PUBKEY=')
  })

  test('behind works too, and one minute is singular', async () => {
    const e = new RelayHttpError(401, 'x', undefined, now + 3 * 60_000)
    expect(await keyRefusedHint(env(), e, now)).toContain('3 minutes behind')
  })

  test('a clock that agrees keeps the Railway fix, hedged with a clock check', async () => {
    const e = new RelayHttpError(401, 'x', undefined, now - 2_000)
    const hint = await keyRefusedHint(env(), e, now)
    expect(hint).toContain("turned away this Mac's key")
    expect(hint).toContain('BRIDGE_PUBKEY=')
    expect(hint).toContain('date and time')
  })

  test('no Date header: the Railway fix', async () => {
    expect(await keyRefusedHint(env(), new RelayHttpError(401, 'x'), now)).toContain('BRIDGE_PUBKEY=')
  })

  test('end to end: doctor against a relay that answers 401 with a Date 10 minutes off blames the clock', async () => {
    const off = new Date(Date.now() - 10 * 60_000).toUTCString()
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === '/healthz') return Response.json({ ok: true })
        return new Response('{}', { status: 401, headers: { date: off } })
      },
    })
    try {
      const home = join(tempHome(), 'app')
      const out: string[] = []
      const io = {
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(l),
        prompt: async () => 'n',
        sleep: async () => {},
        now: () => Date.now(),
      }
      const url = `http://127.0.0.1:${srv.port}`
      expect(await runCli(['init', '--relay-url', url], io, { TALOS_APP_HOME: home })).toBe(0)
      out.length = 0
      const code = await runCli(['doctor', '--agent-dir', home], io, {
        TALOS_APP_HOME: home,
        TALOS_APP_RELAY_URL: url,
      })
      const text = out.join('\n')
      expect(code).toBe(1)
      expect(text).toMatch(/relay accepts this Mac: .*clock is about 10 minutes ahead of the relay/)
    } finally {
      srv.stop(true)
    }
  })
})
