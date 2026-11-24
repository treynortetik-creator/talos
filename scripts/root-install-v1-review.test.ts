// The root ./install.sh on an unstamped kit 1.x agent folder: the review findings of 2026-11-13 (R1-2 to R1-6). Where the
// folder may live, links inside it, checks before any write, the plan run in a real terminal, and .mcp.json in the backup.
// The folder is scripts/v1-agent-fixture.sh (the kit 1.x copy layout) in a sandbox HOME; root-install-v1.test.ts has the rest.
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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { REPO, run, type Sandbox, sandbox, treeHash } from './root-install-harness.ts'

// every case runs install.sh for real, some twice: 30 s ran out on a loaded Lemnos and on Hestia (33-35 s); each passes in seconds alone
vi.setConfig({ testTimeout: scaled(90_000), hookTimeout: scaled(90_000) })

const KIT = join(REPO, 'kit')
// The gate (the kit's self-test, minutes) is replaced by the installer's test hook, which says so in the output
const NO_GATE = { TALOS_INSTALL_GATE_CMD: 'true' }
/** The file the installer keeps in the folder while a carry is under way (written first, removed last). */
const CARRY = '.talos-carry'

function v1Agent(sb: Sandbox, rel = 'my-agent'): string {
  const dir = join(sb.home, rel)
  mkdirSync(join(dir, '..'), { recursive: true })
  const r = spawnSync('bash', [join(REPO, 'scripts', 'v1-agent-fixture.sh'), KIT, dir], {
    encoding: 'utf8',
    env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(r.status, r.stderr).toBe(0)
  return dir
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

describe('R1-5: the kit refuses Desktop, Documents, Downloads and synced folders, and so does the 1.x carry', () => {
  it('a 1.x folder under ~/Documents is refused, plan and --apply alike, until --allow-protected-folder', () => {
    const sb = sandbox()
    const dir = v1Agent(sb, 'Documents/my-agent')
    const before = treeHash(dir)
    for (const extra of [[], ['--apply', '--yes']]) {
      const r = run(sb, ['--agent-dir', dir, '--no-app', ...extra], NO_GATE)
      expect(r.code, r.out).toBe(1)
      expect(r.stderr).toContain('inside Desktop, Documents or Downloads')
      expect(r.stderr).toContain('--allow-protected-folder')
      expect(r.stderr).toContain('Nothing was changed')
    }
    expect(treeHash(dir)).toBe(before)
    const ok = run(sb, ['--agent-dir', dir, '--no-app', '--allow-protected-folder'], NO_GATE)
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toContain('Plan only')
    expect(treeHash(dir)).toBe(before)
  }, 120_000)

  it('the comparison ignores letter case on a Mac, as its file system does (~/documents is ~/Documents)', () => {
    const sb = sandbox()
    const dir = v1Agent(sb, 'documents/my-agent')
    const r = run(sb, ['--agent-dir', dir, '--no-app'], { ...NO_GATE, TALOS_INSTALL_OS: 'Darwin' })
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('inside Desktop, Documents or Downloads')
  }, 120_000)

  it('a 1.x folder in a synced folder is refused until --allow-synced-folder', () => {
    const sb = sandbox()
    const dir = v1Agent(sb, 'Dropbox/my-agent')
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('cloud-synced')
    expect(r.stderr).toContain('--allow-synced-folder')
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--allow-synced-folder'], NO_GATE).code).toBe(0)
  }, 120_000)
})

/** install.sh in a pseudo-terminal, as a person typing in Terminal has it. script(1) needs a stdin it can ask about. */
function inTerminal(sb: Sandbox, args: string[], env: Record<string, string> = {}) {
  const devnull = openSync('/dev/null', 'r')
  try {
    const r = spawnSync('/usr/bin/script', ['-q', '/dev/null', 'bash', join(REPO, 'install.sh'), ...args], {
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
        ...env,
      },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    closeSync(devnull)
  }
}

describe('R1-4: the plan run in a real terminal', () => {
  it.skipIf(process.platform !== 'darwin')(
    "shows adopt's own dry run (it runs only in a terminal) and changes nothing",
    () => {
      const sb = sandbox()
      const dir = v1Agent(sb)
      const before = treeHash(dir)
      const r = inTerminal(sb, ['--agent-dir', dir, '--no-app'], NO_GATE)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('would write the talos-app server into')
      expect(r.out).not.toContain('only runs in Terminal')
      expect(r.out).toContain('Plan only')
      expect(treeHash(dir)).toBe(before)
    },
    120_000,
  )
})

describe('R1-2: links on a path a step would write are named and refused', () => {
  /** A file outside the agent folder that a link inside it points at. */
  function outside(sb: Sandbox, name: string, text: string) {
    const p = join(sb.root, 'outside', name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
    return p
  }

  it('a kit file that is a link to a file outside the folder: refused, named, nothing written there or here', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const target = outside(sb, 'session-start.py', "# somebody else's file\n")
    rmSync(join(dir, 'hooks', 'session-start.py'))
    symlinkSync(target, join(dir, 'hooks', 'session-start.py'))
    const before = treeHash(dir)
    for (const extra of [[], ['--apply', '--yes']]) {
      const r = run(sb, ['--agent-dir', dir, '--no-app', ...extra], NO_GATE)
      expect(r.code, r.out).toBe(1)
      expect(r.stderr).toContain(`hooks/session-start.py -> ${target}`)
      expect(r.stderr).toContain('Replace each link')
      expect(r.stderr).toContain('Nothing was changed')
    }
    expect(readFileSync(target, 'utf8')).toBe("# somebody else's file\n")
    expect(treeHash(dir)).toBe(before)
    expect(readdirSync(sb.home).filter((n) => n.includes('backup'))).toEqual([])
  }, 120_000)

  it('hooks/ as a link to a folder outside, and .mcp.json as a link, are both named', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const hooksOut = join(sb.root, 'outside', 'hooks')
    mkdirSync(join(sb.root, 'outside'), { recursive: true })
    renameSync(join(dir, 'hooks'), hooksOut)
    symlinkSync(hooksOut, join(dir, 'hooks'))
    const mcpOut = outside(sb, 'mcp.json', '{"mcpServers":{}}\n')
    rmSync(join(dir, '.mcp.json'))
    symlinkSync(mcpOut, join(dir, '.mcp.json'))
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain(`hooks -> ${hooksOut}`)
    expect(r.stderr).toContain(`.mcp.json -> ${mcpOut}`)
    expect(readFileSync(mcpOut, 'utf8')).toBe('{"mcpServers":{}}\n')
  }, 120_000)

  it('a .talos-version that is a link leading nowhere is refused (tested with -L, not -e), and nothing is made at its target', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const nowhere = join(sb.root, 'outside', 'stamp')
    symlinkSync(nowhere, join(dir, '.talos-version'))
    const before = treeHash(dir)
    for (const extra of [[], ['--apply', '--yes']]) {
      const r = run(sb, ['--agent-dir', dir, '--no-app', ...extra], NO_GATE)
      expect(r.code, r.out).toBe(1)
      expect(r.stderr).toContain(`.talos-version -> ${nowhere}`)
    }
    expect(existsSync(nowhere)).toBe(false)
    expect(treeHash(dir)).toBe(before)
  }, 120_000)
})

describe('R1-3: everything is checked before anything is written, and a carry that stopped is finished', () => {
  const settings = (dir: string) => join(dir, '.claude', 'settings.json')
  const guardRegistered = (dir: string) => readFileSync(settings(dir), 'utf8').includes('pre-tool-guard.py')

  it('a settings.json that is not valid JSON stops --apply before anything: no backup, no stamp, nothing changed', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    writeFileSync(settings(dir), '{ "permissions": { "allow": [ "Bash(my-own-tool:*)" ] ,,, }\n')
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('is not valid JSON')
    expect(r.stderr).toContain('Fix that file first. Nothing was changed.')
    expect(treeHash(dir)).toBe(before)
    expect(existsSync(join(dir, '.talos-version'))).toBe(false)
    expect(readdirSync(sb.home).filter((n) => n.includes('backup'))).toEqual([])
    // fixed, the same command goes through
    writeFileSync(settings(dir), readFileSync(join(KIT, 'templates', 'dot-claude', 'settings.json')))
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE).code).toBe(0)
  }, 180_000)

  it('an .mcp.json that is not valid JSON stops --apply before anything', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    writeFileSync(join(dir, '.mcp.json'), '{ not json\n')
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('.mcp.json is not valid JSON')
    expect(r.stderr).toContain('Nothing was changed')
    expect(treeHash(dir)).toBe(before)
  }, 120_000)

  it('a step after the stamp fails (the merge): the carry is unfinished, and the next run finishes it', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    // the merge's dry run only reads .claude/; its write needs the folder writable: shut, the merge fails after upgrade.sh
    chmodSync(join(dir, '.claude'), 0o555)
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    chmodSync(join(dir, '.claude'), 0o755)
    expect(first.code, first.out).toBe(1)
    expect(first.stderr).toContain('settings-merge.py --apply failed')
    expect(readFileSync(join(dir, '.talos-version'), 'utf8')).toContain('upgraded_from=unstamped')
    expect(existsSync(join(dir, CARRY))).toBe(true)
    expect(guardRegistered(dir)).toBe(false)
    const backups = readdirSync(sb.home).filter((n) => n.includes('backup'))
    const plan = run(sb, ['--agent-dir', dir, '--no-app'], NO_GATE)
    expect(plan.code, plan.out).toBe(0)
    expect(plan.out).toContain('a carry onto this kit that did not finish')
    expect(plan.out).toContain('would add pre-tool-guard.py')
    expect(plan.out).not.toContain('kit/scripts/upgrade.sh --dry-run')
    const apply = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(apply.code, apply.out).toBe(0)
    expect(guardRegistered(dir)).toBe(true)
    expect(existsSync(join(dir, CARRY))).toBe(false)
    expect(readdirSync(sb.home).filter((n) => n.includes('backup'))).toEqual(backups) // no second upgrade
    const next = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run'])
    expect(next.code, next.out).toBe(0)
    expect(next.out).toContain('already a Talos agent')
  }, 180_000)

  it('--apply runs upgrade.sh first, then the merge, then adopt', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    const at = (s: string) => r.out.indexOf(s)
    expect(at('TALOS UPGRADE')).toBeGreaterThan(-1)
    expect(at('TALOS UPGRADE')).toBeLessThan(at('adding pre-tool-guard.py'))
    expect(at('adding pre-tool-guard.py')).toBeLessThan(at('left for you'))
  }, 180_000)
})

describe("R1-6: .mcp.json goes into upgrade.sh's backup and receipt before adopt writes it", () => {
  const rollback = (sb: Sandbox, dir: string, backup: string) =>
    spawnSync('bash', [join(KIT, 'scripts', 'upgrade.sh'), '--rollback', backup, '--into', dir], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  const backupOf = (sb: Sandbox) => {
    const b = readdirSync(sb.home).filter((n) => n.startsWith('my-agent-backup-'))
    expect(b).toHaveLength(1)
    return join(sb.home, b[0] as string)
  }

  it.skipIf(process.platform !== 'darwin')(
    'in a terminal (adopt runs): the receipt names .mcp.json and settings.json, and upgrade.sh --rollback puts both back',
    () => {
      const sb = sandbox()
      const dir = v1Agent(sb)
      const mcp0 = sha(join(dir, '.mcp.json'))
      const set0 = sha(join(dir, '.claude', 'settings.json'))
      const r = inTerminal(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
      expect(r.code, r.out).toBe(0)
      expect(sha(join(dir, '.mcp.json'))).not.toBe(mcp0) // adopt wrote the talos-app server
      const b = backupOf(sb)
      const receipt = readFileSync(join(b, '_upgrade-receipt.txt'), 'utf8').split('\n')
      expect(receipt).toContain('UPDATED\t.mcp.json')
      expect(receipt).toContain('UPDATED\t.claude/settings.json')
      expect(sha(join(b, 'tree', '.mcp.json'))).toBe(mcp0)
      expect(r.out).toContain(`--rollback ${b}`)
      const back = rollback(sb, dir, b)
      expect(back.status, back.stdout + back.stderr).toBe(0)
      expect(sha(join(dir, '.mcp.json'))).toBe(mcp0)
      expect(sha(join(dir, '.claude', 'settings.json'))).toBe(set0)
      expect(existsSync(join(dir, '.talos-version'))).toBe(false)
    },
    180_000,
  )

  it.skipIf(process.platform !== 'darwin')(
    'a folder with no .mcp.json: the receipt says NEW, and the rollback removes the one adopt made',
    () => {
      const sb = sandbox()
      const dir = v1Agent(sb)
      rmSync(join(dir, '.mcp.json'))
      const r = inTerminal(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(dir, '.mcp.json'))).toBe(true)
      const b = backupOf(sb)
      expect(readFileSync(join(b, '_upgrade-receipt.txt'), 'utf8').split('\n')).toContain('NEW\t.mcp.json')
      expect(rollback(sb, dir, b).status).toBe(0)
      expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    },
    180_000,
  )
})

describe('R2-5: the merge plan does not call a hook stale that the upgrade is about to add', () => {
  it('pre-tool-guard.py (added by the upgrade) is not STALE; a registered hook whose script is really gone still is', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const p = join(dir, '.claude', 'settings.json')
    const s = JSON.parse(readFileSync(p, 'utf8'))
    s.hooks.Stop = [
      ...(s.hooks.Stop ?? []),
      { hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/hooks/gone.py"' }] },
    ]
    writeFileSync(p, JSON.stringify(s, null, 2))
    const r = run(sb, ['--agent-dir', dir, '--no-app'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('would add pre-tool-guard.py on PreToolUse')
    expect(r.out).not.toContain('STALE: pre-tool-guard.py')
    expect(r.out).toContain('STALE: gone.py on Stop')
  }, 120_000)
})

describe("R2-3: adopt's own refusals are checked before anything is written, and --repoint reaches adopt", () => {
  // another clone, in the sandbox (a path under /home can stall on macOS, where /home is an automount)
  const elsewhere = (sb: Sandbox) => join(sb.root, 'other-clone', 'apps', 'bridge')
  const otherClone = (sb: Sandbox, dir: string) =>
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'my-own-server': { command: 'my-server', args: [] },
          'talos-app': { command: 'bun', args: ['run', '--cwd', elsewhere(sb), '--silent', 'start'] },
        },
      }),
    )
  const nothingWritten = (sb: Sandbox, dir: string, before: string) => {
    expect(treeHash(dir)).toBe(before)
    expect(existsSync(join(dir, '.talos-version'))).toBe(false)
    expect(readdirSync(sb.home).filter((n) => n.includes('backup'))).toEqual([])
  }

  it('a talos-app server from another clone: --apply stops before any write, and says --repoint', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    otherClone(sb, dir)
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain(elsewhere(sb))
    expect(r.stderr).toContain('--repoint')
    nothingWritten(sb, dir, before)
    // with --repoint, adopt's dry run agrees, and the plan goes through
    const ok = run(sb, ['--agent-dir', dir, '--no-app', '--repoint'], NO_GATE)
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toContain('adopt --agent-dir')
    expect(ok.out).toContain('--repoint')
  }, 120_000)

  it('an .mcp.json whose mcpServers is not an object stops --apply before any write', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers": []}\n')
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('mcpServers that is not an object')
    nothingWritten(sb, dir, before)
  }, 120_000)

  it('an MCP-apps catalog that does not parse stops --apply before any write', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const apps = join(sb.home, '.config', 'talos', 'app', 'apps')
    mkdirSync(apps, { recursive: true })
    writeFileSync(join(apps, 'catalog.json'), '{ not json')
    const before = treeHash(dir)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(r.code, r.out).toBe(1)
    expect(r.stderr).toContain('catalog')
    nothingWritten(sb, dir, before)
  }, 120_000)

  it.skipIf(process.platform !== 'darwin')(
    "in a terminal, --apply --repoint points the talos-app server at this clone and keeps the owner's own server",
    () => {
      const sb = sandbox()
      const dir = v1Agent(sb)
      otherClone(sb, dir)
      const r = inTerminal(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes', '--repoint'], NO_GATE)
      expect(r.code, r.out).toBe(0)
      const servers = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers
      expect(Object.keys(servers).sort()).toEqual(['my-own-server', 'talos-app'])
      // the entry form of the OS sandbox: bun with both folder-loading flags off, then THIS clone's bridge script (no other clone's path)
      const bridge = join(REPO, 'apps', 'bridge')
      expect(servers['talos-app'].args).toEqual([
        '--no-env-file',
        `--config=${join(bridge, 'bunfig.toml')}`,
        join(bridge, 'src', 'server.ts'),
      ])
    },
    180_000,
  )
})

describe('R2-2: only a carry this installer started and did not finish is finished; anything else is as on main', () => {
  const settings = (dir: string) => join(dir, '.claude', 'settings.json')

  it('a finished carry whose hook registration was removed later is "already a Talos agent", not an unfinished carry', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE).code).toBe(0)
    expect(existsSync(join(dir, CARRY))).toBe(false)
    // the owner (or a later kit's new hook) leaves a kit hook unregistered
    const s = JSON.parse(readFileSync(settings(dir), 'utf8'))
    for (const g of s.hooks.PreToolUse ?? [])
      g.hooks = g.hooks.filter((h: { command: string }) => !h.command.includes('pre-tool-guard'))
    writeFileSync(settings(dir), JSON.stringify(s, null, 2))
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('already a Talos agent')
    expect(r.out).not.toContain('2b/7')
    const a = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], NO_GATE)
    expect(a.out).toContain('already a Talos agent')
    expect(a.out).not.toContain('2b/7')
    expect(readFileSync(settings(dir), 'utf8')).not.toContain('pre-tool-guard')
  }, 180_000)

  it('a folder upgrade.sh stamped "upgraded_from=unstamped" by hand, with no carry file, is as on main', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const up = spawnSync('bash', [join(KIT, 'scripts', 'upgrade.sh'), '--into', dir, '--no-gate'], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(up.status, up.stdout + up.stderr).toBe(0)
    const r = run(sb, ['--agent-dir', dir, '--no-app', '--dry-run'], NO_GATE)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('already a Talos agent')
    expect(r.out).not.toContain('2b/7')
  }, 180_000)
})

describe('R2-1: a carry is not done until its gate passes, and the next run reruns a gate that failed', () => {
  const settings = (dir: string) => join(dir, '.claude', 'settings.json')
  /** A gate (the test hook for scripts/self-test.sh) that records each run in a log and exits with `code`. */
  const gate = (sb: Sandbox, code: number) => ({
    TALOS_INSTALL_GATE_CMD: `echo ran >> "${join(sb.root, 'gate.log')}"; exit ${code}`,
  })
  const gateRuns = (sb: Sandbox) =>
    existsSync(join(sb.root, 'gate.log'))
      ? readFileSync(join(sb.root, 'gate.log'), 'utf8').split('\n').filter(Boolean).length
      : 0

  it('a failing gate stops the carry before the merge; the next run reruns it, and only a pass finishes the carry', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 1))
    expect(first.code, first.out).toBe(1)
    expect(first.stderr).toContain('THE GATE FAILED')
    expect(first.stderr).toContain('--rollback')
    expect(gateRuns(sb)).toBe(1)
    // stamped by upgrade.sh, but not carried: the file stays, and the merge did not run
    expect(existsSync(join(dir, '.talos-version'))).toBe(true)
    expect(existsSync(join(dir, CARRY))).toBe(true)
    expect(readFileSync(join(dir, CARRY), 'utf8')).not.toContain('gate=passed')
    expect(readFileSync(settings(dir), 'utf8')).not.toContain('pre-tool-guard')
    // the next run is not taken in: the plan says the gate runs again, and a gate that still fails stops it again
    const plan = run(sb, ['--agent-dir', dir, '--no-app'], gate(sb, 1))
    expect(plan.code, plan.out).toBe(0)
    expect(plan.out).toContain('the gate runs again first')
    const again = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 1))
    expect(again.code, again.out).toBe(1)
    expect(again.stderr).toContain('THE GATE FAILED')
    expect(gateRuns(sb)).toBe(2)
    expect(readFileSync(settings(dir), 'utf8')).not.toContain('pre-tool-guard')
    // a gate that passes finishes it
    const ok = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 0))
    expect(ok.code, ok.out).toBe(0)
    expect(gateRuns(sb)).toBe(3)
    expect(readFileSync(settings(dir), 'utf8')).toContain('pre-tool-guard')
    expect(existsSync(join(dir, CARRY))).toBe(false)
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--dry-run']).out).toContain('already a Talos agent')
  }, 240_000)

  it('a failed gate says whose problem it is, and the three steps: roll back, update or fix, run again', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    // a kit test that fails while its copy in the folder is the kit's own, byte for byte: the kit's problem
    const kitFail = {
      TALOS_INSTALL_GATE_CMD: 'echo "     FAIL  scripts/test-permission-relay.sh fails -- run it"; exit 1',
    }
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], kitFail)
    expect(first.code, first.out).toBe(1)
    expect(first.stderr).toContain(
      "the failing tests are the kit's own (scripts/test-permission-relay.sh), unchanged in your folder",
    )
    expect(first.stderr).toMatch(/1\) roll back: bash .*upgrade\.sh --rollback .* --into /)
    expect(first.stderr).toContain(`2) update the kit: git -C ${REPO} pull`)
    expect(first.stderr).toContain('3) run ./install.sh --agent-dir')
    expect(first.stderr).toContain('Without the rollback a new run tests the same copies in your folder')
    // the same test, edited in her folder: no longer said to be the kit's
    writeFileSync(join(dir, 'scripts', 'test-permission-relay.sh'), '# edited by the owner\n')
    const mine = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], kitFail)
    expect(mine.stderr).toContain("it may be this Mac's tools or something in your folder")
    expect(mine.stderr).toContain('2) fix what the FAIL lines name')
    // a failure that names no kit script: not the kit's either
    const other = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 1))
    expect(other.stderr).toContain("it may be this Mac's tools or something in your folder")
    // put her copy back: two kit tests, in the suites' other wording, are the kit's ...
    writeFileSync(
      join(dir, 'scripts', 'test-permission-relay.sh'),
      readFileSync(join(REPO, 'kit', 'scripts', 'test-permission-relay.sh')),
    )
    const two = {
      TALOS_INSTALL_GATE_CMD:
        'echo "  FAIL  scripts/test-permission-relay.sh fails"; echo "  FAIL  the jobs suite fails -- run scripts/test-jobs.sh"; exit 1',
    }
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], two).stderr).toContain(
      "the failing tests are the kit's own (scripts/test-jobs.sh scripts/test-permission-relay.sh)",
    )
    // ... but not when a line about her folder fails beside them
    const mixed = {
      TALOS_INSTALL_GATE_CMD:
        'echo "  FAIL  scripts/test-permission-relay.sh fails"; echo "  FAIL  the rendered config fails its own lint"; exit 1',
    }
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], mixed).stderr).toContain(
      "it may be this Mac's tools or something in your folder",
    )
  }, 240_000)

  it('the rollback a failed gate prints ends the carry: .talos-carry goes with it, and says so', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 1))
    expect(first.code, first.out).toBe(1)
    const backup = /^backup=(.*)$/m.exec(readFileSync(join(dir, CARRY), 'utf8'))?.[1] ?? ''
    expect(existsSync(backup)).toBe(true)
    const rb = spawnSync('bash', [join(REPO, 'kit', 'scripts', 'upgrade.sh'), '--rollback', backup, '--into', dir], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home },
    })
    expect(rb.status, rb.stdout + rb.stderr).toBe(0)
    expect(rb.stdout).toContain(
      "removed .talos-carry, the installer's note that a carry was under way: this rollback ends it",
    )
    expect(existsSync(join(dir, CARRY))).toBe(false)
    expect(existsSync(join(dir, '.talos-version'))).toBe(false)
    // a rollback from another backup leaves a carry's note alone (it is not that carry's)
    writeFileSync(join(dir, CARRY), 'backup=/nowhere/else\n')
    const other = spawnSync('bash', [join(REPO, 'kit', 'scripts', 'upgrade.sh'), '--rollback', backup, '--into', dir], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home },
    })
    expect(other.stdout).toContain('kept .talos-carry: it names another backup (/nowhere/else)')
    expect(existsSync(join(dir, CARRY))).toBe(true)
    rmSync(join(dir, CARRY))
    // and the folder is a kit 1.x folder again: the next plan carries it from the start
    expect(run(sb, ['--agent-dir', dir, '--no-app'], gate(sb, 0)).out).toContain(
      'an agent from kit 1.x with no .talos-version',
    )
  }, 240_000)

  it('the plan names what PROTECTED covers in her folder, and does not ask for a merge by hand that the next step does', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    const plan = run(sb, ['--agent-dir', dir, '--no-app'], gate(sb, 0))
    expect(plan.code, plan.out).toBe(0)
    expect(plan.out).toMatch(
      /covers, in your folder: CLAUDE\.md, memory\/ \(\d+ files\), wiki\/ \(your notes\), \.learnings\/ \(\d+ files\), \.env, \.claude\/ \(your settings\)/,
    )
    expect(plan.out).not.toContain('by hand, keeping your permissions')
    expect(plan.out).toContain(
      'next step (settings-merge.py, with a backup first) adds these entries and keeps your permissions',
    )
    // upgrade.sh on its own (kit/UPGRADE.md, by hand) still asks for the merge by hand: nothing else would do it
    const alone = spawnSync('bash', [join(REPO, 'kit', 'scripts', 'upgrade.sh'), '--into', dir, '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home },
    })
    expect(alone.stdout).toContain('by hand, keeping your permissions')
    // the real upgrade says the same, and the merge that follows does it
    const done = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 0))
    expect(done.code, done.out).toBe(0)
    expect(done.out).toContain('next step (settings-merge.py, with a backup first) adds these entries')
    expect(done.out).not.toContain('by hand, keeping your permissions')
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toContain('pre-tool-guard')
  }, 240_000)

  it("verify-install's findings about her own notes read as notes, not FAIL lines beside Done", () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 0)).code).toBe(0)
    const fin = run(sb, ['--agent-dir', dir, '--no-app', '--yes'], gate(sb, 0))
    expect(fin.code, fin.out).toBe(0)
    const all = fin.out + fin.stderr
    // the kit 1.x fixture's notes, as a real older folder has them (seen in the second-user dry run, 2026-11-13)
    expect(all).toContain('2 notes about your own files, not part of the install')
    expect(all).toContain('note: wiki/_onboarding-progress.md missing')
    expect(all).not.toMatch(/^ +FAIL /m)
    expect(all).toContain('Also: 2 notes about your own files (above); the install itself is done.')
  }, 240_000)

  it('a gate that passed is not run again when a later step is what failed', () => {
    const sb = sandbox()
    const dir = v1Agent(sb)
    chmodSync(join(dir, '.claude'), 0o555)
    const first = run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 0))
    chmodSync(join(dir, '.claude'), 0o755)
    expect(first.code, first.out).toBe(1)
    expect(readFileSync(join(dir, CARRY), 'utf8')).toContain('gate=passed')
    expect(run(sb, ['--agent-dir', dir, '--no-app', '--apply', '--yes'], gate(sb, 0)).code).toBe(0)
    expect(gateRuns(sb)).toBe(1)
  }, 180_000)
})
