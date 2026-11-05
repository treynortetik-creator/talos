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
import { join, resolve } from 'node:path'
import { tempHome } from './helpers.ts'

const INSTALL = resolve(import.meta.dir, '..', 'scripts', 'install.sh')
const BRIDGE_DIR = resolve(import.meta.dir, '..')

/** A bun stand-in that execs the real bun, in a folder of our choosing (the wrapper goes next to bun). */
function fakeBunDir(writable = true) {
  const dir = tempHome('talos-bunbin-')
  writeFileSync(join(dir, 'bun'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
  chmodSync(join(dir, 'bun'), 0o755)
  if (!writable) chmodSync(dir, 0o555)
  return dir
}

function install(opts: { home: string; path: string; args?: string[]; dryRun?: boolean; script?: string }) {
  const agent = tempHome('talos-agent-')
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
      ...(opts.args ?? []),
    ],
    { env: { PATH: opts.path, HOME: opts.home, SHELL: '/bin/zsh' }, stdout: 'pipe', stderr: 'pipe' },
  )
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), agent }
}

describe('install.sh wrapper', () => {
  test('writes an executable talos-app next to bun when that folder is on PATH, and it runs', () => {
    const bin = fakeBunDir()
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    const w = join(bin, 'talos-app')
    expect(existsSync(w)).toBe(true)
    expect(statSync(w).mode & 0o111).not.toBe(0)
    expect(readFileSync(w, 'utf8')).toContain(join(BRIDGE_DIR, 'src', 'cli.ts'))
    expect(r.out).toContain(`put a talos-app command at ${w}`)
    expect(r.out).toContain(`checked: ${w} runs`)
    expect(r.out).not.toContain('alias') // no alias instruction any more
    // run it the way a new terminal would: a clean environment that only knows the PATH
    const run = Bun.spawnSync(['talos-app', 'help'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      stdout: 'pipe',
    })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toContain('start [--agent-dir <dir>]')
  })

  test('a folder that is not on PATH: installs there and prints the exact line to add, plus the shell profile', () => {
    const bin = fakeBunDir(false) // not writable, so the choice falls to ~/.local/bin, which is not on PATH
    const home = tempHome()
    const r = install({ home, path: `${bin}:/usr/bin:/bin` })
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

  test('the .mcp.json entry the Mac app reads (#118) is unchanged: bun run --cwd <bridge> --silent start', () => {
    const bin = fakeBunDir()
    const r = install({ home: tempHome(), path: `${bin}:/usr/bin:/bin` })
    const mcp = JSON.parse(readFileSync(join(r.agent, '.mcp.json'), 'utf8')) as {
      mcpServers: { 'talos-app': { command: string; args: string[] } }
    }
    expect(mcp.mcpServers['talos-app'].command).toBe('bun')
    expect(mcp.mcpServers['talos-app'].args).toEqual(['run', '--cwd', BRIDGE_DIR, '--silent', 'start'])
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
  })

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
    expect(r.out).toContain('bun run')
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
    expect(r.out).toContain('bun run') // the next steps name a command that exists
    // ... and that command reads THIS install's home, not the default one
    expect(r.out).toContain(`TALOS_APP_HOME='${join(second, 'app')}' bun run`)
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
})
