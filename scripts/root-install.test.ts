// The root ./install.sh: dry run, real run, refusals, the Mac app step, reruns and verify-install. The harness (a private PATH
// of real tools and stubs, a sandbox HOME) is root-install-harness.ts; the suite is split over the root-install*.test.ts files
// so vitest runs them side by side.
// gate-reads: install.sh kit/* scripts/*
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calls, flag, MOD, mac, REPO, run, SCRIPT, sandbox, snapshot, treeHash } from './root-install-harness.ts'

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
    // the default homes: nothing baked in, so the bridge and the CLI keep finding them the usual way
    expect(launch).not.toContain('export ')
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
    // KIT-8: a rerun installs the clone's dependencies again (after a `git pull` the lockfile may name new packages)
    const installs = readFileSync(sb.log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('pnpm install --frozen-lockfile'))
    expect(installs.length, readFileSync(sb.log, 'utf8')).toBe(2)
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

  // Dante's setup (Pantheon 2026-11-19): installed with TALOS_APP_HOME set, then started from a shell without it, so
  // start-talos.sh ran the CLI against the default home, a bridge with no key and no settings. The script now carries the
  // homes it was installed with; one at its default is left out, so a script stays the same across machines.
  it('start-talos.sh carries a TALOS_APP_HOME other than the default and a TALOS_INBOX_ROOT, and only those', () => {
    const sb = sandbox()
    const appHome = join(sb.home, 'other app home')
    const inbox = join(sb.home, "the owner's inbox")
    const r = run(sb, ['--no-app', '--yes'], { TALOS_APP_HOME: appHome, TALOS_INBOX_ROOT: inbox })
    expect(r.code, r.out).toBe(0)
    const launch = join(sb.agent, 'start-talos.sh')
    // what a shell with neither set gets when it runs the script's exports: the install-time paths, spaces and quotes intact
    const seen = spawnSync(
      'bash',
      ['-c', 'eval "$(grep "^export " "$1")"; printf "%s|%s" "$TALOS_APP_HOME" "$TALOS_INBOX_ROOT"', 'x', launch],
      { encoding: 'utf8', env: { PATH: sb.bin } },
    )
    expect(seen.stdout).toBe(`${appHome}|${inbox}`)
    // the exports come before the exec that runs the CLI
    const text = readFileSync(launch, 'utf8')
    expect(text.indexOf('export TALOS_APP_HOME=')).toBeLessThan(text.indexOf('exec bun'))
    expect(text.indexOf('export TALOS_INBOX_ROOT=')).toBeLessThan(text.indexOf('exec bun'))
    // TALOS_APP_HOME at its default value: not baked in
    const sb2 = sandbox()
    const r2 = run(sb2, ['--no-app', '--yes'], { TALOS_APP_HOME: join(sb2.home, '.config', 'talos', 'app') })
    expect(r2.code, r2.out).toBe(0)
    expect(readFileSync(join(sb2.agent, 'start-talos.sh'), 'utf8')).not.toContain('export ')
    // a relative path is baked in as the absolute one it meant where the install ran (the harness runs it from the repo)
    const sb3 = sandbox()
    const rel = `rel-inbox-${Date.now()}`
    expect(run(sb3, ['--no-app', '--yes'], { TALOS_INBOX_ROOT: rel }).code).toBe(0)
    expect(readFileSync(join(sb3.agent, 'start-talos.sh'), 'utf8')).toContain(
      `export TALOS_INBOX_ROOT=${join(REPO, rel)}\n`,
    )
    expect(existsSync(join(REPO, rel))).toBe(false) // the install only names it; it writes nothing there
  }, 360_000)

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
})
