// The root ./install.sh on an agent folder from kit 1.x with no .talos-version: it used to refuse it (not empty, not a Talos
// agent). Now it carries it onto this kit with the existing tools (talos-app adopt, kit/scripts/upgrade.sh,
// kit/scripts/settings-merge.py): the plan by default, the change only with --apply. The folder is the kit 1.x copy layout
// that kit/scripts/self-test.sh builds and ages (scripts/v1-agent-fixture.sh), in a sandbox HOME.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
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

// A carried folder gets the semantic memory search a new agent gets (scripts/install-memory.sh carry_memsearch_step). The
// harness turns the default off; these turn it on and replace setup.sh by the installer's test hook, so nothing is downloaded.
describe('root install.sh carrying a kit 1.x folder: semantic memory search', () => {
  const ON = { ...NO_GATE, TALOS_INSTALL_MEMSEARCH_DEFAULT: 'on' }
  const logOf = (sb: Sandbox) => join(sb.root, 'memsearch.log')
  /** A setup.sh stand-in that logs its arguments and exits `code`; it fails (and leaves a marker) if the carry is still marked under way. */
  const fake = (sb: Sandbox, code: number) => ({
    ...ON,
    TALOS_INSTALL_MEMSEARCH_CMD: `[ ! -e "$2/.talos-carry" ] || { : > "${join(sb.root, 'carry-still-there')}"; exit 9; }; echo "$@" >> "${logOf(sb)}"; exit ${code}`,
    TALOS_MEM_BYTES: '1073741824', // under 3 GiB: the reranker step skips itself, so it downloads nothing either
  })
  const calls = (sb: Sandbox) => (existsSync(logOf(sb)) ? readFileSync(logOf(sb), 'utf8').trim().split('\n') : [])
  const ARGS = (dir: string, extra = '') => `--agent-dir ${dir} --embed-model auto --no-job${extra}`

  it("plan only: the plan says what would be set up (the reranker in the fetch script's own words), and nothing changes", () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app'], fake(sb, 0))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`would: semantic memory search for this agent: bash ${dir}/scripts/memory/setup.sh`)
    expect(r.out).toContain('the install goes on if it fails')
    // the 1 GiB computer: the fetch script's dry run says the reranker would be skipped
    expect(r.out).toContain('reranker: would be skipped (1 GiB of memory here')
    expect(calls(sb)).toEqual([])
    expect(treeHash(dir)).toBe(before)
    // with enough memory it describes the model
    const big = run(sb, ['--agent-dir', dir, '--no-app'], { ...fake(sb, 0), TALOS_MEM_BYTES: String(8 * 2 ** 30) })
    expect(big.out).toContain('reranker model: bge-reranker-v2-m3')
    expect(treeHash(dir)).toBe(before)
  }, 180_000)

  it('--apply: setup.sh runs once, after the carry is done and its summary printed; the hook says so; the order holds', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--no-reranker'], fake(sb, 0))
    expect(r.code, r.out).toBe(0)
    expect(calls(sb)).toEqual([ARGS(dir)])
    expect(existsSync(join(sb.root, 'carry-still-there'))).toBe(false) // .talos-carry was already gone when it ran
    expect(existsSync(join(dir, '.index', '.wanted'))).toBe(true)
    expect(r.out).toContain(
      'test hook TALOS_INSTALL_MEMSEARCH_CMD runs instead of scripts/memory/setup.sh (not for normal use)',
    )
    const at = (t: string) => r.out.indexOf(t)
    expect(at('Undo all of it:')).toBeGreaterThan(at('== Carried onto this kit'))
    expect(at('== Semantic memory search')).toBeGreaterThan(at('Undo all of it:'))
    expect(at('Still to do, typed by you')).toBeLessThan(at('== Semantic memory search'))
    expect(at('   set up semantic memory search')).toBeGreaterThan(at('== Semantic memory search'))
    expect(at('Next: ./install.sh')).toBeGreaterThan(at('   set up semantic memory search'))
    expect(r.out).not.toMatch(/Done: .*semantic memory search/)
    expect(existsSync(join(dir, '.talos-carry'))).toBe(false)
  }, 180_000)

  it('a carry that stopped and is run again finishes it, and the step runs once', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--no-reranker'], {
      ...fake(sb, 0),
      TALOS_INSTALL_GATE_CMD: 'exit 1',
    })
    expect(first.code, first.out).toBe(1)
    expect(existsSync(join(dir, '.talos-carry'))).toBe(true)
    expect(calls(sb)).toEqual([])
    const again = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--no-reranker'], fake(sb, 0))
    expect(again.code, again.out).toBe(0)
    expect(again.out).toContain('carry onto this kit that did not finish')
    expect(calls(sb)).toEqual([ARGS(dir)])
    expect(existsSync(join(dir, '.talos-carry'))).toBe(false)
  }, 240_000)

  it('Chronos: --no-job unless --with-chronos (and then unless --no-jobs), even when a Chronos config exists', () => {
    const sb = sandbox()
    const cfg = join(sb.root, 'chronos.json')
    writeFileSync(cfg, '{}\n')
    const withCfg = (code: number) => ({ ...fake(sb, code), CHRONOS_CONFIG: cfg })
    const a = v1Agent(sb)
    expect(run(sb, ['--agent-dir', a, '--no-app', '--apply', '--yes', '--no-reranker'], withCfg(0)).code).toBe(0)
    expect(calls(sb)).toEqual([ARGS(a)])
    const sb2 = sandbox()
    const cfg2 = join(sb2.root, 'chronos.json')
    writeFileSync(cfg2, '{}\n')
    const b = v1Agent(sb2)
    const r = run(sb2, ['--agent-dir', b, '--no-app', '--apply', '--yes', '--no-reranker', '--with-chronos'], {
      ...fake(sb2, 0),
      CHRONOS_CONFIG: cfg2,
    })
    expect(r.code, r.out).toBe(0)
    expect(calls(sb2)).toEqual([`--agent-dir ${b} --embed-model auto`])
    const sb3 = sandbox()
    const c = v1Agent(sb3)
    run(
      sb3,
      ['--agent-dir', c, '--no-app', '--apply', '--yes', '--no-reranker', '--with-chronos', '--no-jobs'],
      fake(sb3, 0),
    )
    expect(calls(sb3)).toEqual([ARGS(c)])
  }, 360_000)

  it('--embed-model reaches setup.sh; an explicit --with-memory-search wins over the default being off', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const env = { ...fake(sb, 0), TALOS_INSTALL_MEMSEARCH_DEFAULT: 'off' }
    const r = run(
      sb,
      [
        '--agent-dir',
        dir,
        '--no-app',
        '--apply',
        '--yes',
        '--no-reranker',
        '--embed-model',
        'small',
        '--with-memory-search',
      ],
      env,
    )
    expect(r.code, r.out).toBe(0)
    expect(calls(sb)).toEqual([`--agent-dir ${dir} --embed-model small --no-job`])
  }, 180_000)

  it('an explicit --with-reranker is not memory-gated and runs even when search failed', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--with-reranker'], fake(sb, 1))
    // fetch-reranker.sh really runs here, without the memory gate: with no curl on the PATH it stops at once and downloads nothing
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('reranker: skipped')
    expect(r.out).toContain('reranker model: bge-reranker-v2-m3')
  }, 180_000)

  it('setup.sh exits 3 (Python 3.9): the carry still succeeds, the uv line is printed, the want marker stays for the doctor', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], fake(sb, 3))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('needs Python 3.10+')
    expect(r.out).toContain(`brew install uv && bash ${dir}/scripts/memory/setup.sh`)
    expect(r.out).toContain('reranker: skipped (semantic search is not set up)')
    expect(r.out).not.toContain('   set up semantic memory search')
    expect(existsSync(join(dir, '.index', '.wanted'))).toBe(true)
    expect(existsSync(join(dir, '.talos-carry'))).toBe(false)
    expect(existsSync(join(dir, '.talos-version'))).toBe(true)
  }, 180_000)

  it('--apply on a small computer: the reranker is skipped with its own line, no marker left', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], fake(sb, 0))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('reranker: skipped (1 GiB of memory here')
    expect(existsSync(join(dir, '.index', '.rerank-wanted'))).toBe(false)
  }, 180_000)

  it('setup.sh fails some other way: the carry succeeds and the later command is named', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--no-reranker'], fake(sb, 1))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Semantic search was NOT enabled (setup.sh exited 1)')
    expect(r.out).toContain(`Add it later with:  bash ${dir}/scripts/memory/setup.sh`)
  }, 180_000)

  it('an unwritable .index never fails the finished carry: the summary is printed and one line says the marker is missing', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    mkdirSync(join(dir, '.index'))
    chmodSync(join(dir, '.index'), 0o500)
    try {
      const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], {
        ...fake(sb, 0),
        TALOS_MEM_BYTES: String(8 * 2 ** 30),
      })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('== Carried onto this kit')
      expect(r.out).toContain('is not writable')
      expect(r.out).toContain('Next: ./install.sh')
    } finally {
      chmodSync(join(dir, '.index'), 0o700)
    }
  }, 180_000)

  it('--no-memory-search: not run, one line says it is off and how to add it later', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--no-memory-search'], fake(sb, 0))
    expect(r.code, r.out).toBe(0)
    expect(calls(sb)).toEqual([])
    expect(r.out).toContain(
      `semantic memory search: off (--no-memory-search). Add it later: bash ${dir}/scripts/memory/setup.sh`,
    )
    expect(existsSync(join(dir, '.index', '.wanted'))).toBe(false)
  }, 180_000)
})
