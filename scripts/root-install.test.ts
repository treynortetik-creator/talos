// The root ./install.sh, driven with a private PATH: real node, pnpm, bun, git and python3, and stubs for claude, swift,
// xcodebuild and xcode-select that only record that they were called. The Mac app scripts are replaced by stubs too (the
// Swift build cannot run here); TALOS_INSTALL_OS pretends to be macOS for the app paths.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO = resolve(__dirname, '..')
const SCRIPT = join(REPO, 'install.sh')
const DESKTOP_JSON = (sb: { home: string }) => join(sb.home, 'Library', 'Application Support', 'Talos', 'desktop.json')
const MOD = join(REPO, 'plugins', 'talos-app-mod')
const made: string[] = []
afterAll(() => {
  // a plugin release is read-only (dirs without the write bit): make everything writable first, else rmSync fails with ENOTEMPTY
  for (const d of made) {
    spawnSync('chmod', ['-R', 'u+w', d])
    rmSync(d, { recursive: true, force: true })
  }
})

const REAL_TOOLS = [
  'bash', 'env', 'git', 'python3', 'node', 'pnpm', 'bun', 'sh', 'awk', 'sed', 'grep', 'ls', 'tar', 'mkdir', 'cp', 'chmod',
  'cat', 'printf', 'dirname', 'basename', 'tr', 'date', 'mktemp', 'rm', 'head', 'tail', 'uname', 'id', 'find', 'cut',
  'sort', 'wc', 'readlink', 'sleep', 'mv', 'touch', 'diff', 'xargs', 'tee', 'expr', 'test', 'true', 'false', 'ln', 'stat',
  'uniq', 'seq', 'realpath', 'hostname', 'od', 'sha256sum', 'shasum', 'less', 'perl', 'git-upload-pack',
] // biome-ignore format: one tool list

function which(name: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const p = r.stdout.trim()
  return r.status === 0 && p.startsWith('/') ? p : undefined
}

type Sandbox = { home: string; bin: string; log: string; desktop: string; agent: string; root: string }
const flag = (sb: Sandbox, name: string) => join(sb.root, name)

/** A fresh HOME and a PATH folder holding only the tools the installer may use. */
function sandbox(opts: { claude?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'talos-root-install-'))
  made.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const desktop = join(root, 'desktop')
  const log = join(root, 'calls.log')
  for (const d of [home, bin, desktop]) mkdirSync(d)
  writeFileSync(log, '')
  for (const t of REAL_TOOLS) {
    const p = which(t)
    if (p) symlinkSync(p, join(bin, t))
  }
  const stub = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  const record = (name: string) => `echo "${name} $*" >> "${log}"`
  const tools = ['swift', 'xcodebuild', 'xcode-select', ...(opts.claude === false ? [] : ['claude'])]
  for (const t of tools) stub(bin, t, record(t))
  // The running-app probe: osascript answers "is running" from a flag file and records any quit request; lsappinfo gives a path.
  stub(
    bin,
    'osascript',
    `echo "osascript $*" >> "${log}"\ncase "$*" in *quit*) exit 0 ;; esac\n[ -f "${join(root, 'app-running')}" ] && echo true || echo false`,
  )
  stub(
    bin,
    'lsappinfo',
    `[ -f "${join(root, 'app-running')}" ] && echo '"LSBundlePath"="/home/alex/Applications/Talos.app"'; exit 0`,
  )
  // Wrappers that call the real tool, except while a flag file exists: then they fail the way a full disk or a killed copy does.
  const wrap = (name: string, match: string, flagName: string, after: string) => {
    const real = which(name)
    if (!real) return
    rmSync(join(bin, name), { force: true })
    stub(
      bin,
      name,
      `if [ -f "${join(root, flagName)}" ]; then case " $* " in ${match}) ${after} ;; esac; fi\nexec "${real}" "$@"`,
    )
  }
  wrap('git', '*commit*', 'fail-commit', 'echo "fatal: could not write the commit" >&2; exit 1')
  wrap('tar', '*-xf*', 'fail-tar', `"${which('tar')}" "$@"; exit 137`)
  wrap('python3', '*render-default.py*', 'fail-render', 'exit 1')
  stub(desktop, 'build-app.sh', record('build-app.sh'))
  stub(desktop, 'install.sh', record('app-install.sh'))
  return { home, bin, log, desktop, agent: join(home, 'talos-agent'), root }
}

function run(sb: Sandbox, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      PATH: sb.bin,
      HOME: sb.home,
      TALOS_INSTALL_DESKTOP_SCRIPTS: sb.desktop,
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
}

const calls = (sb: Sandbox) => readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean)

/** path + size + mtime of every file outside .git, so "changes nothing" is a comparison, not a claim. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue // git refreshes its own index when verify-install reads the repo
      const p = join(d, name)
      const s = statSync(p)
      if (s.isDirectory()) walk(p)
      else out.push(`${p} ${s.size} ${s.mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

/** Hash of every path, type and file content under dir (including .git), so "byte-identical" is a comparison. */
function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const s = lstatSync(p)
      h.update(`${p}\0${s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : 'f'}\0`)
      if (s.isDirectory()) walk(p)
      else if (s.isSymbolicLink()) h.update(readlinkSync(p))
      else h.update(readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

describe('root install.sh', () => {
  it('a dry run on a fresh home lists every step and changes nothing', () => {
    const sb = sandbox()
    const before = snapshot(sb.home)
    const r = run(sb, ['--dry-run', '--no-app'])
    expect(r.code).toBe(0)
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(r.out).toContain(`${n}/7`)
    expect(r.out).toContain('would: bash kit/install.sh')
    expect(r.out).toContain('install-mcp')
    expect(r.out).toContain(`--plugin-dir ${MOD}`)
    expect(r.out).toContain('skipped (--no-app)')
    expect(existsSync(sb.agent)).toBe(false)
    expect(snapshot(sb.home)).toEqual(before)
    expect(calls(sb)).toEqual([])
  })

  it('a real run builds the agent, registers the MCP server and the mod launch, and passes verify-install', () => {
    const sb = sandbox()
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code, r.out).toBe(0)
    expect(existsSync(join(sb.agent, '.talos-version'))).toBe(true)
    expect(readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8')).not.toContain('talos:placeholder')
    expect(JSON.parse(readFileSync(join(sb.agent, '.mcp.json'), 'utf8')).mcpServers['talos-app']).toBeTruthy()
    const launch = readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8')
    expect(launch).toContain(`--plugin-dir ${MOD}`)
    expect(launch).toContain(sb.agent)
    const v = spawnSync('bash', [join(sb.agent, 'scripts', 'verify-install.sh')], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home },
    })
    expect(v.status, v.stdout).toBe(0)
    // the launch script hands --plugin-dir to claude (the stub records what it was given)
    const start = spawnSync('bash', [join(sb.agent, 'start-talos.sh')], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home },
    })
    expect(start.stdout + start.stderr).toContain(`--plugin-dir ${MOD}`)
    expect(calls(sb).some((c) => c.startsWith('claude') && c.includes(`--plugin-dir ${MOD}`))).toBe(true)
  }, 120_000)

  it('a second run changes nothing and says so', () => {
    const sb = sandbox()
    expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
    const before = snapshot(sb.agent)
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Nothing to change')
    expect(snapshot(sb.agent)).toEqual(before)
  }, 120_000)

  it('refreshing an edited start-talos.sh keeps the old copy as a .bak', () => {
    const sb = sandbox()
    expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
    const launch = join(sb.agent, 'start-talos.sh')
    const edited = `${readFileSync(launch, 'utf8')}export ALEX_EXAMPLE_EDIT=1\n`
    writeFileSync(launch, edited)
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code, r.out).toBe(0)
    const baks = readdirSync(sb.agent).filter((f) => f.startsWith('start-talos.sh.bak-'))
    expect(baks.length).toBe(1)
    expect(readFileSync(join(sb.agent, baks[0] as string), 'utf8')).toBe(edited)
    expect(readFileSync(launch, 'utf8')).not.toContain('ALEX_EXAMPLE_EDIT')
  }, 120_000)

  it('refuses a non-empty folder that is not a Talos agent and leaves it alone', () => {
    const sb = sandbox()
    mkdirSync(sb.agent)
    writeFileSync(join(sb.agent, 'notes.txt'), 'Alex Example keeps notes here\n')
    const before = snapshot(sb.agent)
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a Talos agent')
    expect(snapshot(sb.agent)).toEqual(before)
  })

  it("a folder under Documents is installed with the kit's macOS warning (the Mac app shows its own note)", () => {
    const sb = sandbox()
    const agent = join(sb.home, 'Documents', 'agent')
    mkdirSync(join(sb.home, 'Documents'))
    const r = run(sb, ['--no-app', '--yes', '--agent-dir', agent])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('inside a macOS-protected folder')
    expect(existsSync(join(agent, '.talos-version'))).toBe(true)
  }, 120_000)

  it('never overwrites a tuned CLAUDE.md', () => {
    const sb = sandbox()
    expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
    const tuned = '# Tuned by Alex Example\nKeep replies short.\n'
    writeFileSync(join(sb.agent, 'CLAUDE.md'), tuned)
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8')).toBe(tuned)
  }, 120_000)

  it('--no-app on a Mac never builds or installs the app', () => {
    const sb = sandbox()
    const r = run(sb, ['--no-app', '--yes'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(r.code, r.out).toBe(0)
    expect(calls(sb).filter((c) => /swift|xcodebuild|build-app|app-install/.test(c))).toEqual([])
  }, 120_000)

  it('on a Mac it builds then installs the app, once', () => {
    const sb = sandbox()
    const first = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(first.code, first.out).toBe(0)
    expect(calls(sb).filter((c) => c.includes('build-app') || c.includes('app-install'))).toEqual([
      'build-app.sh --release',
      'app-install.sh --no-open --no-quit',
    ])
    // the stub installer leaves nothing behind, so fake the installed app to check the skip
    mkdirSync(join(sb.home, 'Applications', 'Talos.app'), { recursive: true })
    const second = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(second.code, second.out).toBe(0)
    expect(second.out).toContain('Nothing to change')
    expect(calls(sb).filter((c) => c.includes('build-app'))).toHaveLength(1)
  }, 120_000)

  it('a failing step stops with what failed and what was already done', () => {
    const sb = sandbox()
    writeFileSync(join(sb.desktop, 'build-app.sh'), '#!/bin/sh\necho swift exploded >&2\nexit 7\n')
    const r = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('FAILED at "7/7 Mac app"')
    expect(r.stderr).toContain('Already done')
    expect(r.stderr).toContain('registered the talos-app MCP server')
    expect(existsSync(join(sb.agent, '.mcp.json'))).toBe(true)
  }, 120_000)

  it('missing prerequisites are named with how to get them, change nothing and exit 3', () => {
    const sb = sandbox({ claude: false })
    const r = run(sb, ['--no-app', '--yes'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('claude')
    expect(r.stderr).toContain('https://claude.com/claude-code')
    expect(r.stderr).toContain('Nothing was changed')
    expect(existsSync(sb.agent)).toBe(false)
  })

  it('on a Mac, missing Xcode tools are named only when the app is wanted', () => {
    const sb = sandbox()
    for (const t of ['swift', 'xcode-select']) rmSync(join(sb.bin, t))
    const withApp = run(sb, ['--dry-run'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(withApp.code).toBe(3)
    expect(withApp.stderr).toContain('xcode-select --install')
    const without = run(sb, ['--dry-run', '--no-app'], { TALOS_INSTALL_OS: 'Darwin' })
    expect(without.code).toBe(0)
  })

  it('refuses the app on Linux with a plain message and suggests --no-app', () => {
    const sb = sandbox()
    const r = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Linux' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--no-app')
    expect(existsSync(sb.agent)).toBe(false)
  })

  // ---------------------------------------------------------------- review fixes
  const FLAGS = ['--plugin-dir', MOD, '--dangerously-load-development-channels', 'server:talos-app']
  const mac = { TALOS_INSTALL_OS: 'Darwin' }

  describe('the Mac app launches this agent (desktop.json)', () => {
    const dir = (sb: Sandbox) => join(sb.home, 'Library', 'Application Support', 'Talos')
    const put = (sb: Sandbox, text: string) => {
      mkdirSync(dir(sb), { recursive: true })
      writeFileSync(DESKTOP_JSON(sb), text)
    }
    const backups = (sb: Sandbox) => readdirSync(dir(sb)).filter((n) => n.includes('.bak'))
    const settings = (sb: Sandbox, out: string) => {
      expect(out).toContain('Settings')
      expect(out).toContain(sb.agent)
      expect(out).toContain(`--plugin-dir ${MOD}`)
      expect(out).toContain('--dangerously-load-development-channels server:talos-app')
    }

    it('always passes --no-quit to the desktop installer, running app or not', () => {
      for (const running of [false, true]) {
        const sb = sandbox()
        if (running) writeFileSync(flag(sb, 'app-running'), '')
        const r = run(sb, ['--yes'], mac)
        expect(r.code, r.out).toBe(0)
        expect(calls(sb)).toContain('app-install.sh --no-open --no-quit')
        expect(calls(sb).filter((c) => c.startsWith('osascript') && /quit/.test(c))).toEqual([])
      }
      const dry = run(sandbox(), ['--yes', '--dry-run'], mac)
      expect(dry.out).toContain('--no-quit')
    }, 120_000)

    it('a missing desktop.json is not created: the exact Settings change is printed, with the reason', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(DESKTOP_JSON(sb))).toBe(false)
      expect(existsSync(dir(sb))).toBe(false)
      settings(sb, r.out)
      expect(r.out).toContain('pre-setup')
    }, 120_000)

    it('a running app: nothing is written, the Settings change and the reason are printed', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"~/talos-agent","args":["--model","opus"]}\n'
      put(sb, text)
      writeFileSync(flag(sb, 'app-running'), '')
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
      expect(backups(sb)).toEqual([])
      settings(sb, r.out)
      expect(r.out).toContain('overwrites')
    }, 120_000)

    it('an existing file, app not running: merges, keeps every other key, backs up first, mode 0600, rerun is a no-op', () => {
      const sb = sandbox()
      const old = {
        v: 1,
        agent_dir: '~/talos-agent',
        args: ['--model', 'opus', '--dangerously-load-development-channels', 'server:talos-app'],
        env: { FOO: 'bar' },
        hotkeys: { compose: 'ctrl+opt+space' },
        future_key: { nested: [1, 2] },
      }
      const oldText = `${JSON.stringify(old, null, 2)}\n`
      put(sb, oldText)
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      const cfg = JSON.parse(readFileSync(DESKTOP_JSON(sb), 'utf8'))
      expect(cfg.args).toEqual([...old.args, '--plugin-dir', MOD])
      expect(cfg.env).toEqual({ FOO: 'bar' })
      expect(cfg.future_key).toEqual({ nested: [1, 2] })
      expect(cfg.agent_dir).toBe('~/talos-agent')
      expect(statSync(DESKTOP_JSON(sb)).mode & 0o777).toBe(0o600)
      expect(backups(sb)).toHaveLength(1)
      expect(readFileSync(join(dir(sb), backups(sb)[0] as string), 'utf8')).toBe(oldText)
      mkdirSync(join(sb.home, 'Applications', 'Talos.app'), { recursive: true })
      const again = run(sb, ['--yes'], mac)
      expect(again.code, again.out).toBe(0)
      expect(again.out).toContain('Nothing to change')
      expect(backups(sb)).toHaveLength(1)
    }, 120_000)

    it('fsyncs the temp file before it replaces the real one', () => {
      const text = readFileSync(SCRIPT, 'utf8')
      const fs = text.indexOf('os.fsync')
      const rep = text.indexOf('os.replace')
      expect(fs).toBeGreaterThan(-1)
      expect(rep).toBeGreaterThan(fs)
    })

    it('a symlinked desktop.json: the target is updated and the link stays a link', () => {
      const sb = sandbox()
      mkdirSync(dir(sb), { recursive: true })
      const real = join(sb.root, 'dotfiles', 'desktop.json')
      mkdirSync(join(sb.root, 'dotfiles'))
      writeFileSync(real, '{"v":1,"agent_dir":"~/talos-agent","args":[]}\n')
      symlinkSync(real, DESKTOP_JSON(sb))
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(lstatSync(DESKTOP_JSON(sb)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(DESKTOP_JSON(sb))).toBe(real)
      expect(JSON.parse(readFileSync(real, 'utf8')).args).toEqual(FLAGS)
    }, 120_000)

    it('a dangling symlink counts as missing: nothing is written through it', () => {
      const sb = sandbox()
      mkdirSync(dir(sb), { recursive: true })
      const target = join(sb.root, 'nowhere.json')
      symlinkSync(target, DESKTOP_JSON(sb))
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(target)).toBe(false)
      expect(lstatSync(DESKTOP_JSON(sb)).isSymbolicLink()).toBe(true)
      settings(sb, r.out)
    }, 120_000)

    it('leaves a desktop.json for a different agent folder alone and says what to change in Settings', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"/home/alex/other-agent","args":["--model","opus"]}\n'
      put(sb, text)
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
      expect(r.out).toContain('/home/alex/other-agent')
      settings(sb, r.out)
    }, 120_000)

    it('--no-app leaves desktop.json alone', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"~/talos-agent","args":[]}\n'
      put(sb, text)
      expect(run(sb, ['--no-app', '--yes'], mac).code).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
    }, 120_000)

    const bad: [string, string, string][] = [
      ['not valid JSON', '{ not json', 'not valid JSON'],
      ['a top level that is a list', '[1,2]\n', 'not a JSON object'],
      ['a top level that is a string', '"hello"\n', 'not a JSON object'],
      ['a top level that is null', 'null\n', 'not a JSON object'],
      ['a numeric agent_dir', '{"v":1,"agent_dir":7,"args":[]}\n', 'agent_dir'],
      ['a list agent_dir', '{"v":1,"agent_dir":["x"],"args":[]}\n', 'agent_dir'],
      ['args that is not a list of strings', '{"v":1,"agent_dir":"~/talos-agent","args":[1]}\n', 'args'],
    ]
    for (const [name, text, word] of bad) {
      it(`${name}: left byte-identical, plain message, no traceback`, () => {
        const sb = sandbox()
        put(sb, text)
        const r = run(sb, ['--yes'], mac)
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
        expect(backups(sb)).toEqual([])
        expect(r.out).toContain(word)
        expect(r.out).not.toContain('Traceback')
        settings(sb, r.out)
      }, 120_000)
    }
  })

  describe('a second clone does not hijack an existing agent', () => {
    const point = (sb: Sandbox) => {
      const mcp = join(sb.agent, '.mcp.json')
      const cfg = JSON.parse(readFileSync(mcp, 'utf8'))
      cfg.mcpServers['talos-app'].args[2] = '/home/alex/old-clone/apps/bridge'
      writeFileSync(mcp, `${JSON.stringify(cfg, null, 2)}\n`)
      const st = join(sb.agent, 'start-talos.sh')
      writeFileSync(st, readFileSync(st, 'utf8').split(REPO).join('/home/alex/old-clone'))
    }
    it('refuses without --repoint, names both clones, and changes nothing', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      point(sb)
      const before = snapshot(sb.agent)
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('/home/alex/old-clone')
      expect(r.out).toContain(REPO)
      expect(r.out).toContain('--repoint')
      expect(snapshot(sb.agent)).toEqual(before)
    }, 120_000)

    it('records the clone as a comment line in start-talos.sh', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      expect(readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8').split('\n')).toContain(`# talos-clone: ${REPO}`)
    }, 120_000)

    it('a clone path with a space is told apart from this clone, and the same path is accepted', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const st = join(sb.agent, 'start-talos.sh')
      const orig = readFileSync(st, 'utf8')
      writeFileSync(st, orig.replace(`# talos-clone: ${REPO}`, '# talos-clone: /home/alex/my clones/talos app'))
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('/home/alex/my clones/talos app')
      writeFileSync(st, orig)
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
    }, 120_000)

    it.each([
      ['unparsable .mcp.json', (sb: Sandbox) => writeFileSync(join(sb.agent, '.mcp.json'), '{ hand edited')],
      [
        'a hand-edited .mcp.json with --cwd gone',
        (sb: Sandbox) =>
          writeFileSync(
            join(sb.agent, '.mcp.json'),
            JSON.stringify({ mcpServers: { 'talos-app': { command: 'bun', args: ['run', '--silent', 'start'] } } }),
          ),
      ],
      [
        'a .mcp.json whose talos-app args are not a list',
        (sb: Sandbox) =>
          writeFileSync(join(sb.agent, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { args: 'x' } } })),
      ],
      [
        'a start-talos.sh without the clone line',
        (sb: Sandbox) => {
          const st = join(sb.agent, 'start-talos.sh')
          writeFileSync(st, readFileSync(st, 'utf8').replace(/^# talos-clone:.*\n/m, ''))
        },
      ],
      [
        'an unreadable start-talos.sh',
        (sb: Sandbox) => {
          const st = join(sb.agent, 'start-talos.sh')
          rmSync(st)
          mkdirSync(st) // a folder where the file should be: cannot be read as a file
        },
      ],
    ])(
      'fails closed on %s: refused without --repoint, nothing changed',
      (_n, edit) => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
        edit(sb)
        const before = treeHash(sb.agent)
        const r = run(sb, ['--no-app', '--yes'])
        expect(r.code, r.out).toBe(1)
        expect(r.out).toContain('--repoint')
        expect(treeHash(sb.agent)).toBe(before)
      },
      120_000,
    )

    it('--repoint moves both files to this clone', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      point(sb)
      const r = run(sb, ['--no-app', '--yes', '--repoint'])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8')).toContain(REPO)
      expect(readFileSync(join(sb.agent, '.mcp.json'), 'utf8')).toContain(join(REPO, 'apps', 'bridge'))
    }, 120_000)
  })

  describe('reruns', () => {
    it('a failed first commit says what was done, and the rerun finishes the commit', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-commit'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('first commit')
      expect(r.stderr).toContain('git init')
      expect(existsSync(join(sb.agent, '.git'))).toBe(true)
      rmSync(flag(sb, 'fail-commit'))
      const again = run(sb, ['--no-app', '--yes'])
      expect(again.code, again.out).toBe(0)
      const head = spawnSync('git', ['-C', sb.agent, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
      expect(head.status, head.stderr).toBe(0)
    }, 120_000)

    it('a killed kit copy stops with the move-aside message, and a rerun is refused with the folder byte-identical', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-tar'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(
        `The kit copy stopped part-way. ${sb.agent} now holds a partial copy. Move it aside (for example: mv ${sb.agent} ${sb.agent}.partial) and run ./install.sh again.`,
      )
      expect(existsSync(join(sb.agent, '.talos-version'))).toBe(false)
      expect(readdirSync(sb.agent).length).toBeGreaterThan(0)
      expect(readdirSync(sb.home).filter((n) => n.includes('partial'))).toEqual([]) // no marker file next to the folder
      rmSync(flag(sb, 'fail-tar'))
      const before = treeHash(sb.agent)
      const again = run(sb, ['--no-app', '--yes'])
      expect(again.code).toBe(1)
      expect(again.out).toContain('not a Talos agent')
      expect(treeHash(sb.agent)).toBe(before)
      // the owner follows the message and it works
      renameSync(sb.agent, `${sb.agent}.partial`)
      const fresh = run(sb, ['--no-app', '--yes'])
      expect(fresh.code, fresh.out).toBe(0)
    }, 120_000)

    it("a kit that refuses before copying never makes the owner's later files deletable", () => {
      const sb = sandbox()
      const agent = join(sb.home, 'Dropbox', 'agent')
      mkdirSync(agent, { recursive: true })
      const first = run(sb, ['--no-app', '--yes', '--agent-dir', agent])
      expect(first.code).toBe(1)
      expect(first.out).toContain('cloud-synced')
      expect(first.out).not.toContain('part-way')
      // the owner starts using the folder: files whose names match the kit's, plus a git history
      writeFileSync(join(agent, 'CLAUDE.md'), '# Alex Example keeps this\n')
      mkdirSync(join(agent, 'memory'))
      writeFileSync(join(agent, 'memory', 'notes.md'), 'Alex Example: fictional note\n')
      const g = (...a: string[]) =>
        spawnSync('git', ['-C', agent, '-c', 'user.name=A', '-c', 'user.email=a@example.com', ...a], {
          encoding: 'utf8',
        })
      g('init', '-q')
      g('add', '.')
      expect(g('commit', '-qm', 'mine').status).toBe(0)
      const before = treeHash(agent)
      const again = run(sb, ['--no-app', '--yes', '--agent-dir', agent])
      expect(again.code).toBe(1)
      expect(treeHash(agent)).toBe(before)
      expect(readFileSync(join(agent, 'memory', 'notes.md'), 'utf8')).toBe('Alex Example: fictional note\n')
    }, 120_000)

    it('a non-empty folder with no .talos-version is refused even if it looks like the kit', () => {
      const sb = sandbox()
      mkdirSync(join(sb.agent, 'hooks'), { recursive: true })
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('not a Talos agent')
    })

    it('the installer source has no marker file and no rm of anything', () => {
      const src = readFileSync(SCRIPT, 'utf8')
      expect(src).not.toMatch(/talos-install-partial/)
      expect(src).not.toMatch(/rm -rf|-exec rm|\brm\b[^\n]*(AGENT_DIR|PARTIAL)/)
    })
  })

  describe('verify-install', () => {
    it('is a warning on an agent that existed before this run', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      writeFileSync(join(sb.agent, 'CLAUDE.md'), '# mine\nyou are the tutor\n')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('WARNING')
      expect(r.out).toContain('verify-install')
    }, 120_000)

    it('stays a hard gate on a fresh install', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-render'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('verify-install')
    }, 120_000)
  })

  describe('the running app is never quit', () => {
    it('with Talos running, builds and installs with --no-quit and says the update applies at the next start', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'app-running'), '')
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(calls(sb)).toContain('app-install.sh --no-open --no-quit')
      expect(calls(sb).filter((c) => c.startsWith('osascript') && /quit/.test(c))).toEqual([])
      expect(r.out).toContain('next app start')
      expect(r.out).toContain('/home/alex/Applications/Talos.app')
    }, 120_000)

    it('with Talos not running, nothing is said about a running app', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('next app start')
    }, 120_000)
  })

  describe('smaller fixes', () => {
    it('no --yes and no TTY: refuses and says to use --yes, changing nothing', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app'])
      expect(r.code).toBe(2)
      expect(r.out).toContain('--yes')
      expect(existsSync(sb.agent)).toBe(false)
    })

    it('a dry run needs no --yes', () => {
      expect(run(sandbox(), ['--no-app', '--dry-run']).code).toBe(0)
    })

    it('the closing hints carry the flags and quote a clone path with spaces', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.out).not.toMatch(/cd .* && claude\s*\)/)
      const upd = r.out.split('\n').find((l) => l.includes('Update:')) as string
      expect(upd).toContain(REPO.includes(' ') ? `'` : REPO)
    }, 120_000)

    it('a failing mktemp is reported, not ignored', () => {
      const sb = sandbox()
      rmSync(join(sb.bin, 'mktemp'))
      writeFileSync(join(sb.bin, 'mktemp'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(sb.bin, 'mktemp'), 0o755)
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('FAILED')
    }, 120_000)
  })
  describe('kit flags, the bridge step and Chronos on an existing agent (SETUP.md promises these)', () => {
    const STUB_CHRONOS = join(REPO, 'kit', 'scripts', 'fixtures', 'fake-chronos')
    const stubTalosApp = (sb: Sandbox) => {
      writeFileSync(join(sb.bin, 'talos-app'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(sb.bin, 'talos-app'), 0o755)
    }

    it('every flag the kit docs quote is accepted, not "unknown option" (exit 2)', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      const r = run(sb, [
        '--dry-run',
        '--no-app',
        '--no-chronos',
        '--with-vault',
        vault,
        '--with-memory-search',
        '--embed-model',
        'small',
        '--with-reranker',
        '--with-voice',
        '--with-qwen-voice',
        '--with-parakeet',
        '--with-diarize',
        '--global-pointer',
        '--allow-synced-folder',
        '--allow-protected-folder',
      ])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('unknown option')
      expect(r.out).toContain(`--with-vault ${join(realpathSync(sb.home), 'private-agent-vault')}`)
      expect(r.out).toContain('--with-memory-search --embed-model small')
      expect(existsSync(vault)).toBe(false)
    })

    it('the exact line from the task: --dry-run --with-vault <new folder> --no-chronos exits 0 and changes nothing', () => {
      const sb = sandbox()
      const before = snapshot(sb.home)
      const r = run(sb, ['--dry-run', '--with-vault', join(sb.home, 'x'), '--no-chronos'])
      expect(r.code, r.out).toBe(0)
      expect(snapshot(sb.home)).toEqual(before)
    })

    it('a flag the kit does not have is still refused (exit 2)', () => {
      expect(run(sandbox(), ['--dry-run', '--with-teleportation']).code).toBe(2)
    })

    it('a Chronos-only flag without --with-chronos is refused loudly, never silently dropped', () => {
      const sb = sandbox()
      for (const flag of [['--notify', 'talos'], ['--no-jobs'], ['--no-load'], ['--chronos-path', STUB_CHRONOS]]) {
        const r = run(sb, ['--dry-run', '--no-app', ...flag])
        expect(r.code, flag.join(' ')).toBe(2)
        expect(r.out).toContain('--with-chronos')
      }
      expect(run(sb, ['--dry-run', '--no-app', '--with-chronos', '--no-chronos']).code).toBe(2)
    })

    it('a flag that needs a value says so instead of eating the next flag', () => {
      const r = run(sandbox(), ['--dry-run', '--no-app', '--with-vault'])
      expect(r.code).toBe(2)
      expect(r.out).toContain('--with-vault needs a value')
    })

    it('--with-vault reaches the kit: a real run creates the vault next to the agent', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      const r = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(vault, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(sb.agent, '.talos-version'))).toBe(true)
    }, 120_000)

    it('--with-chronos on an agent that already exists adds Chronos and the jobs, and leaves the agent alone', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const tuned = '# Tuned by Alex Example\nKeep replies short.\n'
      writeFileSync(join(sb.agent, 'CLAUDE.md'), tuned)
      const cfg = join(sb.home, '.config', 'chronos', 'config.json')
      expect(existsSync(cfg)).toBe(false)
      const r = run(sb, ['--no-app', '--yes', '--with-chronos', '--chronos-path', STUB_CHRONOS, '--no-load'])
      expect(r.code, r.out).toBe(0)
      expect(JSON.parse(readFileSync(cfg, 'utf8')).workspace).toBe(sb.agent)
      const jobs = JSON.parse(readFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), 'utf8')) as {
        id: string
        enabled?: boolean
      }[]
      expect(jobs.filter((j) => j.id.startsWith('talos-')).length).toBeGreaterThan(0)
      expect(jobs.every((j) => !j.enabled)).toBe(true)
      expect(readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8')).toBe(tuned)
      // the old behaviour was exit 0 with Chronos silently not installed: say it ran
      expect(r.out).toContain('added to the existing agent')
    }, 180_000)

    it('--notify talos is reachable from the root installer and records where talos-app lives', () => {
      const sb = sandbox()
      stubTalosApp(sb)
      const r = run(sb, [
        '--no-app',
        '--yes',
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--no-load',
        '--notify',
        'talos',
      ])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(sb.home, '.config', 'talos', 'talos-app-bin'), 'utf8').trim()).toBe(
        join(sb.bin, 'talos-app'),
      )
      const cfg = JSON.parse(readFileSync(join(sb.home, '.config', 'chronos', 'config.json'), 'utf8'))
      expect(cfg.notify).toBe(join(sb.home, '.config', 'talos', 'notify', 'talos.sh'))
    }, 180_000)

    it('--relay-url runs the bridge step: key, bridge.env and the BRIDGE_PUBKEY line for Railway', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes', '--relay-url', 'https://relay.example.test'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('BRIDGE_PUBKEY=')
      const env = readFileSync(join(sb.home, '.config', 'talos', 'app', 'bridge.env'), 'utf8')
      expect(env).toContain('TALOS_APP_RELAY_URL=https://relay.example.test')
      // a second run with the same url keeps the key (init keeps what exists) and still succeeds
      const again = run(sb, ['--no-app', '--yes', '--relay-url', 'https://relay.example.test'])
      expect(again.code, again.out).toBe(0)
    }, 180_000)

    it('without --relay-url it prints the exact bridge command for this agent folder, and writes no bridge settings', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(
        `apps/bridge/scripts/install.sh --agent-dir ${sb.agent} --relay-url https://<your relay host>`,
      )
      expect(existsSync(join(sb.home, '.config', 'talos', 'app', 'bridge.env'))).toBe(false)
    }, 120_000)

    it('refuses a relay url that is not a bare https origin, before changing anything', () => {
      const sb = sandbox()
      for (const bad of [
        'http://relay.example.test',
        'https://relay.example.test/app',
        'relay.example.test',
        'http://localhost:8080',
        'https://relay.example.test?x=1',
        'https://relay.example.test/?x=1',
        'https://relay.example.test#frag',
        'https://user:pw@example.com',
        'https://relay.example.test;x',
        'https://relay.example.test/a/',
        'https://relay example.test',
      ]) {
        const r = run(sb, ['--no-app', '--yes', '--relay-url', bad])
        expect(r.code, bad).toBe(2)
        expect(r.out).toContain('--relay-url')
      }
      expect(existsSync(sb.agent)).toBe(false)
    })

    it('the closing hints no longer run two lines together, and name start-talos.sh as the way to start', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Darwin' })
      expect(r.code, r.out).toBe(0)
      const lines = r.out.split('\n')
      expect(lines.filter((l) => l.includes('Mac app:')).length).toBe(1)
      expect(lines.filter((l) => l.includes('First run:')).length).toBe(1)
      expect(lines.some((l) => l.includes('Mac app:') && l.includes('First run:'))).toBe(false)
      expect(lines.some((l) => l.includes('Start:') && l.includes('start-talos.sh'))).toBe(true)
    }, 120_000)
  })
  describe('review fixes on the setup path', () => {
    const STUB_CHRONOS = join(REPO, 'kit', 'scripts', 'fixtures', 'fake-chronos')
    const cleanClone = () => {
      for (const d of ['vault', 'vault2']) rmSync(join(REPO, d), { recursive: true, force: true })
    }

    it('1. a vault inside the clone is refused, relative or absolute, and nothing is created there', () => {
      try {
        for (const v of ['vault', './vault', join(REPO, 'vault2'), REPO]) {
          const sb = sandbox()
          const r = run(sb, ['--dry-run', '--no-app', '--with-vault', v])
          expect(r.code, v).toBe(2)
          expect(r.out, v).toContain('inside this clone')
          expect(existsSync(join(REPO, 'vault')), v).toBe(false)
          expect(existsSync(join(REPO, 'vault2')), v).toBe(false)
        }
      } finally {
        cleanClone()
      }
    })

    it('1. a relative vault is resolved against where you run it, so a folder next to the clone still works', () => {
      const sb = sandbox()
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', join(sb.home, 'v')])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`--with-vault ${join(realpathSync(sb.home), 'v')}`)
    })

    it('2. a dry run on an existing agent runs the kit dry run, so its refusals fail it (bad --notify)', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const r = run(sb, [
        '--dry-run',
        '--no-app',
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--notify',
        'slack',
      ])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('--notify must be')
      expect(existsSync(join(sb.home, '.config', 'chronos'))).toBe(false)
    }, 180_000)

    it('2. a dry run on an existing agent fails on a foreign non-empty vault', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const vault = join(sb.home, 'notes')
      mkdirSync(vault)
      writeFileSync(join(vault, 'mine.txt'), 'Alex Example keeps notes here\n')
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', vault])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('is not empty')
    }, 180_000)

    it('3. the same flags again, plus --with-chronos, succeed: the vault the kit made is recognised, not refused', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      expect(run(sb, ['--no-app', '--yes', '--with-vault', vault]).code).toBe(0)
      writeFileSync(join(vault, 'my-note.md'), 'a note that must survive\n')
      const again = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(again.code, again.out).toBe(0)
      const cfg = join(sb.home, '.config', 'chronos', 'config.json')
      const r = run(sb, [
        '--no-app',
        '--yes',
        '--with-vault',
        vault,
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--no-load',
      ])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(cfg)).toBe(true)
      expect(readFileSync(join(vault, 'my-note.md'), 'utf8')).toBe('a note that must survive\n')
    }, 240_000)

    it('3. a foreign non-empty folder is still refused as a vault', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'foreign')
      mkdirSync(vault)
      writeFileSync(join(vault, 'x.txt'), 'x')
      const r = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('is not empty')
    }, 120_000)

    it('4. a flag that needs a value refuses the next flag as that value', () => {
      for (const flags of [
        ['--with-vault', '--dry-run'],
        ['--agent-dir', '--yes'],
        ['--relay-url', '--yes'],
        ['--with-chronos', '--notify', '--no-app'],
      ]) {
        const r = run(sandbox(), ['--dry-run', ...flags])
        expect(r.code, flags.join(' ')).toBe(2)
        expect(r.out, flags.join(' ')).toContain('needs a value')
      }
    })

    it('5. a bare https origin is accepted, with or without one trailing slash', () => {
      for (const ok of [
        'https://relay.example.test',
        'https://relay.example.test/',
        'https://relay.example.test:8443',
      ]) {
        const r = run(sandbox(), ['--no-app', '--dry-run', '--relay-url', ok])
        expect(r.code, `${ok}: ${r.out}`).toBe(0)
      }
    })

    it('9. an old ~/my-agent and no ~/talos-agent: stops and asks instead of creating a second agent', () => {
      const sb = sandbox()
      const old = join(sb.home, 'my-agent')
      mkdirSync(old)
      writeFileSync(join(old, '.talos-version'), 'version=1.0.0\n')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('my-agent')
      expect(r.out).toContain('--agent-dir')
      expect(existsSync(sb.agent)).toBe(false)
      // choosing on purpose goes ahead as before
      expect(run(sb, ['--no-app', '--dry-run', '--agent-dir', old]).code).toBe(0)
    })
  })
  describe('round-2 review fixes', () => {
    it('R2-2. a dry run with an agent folder whose parent does not exist yet succeeds and creates nothing', () => {
      const sb = sandbox()
      const agent = join(sb.home, 'a', 'b', 'agent')
      const r = run(sb, ['--dry-run', '--no-app', '--agent-dir', agent])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(sb.home, 'a'))).toBe(false)
      // a real run is not told the parent is fine by that: it creates it (the root installer always did) and succeeds
      const real = run(sb, ['--yes', '--no-app', '--agent-dir', agent])
      expect(real.code, real.out).toBe(0)
    }, 120_000)

    it('R2-3. a vault under the clone is refused when its letters differ only in case (case-insensitive volumes)', () => {
      const swapped = (p: string) =>
        p.replace(/[A-Za-z]+$/, (m) =>
          [...m].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join(''),
        )
      const alt = swapped(REPO)
      if (alt === REPO || !existsSync(alt)) return // a case-sensitive volume: the two paths are different folders
      const r = run(sandbox(), ['--dry-run', '--no-app', '--with-vault', join(alt, 'zz-vault')])
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('inside this clone')
    })

    it('R2-5. a vault inside any git work tree that has a remote is refused, GitLab or self-hosted too', () => {
      const sb = sandbox()
      const repo = join(sb.home, 'work')
      mkdirSync(repo)
      spawnSync('git', ['init', '-q'], { cwd: repo })
      spawnSync('git', ['remote', 'add', 'origin', 'https://git.example.com/alex/notes.git'], { cwd: repo })
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', join(repo, 'vault')])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('has a remote')
    })

    it('R2-8. a relay host with an empty label (.., a leading or trailing dot) is refused', () => {
      for (const bad of [
        'https://a..example.com',
        'https://.example.com',
        'https://example.com.',
        'https://a.-b.example.com',
        'https://-a.example.com',
      ]) {
        const r = run(sandbox(), ['--no-app', '--dry-run', '--relay-url', bad])
        expect(r.code, bad).toBe(2)
        expect(r.out, bad).toContain('--relay-url')
      }
      expect(run(sandbox(), ['--no-app', '--dry-run', '--relay-url', 'https://my-relay.up.railway.app']).code).toBe(0)
    })
  })
})
