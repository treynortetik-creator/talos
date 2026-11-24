// The root ./install.sh pre-flight (step 1): every tool it needs, at the version it needs, checked before anything changes.
// Each tool is hidden from PATH one at a time, and old versions are faked with stub binaries that print what the real ones
// print. A failure must name the tool, the version found against the version needed, and the way to get it with no admin
// password, then exit 3 with nothing changed. The harness (private PATH, sandbox HOME) is root-install-harness.ts.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calls, REPO, run, type Sandbox, sandbox, snapshot } from './root-install-harness.ts'

/** Replace a tool in the sandbox PATH with a script (a real tool there is a link: removed first, never written through). */
function put(sb: Sandbox, name: string, body: string) {
  rmSync(join(sb.bin, name), { force: true })
  writeFileSync(join(sb.bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(sb.bin, name), 0o755)
}
const hide = (sb: Sandbox, ...names: string[]) => {
  for (const n of names) rmSync(join(sb.bin, n), { force: true })
}
/** The "Cannot continue" list: one entry per problem. */
const problems = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4))

/** Runs the installer and asserts the refusal shape every pre-flight failure shares: exit 3, nothing written, nothing built. */
function refused(sb: Sandbox, args: string[] = ['--yes']) {
  const before = snapshot(sb.home)
  const r = run(sb, args)
  expect(r.code, r.out).toBe(3)
  expect(r.stderr).toContain('Nothing was changed')
  expect(r.out).not.toContain('2/7 Agent folder')
  expect(existsSync(sb.agent)).toBe(false)
  expect(snapshot(sb.home)).toEqual(before)
  expect(calls(sb).filter((c) => !c.startsWith('osascript'))).toEqual([])
  return { ...r, list: problems(r.stderr) }
}

const NEED = {
  node: (/"node": *">= *(\d+)/.exec(readFileSync(join(REPO, 'package.json'), 'utf8')) ?? [])[1] as string,
  pnpm: (/"packageManager": *"pnpm@([\d.]+)/.exec(readFileSync(join(REPO, 'package.json'), 'utf8')) ?? [])[1] as string,
  swift: (/swift-tools-version: *([\d.]+)/.exec(readFileSync(join(REPO, 'apps/desktop/Package.swift'), 'utf8')) ??
    [])[1] as string,
}

describe('the Bun floor', () => {
  it('is one number: install.sh asks for the same Bun that the gate and the doctor check', () => {
    const read = (file: string, re: RegExp) => (re.exec(readFileSync(join(REPO, file), 'utf8')) ?? [])[1]
    const doctor = read('apps/bridge/src/bun-floor.ts', /export const BUN_FLOOR = '([\d.]+)'/)
    expect(doctor).toBe('1.4.4')
    expect(read('install.sh', /^BUN_NEED=([\d.]+)/m)).toBe(doctor)
    expect(read('scripts/gate.sh', /^BUN_FLOOR=([\d.]+)/m)).toBe(doctor)
  })
})

describe('root install.sh pre-flight: each tool hidden from PATH', () => {
  // [tool(s) to hide, the words its line must carry: what, and the no-admin route]
  const cases: [string[], string, string[]][] = [
    [['git'], 'git: not found', ['Command Line Tools', 'ask IT']],
    [['python3'], 'python3 3.9 or newer: not found', ['Command Line Tools', 'ask IT']],
    [['node'], `Node ${NEED.node} or newer: not found`, ['No admin needed', 'fnm.vercel.app/install', `fnm install ${NEED.node}`]],
    [['pnpm'], `pnpm ${NEED.pnpm} or newer: not found`, ['No admin needed', 'corepack enable pnpm']],
    [['bun'], 'Bun 1.4.4 or newer: not found', ['No admin needed', 'https://bun.sh/install', '~/.bun']],
    [['claude'], 'Claude Code 2.1.304 or newer: not found', ['No admin needed', 'claude.ai/install.sh', 'https://claude.com/claude-code']],
    [['tmux'], 'tmux 3.2 or newer: not found', ['ask IT for tmux (or Homebrew)', '--no-tmux']],
    [['xcode-select', 'swift'], `Xcode Command Line Tools with Swift ${NEED.swift} or newer: not installed`, [`ask IT for the Xcode Command Line Tools with Swift ${NEED.swift}+`, 'xcode-select --install']],
  ] // biome-ignore format: one case per line

  for (const [names, what, fix] of cases) {
    it(`${names.join(' + ')} missing: one line names it with the no-admin way, exit 3, nothing changed`, () => {
      const sb = sandbox()
      hide(sb, ...names)
      // where pnpm is a Node script (pnpm/action-setup on Linux CI, npm's pnpm) hiding node breaks it too: a standalone
      // stand-in keeps this case to the one missing tool, however pnpm is installed on the machine running the test
      if (names.includes('node') && !names.includes('pnpm')) put(sb, 'pnpm', `echo ${NEED.pnpm}`)
      const r = refused(sb)
      const line = r.list.find((l) => l.startsWith(what))
      expect(line, r.stderr).toBeDefined()
      for (const w of fix) expect(line?.toLowerCase(), `${what}: ${w}`).toContain(w.toLowerCase())
      expect(r.list).toHaveLength(1)
    })
  }

  it('Claude Code installed but not on the PATH (its installer leaves ~/.local/bin off it): that is said, with the one line', () => {
    const sb = sandbox()
    hide(sb, 'claude')
    mkdirSync(join(sb.home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(sb.home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "2.1.325 (Claude Code)"\n')
    chmodSync(join(sb.home, '.local', 'bin', 'claude'), 0o755)
    const r = refused(sb)
    expect(r.list).toHaveLength(1)
    expect(r.list[0]).toContain(
      `Claude Code is installed (${join(sb.home, '.local', 'bin', 'claude')}) but ~/.local/bin is not on your PATH`,
    )
    expect(r.list[0]).toContain(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`)
    expect(r.list[0]).not.toContain('claude.ai/install.sh') // nothing to install again
  })

  it('Claude Code not installed at all: the way to install it also says the PATH line its installer leaves to you', () => {
    const sb = sandbox()
    hide(sb, 'claude')
    const line = refused(sb).list.find((l) => l.startsWith('Claude Code'))
    expect(line).toContain('does not change your PATH')
    expect(line).toContain(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`)
  })

  it('everything missing at once: every problem is listed in one run, and it still stops before step 2', () => {
    const sb = sandbox()
    hide(sb, 'node', 'pnpm', 'bun', 'claude', 'tmux', 'swift', 'xcode-select')
    const r = refused(sb)
    expect(r.list.map((l) => l.split(':')[0]?.split(' ')[0])).toEqual([
      'Node',
      'pnpm',
      'Bun',
      'Claude',
      'Xcode',
      'tmux',
    ])
  })
})

describe('root install.sh pre-flight: versions too old (stub binaries)', () => {
  const cases: [string, string, string, string][] = [
    // tool, stub body, the found/needed words, a no-admin word
    ['tmux', 'echo "tmux 3.1c"', 'tmux 3.2 or newer: found 3.1', 'micromamba'],
    ['node', 'echo 22.3.0', `Node ${NEED.node} or newer: found 22.3.0`, 'fnm'],
    ['pnpm', 'echo 9.15.0', `pnpm ${NEED.pnpm} or newer: found 9.15.0`, 'corepack'],
    ['bun', 'echo 1.3.11', 'Bun 1.4.4 or newer: found 1.3.11', 'bun upgrade'],
    ['bun', 'echo 1.4.3', 'Bun 1.4.4 or newer: found 1.4.3', 'bun upgrade'],
    ['claude', 'echo "2.1.303 (Claude Code)"', 'Claude Code 2.1.304 or newer: found 2.1.303', 'claude update'],
    ['python3', 'echo "Python 3.8.10"', 'python3 3.9 or newer: found 3.8.10', 'ask IT'],
    ['swift', 'echo "swift-driver version: 1.90.11.1 Apple Swift version 5.10 (swiftlang-5.10.0.13)"', `Swift ${NEED.swift} or newer: found 5.10`, `ask IT for the Xcode Command Line Tools with Swift ${NEED.swift}+`],
  ] // biome-ignore format: one case per line
  for (const [tool, body, words, fix] of cases) {
    it(`${tool} too old: found against needed, and the way to a newer one`, () => {
      const sb = sandbox()
      put(sb, tool, body)
      const r = refused(sb)
      const line = r.list.find((l) => l.startsWith(words))
      expect(line, r.stderr).toBeDefined()
      expect(line?.toLowerCase()).toContain(fix.toLowerCase())
      expect(r.list).toHaveLength(1)
    })
  }

  it('a tool that prints no version is a problem, said as that, not passed', () => {
    const sb = sandbox()
    put(sb, 'bun', 'exit 0')
    const r = refused(sb)
    expect(r.list[0]).toContain('Bun 1.4.4 or newer: found')
    expect(r.list[0]).toContain('did not say its version')
  })

  // one test per spelling: three whole dry runs in one test outran the 30 s budget on a loaded machine
  it.each(['tmux 3.2', 'tmux 3.3a', 'tmux next-3.6'])(
    'exactly the minimum passes, and so does the tmux spelling %s',
    (tmux) => {
      const sb = sandbox()
      put(sb, 'tmux', `echo "${tmux}"`)
      // asked its version it says 1.4.4; asked to run the pre-flight's one-line script (a bun that runs nothing is refused) it runs it
      put(sb, 'bun', 'case "$*" in *talos-bun-ok*) echo talos-bun-ok ;; *) echo 1.4.4 ;; esac')
      put(sb, 'claude', 'case "$1" in --version) echo "2.1.304 (Claude Code)" ;; esac')
      put(sb, 'swift', `echo "Apple Swift version ${NEED.swift} (swiftlang-6.2.0.1)"`)
      const r = run(sb, ['--dry-run'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('PROBLEM')
      expect(r.out).toMatch(/found tmux 3\.[236]/)
    },
  )

  it('a version that is newer in a lower part only is not read as older (10.4 > 3.9, 1.10 > 1.3)', () => {
    const sb = sandbox()
    put(sb, 'python3', 'echo "Python 3.10.2"')
    put(sb, 'tmux', 'echo "tmux 10.1"')
    const r = run(sb, ['--dry-run'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('found python3 3.10.2')
  })
})

describe('root install.sh pre-flight: tmux, Homebrew and the Command Line Tools', () => {
  /** The commands the pre-flight prints for tmux without admin, one per line, as they would be pasted. */
  const routeLines = (stderr: string) => {
    const at = stderr.split('\n')
    const from = at.findIndex((l) => l.startsWith('tmux with no admin password'))
    const to = at.findIndex((l, i) => i > from && l.startsWith('Then open a new terminal'))
    return at.slice(from + 2, to).map((l) => l.replace(/^ {2}/, ''))
  }

  it('no tmux and no Homebrew: the micromamba route is printed as exact commands into ~/.local, and IT as the fallback', () => {
    const sb = sandbox()
    hide(sb, 'tmux')
    const r = refused(sb)
    expect(r.list[0]).toContain('No Homebrew here')
    const lines = routeLines(r.stderr)
    // micromamba pinned to one release, and its binary checked against that release's published SHA-256 before it is used
    expect(lines).toContain(
      'curl -fsSL -o ~/.local/talos-tmux-tools/micromamba.download https://github.com/mamba-org/micromamba-releases/releases/download/2.10.0-0/micromamba-osx-arm64',
    )
    const check = lines.find((l) => l.includes('shasum -a 256 -c -'))
    expect(check).toContain('c547639f5caf742236641c362746abb4a3505774753ecd08fe341643670c4c01')
    expect(check?.indexOf('shasum')).toBeLessThan(check?.indexOf('chmod +x') ?? 0)
    // tmux pinned
    expect(lines.some((l) => l.endsWith("--override-channels 'tmux=3.8_'"))).toBe(true)
    // nothing replaced: no ln -sf, and no "latest"
    expect(r.stderr).not.toContain('ln -sf')
    expect(r.stderr).not.toContain('/latest')
  })

  it('the printed link and ~/.zprofile lines are safe to run twice and leave an existing ~/.local/bin/tmux alone', () => {
    const sb = sandbox()
    hide(sb, 'tmux')
    const lines = routeLines(refused(sb).stderr)
    const tail = lines.filter((l) => l.startsWith('if [ -e ~/.local/bin/tmux ]') || l.startsWith('grep -qxF'))
    expect(tail).toHaveLength(2)
    const home = join(sb.root, 'route-home')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.zprofile'), '# mine\n')
    const sh = (h: string) =>
      spawnSync('bash', ['-c', tail.join('\n')], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } })
    // twice: one PATH line, the rest of the file kept
    for (const _ of [1, 2]) expect(sh(home).status).toBe(0)
    const prof = readFileSync(join(home, '.zprofile'), 'utf8')
    expect(prof.split('\n').filter((l) => l === 'export PATH="$HOME/.local/bin:$PATH"')).toHaveLength(1)
    expect(prof.startsWith('# mine\n')).toBe(true)
    // the first run made the link; the second left it
    expect(readlinkSync(join(home, '.local', 'bin', 'tmux'))).toBe(join(home, '.local', 'talos-tmux', 'bin', 'tmux'))
    // a tmux of someone else's already there is not replaced
    const other = join(sb.root, 'other-home')
    mkdirSync(join(other, '.local', 'bin'), { recursive: true })
    writeFileSync(join(other, '.local', 'bin', 'tmux'), '#!/bin/sh\necho mine\n')
    const r = sh(other)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('left alone')
    expect(readFileSync(join(other, '.local', 'bin', 'tmux'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  it('an Intel Mac gets the osx-64 micromamba and its own checksum', () => {
    const sb = sandbox()
    hide(sb, 'tmux')
    const r = run(sb, ['--yes'], { TALOS_FORCE_ARCH: 'x86_64' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('/download/2.10.0-0/micromamba-osx-64')
    expect(r.stderr).toContain('8421462a1ef1df9f7acd114f9e2a24c1332ce4f4e29f44465b4acb44e2755172')
  })

  it('no tmux with Homebrew present: brew install tmux is offered; Homebrew is asked about only when tmux needs it', () => {
    const sb = sandbox()
    put(sb, 'brew', `echo "brew $*" >> "${sb.log}"`)
    hide(sb, 'tmux')
    const r = refused(sb)
    expect(r.list[0]).toContain('brew install tmux')
    const ok = sandbox()
    put(ok, 'brew', `echo "brew $*" >> "${ok.log}"`)
    const fine = run(ok, ['--dry-run'])
    expect(fine.code, fine.out).toBe(0)
    expect(fine.out).not.toMatch(/brew/i)
    expect(calls(ok).filter((c) => c.startsWith('brew'))).toEqual([])
  })

  it('--no-tmux goes on without tmux and says what that costs; --no-app only notes it', () => {
    const sb = sandbox()
    hide(sb, 'tmux')
    const r = run(sb, ['--dry-run', '--no-tmux'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('tmux not checked (--no-tmux)')
    const t = run(sb, ['--dry-run', '--no-app'])
    expect(t.code, t.out).toBe(0)
    expect(t.out).toContain('note: tmux 3.2 or newer: not found')
  })

  it('without the tools, swift is never run (on a Mac without them, /usr/bin/swift opens the install dialog)', () => {
    const sb = sandbox()
    put(sb, 'xcode-select', 'exit 2')
    put(sb, 'swift', `echo "swift $*" >> "${sb.log}"; echo "Apple Swift version 6.2"`)
    const r = refused(sb)
    expect(r.list[0]).toContain('not installed')
    expect(calls(sb).filter((c) => c.startsWith('swift'))).toEqual([])
  })

  // Apple's stubs exist only on a Mac: on Linux /usr/bin/python3 is a link to a versioned python3 and /usr/bin/git the real git
  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/python3') || !existsSync('/usr/bin/git'))(
    "without the tools, Apple's git and python3 stubs are named as such and not run (each would open the install dialog)",
    () => {
      const sb = sandbox()
      put(sb, 'xcode-select', 'exit 2')
      hide(sb, 'git', 'python3')
      symlinkSync('/usr/bin/git', join(sb.bin, 'git'))
      symlinkSync('/usr/bin/python3', join(sb.bin, 'python3'))
      const r = refused(sb, ['--yes', '--no-app'])
      expect(r.list).toHaveLength(2)
      expect(r.list[0]).toMatch(/^git: only Apple's stub/)
      expect(r.list[1]).toMatch(/^python3 3\.9 or newer: only Apple's stub/)
      for (const l of r.list) expect(l).toContain('ask IT')
    },
  )

  it('a full-Xcode Mac: whatever folder xcode-select names, a swift that says 6.2+ passes, and /usr/bin/git is run as git', () => {
    for (const named of ['/Applications/Xcode.app/Contents/Developer', join(tmpdir(), 'no-such-developer-dir'), '']) {
      const sb = sandbox()
      put(sb, 'xcode-select', `case "$1" in -p) [ -n "${named}" ] && echo "${named}"; exit 0 ;; esac`)
      if (existsSync('/usr/bin/git')) {
        hide(sb, 'git')
        symlinkSync('/usr/bin/git', join(sb.bin, 'git'))
      }
      const r = run(sb, ['--dry-run'], { HOME: join(sb.root, 'some-other-home') })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('found swift 6.2.1')
      expect(r.out).not.toContain("only Apple's stub")
    }
  }, 60_000) // two whole sandboxed installs: 32 s under load (2026-11-15)

  it('xcode-select -p failing (a Mac without the tools) is "not installed", whatever swift would say', () => {
    const sb = sandbox()
    put(sb, 'xcode-select', 'echo "xcode-select: error: unable to get active developer directory" >&2; exit 2')
    const r = refused(sb)
    expect(r.list[0]).toContain('Command Line Tools with Swift')
    expect(r.list[0]).toContain('not installed')
  })

  it('the Mac app checks (Swift, tmux) are skipped with --no-app', () => {
    const sb = sandbox()
    hide(sb, 'swift', 'xcode-select', 'tmux')
    const r = run(sb, ['--dry-run', '--no-app'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('Swift')
  })
})
