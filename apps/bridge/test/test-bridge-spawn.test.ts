// Every test that starts the real bridge (src/server.ts) gets an isolated env, never the owner's real home, inbox, Claude folder or
// Chronos. One place makes that env (testkit bridgeChildEnv): FakeClaude calls it for every command that is the bridge, and a test
// that spawns the bridge by hand must call it too. This file checks the helper, and that no spawn in the repo bypasses it.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { bridgeChildEnv, FakeClaude, isBridgeSpawn } from '@talos-app/testkit'
import { scanSource } from './spawn-scan.ts'

const REPO = resolve(import.meta.dir, '..', '..', '..')
const BRIDGE = ['bun', 'run', join(REPO, 'apps', 'bridge', 'src', 'server.ts')]

const made: Array<() => void> = []
afterEach(() => {
  for (const f of made.splice(0)) f()
})

describe('bridgeChildEnv', () => {
  test('recognises the real bridge command line and nothing else', () => {
    expect(isBridgeSpawn(BRIDGE)).toBe(true)
    expect(isBridgeSpawn(['bun', 'run', '--cwd', 'apps/bridge', '--silent', 'src/server.ts'])).toBe(true)
    expect(isBridgeSpawn(['bun', 'run', 'apps/bridge/src/hub/server.ts'])).toBe(false)
    expect(isBridgeSpawn(['bun', 'run', 'stub-bridge.ts'])).toBe(false)
  })

  test('the real bridge gets a throw-away HOME, inbox, Claude folder and test root, and no Chronos discovery', () => {
    const { env, cleanup } = bridgeChildEnv(
      BRIDGE,
      { TALOS_APP_HOME: '/x/home' },
      { HOME: userInfo().homedir, PATH: '/bin' },
    )
    made.push(cleanup)
    expect(env.HOME).not.toBe(userInfo().homedir)
    expect(env.HOME?.startsWith(env.TALOS_TEST_ROOT as string)).toBe(true)
    for (const k of ['TALOS_INBOX_ROOT', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'])
      expect(env[k]?.startsWith(env.TALOS_TEST_ROOT as string), k).toBe(true)
    expect(env.TALOS_APP_CHRONOS_AUTODISCOVER).toBe('off')
    expect(env.TALOS_APP_HOME).toBe('/x/home') // the caller's own value is kept
    expect(env.PATH).toBe('/bin')
    cleanup()
    expect(existsSync(env.TALOS_TEST_ROOT as string)).toBe(false)
  })

  test('a caller that asks for the real home as HOME is refused', () => {
    expect(() => bridgeChildEnv(BRIDGE, { HOME: userInfo().homedir })).toThrow(/real home/)
  })

  test('a Chronos the caller passes is passed through, never what makes the root: the root is a fresh folder', () => {
    // a shared folder such as tmpdir() or /usr/local/bin must never become the root (and get a userhome/ left in it)
    const shared = tmpdir()
    const { env, cleanup } = bridgeChildEnv(BRIDGE, { TALOS_APP_CHRONOS_BIN: join(shared, 'chronos') })
    made.push(cleanup)
    expect(env.TALOS_APP_CHRONOS_BIN).toBe(join(shared, 'chronos'))
    expect(env.TALOS_TEST_ROOT).not.toBe(shared)
    expect(env.TALOS_TEST_ROOT?.startsWith(join(shared, 'talos-test-bridge-'))).toBe(true)
    expect(existsSync(join(shared, 'userhome'))).toBe(false)
  })

  test('a TALOS_TEST_ROOT the process inherited is never reused; one the caller names is kept and not removed', () => {
    const { env, cleanup } = bridgeChildEnv(BRIDGE, {}, { TALOS_TEST_ROOT: '/usr/local/bin', PATH: '/bin' })
    made.push(cleanup)
    expect(env.TALOS_TEST_ROOT).not.toBe('/usr/local/bin')
    const mine = mkdtempSync(join(tmpdir(), 'talos-spawn-named-root-'))
    made.push(() => rmSync(mine, { recursive: true, force: true }))
    const named = bridgeChildEnv(BRIDGE, { TALOS_TEST_ROOT: mine })
    expect(named.env.TALOS_TEST_ROOT).toBe(mine)
    named.cleanup()
    expect(existsSync(mine)).toBe(true)
  })

  test('a HOME that is a link to the real home is refused too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-spawn-link-'))
    made.push(() => rmSync(dir, { recursive: true, force: true }))
    const link = join(dir, 'home')
    symlinkSync(userInfo().homedir, link)
    expect(() => bridgeChildEnv(BRIDGE, { HOME: link })).toThrow(/real home/)
  })

  test('any other command is not touched: base env plus extra', () => {
    const { env } = bridgeChildEnv(['bun', 'run', 'tool.ts'], { A: '1' }, { HOME: '/real', B: '2' })
    expect(env).toEqual({ HOME: '/real', B: '2', A: '1' })
  })
})

// ---- no spawn bypasses it -------------------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'test-results', 'playwright-report'])
function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* tsFiles(p)
    else if (/\.(ts|mts|tsx)$/.test(name)) yield p
  }
}

/** The places a test or a harness starts processes. */
const ROOTS = [
  'apps/bridge/test',
  'apps/bridge/test-contract',
  'apps/relay/test',
  'apps/web/test',
  'packages',
  'e2e',
  'scripts',
]

describe('the scan: each spawn is judged by its own env', () => {
  const scan = (text: string) => scanSource(text, 'fixture.test.ts', {}).bad

  test('one good spawn in a file does not clear another that passes the whole process env', () => {
    const bad = scan(`
      const a = Bun.spawn(['bun', 'run', 'apps/bridge/src/server.ts'], { env: bridgeChildEnv(['x'], {}).env })
      const b = Bun.spawn(['bun', 'run', 'apps/bridge/src/server.ts'], { env: { ...process.env, TALOS_APP_HOME: home } })
    `)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('fixture.test.ts:3')
  })

  test('a spawn with no env at all inherits everything and is caught, whatever sits near it', () => {
    expect(
      scan("// bridgeChildEnv( is mentioned here\nspawn('bun', ['run', 'src/server.ts'], { cwd: dir })"),
    ).toHaveLength(1)
  })

  test('the CLI is caught too: spawn, spawnSync, fork, execa, Bun.spawnSync and Bun.$', () => {
    const cli = "'bun', 'run', join(DIR, 'apps/bridge/src/cli.ts')"
    for (const call of [
      `spawn(${cli}, { env: { ...process.env } })`,
      `spawnSync(${cli}, { env: process.env })`,
      `fork(join(DIR, 'apps/bridge/src/cli.ts'), [], { env: { ...process.env } })`,
      `execa('bun', ['run', 'apps/bridge/src/cli.ts'], { env: { ...process.env } })`,
      `Bun.spawnSync([${cli}], { env: { HOME: process.env.HOME } })`,
      'await Bun.$`bun run apps/bridge/src/cli.ts init`.env({ ...process.env })',
    ])
      expect(scan(call), call).toHaveLength(1)
  })

  test('an env from bridgeChildEnv passes, directly or through the value it was kept in; any other value does not', () => {
    expect(
      scan(`const child = bridgeChildEnv(argv, {})
        spawn('bun', ['run', 'src/server.ts'], { env: child.env })`),
    ).toEqual([])
    expect(
      scan(`const { env } = bridgeChildEnv(argv, {})
        spawn('bun', ['run', 'src/server.ts'], { env })`),
    ).toEqual([])
    expect(
      scan(`const child = bridgeChildEnv(argv, {})
        spawn('bun', ['run', 'src/server.ts'], { env: other.env })`),
    ).toHaveLength(1)
  })

  test('the env is read from the call’s own arguments, however many lines they take', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `    // line ${i}`).join('\n')
    const bad = scan(`spawn(
      'bun',
      ['run', 'src/server.ts'],
      {
${lines}
        env: { ...process.env },
      },
    )`)
    expect(bad).toHaveLength(1)
  })

  test('a spawn that passes variables built just above is judged as the bridge too', () => {
    expect(
      scan(`const [cmd, cmdArgs] = onPty(['bun', 'run', BRIDGE_CLI, ...args])
        this.child = spawn(cmd, cmdArgs, { cwd: DIR, env: { ...process.env } })`),
    ).toHaveLength(1)
  })

  test('FakeClaude is not a spawn the scan polices (it makes its env itself), and other programs are left alone', () => {
    expect(scan("new FakeClaude({ command: 'bun', args: ['run', 'src/server.ts'], env: {} })")).toEqual([])
    expect(scan("spawn('git', ['status'], { env: { ...process.env } })")).toEqual([])
  })

  // ---- the review's fixtures: a command or an env built in a variable above the call
  test('a command built in a variable above the spawn is the bridge too', () => {
    const bad = scan(`
      const argv = ['bun', 'run', join(DIR, 'src', 'server.ts')]
      const p = Bun.spawn(argv, { env: { ...process.env } })
    `)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('fixture.test.ts:3')
  })

  test('a path kept under another name is followed to where it is declared', () => {
    expect(
      scan(`const ENTRY = join(DIR, 'apps', 'bridge', 'server.ts')
        const run = ['bun', 'run', ENTRY]
        spawn('bun', run, { env: { ...process.env } })`),
    ).toHaveLength(1)
  })

  test('an env spread from a name that holds the process env still copies it', () => {
    expect(
      scan(`const base = process.env
        spawn('bun', ['run', 'src/server.ts'], { env: { ...base, HOME: h } })`),
    ).toHaveLength(1)
    expect(
      scan(`const mid = base
        const base = { ...process.env }
        spawn('bun', ['run', 'src/server.ts'], { env: { ...mid, HOME: h } })`),
    ).toHaveLength(1)
  })

  test('exec with a command string, and a spawner imported under another name, are caught', () => {
    expect(scan("exec('bun run apps/bridge/src/cli.ts init')")).toHaveLength(1)
    expect(scan("execSync('bun run apps/bridge/src/cli.ts init', { env: { ...process.env } })")).toHaveLength(1)
    expect(
      scan(`import { spawn as sp } from 'node:child_process'
        sp('bun', ['run', 'src/server.ts'], { env: { ...process.env } })`),
    ).toHaveLength(1)
    expect(
      scan(`const { spawnSync: run } = require('node:child_process')
        run('bun', ['run', 'src/server.ts'], { env: { ...process.env } })`),
    ).toHaveLength(1)
    expect(scan('const found = /x/.exec(line)')).toEqual([]) // a regex's exec is not a spawn
  })

  test('a HOME key alone proves nothing: its value must be a throw-away folder of the test’s own', () => {
    const spawnWith = (home: string, decl = '') =>
      scan(`${decl}
        spawnSync('bun', ['run', 'apps/bridge/src/cli.ts'], { env: { PATH: p, HOME: ${home} } })`)
    expect(spawnWith("'/Users/example'")).toHaveLength(1)
    expect(spawnWith('realHome', "const realHome = '/Users/example'")).toHaveLength(1)
    expect(spawnWith('process.env.HOME')).toHaveLength(1)
    expect(spawnWith("mkdtempSync(join(tmpdir(), 'x-'))")).toEqual([])
    expect(spawnWith('home', "const home = mkdtempSync(join(tmpdir(), 'x-'))")).toEqual([])
    expect(spawnWith('sb.home', 'const sb = sandbox()')).toEqual([])
    expect(spawnWith('join(root, "home")', "const root = testTempDir('x-')")).toEqual([])
  })

  test('a file listed with a reason is not scanned; the same call elsewhere is', () => {
    const text = "spawnSync('bun', ['run', 'apps/bridge/src/cli.ts'], { env: { ...base, TALOS_APP_HOME: h } })"
    expect(
      scanSource(text, 'x/up.ts', { 'x/up.ts': 'sandbox: real claude runs with the owner HOME on purpose' }).bad,
    ).toEqual([])
    expect(scanSource(text, 'x/other.ts', { 'x/up.ts': 'sandbox' }).bad).toHaveLength(1)
  })
})

describe('no test spawns the real bridge or its CLI without bridgeChildEnv', () => {
  test('FakeClaude, the one spawner most suites use, makes its env through it', () => {
    const src = readFileSync(join(REPO, 'packages/testkit/src/fake-claude.ts'), 'utf8')
    expect(src).toContain('bridgeChildEnv(opts.args')
  })

  test('every spawn of src/server.ts or src/cli.ts in the repo takes its own env from bridgeChildEnv', () => {
    const bad: string[] = []
    let seen = 0
    for (const root of ROOTS) {
      const dir = join(REPO, root)
      if (!existsSync(dir)) continue
      for (const file of tsFiles(dir)) {
        if (file.endsWith('test-bridge-spawn.test.ts') || file.endsWith('spawn-scan.ts')) continue
        // product code in a package's src is not a test: only the testkit's own src is a harness
        if (/^packages\/(?!testkit\/)[^/]+\/src\//.test(relative(REPO, file))) continue
        const r = scanSource(readFileSync(file, 'utf8'), relative(REPO, file))
        seen += r.seen
        bad.push(...r.bad)
      }
    }
    expect(seen).toBeGreaterThan(5) // the scan finds the spawns it is meant to police
    expect(bad, `these start the bridge or its CLI without an env from bridgeChildEnv:\n${bad.join('\n')}`).toEqual([])
  })
})

// a stand-in for something the scan cannot see: a bridge folder that is made, so the file leaves nothing behind
test('the helper leaves no folder when the caller names the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'talos-spawn-named-'))
  made.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'x'))
  writeFileSync(join(root, 'x', 'f'), '')
  const { cleanup } = bridgeChildEnv(BRIDGE, { TALOS_TEST_ROOT: root })
  cleanup()
  expect(existsSync(join(root, 'x', 'f'))).toBe(true)
})

describe('the CLI is a bridge process too', () => {
  const CLI = ['bun', 'run', join(REPO, 'apps', 'bridge', 'src', 'cli.ts'), 'init']
  test('is recognised, gets the same isolation, and is refused the real home', () => {
    expect(isBridgeSpawn(CLI)).toBe(true)
    // only the bridge's own cli.ts: a bare or relative cli.ts could be any program's
    expect(isBridgeSpawn(['bun', 'run', 'src/cli.ts'])).toBe(false)
    expect(isBridgeSpawn(['bun', 'run', 'cli.ts'])).toBe(false)
    expect(isBridgeSpawn(['bun', 'run', '/x/apps/bridge/src/cli.ts'])).toBe(true)
    expect(isBridgeSpawn(['bun', 'run', 'apps/bridge/src/relay/cli.ts'])).toBe(false)
    const { env, cleanup } = bridgeChildEnv(CLI, { TALOS_APP_HOME: '/x' }, { HOME: userInfo().homedir })
    made.push(cleanup)
    expect(env.HOME).not.toBe(userInfo().homedir)
    expect(env.TALOS_APP_CHRONOS_AUTODISCOVER).toBe('off')
    expect(() => bridgeChildEnv(CLI, { HOME: userInfo().homedir })).toThrow(/real home/)
  })
})

describe('what the helper and FakeClaude leave behind', () => {
  const folders = () => readdirSync(tmpdir()).filter((n) => n.startsWith('talos-test-bridge-'))

  test('a refused real HOME removes the folder it had made, before it throws', () => {
    const before = folders()
    expect(() => bridgeChildEnv(BRIDGE, { HOME: userInfo().homedir })).toThrow(/real home/)
    expect(folders()).toEqual(before)
  })

  test('a bridge that never starts leaves no folder: start() rejects and the root is removed', async () => {
    const before = folders()
    const claude = new FakeClaude({ command: 'bun', args: ['run', '/nonexistent/apps/bridge/src/server.ts'], env: {} })
    await expect(claude.start()).rejects.toBeDefined()
    expect(folders()).toEqual(before)
  })

  test('stop() removes the root even when closing the client throws', async () => {
    const before = folders()
    const claude = new FakeClaude({ command: 'bun', args: ['run', '/nonexistent/apps/bridge/src/server.ts'], env: {} })
    expect(folders().length).toBe(before.length + 1) // the root of this one
    ;(claude as unknown as { client: { close: () => Promise<void> } }).client.close = async () => {
      throw new Error('close failed')
    }
    await expect(claude.stop()).rejects.toThrow('close failed')
    expect(folders()).toEqual(before)
  })
})

describe('the vitest suites that spawn a bridge or the CLI start from a scrubbed env', () => {
  test('the contract and relay vitest configs load the setup, and the setup puts PATH back when it is done', () => {
    const setup = 'bridge/test-contract/vitest-setup.ts'
    expect(readFileSync(join(REPO, 'apps/bridge/vitest.contract.config.ts'), 'utf8')).toContain(
      './test-contract/vitest-setup.ts',
    )
    expect(readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')).toContain(`../${setup}`)
    const text = readFileSync(join(REPO, 'apps/bridge/test-contract/vitest-setup.ts'), 'utf8')
    expect(text).toMatch(/const restorePath = installFakeClaude\(\)/)
    expect(text).toContain('afterAll(restorePath)')
  })
})
