// The agent session must not inherit another Claude session's markers: Claude Code 2.1.317 reads an inherited
// CLAUDE_CODE_CHILD_SESSION as "I am a child" and stops saving the transcript (2026-11-03). Mirrors the Mac app's
// ClaudeEnvScrub (apps/desktop); the two lists are pinned by their own tests.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcReader } from '../src/claude-env.ts'
import {
  ALWAYS_DROP,
  KEEP as KEEP_NAMES,
  KEEP_PREFIXES,
  launchEnv,
  psShowsChildEnv,
  SESSION_MARKERS,
  sessionMarkerInherited,
  stripClaudeMarkers,
} from '../src/claude-env.ts'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { parseStatusFile, readStatusFile, STATUS_KEYS } from '../src/status-file.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

const POLLUTED: Record<string, string> = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: '0f1e2d3c-4b5a-4968-8776-655443322110',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge_x',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
  CLAUDE_CODE_EXECPATH: '/home/alex/.local/bin/claude',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SSE_PORT: '5555',
  CLAUDE_CODE_SOMETHING_NEW: '1',
  CLAUDECODE: '1',
  CLAUDE_PID: '123',
  CLAUDE_EFFORT: 'high',
  TMUX: '/tmp/tmux-1/x,1,0',
  TMUX_PANE: '%3',
}
const KEEP: Record<string, string> = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
}

describe('stripClaudeMarkers', () => {
  test('drops every marker, keeps PATH, HOME, the keep-list and unrelated CLAUDE_ variables', () => {
    const out = stripClaudeMarkers({
      PATH: '/usr/bin',
      HOME: '/home/alex',
      CLAUDE_CONFIG_DIR: '/c',
      ...POLLUTED,
      ...KEEP,
    })
    for (const k of Object.keys(POLLUTED)) expect(out[k]).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/alex')
    expect(out.CLAUDE_CONFIG_DIR).toBe('/c')
    expect(out.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000')
    expect(out.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000')
  })

  test('launchEnv puts the bridge variables on top of the scrubbed parent', () => {
    const out = launchEnv({ PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1' }, { TALOS_APP_BRIDGE: '1' })
    expect(out).toEqual({ PATH: '/bin', TALOS_APP_BRIDGE: '1' })
  })
})

describe('talos-app start, as a real process', () => {
  test('the claude it launches does not see the markers of the shell that ran start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cenv-'))
    const agent = join(dir, 'agent')
    Bun.spawnSync(['mkdir', '-p', agent])
    writeFileSync(
      join(agent, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'talos-app': { command: 'bun', args: ['run', '--cwd', '/x', '--silent', 'start'], env: {} } },
      }),
    )
    const out = join(dir, 'env.txt')
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nenv > ${out}\n`)
    chmodSync(join(dir, 'claude'), 0o755)
    const run = Bun.spawnSync(
      [
        'bun',
        '--no-env-file',
        'run',
        '--no-install',
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'start',
        '--agent-dir',
        agent,
      ],
      {
        env: {
          PATH: `${dir}:/usr/bin:/bin:${process.execPath.replace(/\/bun$/, '')}`,
          HOME: dir,
          TALOS_APP_HOME: join(dir, 'app'),
          ...POLLUTED,
          ...KEEP,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(run.exitCode).toBe(0)
    const seen = readFileSync(out, 'utf8')
    expect(seen).toContain('TALOS_APP_BRIDGE=1')
    for (const k of Object.keys(POLLUTED)) expect(seen).not.toMatch(new RegExp(`^${k}=`, 'm'))
    expect(seen).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000')
  })
})

describe('the bridge records whether its session is polluted', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.stop()
    h = undefined
  })

  test('sessionMarkerInherited reads our own environment first', () => {
    expect(sessionMarkerInherited({ CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(true)
  })

  // Claude Code leaves its markers out of the MCP children it starts, so the bridge's own environment and its
  // parent's are clean even when claude itself was launched polluted. The marker is up the tree.
  // Capability probe: some hosts (a launchd service on CI) never show another process's environment through `ps eww`, so a
  // real-tree check can only read false there. Skip those cases, loudly; the product answers 'unknown' on such a host.
  const psCanReadEnv = psShowsChildEnv()
  if (!psCanReadEnv)
    console.warn(
      'SKIPPING real-process-tree marker tests: `ps eww` does not show a child process environment on this host (probe TALOS_PROBE=1 not visible)',
    )
  describe.skipIf(!psCanReadEnv)('with a real process tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-'))
    const checker = join(dir, 'checker.ts')
    writeFileSync(
      checker,
      `import { sessionMarkerInherited } from ${JSON.stringify(join(import.meta.dir, '../src/claude-env.ts'))}\nconsole.log('RESULT=' + sessionMarkerInherited(process.env, undefined, undefined, Number(process.env.WALK_DEPTH ?? 12)))\n`,
    )
    // ancestor (marker) -> middle (marker removed) -> [middle2] -> checker. `; exit` stops sh from exec-ing the last command, which would collapse the levels.
    function run(marker: boolean, levels: number, walk = 12): string {
      let inner = `${process.execPath} ${checker}; exit`
      for (let i = 0; i < levels; i++) inner = `env -u CLAUDE_CODE_CHILD_SESSION sh -c ${JSON.stringify(inner)}; exit`
      const r = spawnSync('sh', ['-c', `${inner}`], {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          WALK_DEPTH: String(walk),
          ...(marker ? { CLAUDE_CODE_CHILD_SESSION: '1' } : {}),
        },
      })
      return `${r.stdout}${r.stderr}`
    }

    test('finds the marker on a grandparent whose child process does not carry it', () => {
      expect(run(true, 1)).toContain('RESULT=true')
    })
    test('finds it several levels up', () => {
      expect(run(true, 3)).toContain('RESULT=true')
    })
    test('no marker in the tree we built reads false', () => {
      // the walk stops at the tree's top (the test runner may itself sit under a polluted session)
      expect(run(false, 2, 3)).toContain('RESULT=false')
    })
  })

  test('the claude pid named by CLAUDE_PID is read first when set', () => {
    const seen: number[] = []
    const proc = {
      parentOf: () => undefined,
      envText: (pid: number) => {
        seen.push(pid)
        return pid === 4242 ? 'claude CLAUDE_CODE_CHILD_SESSION=1' : ''
      },
    }
    expect(sessionMarkerInherited({ CLAUDE_PID: '4242' }, proc)).toBe(true)
    expect(seen[0]).toBe(4242)
  })

  test('stops at a clean claude: a marker on a process above it (the tmux server, the app) does not count', () => {
    const tree: Record<number, { parent: number; text: string }> = {
      200: { parent: 100, text: 'bun run server.ts PATH=/bin' },
      100: { parent: 50, text: '/opt/example/bin/claude --dangerously-skip-permissions PATH=/bin' },
      50: { parent: 1, text: 'tmux -L talos new-session CLAUDE_CODE_CHILD_SESSION=1 PATH=/bin' },
    }
    const proc = { parentOf: (p: number) => tree[p]?.parent, envText: (p: number) => tree[p]?.text ?? '' }
    expect(sessionMarkerInherited({}, proc, 200)).toBe(false)
    tree[100].text = '/opt/example/bin/claude CLAUDE_CODE_CHILD_SESSION=1 PATH=/bin'
    expect(sessionMarkerInherited({}, proc, 200)).toBe(true)
  })

  test('CLAUDE_PID is the answer when set: a polluted parent of a clean claude reads false', () => {
    const proc = {
      parentOf: () => 9,
      envText: (p: number) => (p === 9 ? 'tmux CLAUDE_CODE_CHILD_SESSION=1' : 'claude PATH=/bin'),
    }
    expect(sessionMarkerInherited({ CLAUDE_PID: '4242' }, proc)).toBe(false)
  })

  test('an ancestor lookup that throws reads as unknown, never as a clean answer or an error', () => {
    const proc = {
      parentOf: () => {
        throw new Error('ps gone')
      },
      envText: () => '',
    }
    expect(sessionMarkerInherited({}, proc)).toBe('unknown')
  })

  describe('where the OS will not show process environments', () => {
    const blind = (extra: Partial<ProcReader> = {}): ProcReader => ({
      parentOf: (p) => (p === 200 ? 100 : p === 100 ? 50 : undefined),
      envText: () => 'claude PATH=/bin',
      canReadEnv: () => false,
      ...extra,
    })
    test('a clean-looking walk reads unknown, not false', () => {
      expect(sessionMarkerInherited({}, blind({ envText: () => 'sh PATH=/bin' }), 200)).toBe('unknown')
    })
    test('a walk that reaches claude reads unknown, not false', () => {
      expect(sessionMarkerInherited({}, blind(), 200)).toBe('unknown')
    })
    test('CLAUDE_PID with no marker visible reads unknown', () => {
      expect(sessionMarkerInherited({ CLAUDE_PID: '4242' }, blind(), 200)).toBe('unknown')
    })
    test('a marker that IS visible still reads true', () => {
      expect(sessionMarkerInherited({}, blind({ envText: () => 'sh CLAUDE_CODE_CHILD_SESSION=1' }), 200)).toBe(true)
    })
    test('the same clean walk reads false where the OS can show environments', () => {
      expect(sessionMarkerInherited({}, blind({ canReadEnv: () => true }), 200)).toBe(false)
    })
    test('the real probe returns a boolean and does not leave its child behind', () => {
      expect(typeof psShowsChildEnv()).toBe('boolean')
    })
  })

  test('status.json parsing keeps unknown, and still reads an old frame (no field) as false', () => {
    const base = JSON.parse(
      JSON.stringify({
        v: 1,
        pid: 1,
        instance: 'i',
        started_at: new Date().toISOString(),
        mode: 'live',
        relay: { connected: true, last_connect_at: null, last_close_code: null },
        queue_depth: 0,
        permission_relay: false,
        updated_at: new Date().toISOString(),
      }),
    )
    expect(parseStatusFile(base)?.claude_session_marker_inherited).toBe(false)
    expect(
      parseStatusFile({ ...base, claude_session_marker_inherited: 'unknown' })?.claude_session_marker_inherited,
    ).toBe('unknown')
    expect(parseStatusFile({ ...base, claude_session_marker_inherited: true })?.claude_session_marker_inherited).toBe(
      true,
    )
    // a value from a newer peer that we do not know is not read as a clean answer
    expect(
      parseStatusFile({ ...base, claude_session_marker_inherited: 'maybe' })?.claude_session_marker_inherited,
    ).toBe('unknown')
  })

  test('the name lists are the same as the Mac app ClaudeEnvScrub', () => {
    const swift = readFileSync(
      join(import.meta.dir, '../../desktop/Sources/TalosDesktopCore/ClaudeEnvScrub.swift'),
      'utf8',
    )
    const swiftList = (name: string): string[] => {
      const at = swift.indexOf(`static let ${name}:`)
      expect(at).toBeGreaterThan(-1)
      const open = swift.indexOf('= [', at) + 2
      const close = swift.indexOf(']', open)
      return [...swift.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).sort()
    }
    expect(swiftList('alwaysDrop')).toEqual([...ALWAYS_DROP].sort())
    expect(swiftList('keep')).toEqual([...KEEP_NAMES].sort())
    expect(swiftList('keepPrefixes')).toEqual([...KEEP_PREFIXES].sort())
    expect(swiftList('sessionMarkers')).toEqual([...SESSION_MARKERS].sort())
  })

  test('a real live bridge started under the marker writes it into status.json', async () => {
    const was = process.env.CLAUDE_CODE_CHILD_SESSION
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    try {
      h = await startHarness()
      await waitFor(() => readStatusFile(paths(h?.home ?? '').status) !== undefined, 3000, 'status.json')
      expect(readStatusFile(paths(h.home).status)?.claude_session_marker_inherited).toBe(true)
      expect(STATUS_KEYS).toContain('claude_session_marker_inherited')
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION
      else process.env.CLAUDE_CODE_CHILD_SESSION = was
    }
  })
})

describe('the doctor row', () => {
  const rowFor = async (marker: boolean | 'unknown') => {
    const home = join(mkdtempSync(join(tmpdir(), 'cenv-doc-')), 'app')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      paths(home).status,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        instance: 'i',
        started_at: new Date().toISOString(),
        mode: 'live',
        relay: { connected: true, last_connect_at: null, last_close_code: null },
        queue_depth: 0,
        permission_relay: false,
        permission_relay_declared: false,
        bridge_commit: null,
        ...(marker === undefined ? {} : { claude_session_marker_inherited: marker }),
        updated_at: new Date().toISOString(),
      }),
    )
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    await runCli(['doctor', '--agent-dir', home], io, { TALOS_APP_HOME: home }, { alive: () => true })
    return out.join('\n')
  }
  test('warns, with the fix, when the running session inherited the marker', async () => {
    const text = await rowFor(true)
    expect(text).toMatch(/warn\s+transcript saving: transcripts are not being saved/)
    expect(text).toContain('Restart the session from the Mac app')
  })
  test('says it could not check, in plain words, when the bridge could not read process environments', async () => {
    const text = await rowFor('unknown')
    expect(text).toMatch(/warn\s+transcript saving: couldn't check whether transcripts are saved/)
    expect(text).toContain("this Mac doesn't show process environments")
    expect(text).not.toContain('not being saved')
  })
  test('says nothing when it did not', async () => {
    expect(await rowFor(false)).not.toContain('transcript saving')
  })
})
