// D54: install.sh puts a REAL `talos-app` command on PATH (a wrapper script), not an alias that dies with the terminal.
// Runs the real script with a throwaway HOME and --bin-dir/PATH, so nothing on the developer's machine is touched.
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tempHome, writeKit } from './helpers.ts'

const INSTALL = resolve(import.meta.dir, '..', 'scripts', 'install.sh')
const BRIDGE_DIR = resolve(import.meta.dir, '..')

/** A bun stand-in that execs the real bun, in a folder of our choosing (the wrapper goes next to bun). */
function fakeBunDir(writable = true, version?: string) {
  const dir = tempHome('talos-bunbin-')
  // with a version: `bun --version` says that one, and everything else runs on the real bun
  const say = version ? `[ "$1" = --version ] && { echo ${version}; exit 0; }\n` : ''
  writeFileSync(join(dir, 'bun'), `#!/bin/sh\n${say}exec ${process.execPath} "$@"\n`)
  chmodSync(join(dir, 'bun'), 0o755)
  if (!writable) chmodSync(dir, 0o555)
  return dir
}

/**
 * Runs the real script. Most tests aim the wrapper at the first PATH folder with --bin-dir (so nothing else is touched);
 * `autoPick` leaves the choice to the script, which is what the default-folder tests are about.
 * `fakeUid` puts a stub `id` first on PATH that answers `id -u` with that number (a second macOS user, without one).
 */
function install(opts: {
  home: string
  path: string
  args?: string[]
  dryRun?: boolean
  script?: string
  autoPick?: boolean
  fakeUid?: number
  /** the agent folder already has the Talos kit (the root ./install.sh put it there) */
  kit?: boolean
}) {
  const agent = tempHome('talos-agent-')
  if (opts.kit) writeKit(agent)
  const args = opts.args ?? []
  const pinned = opts.autoPick || args.includes('--bin-dir') ? [] : ['--bin-dir', opts.path.split(':')[0] as string]
  const extraEnv = opts.fakeUid === undefined ? {} : { TALOS_APP_TEST_ID: join(idStub(opts.fakeUid), 'id') }
  const r = Bun.spawnSync(
    [
      'bash',
      opts.script ?? INSTALL,
      '--agent-dir',
      agent,
      '--relay-url',
      'https://relay.example.com',
      '--home',
      join(opts.home, 'app'),
      ...(opts.dryRun ? ['--dry-run'] : []),
      ...pinned,
      ...args,
    ],
    { env: { PATH: opts.path, HOME: opts.home, SHELL: '/bin/zsh', ...extraEnv }, stdout: 'pipe', stderr: 'pipe' },
  )
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), agent }
}

/**
 * A folder holding an `id` that says `id -u` is <uid> and passes everything else to the real id. The wrapper calls
 * /usr/bin/id by absolute path (a user's PATH must not decide who they are); tests point it at this stub through
 * TALOS_APP_TEST_ID, which only tests set.
 */
function idStub(uid: number): string {
  const dir = tempHome('talos-idstub-')
  const real = Bun.which('id') ?? '/usr/bin/id'
  writeFileSync(join(dir, 'id'), `#!/bin/sh\n[ "$1" = -u ] && { echo ${uid}; exit 0; }\nexec ${real} "$@"\n`)
  chmodSync(join(dir, 'id'), 0o755)
  return dir
}

const REAL_UID = Number(new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim())

/** Runs a wrapper the way a terminal of another user would: its HOME, a stub id, a PATH that only knows these folders. */
function runAs(
  wrapper: string,
  uid: number,
  home: string,
  args: string[] = ['help'],
  extraPath = '',
  extraEnv: Record<string, string> = {},
) {
  const r = Bun.spawnSync([wrapper, ...args], {
    env: { PATH: `${extraPath}/usr/bin:/bin`, HOME: home, TALOS_APP_TEST_ID: join(idStub(uid), 'id'), ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('install.sh wrapper', () => {
  test('writes an executable talos-app in ~/.local/bin when that is on PATH, and it runs', () => {
    const bin = fakeBunDir()
    const home = tempHome()
    const dir = join(home, '.local', 'bin')
    mkdirSync(dir, { recursive: true })
    const path = `${dir}:${bin}:/usr/bin:/bin`
    const r = install({ home, path, autoPick: true })
    expect(r.code).toBe(0)
    const w = join(dir, 'talos-app')
    expect(existsSync(w)).toBe(true)
    expect(statSync(w).mode & 0o111).not.toBe(0)
    expect(readFileSync(w, 'utf8')).toContain(join(BRIDGE_DIR, 'src', 'cli.ts'))
    expect(r.out).toContain(`put a talos-app command at ${w}`)
    expect(r.out).toContain(`checked: ${w} runs`)
    expect(r.out).not.toContain('alias') // no alias instruction any more
    // run it the way a new terminal would: a clean environment that only knows the PATH
    const run = Bun.spawnSync(['talos-app', 'help'], { env: { PATH: path, HOME: home }, stdout: 'pipe' })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toContain('start [--agent-dir <dir>]')
  })

  test('a folder that is not on PATH: installs in ~/.local/bin and prints the exact line to add, plus the shell profile', () => {
    const bin = fakeBunDir(false) // not writable, and outside HOME either way
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, autoPick: true })
    chmodSync(bin, 0o755)
    expect(r.code).toBe(0)
    expect(existsSync(join(home, '.local', 'bin', 'talos-app'))).toBe(true)
    expect(r.out).toContain(`${join(home, '.local', 'bin')} is not on your PATH`)
    expect(r.out).toContain(`echo 'export PATH="${join(home, '.local', 'bin')}:$PATH"' >> ${join(home, '.zshrc')}`)
  })

  test('never replaces a talos-app it did not write', () => {
    const bin = fakeBunDir()
    writeFileSync(join(bin, 'talos-app'), '#!/bin/sh\necho mine\n')
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toContain('echo mine')
    expect(r.out).toContain('NOT installed')
    expect(r.out).toContain('left alone')
  })

  test('running it again rewrites its own wrapper (idempotent)', () => {
    const bin = fakeBunDir()
    const home = tempHome()
    expect(install({ home, path: `${bin}:/usr/bin:/bin` }).code).toBe(0)
    const first = readFileSync(join(bin, 'talos-app'), 'utf8')
    const r = install({ home, path: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(first)
  })

  test('--dry-run writes nothing and names the folder; --bin-dir picks it', () => {
    const bin = fakeBunDir()
    const other = tempHome('talos-other-')
    const home = tempHome()
    const dry = install({ home, path: `${bin}:/usr/bin:/bin`, dryRun: true })
    expect(dry.code).toBe(0)
    expect(dry.out).toContain(`would put a talos-app command in ${bin}/talos-app`)
    expect(existsSync(join(bin, 'talos-app'))).toBe(false)
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, args: ['--bin-dir', other] })
    expect(r.code).toBe(0)
    expect(existsSync(join(other, 'talos-app'))).toBe(true)
    expect(r.out).toContain(`${other} is not on your PATH`)
  })

  test('the .mcp.json entry the Mac app reads (#118): an absolute bun, then run --cwd <bridge> --silent start', () => {
    const bin = fakeBunDir()
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` })
    const mcp = JSON.parse(readFileSync(join(r.agent, '.mcp.json'), 'utf8')) as {
      mcpServers: { 'talos-app': { command: string; args: string[] } }
    }
    expect(isAbsolute(mcp.mcpServers['talos-app'].command)).toBe(true)
    expect(mcp.mcpServers['talos-app'].args).toEqual(['run', '--cwd', BRIDGE_DIR, '--silent', 'src/server.ts'])
  })

  test("the wrapper does not load the current folder's .env into the CLI or into the claude that `start` launches", () => {
    const bin = fakeBunDir()
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    // a stand-in claude that records its environment
    const claudeDir = tempHome('talos-claude-')
    const envOut = join(claudeDir, 'env.txt')
    writeFileSync(join(claudeDir, 'claude'), `#!/bin/sh\nenv > ${envOut}\n`)
    chmodSync(join(claudeDir, 'claude'), 0o755)
    // the agent folder has a .env, as a real one does (keys for its own tools)
    writeFileSync(join(r.agent, '.env'), 'ANTHROPIC_API_KEY=sk-test-should-not-leak\nSECRET_X=hunter2\n')
    writeKit(r.agent) // start refuses a folder without the kit
    const run = Bun.spawnSync(['talos-app', 'start', '--agent-dir', r.agent], {
      cwd: r.agent,
      env: { PATH: `${bin}:${claudeDir}:/usr/bin:/bin`, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).toBe(0)
    const seen = readFileSync(envOut, 'utf8')
    expect(seen).toContain('TALOS_APP_BRIDGE=1') // the real start path ran
    expect(seen).not.toContain('ANTHROPIC_API_KEY')
    expect(seen).not.toContain('SECRET_X')
  })

  test('--home is pinned in the wrapper: a new terminal reads the same folder the .mcp.json entry uses', () => {
    const bin = fakeBunDir()
    const home = tempHome()
    const custom = join(tempHome('talos-customhome-'), 'my app home')
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, args: ['--home', custom] })
    expect(r.code).toBe(0)
    const run = Bun.spawnSync(['talos-app', 'status', '--json'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // status reads <home>/status.json and the key under <home>; the key id exists only in the custom folder
    const out = run.stdout.toString() + run.stderr.toString()
    expect(out).not.toContain('run talos-app init')
    expect(out).not.toContain('no relay URL')
    const text = Bun.spawnSync(['talos-app', 'status'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const t = text.stdout.toString()
    expect(t).not.toContain('run talos-app init')
    expect(t).toMatch(/bridge key id: [0-9a-f]{8,}/)
    // an explicit TALOS_APP_HOME in the environment still wins
    const other = Bun.spawnSync(['talos-app', 'status'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TALOS_APP_HOME: join(home, 'elsewhere') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(other.stdout.toString()).toContain('run talos-app init')
    // the real install.sh, then `talos-app status` three times, each its own bun start: 13 s on Titan (WSL), past the 5 s
    // default; it waits as long as the four runs take
  }, 60_000)

  test('a folder name with an apostrophe still gives a working wrapper', () => {
    const base = tempHome("talos-o'brien-")
    const bin = join(base, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    chmodSync(join(bin, 'bun'), 0o755)
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    expect(r.err).not.toContain('did not run')
    expect(r.out).toContain(`checked: ${join(bin, 'talos-app')} runs`)
    const run = Bun.spawnSync([join(bin, 'talos-app'), 'help'], {
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdout: 'pipe',
    })
    expect(run.exitCode).toBe(0)
  })

  test('the Next steps start a folder without the Talos kit with --no-kit, and a kit folder without it', () => {
    const bin = fakeBunDir()
    const plain = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` })
    expect(plain.code).toBe(0)
    expect(plain.out).toContain(`start --agent-dir ${plain.agent} --no-kit -- <your existing claude flags>`)
    const kit = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin`, kit: true })
    expect(kit.code).toBe(0)
    expect(kit.out).toContain(`start --agent-dir ${kit.agent} -- <your existing claude flags>`)
  })

  test('an unwritable --bin-dir does not abort: the rest of the install and the Next steps still print', () => {
    const bin = fakeBunDir()
    const ro = tempHome('talos-ro-')
    chmodSync(ro, 0o555)
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin`, args: ['--bin-dir', ro] })
    chmodSync(ro, 0o755)
    expect(r.code).toBe(0)
    expect(r.out).toContain('NOT installed: could not write')
    expect(r.out).toContain('Next:')
    expect(r.out).toContain('BRIDGE_PUBKEY')
    // with no wrapper, the steps name a command that exists
    expect(r.out).toContain('bun --no-env-file run')
    expect(r.err).not.toContain('Permission denied')
  })

  test('a --bin-dir with a trailing slash that is on PATH counts as on PATH', () => {
    const bin = fakeBunDir()
    const other = tempHome('talos-slash-')
    const r = install({ home: tempHome(), path: `${bin}:${other}:/usr/bin:/bin`, args: ['--bin-dir', `${other}/`] })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('is not on your PATH')
    // and the reverse: PATH holds the slash, the flag does not
    const r2 = install({ home: tempHome(), path: `${bin}:${other}/:/usr/bin:/bin`, args: ['--bin-dir', other] })
    expect(r2.out).not.toContain('is not on your PATH')
  })

  // W1: a wrapper that already points at another TALOS_APP_HOME is somebody's real command; a test or a second checkout
  // must not repoint it silently.
  test('an existing wrapper naming a different TALOS_APP_HOME is left alone with a warning; --replace-wrapper replaces it', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const first = tempHome()
    expect(install({ home: first, path }).code).toBe(0)
    const before = readFileSync(join(bin, 'talos-app'), 'utf8')
    // first install used the default-style home <first>/app, pinned because it differs from $HOME/.config/talos/app
    expect(before).toContain(join(first, 'app'))
    const second = tempHome()
    const r = install({ home: second, path })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(before)
    expect(r.err).toContain('already points at a different TALOS_APP_HOME')
    expect(r.out).toContain('--replace-wrapper')
    expect(r.out).toContain('bun --no-env-file run') // the next steps name a command that exists
    // ... and that command reads THIS install's home, not the default one
    expect(r.out).toContain(`TALOS_APP_HOME='${join(second, 'app')}' bun --no-env-file run`)
    const forced = install({ home: second, path, args: ['--replace-wrapper'] })
    expect(forced.code).toBe(0)
    const after = readFileSync(join(bin, 'talos-app'), 'utf8')
    expect(after).not.toBe(before)
    expect(after).toContain(join(second, 'app'))
  })

  test('a wrapper pinned to a home with an apostrophe is recognised as the same home on a re-run', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const home = tempHome("talos-o'neil-")
    expect(install({ home, path }).code).toBe(0)
    const before = readFileSync(join(bin, 'talos-app'), 'utf8')
    const r = install({ home, path })
    expect(r.err).not.toContain('different TALOS_APP_HOME')
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(before)
  })

  // A second checkout (another path) with the SAME home must not repoint the command either.
  test('a second checkout with the same home is left alone while the first still exists; a deleted first one is replaced', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const home = tempHome()
    expect(install({ home, path }).code).toBe(0)
    const before = readFileSync(join(bin, 'talos-app'), 'utf8')
    const clone = tempHome('talos-clone-')
    mkdirSync(join(clone, 'scripts'))
    copyFileSync(INSTALL, join(clone, 'scripts', 'install.sh'))
    for (const n of ['src', 'node_modules', 'package.json']) symlinkSync(join(BRIDGE_DIR, n), join(clone, n))
    const r = install({ home, path, script: join(clone, 'scripts', 'install.sh') })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(before)
    expect(r.err).toContain('different checkout')
    expect(r.out).toContain('--replace-wrapper')
    // the checkout the wrapper names is gone: a broken command is worth replacing
    const gone = tempHome('talos-gone-')
    mkdirSync(join(gone, 'scripts'))
    copyFileSync(INSTALL, join(gone, 'scripts', 'install.sh'))
    for (const n of ['src', 'node_modules', 'package.json']) symlinkSync(join(BRIDGE_DIR, n), join(gone, n))
    expect(install({ home, path, script: join(gone, 'scripts', 'install.sh') }).code).toBe(0) // keeps (real checkout exists)
    const stale = before.replace(BRIDGE_DIR, join(gone, 'deleted-checkout'))
    writeFileSync(join(bin, 'talos-app'), stale)
    const fixed = install({ home, path })
    expect(fixed.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(before)
  })

  // A run with a fake HOME and no --home: the default home of THAT HOME is not the real account's default.
  test('a wrapper that pins no home is not mistaken for a fake HOME default', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const fake = tempHome()
    expect(install({ home: fake, path }).code).toBe(0)
    const w = join(bin, 'talos-app')
    // an unpinned wrapper means "the account's real ~/.config/talos/app"
    writeFileSync(
      w,
      readFileSync(w, 'utf8')
        .replace(/^\[ -n .*TALOS_APP_HOME=.*\n/m, '')
        .replace(/^export TALOS_APP_HOME\n/m, ''),
    )
    const agent = tempHome('talos-agent-')
    const r = Bun.spawnSync(
      ['bash', INSTALL, '--agent-dir', agent, '--relay-url', 'https://relay.example.com', '--bin-dir', bin],
      {
        env: { PATH: path, HOME: fake, SHELL: '/bin/zsh' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(r.exitCode).toBe(0)
    expect(r.stderr.toString()).toContain('already points at a different TALOS_APP_HOME')
  })

  test('an older Bun is refused before anything is written, with how to upgrade', () => {
    const bin = fakeBunDir(true, '1.3.11')
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, args: ['--bin-dir', bin] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('Bun 1.3.11 is older than 1.4.4, the oldest Talos supports.')
    expect(r.err).toContain('macOS or Linux (or a WSL distro you set up yourself): bun upgrade')
    expect(existsSync(join(home, 'app'))).toBe(false)
    expect(existsSync(join(r.agent, '.mcp.json'))).toBe(false)
    expect(existsSync(join(bin, 'talos-app'))).toBe(false)
  })
})

// Two macOS users on one Mac, each with their own Talos: a machine-wide folder (Homebrew's /opt/homebrew/bin) must never
// hold the one `talos-app` both of them type.
describe('install.sh wrapper: one wrapper per user', () => {
  test('the default never writes next to a bun that lives outside $HOME (a machine-wide folder)', () => {
    const bin = fakeBunDir() // stands in for /opt/homebrew/bin: on PATH, writable, not inside HOME
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    expect(existsSync(join(bin, 'talos-app'))).toBe(false)
    expect(existsSync(join(home, '.local', 'bin', 'talos-app'))).toBe(true)
    expect(r.out).toContain(`${join(home, '.local', 'bin')} is not on your PATH`)
  })

  test("bun's own folder is used when it is inside $HOME and on PATH", () => {
    const home = tempHome()
    const mine = join(home, 'tools', 'bin')
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'bun'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    chmodSync(join(mine, 'bun'), 0o755)
    const r = install({ home, path: `${mine}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    expect(existsSync(join(mine, 'talos-app'))).toBe(true)
    expect(existsSync(join(home, '.local', 'bin', 'talos-app'))).toBe(false)
  })

  test('a bun folder only shares HOME as a name prefix is not inside HOME', () => {
    const base = tempHome()
    const home = join(base, 'alex')
    const sibling = join(base, 'alex2', 'bin') // "<home>2/bin" starts with the text of HOME but is another folder
    mkdirSync(home, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'bun'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
    chmodSync(join(sibling, 'bun'), 0o755)
    const r = install({ home, path: `${sibling}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    expect(existsSync(join(sibling, 'talos-app'))).toBe(false)
    expect(existsSync(join(home, '.local', 'bin', 'talos-app'))).toBe(true)
  })

  test('--dry-run with the default writes nothing, not even ~/.local/bin, and names the per-user folder', () => {
    const bin = fakeBunDir()
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin`, autoPick: true, dryRun: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`would put a talos-app command in ${join(home, '.local', 'bin')}/talos-app`)
    expect(existsSync(join(home, '.local'))).toBe(false)
    expect(existsSync(join(bin, 'talos-app'))).toBe(false)
  })

  test('the wrapper records the installing user id', () => {
    const bin = fakeBunDir()
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin`, fakeUid: 777 })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toContain('TALOS_APP_OWNER_UID=777')
  })

  test('run by another user with no wrapper of their own: it does not run this clone, says so, exits non-zero', () => {
    const bin = fakeBunDir()
    const owner = tempHome()
    expect(install({ home: owner, path: `${bin}:/usr/bin:/bin` }).code).toBe(0)
    const other = tempHome('talos-otheruser-')
    const r = runAs(join(bin, 'talos-app'), REAL_UID + 1, other)
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('start [--agent-dir <dir>]') // the CLI did not run
    expect(r.err).toContain("belongs to another user's Talos")
    expect(r.err).toContain('install.sh')
    expect(r.err.trim().split('\n').length).toBe(1) // one plain line
    expect(existsSync(join(other, '.config'))).toBe(false) // nothing was created in their home either
  })

  test("run by another user: it hands over to that user's own wrapper in ~/.local/bin (and ~/.bun/bin), paths with spaces and quotes", () => {
    const bin = fakeBunDir()
    expect(install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` }).code).toBe(0)
    for (const sub of ['.local', '.bun']) {
      const other = tempHome(`talos-o'brien ${sub} `)
      const dir = join(other, sub, 'bin')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'talos-app'),
        '#!/bin/sh\n# talos-app-wrapper (written by apps/bridge/scripts/install.sh)\necho "second user: $*"\n',
      )
      chmodSync(join(dir, 'talos-app'), 0o755)
      const r = runAs(join(bin, 'talos-app'), REAL_UID + 1, other, ['status', 'a b'])
      expect(r.err).toBe('')
      expect(r.out.trim()).toBe('second user: status a b')
      expect(r.code).toBe(0)
    }
  })

  test("another user's ~/.local/bin/talos-app that this script did not write is never run", () => {
    const bin = fakeBunDir()
    expect(install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` }).code).toBe(0)
    const other = tempHome('talos-otheruser-')
    mkdirSync(join(other, '.local', 'bin'), { recursive: true })
    writeFileSync(join(other, '.local', 'bin', 'talos-app'), '#!/bin/sh\necho foreign-ran\n')
    chmodSync(join(other, '.local', 'bin', 'talos-app'), 0o755)
    const r = runAs(join(bin, 'talos-app'), REAL_UID + 1, other)
    expect(r.out).not.toContain('foreign-ran')
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("belongs to another user's Talos")
  })

  test('the same file found as "their" wrapper is not exec-ed (a wrapper in ~/.local/bin run by a user id that is not its owner)', () => {
    // two accounts that share one HOME (or a symlink): the wrapper would exec itself forever
    const home = tempHome()
    const dir = join(home, '.local', 'bin')
    const bun = fakeBunDir()
    mkdirSync(dir, { recursive: true })
    expect(install({ home, path: `${dir}:${bun}:/usr/bin:/bin`, autoPick: true }).code).toBe(0)
    const r = runAs(join(dir, 'talos-app'), REAL_UID + 1, home)
    expect(r.code).not.toBe(0) // returned at all: no loop (the spawn has a 20 s limit)
    expect(r.err).toContain("belongs to another user's Talos")
  })

  test('two wrappers in one home, both pinned to another user, do not exec each other round and round', () => {
    const bun = fakeBunDir()
    const home = tempHome('talos-usery-')
    const dirA = join(home, '.local', 'bin')
    const dirB = join(home, '.bun', 'bin')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    // both pinned to user 7001 (stale copies of someone else's wrapper); user 7002 types either one
    for (const d of [dirA, dirB])
      expect(install({ home, path: `${d}:${bun}:/usr/bin:/bin`, autoPick: true, fakeUid: 7001 }).code).toBe(0)
    for (const d of [dirA, dirB]) {
      const r = runAs(join(d, 'talos-app'), 7002, home) // A hands to B, B would hand back to A: the hop mark stops it
      expect(r.code).not.toBe(0)
      expect(r.err).toContain("belongs to another user's Talos")
    }
  })

  test('the owner still runs their own wrapper (the pin does not lock the owner out)', () => {
    const bin = fakeBunDir()
    expect(install({ home: tempHome(), path: `${bin}:/usr/bin:/bin`, fakeUid: 4242 }).code).toBe(0)
    const r = runAs(join(bin, 'talos-app'), 4242, tempHome(), ['help'], `${bin}:`)
    expect(r.code).toBe(0)
    expect(r.out).toContain('start [--agent-dir <dir>]')
  })

  test('an existing wrapper pinned to another user is left alone with a warning, even when its home matches', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const home = tempHome()
    expect(install({ home, path, fakeUid: 7001 }).code).toBe(0)
    const before = readFileSync(join(bin, 'talos-app'), 'utf8')
    const r = install({ home, path, fakeUid: 7002 })
    expect(r.code).toBe(0)
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toBe(before)
    expect(r.err).toContain("another user's")
    expect(r.out).toContain('--replace-wrapper')
    const forced = install({ home, path, fakeUid: 7002, args: ['--replace-wrapper'] })
    expect(readFileSync(join(bin, 'talos-app'), 'utf8')).toContain('TALOS_APP_OWNER_UID=7002')
    expect(forced.code).toBe(0)
  })

  test('an older wrapper of ours with no user pin is rewritten with the pin when it is the target and the same install', () => {
    const bin = fakeBunDir()
    const path = `${bin}:/usr/bin:/bin`
    const home = tempHome()
    expect(install({ home, path }).code).toBe(0)
    const w = join(bin, 'talos-app')
    writeFileSync(w, readFileSync(w, 'utf8').replace(/^TALOS_APP_OWNER_UID=[\s\S]*?^unset TALOS_APP_HOP\n/m, ''))
    expect(readFileSync(w, 'utf8')).not.toContain('OWNER_UID')
    expect(install({ home, path }).code).toBe(0)
    expect(readFileSync(w, 'utf8')).toContain(`TALOS_APP_OWNER_UID=${REAL_UID}`)
  })

  test('a talos-app earlier on PATH shadows the new one: said plainly with the fix, and that file is left untouched', () => {
    const bun = fakeBunDir()
    const home = tempHome()
    const mine = join(home, '.local', 'bin')
    mkdirSync(mine, { recursive: true })
    const wide = tempHome('talos-machinewide-')
    const oldWrapper = '#!/bin/sh\n# talos-app-wrapper (written by apps/bridge/scripts/install.sh)\necho old\n'
    writeFileSync(join(wide, 'talos-app'), oldWrapper)
    chmodSync(join(wide, 'talos-app'), 0o555) // read-only, so the repair of older wrappers leaves it as it is
    const r = install({ home, path: `${wide}:${mine}:${bun}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`put a talos-app command at ${join(mine, 'talos-app')}`)
    expect(r.out).toContain(`a new terminal will run ${join(wide, 'talos-app')}`)
    expect(r.out).toContain('not the one just written')
    expect(r.out).toContain('older install') // it is one of ours from before
    expect(r.out).toContain(`export PATH="${mine}:$PATH"`) // the fix
    expect(r.out).toContain('--bin-dir')
    expect(readFileSync(join(wide, 'talos-app'), 'utf8')).toBe(oldWrapper)
  })

  test('a shadowing talos-app that is not ours is named too (and not called an older install)', () => {
    const bun = fakeBunDir()
    const home = tempHome()
    const wide = tempHome('talos-machinewide-')
    writeFileSync(join(wide, 'talos-app'), '#!/bin/sh\necho mine\n')
    chmodSync(join(wide, 'talos-app'), 0o755)
    const r = install({ home, path: `${wide}:${bun}:/usr/bin:/bin`, autoPick: true })
    expect(r.out).toContain(`a new terminal will run ${join(wide, 'talos-app')}`)
    expect(r.out).not.toContain('older install')
    expect(readFileSync(join(wide, 'talos-app'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  test('no shadow note when the first talos-app on PATH is the file just written', () => {
    const bin = fakeBunDir()
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` })
    expect(r.out).not.toContain('a new terminal will run')
  })
})

describe('install.sh wrapper: repairs, hop mark, absolute id, quoting', () => {
  /** An older wrapper of ours: the same text without the user pin, as written before this change. */
  function oldWrapperIn(dir: string, home: string, bun: string): string {
    expect(install({ home, path: `${bun}:/usr/bin:/bin`, args: ['--bin-dir', dir] }).code).toBe(0)
    const w = join(dir, 'talos-app')
    const text = readFileSync(w, 'utf8')
    const start = text.indexOf('TALOS_APP_OWNER_UID=')
    const end = text.indexOf('unset TALOS_APP_HOP\n') + 'unset TALOS_APP_HOP\n'.length
    expect(start).toBeGreaterThan(0)
    writeFileSync(w, text.slice(0, start) + text.slice(end))
    chmodSync(w, 0o755)
    return readFileSync(w, 'utf8')
  }

  test('an older unpinned wrapper of ours in a machine-wide folder on PATH is pinned in place when this user owns it', () => {
    const bun = fakeBunDir()
    const wide = tempHome('talos-machinewide-')
    const home = tempHome()
    const old = oldWrapperIn(wide, home, bun)
    expect(old).not.toContain('OWNER_UID')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    const r = install({ home, path: `${join(home, '.local', 'bin')}:${wide}:${bun}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    const now = readFileSync(join(wide, 'talos-app'), 'utf8')
    expect(now).toContain(`TALOS_APP_OWNER_UID=${REAL_UID}`)
    // BUN, home pin and cli target are exactly as they were: only the pin block was added
    for (const line of old.split('\n')) expect(now).toContain(line)
    expect(now.replace(/TALOS_APP_OWNER_UID=[\s\S]*?unset TALOS_APP_HOP\n/, '')).toBe(old)
    expect(r.out).toContain(`pinned ${join(wide, 'talos-app')} to your user id`)
    // the reported state: another user typing it no longer runs this clone
    const other = tempHome('talos-otheruser-')
    const run = runAs(join(wide, 'talos-app'), REAL_UID + 1, other)
    expect(run.code).not.toBe(0)
    expect(run.err).toContain("belongs to another user's Talos")
    expect(run.out).not.toContain('start [--agent-dir <dir>]')
  })

  test('the repair leaves alone: a file that is not ours, a read-only one, one already pinned, one inside $HOME', () => {
    const bun = fakeBunDir()
    const home = tempHome()
    const dirs = ['foreign', 'readonly', 'pinned'].map((n) => tempHome(`talos-${n}-`))
    const foreign = '#!/bin/sh\necho mine\n'
    writeFileSync(join(dirs[0] as string, 'talos-app'), foreign)
    const ro = oldWrapperIn(dirs[1] as string, home, bun)
    chmodSync(join(dirs[1] as string, 'talos-app'), 0o444)
    chmodSync(dirs[1] as string, 0o555)
    expect(
      install({ home, path: `${bun}:/usr/bin:/bin`, args: ['--bin-dir', dirs[2] as string], fakeUid: 7001 }).code,
    ).toBe(0)
    const pinned = readFileSync(join(dirs[2] as string, 'talos-app'), 'utf8')
    const inside = join(home, 'elsewhere')
    mkdirSync(inside, { recursive: true })
    const insideOld = oldWrapperIn(inside, home, bun)
    const path = `${dirs.join(':')}:${inside}:${bun}:/usr/bin:/bin`
    const r = install({ home, path, autoPick: true })
    chmodSync(dirs[1] as string, 0o755)
    expect(r.code).toBe(0)
    expect(readFileSync(join(dirs[0] as string, 'talos-app'), 'utf8')).toBe(foreign)
    expect(readFileSync(join(dirs[1] as string, 'talos-app'), 'utf8')).toBe(ro)
    expect(readFileSync(join(dirs[2] as string, 'talos-app'), 'utf8')).toBe(pinned)
    expect(readFileSync(join(inside, 'talos-app'), 'utf8')).toBe(insideOld)
    expect(r.out).not.toContain('pinned ')
  })

  test('--dry-run reports the repair and writes nothing', () => {
    const bun = fakeBunDir()
    const wide = tempHome('talos-machinewide-')
    const home = tempHome()
    const old = oldWrapperIn(wide, home, bun)
    const r = install({ home, path: `${wide}:${bun}:/usr/bin:/bin`, autoPick: true, dryRun: true })
    expect(r.code).toBe(0)
    expect(readFileSync(join(wide, 'talos-app'), 'utf8')).toBe(old)
    expect(r.out).toContain(`would pin ${join(wide, 'talos-app')} to your user id`)
  })

  test('the hop mark does not leak: the owner side clears it, so a nested call that hops again works', () => {
    const bun = fakeBunDir()
    const homeA = tempHome('talos-usera-')
    const homeB = tempHome('talos-userb-')
    const dirA = join(homeA, '.local', 'bin')
    const dirB = join(homeB, '.local', 'bin')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    // A's wrapper is pinned to user 7001, B's own wrapper to user 7002 (the one typing)
    expect(install({ home: homeA, path: `${dirA}:${bun}:/usr/bin:/bin`, autoPick: true, fakeUid: 7001 }).code).toBe(0)
    const instB = install({ home: homeB, path: `${dirB}:${bun}:/usr/bin:/bin`, autoPick: true, fakeUid: 7002 })
    expect(instB.code).toBe(0)
    // a stand-in claude, launched by B's `start`, that records its environment and calls A's wrapper again
    const claudeDir = tempHome('talos-claude-')
    const rec = join(claudeDir, 'rec')
    writeFileSync(
      join(claudeDir, 'claude'),
      `#!/bin/sh\nenv > ${rec}.env\n'${join(dirA, 'talos-app')}' help > ${rec}.out 2> ${rec}.err\necho $? > ${rec}.code\n`,
    )
    chmodSync(join(claudeDir, 'claude'), 0o755)
    const agent = writeKit(instB.agent) // start refuses a folder without the kit
    const r = runAs(join(dirA, 'talos-app'), 7002, homeB, ['start', '--agent-dir', agent], `${bun}:${claudeDir}:`)
    expect(`${r.code} ${r.err} ${r.out}`).toMatch(/^0 /)
    expect(readFileSync(`${rec}.env`, 'utf8')).not.toContain('TALOS_APP_HOP')
    expect(readFileSync(`${rec}.code`, 'utf8').trim()).toBe('0')
    expect(readFileSync(`${rec}.out`, 'utf8')).toContain('start [--agent-dir <dir>]')
    expect(readFileSync(`${rec}.err`, 'utf8')).toBe('')
  }, 60_000)

  test('the wrapper asks /usr/bin/id, not whatever `id` a PATH holds, who is running it', () => {
    const bin = fakeBunDir()
    expect(install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` }).code).toBe(0)
    const text = readFileSync(join(bin, 'talos-app'), 'utf8')
    expect(text).toContain('/usr/bin/id')
    // a user-writable PATH with an `id` that lies must not make a stranger the owner
    const liar = tempHome('talos-liar-')
    writeFileSync(join(liar, 'id'), `#!/bin/sh\necho ${REAL_UID}\n`)
    chmodSync(join(liar, 'id'), 0o755)
    const r = Bun.spawnSync([join(bin, 'talos-app'), 'help'], {
      env: { PATH: `${liar}:/usr/bin:/bin`, HOME: tempHome(), TALOS_APP_TEST_ID: join(idStub(REAL_UID + 1), 'id') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0) // the test override says "someone else"; the liar on PATH was ignored
    const direct = Bun.spawnSync([join(bin, 'talos-app'), 'help'], {
      env: { PATH: `${liar}:${bin}:/usr/bin:/bin`, HOME: tempHome() },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(direct.exitCode).toBe(0) // real id is the real owner
  })

  test('the PATH line and the --bin-dir fix are quoted for a folder with spaces, quotes and $', () => {
    const bun = fakeBunDir()
    const wide = tempHome("talos-it's $odd dir-")
    writeFileSync(join(wide, 'talos-app'), '#!/bin/sh\necho mine\n')
    chmodSync(join(wide, 'talos-app'), 0o755)
    const home = tempHome("talos-o'brien home-")
    const r = install({ home, path: `${wide}:${bun}:/usr/bin:/bin`, autoPick: true })
    expect(r.code).toBe(0)
    const dir = join(home, '.local', 'bin')
    // the printed profile line must run as shell: write it to a profile and read it back through sh
    const m = r.out.match(/^ {2}(echo .*)$/m)
    expect(m).not.toBeNull()
    const prof = join(tempHome('talos-prof-'), 'profile')
    const sh = Bun.spawnSync(['sh', '-c', (m as RegExpMatchArray)[1]?.replace(/>> .*$/, `>> '${prof}'`) as string])
    expect(sh.exitCode).toBe(0)
    const probe = Bun.spawnSync(['sh', '-c', `. '${prof}'; printf %s "$PATH"`], { env: { PATH: '/usr/bin:/bin' } })
    expect(probe.stdout.toString().startsWith(`${dir}:`)).toBe(true)
    // --bin-dir <the shadowing folder> is printed in a form sh reads back as that one folder
    const fix = r.out.match(/--bin-dir (.*?) to write there/)
    expect(fix).not.toBeNull()
    const back = Bun.spawnSync(['sh', '-c', `printf %s ${(fix as RegExpMatchArray)[1]}`])
    expect(back.stdout.toString()).toBe(wide)
  })
})
