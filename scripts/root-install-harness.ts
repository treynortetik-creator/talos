// The shared harness of the root-install*.test.ts files: the root ./install.sh, driven with a private PATH of real node, pnpm,
// bun, git and python3, and stubs for claude, swift, xcodebuild and xcode-select that only record that they were called. The
// Mac app scripts are replaced by stubs too (the Swift build cannot run here); TALOS_INSTALL_OS (default Darwin) and
// TALOS_FORCE_ARCH (arm64) pretend to be an Apple Silicon Mac, so the suite runs the same on Linux.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll } from 'vitest'

export const REPO = resolve(__dirname, '..')
export const SCRIPT = join(REPO, 'install.sh')
export const DESKTOP_JSON = (sb: { home: string }) =>
  join(sb.home, 'Library', 'Application Support', 'Talos', 'desktop.json')
export const MOD = join(REPO, 'plugins', 'talos-app-mod')
const made: string[] = []
afterAll(() => {
  // a plugin release is read-only (dirs without the write bit): make everything writable first, else rmSync fails with ENOTEMPTY
  for (const d of made) {
    spawnSync('chmod', ['-R', 'u+w', d])
    rmSync(d, { recursive: true, force: true })
  }
}, 60_000) // many trees of a whole install each: the default 10 s ran out under a busy gate

const REAL_TOOLS = [
  'bash', 'env', 'git', 'python3', 'node', 'pnpm', 'bun', 'sh', 'awk', 'sed', 'grep', 'ls', 'tar', 'mkdir', 'cp', 'chmod',
  'cat', 'printf', 'dirname', 'basename', 'tr', 'date', 'mktemp', 'rm', 'head', 'tail', 'uname', 'id', 'find', 'cut',
  'sort', 'wc', 'readlink', 'sleep', 'mv', 'touch', 'diff', 'xargs', 'tee', 'expr', 'test', 'true', 'false', 'ln', 'stat',
  'uniq', 'seq', 'realpath', 'hostname', 'od', 'sha256sum', 'shasum', 'less', 'perl', 'git-upload-pack', 'cmp',
] // biome-ignore format: one tool list

export function which(name: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const p = r.stdout.trim()
  return r.status === 0 && p.startsWith('/') ? p : undefined
}

export type Sandbox = { home: string; bin: string; log: string; desktop: string; agent: string; root: string }
export const flag = (sb: Sandbox, name: string) => join(sb.root, name)

/** A fresh HOME and a PATH folder holding only the tools the installer may use. */
export function sandbox(opts: { claude?: boolean } = {}): Sandbox {
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
  const tools = ['swift', 'xcodebuild', 'xcode-select', 'tmux', ...(opts.claude === false ? [] : ['claude'])]
  // The version questions the pre-flight asks are answered (new enough) and not recorded: they read, they change nothing.
  // xcode-select -p names a folder that exists, as on a Mac with the tools.
  const versions: Record<string, string> = {
    swift: `case "$1" in --version|-version) echo "swift-driver version: 1.0.0 Apple Swift version 6.2.1 (swiftlang-6.2.1)"; exit 0 ;; esac`,
    'xcode-select': `case "$1" in -p|--print-path) echo "${root}"; exit 0 ;; esac`,
    tmux: `case "$1" in -V) echo "tmux 3.5a"; exit 0 ;; esac`,
    claude: `case "$1" in --version|-v) echo "2.1.330 (Claude Code)"; exit 0 ;; esac`,
  }
  for (const t of tools) stub(bin, t, `${versions[t] ?? ''}\n${record(t)}`)
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

export function run(sb: Sandbox, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      PATH: sb.bin,
      HOME: sb.home,
      TALOS_INSTALL_DESKTOP_SCRIPTS: sb.desktop,
      GIT_CONFIG_GLOBAL: '/dev/null',
      // the Command Line Tools python3 (a stock Mac) writes its .pyc cache into $HOME/Library/Caches: not a write the
      // installer made, and a dry run's "changes nothing" snapshot would see it
      PYTHONDONTWRITEBYTECODE: '1',
      // the CI Mac, wherever this runs: the kit refuses Chronos off macOS and MLX models off Apple Silicon
      TALOS_INSTALL_OS: 'Darwin',
      TALOS_FORCE_ARCH: 'arm64',
      // a new agent's semantic memory search downloads a Python venv and a model: off here, on in the tests of that default
      TALOS_INSTALL_MEMSEARCH_DEFAULT: 'off',
      ...env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
}

export const calls = (sb: Sandbox) => readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean)

/** path + size + mtime of every file outside .git, so "changes nothing" is a comparison, not a claim. */
export function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue // git refreshes its own index when verify-install reads the repo
      // the tools' own caches in the sandbox home, never the installer's (its desktop.json, under Library/Application Support,
      // is still compared): a newer Bun keeps its transpiler cache in ~/Library/Caches/bun and pnpm 12 its store in ~/Library/pnpm
      if (d === join(dir, 'Library') && (name === 'Caches' || name === 'pnpm')) continue
      const p = join(d, name)
      const s = lstatSync(p) // a link is itself, not what it leads to (a store link can lead nowhere)
      if (s.isDirectory()) walk(p)
      else out.push(`${p} ${s.size} ${s.mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

/** Hash of every path, type and file content under dir (including .git), so "byte-identical" is a comparison. */
export function treeHash(dir: string): string {
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

export const FLAGS = ['--plugin-dir', MOD, '--dangerously-load-development-channels', 'server:talos-app']
export const mac = { TALOS_INSTALL_OS: 'Darwin' }
