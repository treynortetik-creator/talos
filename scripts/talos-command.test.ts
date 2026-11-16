// The `talos` command (docs/SETUP.md "Upgrading": talos update, rollback, restore): kit/install.sh puts a two-line wrapper in
// ~/.local/bin that runs the active release's updater. Same sandbox as install-bughunt.test.ts.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

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
  // the root installer's pre-flight asks claude its version (not recorded: it reads)
  stub(
    bin,
    'claude',
    `case "$1" in --version) echo "2.1.330 (Claude Code)"; exit 0 ;; esac\necho "claude $*" >> "${log}"`,
  )
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
const _rootInstall = (sb: Sandbox, args: string[], opts: { cwd?: string } = {}) =>
  sh(sb, ['bash', ROOT_INSTALL, ...args], opts)

describe('the talos command', () => {
  const kitInstall = (sb: Sandbox, args: string[], env: Record<string, string> = {}) =>
    sh(sb, ['bash', join(KIT, 'install.sh'), '--agent-dir', sb.agent, '--no-chronos', ...args], { env })

  it("with ~/.local/bin there, `talos` is written and runs the active release's updater", () => {
    const sb = sandbox()
    mkdirSync(join(sb.home, '.local', 'bin'), { recursive: true })
    const r = kitInstall(sb, [])
    expect(r.code, r.out).toBe(0)
    const talos = join(sb.home, '.local', 'bin', 'talos')
    expect(r.out).toContain(`wrote ${talos}`)
    expect(r.out).toContain('is not on your PATH yet') // the sandbox PATH does not have it
    const text = readFileSync(talos, 'utf8')
    expect(text).toMatch(/^#!\/bin\/sh\n/)
    expect(text).toContain('/current/talos-kit/bin/talos-update" "$@"')
    const help = sh(sb, [talos, '--help'])
    expect(help.code, help.out).toBe(0)
    expect(help.out).toMatch(/update/)
  })
  it("a `talos` that is not the kit's is left alone; with no ~/.local/bin nothing is written and the full path is printed", () => {
    const sb = sandbox()
    const r = kitInstall(sb, [])
    expect(r.code, r.out).toBe(0)
    expect(existsSync(join(sb.home, '.local', 'bin', 'talos'))).toBe(false)
    expect(r.out).toMatch(
      /no ~\/\.local\/bin, so no `talos` command was added\. Run the kit's updater as ".*\/current\/talos-kit\/bin\/talos-update"/,
    )
    const sb2 = sandbox()
    mkdirSync(join(sb2.home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(sb2.home, '.local', 'bin', 'talos'), '#!/bin/sh\necho mine\n')
    const r2 = kitInstall(sb2, [])
    expect(r2.code, r2.out).toBe(0)
    expect(readFileSync(join(sb2.home, '.local', 'bin', 'talos'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(r2.out).toContain("is not the kit's; left alone")
  })
  it('an agent installed before is given `talos` by --add-to-existing, and a second write is the same file', () => {
    const sb = sandbox()
    expect(kitInstall(sb, []).code).toBe(0)
    mkdirSync(join(sb.home, '.local', 'bin'), { recursive: true })
    const r = kitInstall(sb, ['--add-to-existing'])
    expect(r.code, r.out).toBe(0)
    const talos = join(sb.home, '.local', 'bin', 'talos')
    const first = readFileSync(talos, 'utf8')
    expect(kitInstall(sb, ['--add-to-existing']).code).toBe(0)
    expect(readFileSync(talos, 'utf8')).toBe(first)
  })
})
