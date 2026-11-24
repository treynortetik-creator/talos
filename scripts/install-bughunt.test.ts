// The installers' bug-hunt findings of 2026-11-10 (docs/audits/2026-11-10-bughunt-triage.md, package P-C1): ./install.sh and
// kit/install.sh. Each test states the correct behaviour.
// Same sandbox as root-install.test.ts: a temp HOME, a private PATH of real tools plus stubs, TALOS_INSTALL_OS=Darwin.
// mac-list: it drives the installers as a Mac (TALOS_INSTALL_OS=Darwin), so CI's Macs run it too.
// gate-reads: install.sh kit/* scripts/*
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { recordPnpmInstall } from './root-install-harness.ts'

const REPO = resolve(__dirname, '..')
const ROOT_INSTALL = join(REPO, 'install.sh')
const KIT = join(REPO, 'kit')
const made: string[] = []
afterAll(() => {
  for (const d of made) {
    spawnSync('chmod', ['-R', 'u+w', d]) // a plugin release is read-only
    rmSync(d, { recursive: true, force: true })
  }
})

const REAL_TOOLS = [
  'bash', 'env', 'git', 'python3', 'node', 'pnpm', 'bun', 'sh', 'awk', 'sed', 'grep', 'ls', 'tar', 'mkdir', 'cp', 'chmod',
  'cat', 'printf', 'dirname', 'basename', 'tr', 'date', 'mktemp', 'rm', 'head', 'tail', 'uname', 'id', 'find', 'cut',
  'sort', 'wc', 'readlink', 'sleep', 'mv', 'touch', 'diff', 'xargs', 'tee', 'expr', 'test', 'true', 'false', 'ln', 'stat',
  'uniq', 'seq', 'realpath', 'hostname', 'od', 'sha256sum', 'shasum', 'perl', 'rmdir', 'cksum', 'cmp',
] // biome-ignore format: one tool list

function which(name: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const p = r.stdout.trim()
  return r.status === 0 && p.startsWith('/') ? p : undefined
}

type Sandbox = { root: string; home: string; bin: string; log: string; agent: string }

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'talos-bughunt-install-'))
  made.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const log = join(root, 'calls.log')
  for (const d of [home, bin]) mkdirSync(d)
  writeFileSync(log, '')
  for (const t of REAL_TOOLS) {
    const p = which(t)
    if (p) symlinkSync(p, join(bin, t))
  }
  // the pre-flight asks claude its version (not recorded: it reads)
  stub(
    bin,
    'claude',
    `case "$1" in --version) echo "2.1.330 (Claude Code)"; exit 0 ;; esac\necho "claude $*" >> "${log}"`,
  )
  recordPnpmInstall(bin, log) // never a real install into the shared checkout (root-install-harness.ts says why)
  return { root, home, bin, log, agent: join(home, 'talos-agent') }
}

function stub(dir: string, name: string, body: string) {
  rmSync(join(dir, name), { force: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function sh(sb: Sandbox, argv: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO,
    input: opts.input ?? '',
    env: {
      PATH: sb.bin,
      HOME: sb.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      TALOS_INSTALL_OS: 'Darwin',
      TALOS_INSTALL_MEMSEARCH_DEFAULT: 'off', // a new agent's search downloads a venv and a model: not in tests
      TALOS_FORCE_ARCH: 'arm64',
      ...opts.env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
}
// This sandbox's PATH has no plutil, which Chronos's installer needs on a Mac (it died with 127 there), and the tests here are about
// other things: Chronos is off unless a test names it, as in root-install-harness.ts. /usr/bin stays off this PATH on purpose.
const rootInstall = (sb: Sandbox, args: string[], opts: { cwd?: string } = {}) =>
  sh(
    sb,
    [
      'bash',
      ROOT_INSTALL,
      ...args,
      ...(args.some((a) => a === '--with-chronos' || a === '--no-chronos') ? [] : ['--no-chronos']),
    ],
    opts,
  )

describe('installers: the 2026-11-10 bug hunt (P-C1)', () => {
  // FINDING C2 (install.sh:357). start-talos.sh ran `bun run …/cli.ts start`: bun loads the .env of the folder it is started from,
  // so the agent folder's secrets reached claude, though docs/SETUP.md says talos-app never loads that .env. Every launcher
  // the installers write for `talos-app start` keeps it out.
  it('C2: start-talos.sh and the PATH wrapper start talos-app without loading a .env', () => {
    const sb = sandbox()
    const r = rootInstall(sb, ['--no-app', '--yes'])
    expect(r.code, r.out).toBe(0)
    const launch = readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8')
    expect(launch).toMatch(/^exec bun --no-env-file run /m)
    const wrapper = readFileSync(join(REPO, 'apps', 'bridge', 'scripts', 'install.sh'), 'utf8')
      .split('\n')
      .find((l) => l.includes('exec') && l.includes('run $(shq "$BRIDGE_DIR/src/cli.ts")'))
    expect(wrapper).toContain('--no-env-file')
    // bun itself: with the flag, a .env beside it is not read
    writeFileSync(join(sb.root, '.env'), 'TALOS_LEAK_PROBE=from-dotenv\n')
    const probe = spawnSync(
      which('bun') as string,
      ['--no-env-file', '-e', 'console.log(process.env.TALOS_LEAK_PROBE ?? "unset")'],
      { cwd: sb.root, encoding: 'utf8', env: { PATH: sb.bin, HOME: sb.home } },
    )
    expect(probe.stdout.trim()).toBe('unset')
  })

  // FINDING 1 (install.sh:179 + kit/install.sh:303-313). kit/install.sh stamps .talos-version BEFORE it renders the default
  // CLAUDE.md, and a failed render is only a WARNING there. The root installer then fails its verify gate and says "Fix the
  // problem and run ./install.sh again". On that re-run .talos-version makes the folder "already a Talos agent": the kit step is
  // skipped, verify-install is demoted to warnings, and the run exits 0 with CLAUDE.md still the shipped placeholder.
  it('F1: a re-run after a failed fresh install does not report success over a placeholder CLAUDE.md', () => {
    const sb = sandbox()
    const realPy = which('python3') as string
    const failFlag = join(sb.root, 'fail-render')
    stub(
      sb.bin,
      'python3',
      `if [ -f "${failFlag}" ]; then case " $* " in *render-default.py*) exit 1 ;; esac; fi\nexec "${realPy}" "$@"`,
    )
    writeFileSync(failFlag, '')
    const first = rootInstall(sb, ['--no-app', '--yes'])
    expect(first.code, first.out).toBe(1)
    expect(first.stderr).toContain('run ./install.sh again')
    rmSync(failFlag) // the owner fixed the problem and follows the advice
    const again = rootInstall(sb, ['--no-app', '--yes'])
    const placeholder = readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8').includes('talos:placeholder')
    // correct: either the re-run finishes the install (no placeholder), or it fails. Never exit 0 over a placeholder.
    expect(again.code === 0 && placeholder, again.out).toBe(false)
    // and what it rendered is committed (the day-zero commit was made over the placeholder)
    const head = spawnSync('git', ['-C', sb.agent, 'show', 'HEAD:CLAUDE.md'], {
      encoding: 'utf8',
      env: { PATH: sb.bin },
    })
    expect(head.stdout).not.toContain('talos:placeholder')
  })

  it('F1c: files rendered after the day-zero commit (a run stopped in between) are committed by the next run', () => {
    const sb = sandbox()
    const realPy = which('python3') as string
    const failFlag = join(sb.root, 'fail-render')
    stub(
      sb.bin,
      'python3',
      `if [ -f "${failFlag}" ]; then case " $* " in *render-default.py*) exit 1 ;; esac; fi\nexec "${realPy}" "$@"`,
    )
    writeFileSync(failFlag, '')
    expect(rootInstall(sb, ['--no-app', '--yes']).code).toBe(1)
    rmSync(failFlag)
    // rendered, but the run that did it stopped before its commit
    expect(spawnSync(realPy, [join(sb.agent, 'scripts', 'render-default.py'), '--into', sb.agent]).status).toBe(0)
    const again = rootInstall(sb, ['--no-app', '--yes'])
    expect(again.code, again.out).toBe(0)
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', sb.agent, ...a], { encoding: 'utf8', env: { PATH: sb.bin } })
    expect(git('show', 'HEAD:CLAUDE.md').stdout).not.toContain('talos:placeholder')
    expect(git('status', '--porcelain', 'CLAUDE.md', 'memory').stdout).toBe('')
  })

  // F1's other side: a CLAUDE.md the owner wrote in (even one that still carries the marker) is theirs. The agent counts as
  // installed, and a re-run is the usual one, never "the earlier install stopped".
  it('F1b: an owner-tuned CLAUDE.md that still carries the placeholder marker is an installed agent', () => {
    const sb = sandbox()
    const first = rootInstall(sb, ['--no-app', '--yes'])
    expect(first.code, first.out).toBe(0)
    writeFileSync(join(sb.agent, 'CLAUDE.md'), '# Mine\n\n<!-- talos:placeholder --> (I quote it in my notes)\n')
    const again = rootInstall(sb, ['--no-app', '--yes'])
    expect(again.out).toContain('already a Talos agent')
    expect(readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8')).toContain('# Mine')
    expect(again.out).not.toContain('did not finish')
  })

  // FINDING 2 (install.sh:295-296). "Is a git identity set?" is asked with `git config user.name` in the directory the installer
  // was started from, but the commit is made in the agent folder. A machine whose identity is per-repository (repo-local config,
  // or includeIf "gitdir:") answers yes for the clone and has none in ~/talos-agent, so the day-zero commit fails, on every re-run.
  it('F2: the day-zero commit works when the git identity exists only where the installer was started', () => {
    const sb = sandbox()
    const work = join(sb.root, 'work')
    mkdirSync(work)
    const g = (...a: string[]) => spawnSync('git', ['-C', work, ...a], { env: { PATH: sb.bin, HOME: sb.home } })
    g('init', '-q')
    g('config', 'user.name', 'Alex Example')
    g('config', 'user.email', 'alex@example.com')
    const r = rootInstall(sb, ['--no-app', '--yes'], { cwd: work })
    expect(r.out).not.toContain('Please tell me who you are')
    expect(r.code, r.out).toBe(0)
  })

  // FINDING 3 (install.sh:174). "The agent folder cannot be inside this clone" compares the two paths as text. The vault gets
  // `pwd -P` (install.sh:93); the agent folder does not, so a path that reaches the clone through a symlink passes the check.
  it('F3: an agent folder that reaches the clone through a symlink is refused', () => {
    const sb = sandbox()
    const link = join(sb.root, 'link-to-clone')
    symlinkSync(REPO, link)
    const r = rootInstall(sb, ['--no-app', '--dry-run', '--agent-dir', join(link, 'zz-bughunt-agent')])
    expect(existsSync(join(REPO, 'zz-bughunt-agent'))).toBe(false)
    expect(r.out).toContain('inside this clone')
    expect(r.code, r.out).toBe(1)
  })

  it('F3b: a . or .. in a part of the agent path that does not exist yet is refused (mkdir would resolve it after the check)', () => {
    const sb = sandbox()
    const r = rootInstall(sb, ['--no-app', '--dry-run', '--agent-dir', `${sb.root}/nope/../../x`])
    expect(r.out).toContain('. or ..')
    expect(r.code, r.out).toBe(1)
  })

  // FINDING 4 (install.sh:248). "Dependencies are installed" means only that two node_modules FOLDERS exist. A pnpm install that
  // was interrupted leaves both (without node_modules/.modules.yaml, which pnpm writes last), so every re-run skips pnpm install
  // and then dies in step 5 with bun's "Cannot find module".
  it('F4: node_modules folders left by an interrupted pnpm install are not taken for a finished install', () => {
    const sb = sandbox()
    const clone = join(sb.root, 'clone')
    mkdirSync(join(clone, 'plugins', 'talos-app-mod'), { recursive: true })
    mkdirSync(join(clone, 'node_modules'))
    mkdirSync(join(clone, 'apps', 'bridge', 'node_modules'), { recursive: true })
    copyFileSync(ROOT_INSTALL, join(clone, 'install.sh'))
    // install.sh sources its memory defaults from scripts/ (a new agent's search and memory browser)
    mkdirSync(join(clone, 'scripts'))
    copyFileSync(join(REPO, 'scripts', 'install-memory.sh'), join(clone, 'scripts', 'install-memory.sh'))
    copyFileSync(join(REPO, 'scripts', 'install-js.sh'), join(clone, 'scripts', 'install-js.sh'))
    symlinkSync(KIT, join(clone, 'kit'))
    // --no-chronos: this fake clone has no apps/chronos, and the finding is about pnpm
    const r = sh(sb, ['bash', join(clone, 'install.sh'), '--no-app', '--dry-run', '--no-chronos'], { cwd: clone })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('already done: pnpm install')
    expect(r.out).toContain('would: pnpm install --frozen-lockfile')
  })

  // FINDING 5 (kit/install.sh:197-198). On an agent that exists, kit/install.sh said "To take a newer kit version, run: bash
  // <kit>/scripts/upgrade.sh --into <agent> --dry-run". Every agent this installer makes is in the plugin layout, and upgrade.sh
  // refuses that layout (exit 2), so the advice was a dead end. The plugin layout updates with `talos update` (docs/SETUP.md).
  it('F5: the upgrade command kit/install.sh prints for an existing agent is the one for its layout', () => {
    const sb = sandbox()
    const first = sh(sb, ['bash', join(KIT, 'install.sh'), '--agent-dir', sb.agent, '--no-chronos'])
    expect(first.code, first.out).toBe(0)
    const second = sh(sb, ['bash', join(KIT, 'install.sh'), '--agent-dir', sb.agent, '--no-chronos'])
    expect(second.code).toBe(1)
    expect(second.out).not.toContain('upgrade.sh')
    // the release updater, by its path (no installer puts a `talos` command on PATH), with the agent folder quoted
    const line = second.out.split('\n').find((l) => l.includes('bin/talos-update'))
    expect(line, second.out).toBeDefined()
    const words = spawnSync('bash', ['-c', `set -- ${line}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).stdout.split(
      '\n',
    )
    expect(existsSync(words[0] as string), words[0]).toBe(true)
    expect(words.slice(1, 5)).toEqual(['update', '--agent', sb.agent, '--dry-run'])
    const advised = sh(
      sb,
      words.filter((w) => w !== ''),
    )
    expect(advised.out).not.toMatch(/command not found|No such file|unrecognized arguments/)
    // and the copying upgrader still refuses this layout, as it should
    const old = sh(sb, ['bash', join(KIT, 'scripts', 'upgrade.sh'), '--into', sb.agent, '--dry-run'])
    expect(old.code).not.toBe(0)
  })

  // FINDING 6 (kit/install.sh:269-276). The kit is copied into the agent folder BEFORE plugin-release.py is asked whether the
  // release can be built. When the kit changed without a VERSION bump (a pulled clone, a local fix), the build is refused
  // ("already exists with different content") after the copy, and the root installer's "move it aside and run again" loops.
  it('F6: a release that cannot be built is found out before anything is copied into the new agent folder', () => {
    const sb = sandbox()
    const kit = join(sb.root, 'kit')
    cpSync(KIT, kit, { recursive: true })
    const one = sh(sb, ['bash', join(kit, 'install.sh'), '--agent-dir', sb.agent, '--no-chronos'])
    expect(one.code, one.out).toBe(0)
    appendFileSync(join(kit, 'scripts', 'wiki-search.sh'), '# a later fix, same VERSION\n')
    const second = join(sb.home, 'second-agent')
    const two = sh(sb, ['bash', join(kit, 'install.sh'), '--agent-dir', second, '--no-chronos'])
    const leftover = two.code === 0 || !existsSync(second) ? [] : readdirSync(second)
    expect(leftover, two.out).toEqual([])
  })
})
