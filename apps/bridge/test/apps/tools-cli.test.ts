import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readCatalog } from '../../src/apps/catalog.ts'
import type { AppsCliDeps } from '../../src/apps/cli.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { appPaths } from '../../src/apps/paths.ts'
import { type CliIO, runCli } from '../../src/cli-main.ts'
import { loadEnv } from '../../src/config.ts'
import { callTool } from '../../src/tools/index.ts'
import { type AppsHarness, mkApps } from './harness.ts'
import { approvedFixture, memSecrets, readProbe, ScriptedSource, stdioConfig, tmp } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..', '..')
const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})

describe('list_apps', () => {
  it('trust mode does not soften a write: the line still says card, and never "no card" or "your tap alone"', async () => {
    const a = await mkApps({ config: (c) => ({ ...c, trust_mode: true }) })
    live.push(a)
    const text = (await a.h.bridge.callTool('list_apps', {})).content[0]?.text ?? ''
    expect(text).toContain('set_note: card')
    expect(text).not.toContain('no card')
    expect(text).not.toContain('trust mode:')
  })

  it('names each approved app, its tools and their run rules; says when labels are not re-checked', async () => {
    const a = await mkApps()
    live.push(a)
    const text = (await a.h.bridge.callTool('list_apps', {})).content[0]?.text ?? ''
    expect(text).toContain('Probe view (probe) shown by show_widget, read_note, set_note, app_only_refresh')
    expect(text).toContain('read_note: no tap')
    expect(text).toContain('set_note: card')
    expect(text).toContain('model_only: not for apps')
    expect(text).toContain('app_only_refresh: not supported (this server type)')
    expect(text).toContain('labels not re-checked')
  })
  it('an http server with app-only tools: direct, and whether it needs a sign-in; declined and refused apps with their reasons; a version warning', async () => {
    const a = await mkApps({
      fx: {
        direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'oauth' },
        ownerDirect: true,
        tools: [
          {
            name: 'peek',
            resource_uri: 'ui://probe/view.html',
            visibility: ['app'],
            read_only: true,
            destructive: false,
            open_world: true,
          },
          {
            name: 'poll',
            resource_uri: 'ui://probe/view.html',
            visibility: ['app'],
            read_only: false,
            destructive: true,
            open_world: true,
          },
        ],
      },
    })
    live.push(a)
    writeFileSync(a.fx.P.liveVersion, '2.9.0\n')
    const t1 = (await a.h.bridge.callTool('list_apps', {})).content[0]?.text ?? ''
    expect(t1).toContain('peek: direct (needs sign-in), no tap')
    expect(t1).toContain('poll: direct (needs sign-in), card')
    expect(t1).not.toContain('labels not re-checked')
    expect(t1).toContain('Warning: scanned with Claude Code 2.1.312, this session runs 2.9.0')
    const cat = JSON.parse(readFileSync(a.fx.P.catalog, 'utf8'))
    cat.servers[0].resources[0].state = 'refused'
    cat.servers[0].resources[0].reason = 'Code not pinned: loads x without an integrity hash.'
    a.writeCatalog(cat)
    const t2 = (await a.h.bridge.callTool('list_apps', {})).content[0]?.text ?? ''
    expect(t2).toContain('refused - Code not pinned')
  })
  it('no catalog: says how to get one; headless processes get the live-session message', async () => {
    const a = await mkApps()
    live.push(a)
    await Bun.$`rm ${a.fx.P.catalog}`
    expect((await a.h.bridge.callTool('list_apps', {})).content[0]?.text).toContain('No apps are approved')
    const r = await callTool({ ...a.h.bridge.ctx, mode: 'headless' } as never, 'list_apps', {})
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('needs a live session')
  })
  it('the app tools are absent from the tool list unless apps are on', async () => {
    const on = await mkApps()
    live.push(on)
    expect(on.h.bridge.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['app_show', 'app_result', 'list_apps']),
    )
    const { startHarness } = await import('../helpers.ts')
    const off = await startHarness({})
    try {
      expect(off.bridge.tools.map((t) => t.name)).not.toContain('app_show')
      const r = await off.bridge.callTool('app_show', { thread_id: 'general', capture_id: 'x' })
      expect(r.isError).toBe(true)
      expect(r.content[0]?.text).toBe('unknown tool app_show')
    } finally {
      await off.stop()
    }
  })
})

// ---- the CLI ---------------------------------------------------------------------------------------------------------

function cli(home: string, deps: AppsCliDeps = {}, answers: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const io: CliIO = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q) => {
      asked.push(q)
      return answers.shift() ?? 'n'
    },
    sleep: async () => {},
    now: () => Date.parse('2026-10-30T12:00:00Z'),
  }
  const env = {
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: 'https://relay.example.com',
    PATH: process.env.PATH,
    HOME: tmp('empty-home-'),
  }
  return { out, err, asked, run: (argv: string[]) => runCli(argv, io, env, { apps: deps }), env }
}

describe('talos-app apps', () => {
  it('list: empty, then the catalog with state and key prefix', async () => {
    const home = tmp()
    const c = cli(home)
    expect(await c.run(['apps', 'list'])).toBe(0)
    expect(c.out).toEqual(['No apps. Run: talos-app apps scan'])
    const fx = await approvedFixture(home)
    const c2 = cli(home)
    await c2.run(['apps', 'list'])
    expect(c2.out[0]).toContain('catalog rev 1')
    expect(c2.out[1]).toBe(`Probe view  probe (local)  approved  ${fx.key.slice(0, 16)}`)
  })
  it('revoke by server name or by key prefix; nothing matching is an error; rev goes up', async () => {
    const home = tmp()
    const fx = await approvedFixture(home)
    const c = cli(home)
    expect(await c.run(['apps', 'revoke', 'nope'])).toBe(1)
    expect(c.err[0]).toContain('nothing approved matches nope')
    expect(await c.run(['apps', 'revoke', 'abc'])).toBe(1) // too short to be a key prefix
    expect(await c.run(['apps', 'revoke', fx.key.slice(0, 8)])).toBe(0)
    const cat = readCatalog(appPaths(home))
    expect(cat.ok && cat.catalog?.servers[0]?.resources[0]?.state).toBe('declined')
    expect(cat.ok && cat.catalog?.rev).toBe(2)
    expect(await c.run(['apps', 'revoke', 'probe'])).toBe(1) // already declined: nothing approved matches
    expect(await c.run(['apps', 'revoke'])).toBe(2)
  })
  it('strict on|off flips the catalog switch and bumps rev; bad usage is 2', async () => {
    const home = tmp()
    await approvedFixture(home)
    const c = cli(home)
    expect(await c.run(['apps', 'strict', 'on'])).toBe(0)
    let cat = readCatalog(appPaths(home))
    expect(cat.ok && cat.catalog?.strict).toBe(true)
    expect(await c.run(['apps', 'strict', 'off'])).toBe(0)
    cat = readCatalog(appPaths(home))
    expect(cat.ok && cat.catalog?.strict).toBe(false)
    expect(cat.ok && cat.catalog?.rev).toBe(3)
    expect(await c.run(['apps', 'strict', 'maybe'])).toBe(2)
    expect(await cli(tmp()).run(['apps', 'strict', 'on'])).toBe(1) // no catalog yet
  })
  it('logout deletes the oauth and config items of one server; login is for http/sse only and needs the stored config', async () => {
    const home = tmp()
    await approvedFixture(home, {
      direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'oauth' },
      ownerDirect: true,
    })
    const { kc, secrets } = memSecrets()
    const id = serverIdOf('probe', 'local')
    await secrets.saveConfig(id, { type: 'http', url: 'https://mcp.example.com/mcp' })
    await secrets.saveOauth(id, { tokens: { access_token: 't' } })
    const c = cli(home, { secrets })
    expect(await c.run(['apps', 'logout', 'probe'])).toBe(0)
    expect(kc.items.size).toBe(0)
    expect(await c.run(['apps', 'login', 'probe'])).toBe(1)
    expect(c.err.at(-1)).toContain('settings are not in your Keychain; run apps scan')
    expect(await c.run(['apps', 'login', 'ghost'])).toBe(1)
    expect(await c.run(['apps', 'login'])).toBe(2)
    const stdioHome = tmp()
    await approvedFixture(stdioHome)
    const c2 = cli(stdioHome, { secrets })
    expect(await c2.run(['apps', 'login', 'probe'])).toBe(1)
    expect(c2.err.at(-1)).toContain('remote (http/sse) servers only')
  })
  it('server names with escape sequences are printed escaped', async () => {
    const home = tmp()
    await approvedFixture(home, { server: 'ev\u001b[2Jil' })
    const c = cli(home)
    await c.run(['apps', 'list'])
    expect(c.out.join('\n')).not.toContain('\u001b')
    expect(c.out.join('\n')).toContain('\\x1b')
  })
  it('scan through the CLI: approves with y, exit 0; --check exits 1 on drift and 0 when clean; a stop is exit 1 on stderr', async () => {
    const home = tmp()
    const agentDir = tmp('agent-')
    const probe = await readProbe()
    const mk = (version = '2.1.312', drift?: Awaited<ReturnType<typeof readProbe>>) =>
      new ScriptedSource(
        version,
        [
          {
            name: 'probe',
            status: 'connected',
            source: 'local',
            config: stdioConfig(),
            tools: (drift ?? probe).tools as never,
          },
        ],
        { 'probe:ui://probe/view.html': (drift ?? probe).contents },
      )
    const sec = memSecrets()
    const deps = (source: ScriptedSource): AppsCliDeps => ({ source, secrets: sec.secrets, bridgeDir: BRIDGE_DIR })
    const c = cli(home, deps(mk()), ['y', 'Notes', 'auto'])
    expect(await c.run(['apps', 'scan', '--agent-dir', agentDir])).toBe(0)
    expect(c.asked).toEqual([
      'Approve this app? y/N ',
      'Label for this app [probe · show_widget]: ',
      'Show results automatically or ask each time (auto/ask) [auto]: ',
    ])
    expect(existsSync(join(agentDir, '.claude', 'settings.local.json'))).toBe(true)
    const clean = cli(home, deps(mk()))
    expect(await clean.run(['apps', 'scan', '--check', '--agent-dir', agentDir])).toBe(0)
    const drifted = await readProbe({ PROBE_GEN: '1', PROBE_DRIFT: 'csp' })
    const dr = cli(home, deps(mk('2.1.312', drifted)))
    expect(await dr.run(['apps', 'scan', '--check', '--agent-dir', agentDir])).toBe(1)
    expect(dr.out.join('\n')).toContain('now may also connect to: https://api2.example.com')
    const stop = cli(home, deps(mk('2.1.100')))
    expect(await stop.run(['apps', 'scan', '--agent-dir', agentDir])).toBe(1)
    expect(stop.err[0]).toContain('too old for apps')
  })
  it('unknown subcommand: usage and exit 2; no subcommand: usage and 0', async () => {
    const c = cli(tmp())
    expect(await c.run(['apps', 'frobnicate'])).toBe(2)
    expect(await c.run(['apps'])).toBe(0)
    expect(c.out.join('\n')).toContain('usage: talos-app apps scan')
  })
})

describe('install: hooks into settings.local.json', () => {
  it('install-app-hooks is idempotent, keeps foreign hooks, and writes nothing without a catalog or into the user scope', async () => {
    const home = tmp()
    const emptyHome = tmp('empty-home-')
    const agentDir = tmp('agent-')
    const c = cli(home)
    c.env.HOME = emptyHome
    expect(await c.run(['install-app-hooks', '--agent-dir', agentDir])).toBe(0)
    expect(existsSync(join(agentDir, '.claude'))).toBe(false)
    await approvedFixture(home)
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    const file = join(agentDir, '.claude', 'settings.local.json')
    writeFileSync(
      file,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] }, model: 'x' }),
    )
    expect(await c.run(['install-app-hooks', '--agent-dir', agentDir])).toBe(0)
    const once = readFileSync(file, 'utf8')
    expect(await c.run(['install-app-hooks', '--agent-dir', agentDir])).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(once)
    expect(c.out.at(-1)).toBe('app hooks already up to date')
    const cfg = JSON.parse(once)
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe('echo foreign')
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('^mcp__probe__.*')
    expect(cfg.model).toBe('x')
    expect(readdirSync(emptyHome)).toEqual([])
    expect(await c.run(['install-app-hooks'])).toBe(2)
    expect(await c.run(['install-app-hooks', '--agent-dir', agentDir, '--dry-run'])).toBe(0)
  })
  it('scripts/install.sh runs the same merge (twice, byte-identical) and leaves the user scope alone', async () => {
    const home = tmp('home-')
    const emptyHome = tmp('empty-home-')
    const agentDir = tmp('agent-')
    const binDir = tmp('bin-')
    await approvedFixture(home)
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    const file = join(agentDir, '.claude', 'settings.local.json')
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign-pre' }] }] },
      }),
    )
    const run = async () => {
      const p = Bun.spawn(
        [
          'bash',
          join(BRIDGE_DIR, 'scripts', 'install.sh'),
          '--agent-dir',
          agentDir,
          '--relay-url',
          'https://relay.example.com',
          '--home',
          home,
          '--bin-dir', // a throwaway folder: the default is next to bun, which is the real talos-app on PATH (W1)
          binDir,
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH ?? '', HOME: emptyHome, TALOS_APP_HOME: home },
        },
      )
      const [o, e] = await Promise.all([
        new Response(p.stdout as ReadableStream).text(),
        new Response(p.stderr as ReadableStream).text(),
      ])
      return { code: await p.exited, o, e }
    }
    const first = await run()
    expect({ code: first.code, e: first.e }).toEqual({ code: 0, e: '' })
    const a = readFileSync(file, 'utf8')
    const cfg = JSON.parse(a)
    expect(cfg.hooks.PreToolUse.map((g: { matcher: string }) => g.matcher)).toEqual(['Bash', '^mcp__probe__.*'])
    expect(cfg.hooks.PreToolUse[1].hooks[0].command).toBe(`bun run --cwd ${BRIDGE_DIR} --silent cli hook pre-tool-use`)
    expect((await run()).code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(a)
    expect(existsSync(join(emptyHome, '.claude'))).toBe(false) // never the user scope (bun itself may make ~/Library)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // --dry-run writes nothing new
    const dry = Bun.spawn(
      [
        'bash',
        join(BRIDGE_DIR, 'scripts', 'install.sh'),
        '--agent-dir',
        tmp('agent-'),
        '--relay-url',
        'https://relay.example.com',
        '--home',
        tmp('home-'),
        '--bin-dir',
        binDir,
        '--dry-run',
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: emptyHome } },
    )
    expect(await dry.exited).toBe(0)
    expect(await new Response(dry.stdout as ReadableStream).text()).toContain('would set 0 app hook matcher(s)')
  }, 60_000)
})

describe('the loaded environment', () => {
  it('apps is off unless TALOS_APP_APPS=1', () => {
    expect(loadEnv({ TALOS_APP_HOME: tmp() }).apps).toBe(false)
    expect(loadEnv({ TALOS_APP_HOME: tmp(), TALOS_APP_APPS: '0' }).apps).toBe(false)
    expect(loadEnv({ TALOS_APP_HOME: tmp(), TALOS_APP_APPS: '1' }).apps).toBe(true)
  })
})

describe('doctor: the apps part', () => {
  const doctor = async (home: string, agentDir: string, extra: string[] = [], deps: AppsCliDeps = {}) => {
    const c = cli(home, deps)
    const code = await c.run(['doctor', '--agent-dir', agentDir, ...extra])
    return { code, lines: c.out.filter((l) => /^\S+\s+apps /.test(l)) }
  }
  it('silent unless apps are on or a catalog exists', async () => {
    const r = await doctor(tmp(), tmp('agent-'))
    expect(r.lines).toEqual([])
  })
  it('healthy: catalog, version, hook entries with onFailure block, and the gate command really runs', async () => {
    const home = tmp()
    const agentDir = tmp('agent-')
    await approvedFixture(home)
    const c = cli(home)
    await c.run(['install-app-hooks', '--agent-dir', agentDir])
    const r = await doctor(home, agentDir)
    expect(r.lines.join('\n')).toContain('ok    apps catalog: rev 1, 1 server(s) with an approved app')
    expect(r.lines.join('\n')).toContain('ok    apps hooks: 1 gate entry with onFailure block')
    expect(r.lines.join('\n')).toContain('ok    apps gate runs: exit 0')
  })
  it('FAILs when the gate entry would fail open, when there is no entry, and when the catalog is corrupt; warns on a version change', async () => {
    const home = tmp()
    const agentDir = tmp('agent-')
    await approvedFixture(home)
    const c = cli(home)
    await c.run(['install-app-hooks', '--agent-dir', agentDir])
    const file = join(agentDir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    delete cfg.hooks.PreToolUse[0].hooks[0].onFailure
    writeFileSync(file, JSON.stringify(cfg))
    const open = await doctor(home, agentDir)
    expect(open.code).toBe(1)
    expect(open.lines.join('\n')).toContain('FAIL  apps hooks: the gate entry is missing "onFailure": "block"')
    writeFileSync(file, '{}')
    expect((await doctor(home, agentDir)).lines.join('\n')).toContain('FAIL  apps hooks: no gate entry for probe')
    const P = appPaths(home)
    mkdirSync(P.dir, { recursive: true })
    writeFileSync(P.liveVersion, '9.9.9\n')
    expect((await doctor(home, agentDir)).lines.join('\n')).toContain(
      'warn  apps Claude Code version: scanned with 2.1.312, live session runs 9.9.9',
    )
    writeFileSync(P.catalog, '{broken')
    expect((await doctor(home, agentDir)).lines.join('\n')).toContain('FAIL  apps catalog: catalog is not JSON')
  })
  it('--deep runs the scan check through the same session and reports drift', async () => {
    const home = tmp()
    const agentDir = tmp('agent-')
    const sec = memSecrets()
    const probe = await readProbe()
    const mk = (p: typeof probe) =>
      new ScriptedSource(
        '2.1.312',
        [{ name: 'probe', status: 'connected', source: 'local', config: stdioConfig(), tools: p.tools as never }],
        { 'probe:ui://probe/view.html': p.contents },
      )
    const scan = cli(home, { source: mk(probe), secrets: sec.secrets, bridgeDir: BRIDGE_DIR }, ['y', 'Notes', 'auto'])
    await scan.run(['apps', 'scan', '--agent-dir', agentDir])
    const clean = await doctor(home, agentDir, ['--deep'], {
      source: mk(probe),
      secrets: sec.secrets,
      bridgeDir: BRIDGE_DIR,
    })
    expect(clean.lines.join('\n')).toContain('ok    apps scan --check: no drift')
    const drifted = await doctor(home, agentDir, ['--deep'], {
      source: mk(await readProbe({ PROBE_GEN: '1', PROBE_DRIFT: 'csp' })),
      secrets: sec.secrets,
      bridgeDir: BRIDGE_DIR,
    })
    expect(drifted.lines.join('\n')).toContain('warn  apps scan --check: drift: probe')
  })
})

describe('the agent folder is never the home folder', () => {
  it('scan and install-app-hooks refuse it, and the user-scope folder stays untouched', async () => {
    const home = tmp()
    await approvedFixture(home)
    const c = cli(home)
    const userHome = c.env.HOME as string
    expect(await c.run(['apps', 'scan', '--agent-dir', userHome])).toBe(1)
    expect(c.err.at(-1)).toContain('agent folder is your home folder')
    expect(await c.run(['install-app-hooks', '--agent-dir', userHome])).toBe(1)
    expect(existsSync(join(userHome, '.claude'))).toBe(false)
  })
})
