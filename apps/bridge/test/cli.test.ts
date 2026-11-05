import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { ConfigFile, parseConfig } from '../src/config-file.ts'
import { type McpEntry, mcpEntry, mergeMcpConfig } from '../src/mcp-config.ts'
import { type Harness, startHarness, tempHome } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

function cliIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
const mode = (p: string) => statSync(p).mode & 0o777
const INSTALL = resolve(import.meta.dir, '..', 'scripts', 'install.sh')

describe('talos-app init', () => {
  test('creates the home (0700), key (0600), config.json from the example and bridge.env, and prints BRIDGE_PUBKEY', async () => {
    const home = join(tempHome(), 'app')
    const { out, err, io } = cliIO()
    expect(await runCli(['init', '--relay-url', 'https://relay.example.com/'], io, { TALOS_APP_HOME: home })).toBe(0)
    expect(err).toEqual([])
    const p = paths(home)
    expect(mode(home)).toBe(0o700)
    for (const d of [p.media, p.approved, p.enrollPending]) expect(mode(d)).toBe(0o700)
    expect(mode(p.bridgeKey)).toBe(0o600)
    expect(mode(p.configJson)).toBe(0o600)
    expect(mode(p.envFile)).toBe(0o600)
    const key = JSON.parse(readFileSync(p.bridgeKey, 'utf8'))
    expect(out).toContain(`BRIDGE_PUBKEY=${key.public}`)
    expect(key.public).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const cfg = parseConfig(JSON.parse(readFileSync(p.configJson, 'utf8')))
    expect(cfg.ok).toBe(true)
    if (cfg.ok) {
      expect(cfg.config.threads.map((t) => t.id)).toEqual(['general', 'inbox'])
      expect(cfg.config.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      expect(cfg.config.threads.every((t) => Date.now() - Date.parse(t.created_at) < 60_000)).toBe(true)
    }
    expect(readFileSync(p.envFile, 'utf8')).toBe('TALOS_APP_RELAY_URL=https://relay.example.com\n')
  })

  test('a fresh install writes permission_relay true to config.json, for both example configs', async () => {
    for (const which of ['default', 'five-threads']) {
      const home = join(tempHome(), 'app')
      const { io } = cliIO()
      const args = ['init', '--relay-url', 'https://relay.example.com', '--config', which]
      expect(await runCli(args, io, { TALOS_APP_HOME: home })).toBe(0)
      expect(JSON.parse(readFileSync(paths(home).configJson, 'utf8')).permission_relay).toBe(true)
    }
  })

  test('init never flips a saved permission_relay false, and a saved file with no key loads as false', async () => {
    const home = join(tempHome(), 'app')
    expect(
      await runCli(['init', '--relay-url', 'https://relay.example.com'], cliIO().io, { TALOS_APP_HOME: home }),
    ).toBe(0)
    const p = paths(home)
    const saved = JSON.parse(readFileSync(p.configJson, 'utf8'))
    writeFileSync(p.configJson, JSON.stringify({ ...saved, permission_relay: false }))
    expect(
      await runCli(['init', '--relay-url', 'https://relay.example.com'], cliIO().io, { TALOS_APP_HOME: home }),
    ).toBe(0)
    const kept = JSON.parse(readFileSync(p.configJson, 'utf8'))
    expect(kept.permission_relay).toBe(false)
    expect(new ConfigFile(p.configJson).load().permission_relay).toBe(false)
    const { permission_relay: _gone, ...noKey } = kept
    writeFileSync(p.configJson, JSON.stringify(noKey))
    expect(new ConfigFile(p.configJson).load().permission_relay).toBe(false)
  })

  test('a second run keeps the key and config, updates the relay URL and keeps other bridge.env lines', async () => {
    const home = join(tempHome(), 'app')
    const first = cliIO()
    await runCli(['init', '--relay-url', 'https://one.example.com'], first.io, { TALOS_APP_HOME: home })
    const p = paths(home)
    writeFileSync(p.envFile, `${readFileSync(p.envFile, 'utf8')}TALOS_APP_STT_TIMEOUT_S=60\n`)
    const keyBefore = readFileSync(p.bridgeKey, 'utf8')
    const cfgBefore = readFileSync(p.configJson, 'utf8')
    const second = cliIO()
    expect(await runCli(['init', '--relay-url', 'https://two.example.com'], second.io, { TALOS_APP_HOME: home })).toBe(
      0,
    )
    expect(readFileSync(p.bridgeKey, 'utf8')).toBe(keyBefore)
    expect(readFileSync(p.configJson, 'utf8')).toBe(cfgBefore)
    expect(readFileSync(p.envFile, 'utf8')).toBe(
      'TALOS_APP_STT_TIMEOUT_S=60\nTALOS_APP_RELAY_URL=https://two.example.com\n',
    )
    expect(second.out.join('\n')).toContain('kept the existing bridge key')
  })

  test('--config five-threads gives the five-thread example; bad arguments exit non-zero', async () => {
    const home = join(tempHome(), 'app')
    const a = cliIO()
    expect(
      await runCli(['init', '--relay-url', 'https://r.example.com', '--config', 'five-threads'], a.io, {
        TALOS_APP_HOME: home,
      }),
    ).toBe(0)
    const cfg = parseConfig(JSON.parse(readFileSync(paths(home).configJson, 'utf8')))
    expect(cfg.ok && cfg.config.threads.length).toBeGreaterThanOrEqual(5)
    const b = cliIO()
    expect(await runCli(['init'], b.io, { TALOS_APP_HOME: join(tempHome(), 'x') })).toBe(1)
    expect(await runCli(['init', '--relay-url', 'not a url'], b.io, { TALOS_APP_HOME: join(tempHome(), 'y') })).toBe(1)
    expect(
      await runCli(['init', '--relay-url', 'https://r.example.com', '--config', 'weird'], b.io, {
        TALOS_APP_HOME: join(tempHome(), 'z'),
      }),
    ).toBe(1)
    expect(await runCli(['bogus'], b.io, {})).toBe(2)
  })
})

describe('talos-app post, digest, status, doctor', () => {
  const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })

  test('post sends a headless reply over signed HTTP and opens no socket', async () => {
    h = await startHarness({ startBridge: false })
    const { out, io } = cliIO()
    expect(await runCli(['post', 'general', 'nightly', 'report', 'ready'], io, env(h))).toBe(0)
    expect(out[0]).toMatch(/^sent \(id: m_/)
    const f = await h.relay.expectFrame('reply', (r) => r.message.text === 'nightly report ready', {
      direction: 'from_bridge',
    })
    expect(f.message.via).toBe('headless')
    expect(h.relay.bridgeConnected).toBe(false)
    const bad = cliIO()
    expect(await runCli(['post', 'nope', 'x'], bad.io, env(h))).toBe(1)
    expect(await runCli(['post', 'general'], bad.io, env(h))).toBe(1)
  })

  test('digest prints the relay digest inside the untrusted wrapper', async () => {
    h = await startHarness({ startBridge: false })
    const { out, io } = cliIO()
    expect(await runCli(['digest', '--since', '2026-10-28T00:00:00.000Z'], io, env(h))).toBe(0)
    const text = out.join('\n')
    expect(text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>/)
    expect(text).toContain('2026-10-28T00:00:00.000Z')
    const req = h.relay.http.find((r) => r.path.startsWith('/bridge/digest'))
    expect(req?.path).toBe('/bridge/digest?since=2026-10-28T00%3A00%3A00.000Z')
    expect(req?.status).toBe(200)
  })

  test('status reports reachability, key id, last connect, queue depth, STT/TTS and mirror state', async () => {
    h = await startHarness()
    const { out, io } = cliIO()
    expect(await runCli(['status'], io, { ...env(h), TALOS_APP_STT_CMD: '["x"]' })).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('relay reachable: yes')
    expect(text).toContain(`bridge key id: ${h.relay.bridgeKey.keyId}`)
    expect(text).toMatch(/last connect: \d{4}-/)
    expect(text).toContain('queue depth: 0')
    expect(text).toContain('STT: configured  TTS: not configured')
  })

  test('doctor passes on a healthy setup and fails on a world-readable key or a missing .mcp.json entry', async () => {
    h = await startHarness({ startBridge: false })
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const inst = cliIO()
    await runCli(['install-mcp', '--agent-dir', agent], inst.io, env(h))
    const ok = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent], ok.io, env(h))).toBe(0)
    expect(ok.out.some((l) => l.startsWith('ok') && l.includes('relay /healthz'))).toBe(true)
    expect(ok.out.some((l) => l.includes('MCP SDK version') && l.includes('1.32.2'))).toBe(true)
    expect(ok.out.some((l) => l.startsWith('FAIL'))).toBe(false)
    // D40: the refused-key banner sends the owner here, so doctor must print the line the relay needs (the real base64url key)
    const pub = (JSON.parse(readFileSync(paths(h.home).bridgeKey, 'utf8')) as { public: string }).public
    expect(ok.out).toContain(`BRIDGE_PUBKEY=${pub}`)
    expect(ok.out.some((l) => l.includes('BRIDGE_PUBKEY_FORCE=1'))).toBe(true)
    const { chmodSync } = await import('node:fs')
    chmodSync(paths(h.home).bridgeKey, 0o644)
    const bad = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent], bad.io, env(h))).toBe(1)
    expect(bad.out.some((l) => l.startsWith('FAIL') && l.includes('bridge.key mode'))).toBe(true)
    chmodSync(paths(h.home).bridgeKey, 0o600)
    const { rmSync, writeFileSync } = await import('node:fs')
    rmSync(paths(h.home).devicesJson)
    const nodev = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent], nodev.io, env(h))).toBe(0)
    expect(nodev.out.some((l) => l.includes('devices.json: none pinned yet') && l.startsWith('ok'))).toBe(true)
    writeFileSync(paths(h.home).devicesJson, '{not json', { mode: 0o600 })
    const corrupt = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent], corrupt.io, env(h))).toBe(1)
    expect(corrupt.out.some((l) => l.startsWith('FAIL') && l.includes('devices.json'))).toBe(true)
    writeFileSync(paths(h.home).devicesJson, '{"version":1,"devices":[]}')
    chmodSync(paths(h.home).devicesJson, 0o644)
    const perm = cliIO()
    expect(await runCli(['doctor', '--agent-dir', agent], perm.io, env(h))).toBe(1)
    expect(perm.out.some((l) => l.startsWith('FAIL') && l.includes('devices.json mode'))).toBe(true)
    rmSync(paths(h.home).devicesJson)
    const empty = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const none = cliIO()
    expect(await runCli(['doctor', '--agent-dir', empty], none.io, env(h))).toBe(1)
    expect(none.out.some((l) => l.startsWith('FAIL') && l.includes('.mcp.json'))).toBe(true)
  })
})

describe('.mcp.json merge and install.sh', () => {
  const entry = mcpEntry('/opt/talos-app/apps/bridge', '/home/user/.config/talos/app')

  test('merge keeps other servers and top-level keys, and is idempotent', () => {
    const existing = { someKey: 1, mcpServers: { other: { command: 'x', args: [] } } }
    const first = mergeMcpConfig(existing, entry)
    expect(first.changed).toBe(true)
    expect(first.config.someKey).toBe(1)
    expect((first.config.mcpServers as Record<string, unknown>).other).toEqual(existing.mcpServers.other)
    expect((first.config.mcpServers as Record<string, unknown>)['talos-app']).toEqual(entry)
    expect(mergeMcpConfig(first.config, entry).changed).toBe(false)
    expect(mergeMcpConfig(undefined, entry).config).toEqual({ mcpServers: { 'talos-app': entry } })
    expect(entry).toEqual({
      command: 'bun',
      args: ['run', '--cwd', '/opt/talos-app/apps/bridge', '--silent', 'start'],
      env: { TALOS_APP_HOME: '/home/user/.config/talos/app' },
    })
  })

  test('merge keeps each string-valued env key on its own, drops only the non-string ones, and names what it dropped', () => {
    const existing = {
      mcpServers: {
        'talos-app': {
          command: 'bun',
          args: ['old'],
          env: { EXTRA_FLAG: 'on', RETRIES: 3, NESTED: { a: 1 }, NOTHING: null, TALOS_APP_HOME: 42 },
        },
      },
    }
    const next = mcpEntry('/opt/talos-app/apps/bridge', '/home/user/.config/talos/app')
    const r = mergeMcpConfig(existing, next)
    const got = (r.config.mcpServers as Record<string, McpEntry>)['talos-app']
    expect(got.env).toEqual({ EXTRA_FLAG: 'on', TALOS_APP_HOME: '/home/user/.config/talos/app' })
    expect(r.droppedEnv).toEqual(['RETRIES', 'NESTED', 'NOTHING', 'TALOS_APP_HOME'])
    expect(mergeMcpConfig(undefined, next).droppedEnv).toEqual([])
    expect(mergeMcpConfig({ mcpServers: { 'talos-app': { env: ['x'] } } }, next).droppedEnv).toEqual([])
  })

  test('install-mcp prints the env keys it dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'talos-app': { command: 'bun', args: [], env: { KEEP: 'yes', BAD: 7 } } } }),
    )
    const c = cliIO()
    expect(await runCli(['install-mcp', '--agent-dir', dir], c.io, { TALOS_APP_HOME: join(tempHome(), 'z') })).toBe(0)
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers['talos-app']
    expect(written.env.KEEP).toBe('yes')
    expect(written.env.BAD).toBeUndefined()
    expect(c.out.join('\n')).toMatch(/dropped env keys? .*BAD.*not a string/)
  })

  test('merge keeps env keys the owner added to the talos-app entry and sets only the ones Talos owns', () => {
    const existing = {
      mcpServers: {
        'talos-app': {
          command: 'bun',
          args: ['old'],
          env: { TALOS_APP_HOME: '/stale', EXTRA_FLAG: 'on', HTTPS_PROXY: 'http://proxy.example.com:8080' },
        },
      },
    }
    const next = mcpEntry('/opt/talos-app/apps/bridge', '/home/user/.config/talos/app', '/home/alex/agent')
    const { config, changed } = mergeMcpConfig(existing, next)
    const got = (config.mcpServers as Record<string, McpEntry>)['talos-app']
    expect(changed).toBe(true)
    expect(got.args).toEqual(next.args)
    expect(got.env).toEqual({
      TALOS_APP_HOME: '/home/user/.config/talos/app',
      TALOS_AGENT_DIR: '/home/alex/agent',
      EXTRA_FLAG: 'on',
      HTTPS_PROXY: 'http://proxy.example.com:8080',
    })
    // a second run with the extras in place changes nothing
    expect(mergeMcpConfig(config, next).changed).toBe(false)
  })

  test('install-mcp records the agent folder in the server entry, and a second run on an older entry adds it', async () => {
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const home = tempHome()
    const old = mcpEntry('/opt/talos-app/apps/bridge', home)
    writeFileSync(join(agent, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': old } }))
    const a = cliIO()
    expect(await runCli(['install-mcp', '--agent-dir', agent], a.io, { TALOS_APP_HOME: home })).toBe(0)
    const cfg = JSON.parse(readFileSync(join(agent, '.mcp.json'), 'utf8'))
    expect(cfg.mcpServers['talos-app'].env.TALOS_AGENT_DIR).toBe(resolve(agent))
    expect(mcpEntry('/b', '/h', '/home/alex/agent').env).toEqual({
      TALOS_APP_HOME: '/h',
      TALOS_AGENT_DIR: '/home/alex/agent',
    })
  })

  test('install-mcp refuses to overwrite an invalid .mcp.json and --dry-run writes nothing', async () => {
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    writeFileSync(join(agent, '.mcp.json'), '{ not json')
    const a = cliIO()
    expect(await runCli(['install-mcp', '--agent-dir', agent], a.io, { TALOS_APP_HOME: tempHome() })).toBe(1)
    expect(readFileSync(join(agent, '.mcp.json'), 'utf8')).toBe('{ not json')
    const fresh = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const b = cliIO()
    expect(await runCli(['install-mcp', '--agent-dir', fresh, '--dry-run'], b.io, { TALOS_APP_HOME: tempHome() })).toBe(
      0,
    )
    expect(existsSync(join(fresh, '.mcp.json'))).toBe(false)
    expect(b.out.join('\n')).toContain('would write')
  })

  // Always a throwaway --bin-dir: without it install.sh writes the wrapper next to bun and overwrites the real talos-app on PATH (W1).
  const sh = (args: string[], env: Record<string, string>) =>
    Bun.spawnSync(
      [
        'bash',
        INSTALL,
        ...(args.includes('--bin-dir') ? [] : ['--bin-dir', mkdtempSync(join(tmpdir(), 'talos-bin-'))]),
        ...args,
      ],
      {
        env: { PATH: process.env.PATH ?? '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

  // 8 `bun run cli.ts` starts + 3 bash in one sync test: 0.8 s idle, 8 s under load; the bridge-wide 30 s budget (package.json test script) covers it
  test('install.sh: --dry-run writes nothing; a real run is idempotent, merges without clobbering, and never touches ~/.claude', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'talos-fakehome-'))
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    const home = join(fakeHome, 'talos-home')
    writeFileSync(
      join(agent, '.mcp.json'),
      JSON.stringify({ mcpServers: { keep: { command: 'keep-me', args: ['1'] } } }, null, 2),
    )
    const base = ['--agent-dir', agent, '--relay-url', 'https://relay.example.com', '--home', home]
    const dry = sh([...base, '--dry-run'], { HOME: fakeHome })
    expect(dry.exitCode, dry.stderr.toString()).toBe(0)
    expect(dry.stdout.toString()).toContain('dry run')
    expect(existsSync(home)).toBe(false)
    expect(JSON.parse(readFileSync(join(agent, '.mcp.json'), 'utf8')).mcpServers['talos-app']).toBeUndefined()

    const run1 = sh([...base, '--config', 'five-threads'], { HOME: fakeHome })
    expect(run1.exitCode, run1.stderr.toString()).toBe(0)
    expect(run1.stdout.toString()).toMatch(/BRIDGE_PUBKEY=[A-Za-z0-9_-]{43}/)
    const mcp1 = readFileSync(join(agent, '.mcp.json'), 'utf8')
    const parsed = JSON.parse(mcp1)
    expect(parsed.mcpServers.keep).toEqual({ command: 'keep-me', args: ['1'] })
    expect(parsed.mcpServers['talos-app'].command).toBe('bun')
    expect(parsed.mcpServers['talos-app'].args.slice(0, 3)).toEqual(['run', '--cwd', resolve(import.meta.dir, '..')])
    expect(parsed.mcpServers['talos-app'].env).toEqual({ TALOS_APP_HOME: home, TALOS_AGENT_DIR: resolve(agent) })
    const key1 = readFileSync(join(home, 'bridge.key'), 'utf8')
    const cfg1 = readFileSync(join(home, 'config.json'), 'utf8')

    const run2 = sh(['--agent-dir', agent, '--home', home], { HOME: fakeHome }) // relay URL already in bridge.env
    expect(run2.exitCode, run2.stderr.toString()).toBe(0)
    expect(readFileSync(join(agent, '.mcp.json'), 'utf8')).toBe(mcp1)
    expect(readFileSync(join(home, 'bridge.key'), 'utf8')).toBe(key1)
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(cfg1)
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false)
    expect(readdirSync(fakeHome).filter((f) => f !== '.bun' && f !== 'Library')).toEqual(['talos-home']) // bun's own cache dir is not ours
  })

  test('install.sh rejects missing or wrong arguments', () => {
    const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
    expect(sh([], { HOME: tmpdir() }).exitCode).toBe(2)
    expect(
      sh(['--agent-dir', join(agent, 'missing'), '--relay-url', 'https://r.example.com'], { HOME: tmpdir() }).exitCode,
    ).toBe(1)
    expect(
      sh(['--agent-dir', agent, '--relay-url', 'https://r.example.com', '--config', 'weird'], { HOME: tmpdir() })
        .exitCode,
    ).toBe(2)
    expect(sh(['--agent-dir', agent], { HOME: tmpdir(), TALOS_APP_HOME: join(tmpdir(), 'nope-talos') }).exitCode).toBe(
      2,
    ) // first install needs --relay-url
    expect(sh(['--bogus'], { HOME: tmpdir() }).exitCode).toBe(2)
  })
})
