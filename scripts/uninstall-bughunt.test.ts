// The uninstaller's and privacy gate's bug-hunt findings of 2026-11-10 (docs/audits/2026-11-10-bughunt-triage.md, package
// P-C2, with F11): kit/uninstall.sh, scripts/check-no-personal.sh, scripts/export-public.sh, install.sh's printed bridge command. Each test states the correct behaviour.
// Same sandbox as root-install.test.ts: a temp HOME, a private PATH of real tools plus stubs, TALOS_INSTALL_OS=Darwin.
// gate-reads: install.sh kit/* scripts/*
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
import { fakeTool } from './fake-tool'
import { recordPnpmInstall } from './root-install-harness.ts'

const REPO = resolve(__dirname, '..')
const ROOT_INSTALL = join(REPO, 'install.sh')
const KIT = join(REPO, 'kit')
const STUB_CHRONOS = join(KIT, 'scripts', 'fixtures', 'fake-chronos')
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
  recordPnpmInstall(bin, log) // never a real install into the shared checkout (root-install-harness.ts says why)
  return { root, home, bin, log, agent: join(home, 'talos-agent') }
}

function stub(dir: string, name: string, body: string) {
  fakeTool(dir, name, `#!/bin/sh\n${body}\n`)
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
const rootInstall = (sb: Sandbox, args: string[], opts: { cwd?: string } = {}) =>
  sh(sb, ['bash', ROOT_INSTALL, ...args], opts)

describe('uninstall and the privacy gate: the 2026-11-10 bug hunt (P-C2)', () => {
  describe('kit/uninstall.sh', () => {
    const uninstall = (sb: Sandbox, args: string[], cwd?: string) =>
      sh(sb, ['bash', join(KIT, 'uninstall.sh'), ...args], { cwd })

    // FINDING 7 (kit/uninstall.sh:122-124). The script's own rule for --purge-app is "Ask FIRST, before any change". The
    // --purge-chronos question comes after the jobs, the session hook, the global pointer and the kit's config are already
    // gone, so "no" (or no terminal) leaves half an uninstall and the line "aborted before touching Chronos".
    it('F7: declining the --purge-chronos question leaves everything as it was', () => {
      const sb = sandbox()
      const inst = rootInstall(sb, ['--no-app', '--yes', '--with-chronos', '--chronos-path', STUB_CHRONOS, '--no-load'])
      expect(inst.code, inst.out).toBe(0)
      const jobs = join(sb.home, '.config', 'chronos', 'jobs.json')
      const before = readFileSync(jobs, 'utf8')
      expect(before).toContain('talos-morning-brief')
      const r = uninstall(sb, ['--purge-chronos']) // stdin is empty: the question gets no "purge"
      expect(r.code).toBe(1)
      expect(r.out).toContain('aborted')
      expect(readFileSync(jobs, 'utf8') === before, 'jobs.json was changed before the question was asked').toBe(true)
      expect(existsSync(join(sb.home, '.config', 'talos', 'agent-dir'))).toBe(true)
    })

    // FINDING 8 (kit/uninstall.sh:110-116). The names are read NUL-separated "so an odd file name cannot split", then joined
    // with spaces and printed with an unquoted `for _n in $KEPT_OTHER`: a name with a space becomes two files that do not
    // exist, and a file called `*` lists the files of whatever folder the uninstaller was started in.
    it('F8: a kept file is listed under its own name, spaces and glob characters included', () => {
      const sb = sandbox()
      const cfg = join(sb.home, '.config', 'talos')
      mkdirSync(cfg, { recursive: true })
      writeFileSync(join(cfg, 'my notes.txt'), 'x')
      writeFileSync(join(cfg, '*'), 'x')
      const cwd = join(sb.root, 'elsewhere')
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'UNRELATED-FILE'), 'x')
      const r = uninstall(sb, [], cwd)
      expect(r.out).toContain('kept my notes.txt')
      expect(r.out).not.toContain('UNRELATED-FILE')
    })

    // FINDING 9 (kit/uninstall.sh:23, 60). `set -u` only, and no step's exit status is looked at. When unregistering the jobs
    // fails (here: a jobs.json Chronos cannot parse) the talos-* jobs stay registered, the notify wrapper and the records are
    // deleted anyway, and the run ends with "Done." and exit 0.
    it('F9: an uninstall whose job removal failed does not exit 0', () => {
      const sb = sandbox()
      const chronos = join(sb.home, '.config', 'chronos')
      mkdirSync(chronos, { recursive: true })
      writeFileSync(join(chronos, 'config.json'), '{"jobs_file":"~/.config/chronos/jobs.json"}\n')
      writeFileSync(join(chronos, 'jobs.json'), '[{"id":"talos-morning-brief"\n')
      const r = uninstall(sb, ['--agent-dir', sb.agent])
      expect(r.out).toContain('cannot read')
      expect(r.code, r.out).not.toBe(0)
    })
  })

  // FINDING 10 (scripts/check-no-personal.sh:76-83). A rule whose PATTERN (or PATH_RE) is not a valid regular expression makes
  // grep exit 2; the `2>/dev/null || true` around it turns that into "no hits", so the rule never matches anything and the
  // scan prints ok. Everything else in this script fails closed (exit 2).
  it('F10: a rule that is not a valid regular expression is an error, not a clean scan', () => {
    const sb = sandbox()
    const scan = join(sb.root, 'scan')
    mkdirSync(scan)
    writeFileSync(join(scan, 'a.txt'), 'call me on (555) 0100\n')
    const rules = join(sb.root, 'rules.txt')
    writeFileSync(rules, '.*\t-\t(555 0100|\\(555\\) 0100\n') // an unbalanced "(": grep -E refuses it
    const r = sh(sb, ['bash', join(REPO, 'scripts', 'check-no-personal.sh'), scan], {
      cwd: scan,
      env: { CHECK_NO_GIT: '1', CHECK_EXTRA_RULES: rules },
    })
    expect(r.stdout).not.toContain('check-no-personal: ok')
    expect(r.code, r.out).not.toBe(0)
  })

  // A grep error fails the scan closed, but "no match" is not one. BSD xargs (a Mac) passes any exit 1-125 on as 1, so the
  // exit cannot tell them apart there: a clean scan must still say ok, and grep's stderr is what fails it.
  it('F10b: with BSD xargs exit codes a clean scan is ok, and a file grep cannot read still fails it closed', () => {
    const sb = sandbox()
    const realX = which('xargs') as string
    stub(sb.bin, 'xargs', `"${realX}" "$@"; rc=$?; [ $rc -ge 1 ] && [ $rc -le 125 ] && exit 1; exit $rc`)
    const scan = join(sb.root, 'scan')
    mkdirSync(scan)
    writeFileSync(join(scan, 'a.txt'), 'nothing personal here\n')
    const rules = join(sb.root, 'rules.txt')
    writeFileSync(rules, '.*\t-\tcall me on 555\n')
    const run = () =>
      sh(sb, ['bash', join(REPO, 'scripts', 'check-no-personal.sh'), scan], {
        cwd: scan,
        env: { CHECK_NO_GIT: '1', CHECK_EXTRA_RULES: rules },
      })
    const clean = run()
    expect(clean.code, clean.out).toBe(0)
    expect(clean.stdout).toContain('check-no-personal: ok')
    if (process.getuid?.() !== 0) {
      writeFileSync(join(scan, 'b.txt'), 'x\n')
      chmodSync(join(scan, 'b.txt'), 0o000)
      const blind = run()
      chmodSync(join(scan, 'b.txt'), 0o644)
      expect(blind.code, blind.out).toBe(2)
      expect(blind.stdout).not.toContain('check-no-personal: ok')
    }
  })

  // FINDING 11 (install.sh:327, 345, 538). The bridge command the installer tells a first-time user to run next is printed with
  // the agent folder unquoted, so with a space in the path the pasted command hands the bridge installer half a path.
  it('F11: the printed bridge command keeps an agent folder with a space as one argument', () => {
    const sb = sandbox()
    const agent = join(sb.home, 'my agent')
    const r = rootInstall(sb, ['--no-app', '--dry-run', '--agent-dir', agent])
    expect(r.code, r.out).toBe(0)
    const marker = 'the bridge command comes first: '
    const line = r.out.split('\n').find((l) => l.includes(marker)) as string
    const cmd = line.slice(line.indexOf(marker) + marker.length).replace('https://<your relay host>', 'https://x.test')
    const words = spawnSync('bash', ['-c', `set -- ${cmd}; printf '%s\\n' "$@"`], { encoding: 'utf8' })
    expect(words.stdout.split('\n')).toContain(agent)
  })

  // FINDING 12 (scripts/export-public.sh:60-63). The target folder is created before the "must be outside the source
  // repository" check, so a refused target (exit 2) still leaves a new empty folder inside the repository.
  it('F12: a refused export target inside the source repository is not created', () => {
    const sb = sandbox()
    const src = join(sb.root, 'src')
    mkdirSync(src)
    const g = (...a: string[]) =>
      spawnSync('git', ['-C', src, '-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...a])
    g('init', '-q')
    writeFileSync(join(src, 'f.txt'), 'x\n')
    g('add', 'f.txt')
    expect(g('commit', '-qm', 'one').status).toBe(0)
    const target = join(src, 'out')
    const r = sh(sb, ['bash', join(REPO, 'scripts', 'export-public.sh'), target], { env: { EXPORT_SOURCE: src } })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('outside the source repository')
    expect(existsSync(target)).toBe(false)
  })
})
