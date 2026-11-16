// The root ./install.sh on an agent folder from kit 1.x with no .talos-version: it used to refuse it (not empty, not a Talos
// agent). Now it carries it onto this kit with the existing tools (talos-app adopt, kit/scripts/upgrade.sh,
// kit/scripts/settings-merge.py): the plan by default, the change only with --apply. The folder is the kit 1.x copy layout
// that kit/scripts/self-test.sh builds and ages (scripts/v1-agent-fixture.sh), in a sandbox HOME.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, run, type Sandbox, sandbox, treeHash } from './root-install-harness.ts'

const KIT = join(REPO, 'kit')
// The owner's own files: every one must be byte-for-byte the same after --apply.
const OWNER = [
  'CLAUDE.md',
  'memory/STATE.md',
  'memory/HANDOFF.md',
  'memory/2026-08-30.md',
  'wiki/me.md',
  'wiki/_index.md',
  'wiki/concepts/alpha.md',
  '.learnings/LEARNINGS.md',
  '.env',
]
// The gate (the kit's self-test, minutes) is replaced by the installer's test hook, which says so in the output
const NO_GATE = { TALOS_INSTALL_GATE_CMD: 'true' }

function v1Agent(sb: Sandbox): string {
  const dir = join(sb.home, 'my-agent')
  const r = spawnSync('bash', [join(REPO, 'scripts', 'v1-agent-fixture.sh'), KIT, dir], {
    encoding: 'utf8',
    env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(r.status, r.stderr).toBe(0)
  return dir
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const sums = (dir: string) => Object.fromEntries(OWNER.map((f) => [f, sha(join(dir, f))]))
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const hookCommands = (settings: { hooks?: Record<string, { hooks: { command: string }[] }[]> }) =>
  Object.entries(settings.hooks ?? {}).flatMap(([ev, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => `${ev} ${h.command}`)),
  )

describe('root install.sh on an unstamped kit 1.x agent folder', () => {
  it("is recognized, and without --apply prints each tool's plan and changes nothing (byte-for-byte, .git included)", () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const before = treeHash(dir)
    const siblings = readdirSync(sb.home).sort()
    const r = run(sb, ['--agent-dir', dir, '--no-app'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('an agent from kit 1.x with no .talos-version')
    // a) adopt: shown as the command to type (this run has no terminal, and adopt runs only when typed)
    expect(r.out).toContain(`adopt --agent-dir ${dir}`)
    // b) upgrade.sh's own dry run: the pre-tool guard is new, the stale hook is updated, the owner's files are protected
    expect(r.out).toContain('+ hooks/pre-tool-guard.py')
    expect(r.out).toContain('~ hooks/session-start.py')
    expect(r.out).toMatch(/\d+ protected/)
    expect(r.out).toContain('DRY RUN -- nothing was written.')
    // c) settings-merge.py's dry run
    expect(r.out).toContain('would add pre-tool-guard.py on PreToolUse')
    expect(r.out).toContain('Nothing was changed.')
    expect(r.out).toContain(`--agent-dir ${dir} --apply`)
    expect(treeHash(dir)).toBe(before)
    // Library: a newer Bun (1.4.4) keeps its transpiler cache in ~/Library/Caches/bun when it runs a .ts file (adopt's dry
    // run); that is Bun's, not something the installer left next to the folder
    expect(
      readdirSync(sb.home)
        .filter((n) => n !== 'Library')
        .sort(),
    ).toEqual(siblings.filter((n) => n !== 'Library')) // no backup folder, nothing beside it
    expect(existsSync(join(dir, '.talos-version'))).toBe(false)
  }, 120_000)

  it('--dry-run gives the same plan and changes nothing; --apply with --dry-run is refused', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('would add pre-tool-guard.py')
    const both = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run', '--apply'], NO_GATE)
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('contradict')
    expect(treeHash(dir)).toBe(before)
  }, 120_000)

  it('--apply with no terminal and no --yes does not go ahead silently', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply'], NO_GATE)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--apply --yes')
    expect(treeHash(dir)).toBe(before)
  }, 120_000)

  it('--apply: code upgraded and stamped, the hook merged after a backup, every owner file byte-for-byte as it was', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const owner = sums(dir)
    const settingsBefore = json(join(dir, '.claude', 'settings.json'))
    const settingsBytes = readFileSync(join(dir, '.claude', 'settings.json'))
    const mcpBefore = readFileSync(join(dir, '.mcp.json'))
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    // the owner's files
    expect(sums(dir)).toEqual(owner)
    // the code: the stale hook replaced, the missing one added, the stamp written as upgraded from unstamped
    expect(sha(join(dir, 'hooks', 'session-start.py'))).toBe(sha(join(KIT, 'hooks', 'session-start.py')))
    expect(existsSync(join(dir, 'hooks', 'pre-tool-guard.py'))).toBe(true)
    const stamp = readFileSync(join(dir, '.talos-version'), 'utf8')
    expect(stamp).toContain('upgraded_from=unstamped')
    // upgrade.sh's full backup, beside the folder, holding the old bytes
    const bak = readdirSync(sb.home).find((n) => n.startsWith('my-agent-backup-'))
    expect(bak, readdirSync(sb.home).join(' ')).toBeDefined()
    expect(readFileSync(join(sb.home, bak as string, 'tree', '.claude', 'settings.json'))).toEqual(settingsBytes)
    // settings.json: its own backup first, then only the hook added; permissions and every hook it had are kept
    const after = json(join(dir, '.claude', 'settings.json'))
    expect(after.permissions).toEqual(settingsBefore.permissions)
    expect(after.permissions.allow).toContain('Bash(my-own-tool:*)')
    for (const h of hookCommands(settingsBefore)) expect(hookCommands(after)).toContain(h)
    expect(hookCommands(after).some((h) => h.startsWith('PreToolUse') && h.includes('pre-tool-guard.py'))).toBe(true)
    const sbak = readdirSync(join(dir, '.claude')).find((n) => n.startsWith('settings.json.bak-'))
    expect(sbak).toBeDefined()
    expect(readFileSync(join(dir, '.claude', sbak as string))).toEqual(settingsBytes)
    // adopt runs only typed in a terminal: here it is left, said so with the command, and .mcp.json is untouched
    expect(r.out).toContain('left for you')
    expect(r.out).toContain(`adopt --agent-dir ${dir}`)
    expect(readFileSync(join(dir, '.mcp.json'))).toEqual(mcpBefore)
    // the gate is the installer's own run (upgrade.sh --no-gate), here the suite's test hook, and the output says so
    expect(r.out).toContain('this installer runs the same gate right after it')
    expect(r.out).toContain('TALOS_INSTALL_GATE_CMD runs instead of scripts/self-test.sh')
    expect(r.out).toContain(`./install.sh --agent-dir ${dir}`)
  }, 180_000)

  it('after --apply the folder is a Talos agent: the next run takes the normal path', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE).code).toBe(0)
    const owner = sums(dir)
    const next = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run'])
    expect(next.code, next.out).toBe(0)
    expect(next.out).toContain('already a Talos agent')
    expect(next.out).not.toContain('2b/7')
    expect(sums(dir)).toEqual(owner)
  }, 180_000)

  it.skipIf(process.platform !== 'darwin')(
    "in a terminal, --apply runs talos-app adopt: the talos-app server is added and the owner's own server kept",
    () => {
      const sb = sandbox()
      const dir = v1Agent(sb)
      const owner = sums(dir)
      // a pseudo-terminal, as a person typing it in Terminal has (adopt refuses to run from a pipe). script(1) needs a stdin it
      // can ask about, so it gets /dev/null as a file rather than a pipe.
      const devnull = openSync('/dev/null', 'r')
      const r = spawnSync(
        '/usr/bin/script',
        ['-q', '/dev/null', 'bash', join(REPO, 'install.sh'), '--agent-dir', dir, '--no-app', '--apply', '--yes'],
        {
          encoding: 'utf8',
          cwd: REPO,
          stdio: [devnull, 'pipe', 'pipe'],
          env: {
            PATH: sb.bin,
            HOME: sb.home,
            GIT_CONFIG_GLOBAL: '/dev/null',
            PYTHONDONTWRITEBYTECODE: '1',
            TALOS_INSTALL_OS: 'Darwin',
            TALOS_INSTALL_MEMSEARCH_DEFAULT: 'off', // a new agent's search downloads a venv and a model: not in tests
            TALOS_FORCE_ARCH: 'arm64',
            TERM: 'dumb',
            ...NO_GATE,
          },
        },
      )
      closeSync(devnull)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain('connected')
      const servers = json(join(dir, '.mcp.json')).mcpServers
      expect(Object.keys(servers).sort()).toEqual(['my-own-server', 'talos-app'])
      expect(sums(dir)).toEqual(owner)
    },
    180_000,
  )

  it('a non-empty folder that is not a kit agent is still refused, and pointed at adopt', () => {
    const sb = sandbox()
    const dir = join(sb.home, 'notes')
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# mine\n')
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('is not a Talos agent')
    expect(r.stderr).toContain(`talos-app adopt --agent-dir ${dir}`)
    expect(treeHash(dir)).toBe(before)
  })
})
