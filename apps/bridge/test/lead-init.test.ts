// `talos-app lead init <thread-id> --folder <dir>`: a lead's folder, its brief, board, decisions, fence and Stop hook,
// and the thread's session_opts.cwd, set through the config file like every other session change.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { paths } from '../src/config.ts'
import { cmdLead } from '../src/lead/cli.ts'
import { LEAD_BOARD_MAX, LEAD_BRIEF_MAX } from '../src/lead/settings.ts'
import { COMMANDS, terminalOnly } from '../src/talos.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}

function setup() {
  const talosHome = tmp('tl-home-')
  const agentDir = tmp('tl-agent-')
  writeFileSync(join(agentDir, '.talos-version'), '1')
  // folders must sit under $HOME for the existing check; the tests point it at a fake home through roots
  const base = tmp('tl-lead-')
  const cfgPath = paths(talosHome).configJson
  const cfg = {
    ...defaultConfig,
    threads: [
      ...(defaultConfig as { threads: unknown[] }).threads,
      {
        id: 'trip',
        name: 'Trip',
        kind: 'agent',
        order: 9,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'garden',
        name: 'Garden',
        kind: 'agent',
        order: 10,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), isTerminal: true }
  const env = { home: talosHome } as never
  const claudeDir = join(base, '.claude')
  const run = (
    args: string[],
    deps: { agentDir?: string; claudeDir?: string; pathDirs?: string[]; tmpDirs?: string[] } = {},
  ) => cmdLead(env, args, io, { home: base, claudeDir, pathDirs: [], ...deps })
  return { talosHome, agentDir, base, cfgPath, lines, run, io, env, claudeDir }
}
const cwdOf = (cfgPath: string, id = 'trip') =>
  (JSON.parse(readFileSync(cfgPath, 'utf8')).threads as Array<{ id: string; session_opts?: { cwd?: string } }>).find(
    (t) => t.id === id,
  )?.session_opts?.cwd

describe('lead init', () => {
  test('creates the folder with brief, board, decisions, fence and hooks, and sets the thread folder', () => {
    const s = setup()
    const dir = join(s.base, 'leads', 'trip')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--sandbox'])).toBe(0)
    for (const f of [
      'CLAUDE.md',
      'BOARD.md',
      'decisions.md',
      '.claude/settings.json',
      '.claude/hooks/board-stop.sh',
      '.claude/hooks/turn-start.sh',
      '.talos-lead',
    ])
      expect(existsSync(join(dir, f)), f).toBe(true)
    expect(statSync(join(dir, '.claude/hooks/board-stop.sh')).mode & 0o111).not.toBe(0)
    expect(cwdOf(s.cfgPath)).toBe(dir)
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
    expect(settings.permissions.deny).toContain(`Read(/${s.agentDir}/**)`)
    expect(settings.permissions.deny).toContain(`Read(/${s.talosHome}/**)`)
    expect(settings.disableClaudeAiConnectors).toBe(true)
    expect(settings.hooks.PreToolUse).toBeUndefined()
    expect(settings.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Monitor', 'Tmux', 'PowerShell']))
    expect(settings.permissions.deny).toContain(`Read(/${s.claudeDir}/**)`)
    expect(settings.permissions.deny).toContain(`Edit(/${s.claudeDir}/**)`)
    expect(settings.permissions.deny).toContain('mcp__computer-use__*')
    expect(settings.env.npm_config_cache).toBe(join(dir, '.cache', 'npm'))
    expect(existsSync(join(dir, '.claude/hooks/lead-guard.sh'))).toBe(false)
    const marker = JSON.parse(readFileSync(join(dir, '.talos-lead'), 'utf8'))
    expect(marker.thread).toBe('trip')
    expect(marker.claude_dir).toBe(s.claudeDir)
    expect(marker.protect).toEqual(
      expect.arrayContaining([s.agentDir, s.talosHome, join(s.base, 'private-agent-vault')]),
    )
  })

  test('the autostart paths and the PATH folders (read once by the CLI) are closed to the file tools', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    const bin = '/Users/alex/tools/bin'
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir], { pathDirs: [bin, '/tmp/x'] })).toBe(0)
    const d = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).permissions.deny as string[]
    expect(d).toContain(`Edit(/${s.base}/.zshrc)`)
    expect(d).toContain(`NotebookEdit(/${s.base}/.ssh/**)`)
    expect(d).toContain(`Write(/${bin}/**)`)
    expect(d.some((r) => r.includes('/tmp/x'))).toBe(false)
    expect(d).not.toContain(`Read(/${s.base}/.zshrc)`)
    // lead check leaves the PATH-derived rules out
    const j = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
    j.permissions.deny = j.permissions.deny.filter((r: string) => !r.includes('/tools/bin'))
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(j))
    expect(s.run(['check', dir])).toBe(0)
  })

  test('a re-run over an old folder removes the old guard script and its registration', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--sandbox'])
    const guard = join(dir, '.claude/hooks/lead-guard.sh')
    writeFileSync(guard, '#!/bin/sh\n')
    const sp = join(dir, '.claude/settings.json')
    const old = JSON.parse(readFileSync(sp, 'utf8'))
    old.hooks.PreToolUse = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/lead-guard.sh' }] },
    ]
    old.sandbox = { enabled: false }
    writeFileSync(sp, JSON.stringify(old))
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(existsSync(guard)).toBe(false)
    const now = JSON.parse(readFileSync(sp, 'utf8'))
    expect(now.hooks.PreToolUse).toBeUndefined()
    expect(now.sandbox.enabled).toBe(true)
    expect(s.lines.join('\n')).toMatch(/sandbox/)
  })

  test('an old guard script that is a symbolic link is refused and its target is untouched', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    const victim = join(s.base, 'victim.sh')
    writeFileSync(victim, 'precious')
    symlinkSync(victim, join(dir, '.claude/hooks/lead-guard.sh'))
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
  })

  test('CLAUDE_CONFIG_DIR (deps.claudeDir) makes that whole folder a root, beside ~/.claude, and is kept in the marker', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    const cfgDir = join(s.base, 'cfg')
    expect(
      s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--sandbox'], { claudeDir: cfgDir }),
    ).toBe(0)
    const d = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).permissions.deny as string[]
    expect(d).toContain(`Read(/${cfgDir}/**)`)
    expect(d).toContain(`Edit(/${cfgDir}/**)`)
    expect(d).toContain(`Read(/${s.base}/.claude/**)`)
    expect(d).toContain(`Read(/${s.base}/.claude.json)`)
    expect(d).toContain(`Read(/${s.base}/.claude.json.backup)`)
    expect(JSON.parse(readFileSync(join(dir, '.talos-lead'), 'utf8')).claude_dir).toBe(cfgDir)
  })

  test('a CLAUDE_CONFIG_DIR that is relative or starts with ~ is an error in init and writes nothing', () => {
    for (const bad of ['rel/cfg', '~/cfg']) {
      const s = setup()
      const dir = join(s.base, 'trip')
      s.lines.length = 0
      const code = cmdLead(s.env, ['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir], s.io, {
        home: s.base,
        configDirEnv: bad,
      })
      expect(code, bad).toBe(1)
      expect(s.lines.join('\n')).toMatch(/CLAUDE_CONFIG_DIR/)
      expect(existsSync(dir)).toBe(false)
    }
  })

  test('the old guard script is removed only after the new settings.json is in place', () => {
    if (process.getuid?.() === 0) return // a read-only folder does not stop root
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    const guard = join(dir, '.claude/hooks/lead-guard.sh')
    writeFileSync(guard, '#!/bin/sh\n')
    const sp = join(dir, '.claude/settings.json')
    const before = readFileSync(sp, 'utf8')
    chmodSync(join(dir, '.claude'), 0o555) // the settings.json write cannot create its temp file
    try {
      expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
      expect(existsSync(guard)).toBe(true)
      expect(readFileSync(sp, 'utf8')).toBe(before)
    } finally {
      chmodSync(join(dir, '.claude'), 0o755)
    }
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(existsSync(guard)).toBe(false)
  })

  test('a root or --protect path with a glob character is refused with nothing written', () => {
    for (const bad of ['*', '?', '[', ']', '{', '}']) {
      const s = setup()
      const dir = join(s.base, 'trip')
      s.lines.length = 0
      const code = s.run([
        'init',
        'trip',
        '--folder',
        dir,
        '--agent-dir',
        s.agentDir,
        '--protect',
        join(s.base, `d${bad}x`),
      ])
      expect(code, bad).toBe(1)
      expect(s.lines.join('\n'), bad).toMatch(/glob/i)
      expect(existsSync(dir)).toBe(false)
    }
    // the agent folder, the Talos home and the Claude config folder are roots too
    const s = setup()
    const odd = join(s.base, 'agent[1]')
    mkdirSync(odd)
    writeFileSync(join(odd, '.talos-version'), '1')
    expect(s.run(['init', 'trip', '--folder', join(s.base, 'trip'), '--agent-dir', odd])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/glob/i)
    s.lines.length = 0
    expect(
      s.run(['init', 'trip', '--folder', join(s.base, 'trip'), '--agent-dir', s.agentDir], {
        claudeDir: join(s.base, 'cfg*'),
      }),
    ).toBe(1)
    expect(s.lines.join('\n')).toMatch(/glob/i)
    expect(existsSync(join(s.base, 'trip'))).toBe(false)
  })

  test('the standing brief says what a lead must know, and both files are within their caps', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    const brief = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(LEAD_BRIEF_MAX)
    expect(Buffer.byteLength(readFileSync(join(dir, 'BOARD.md'), 'utf8'))).toBeLessThanOrEqual(LEAD_BOARD_MAX)
    expect(brief).toMatch(/trust=agent/)
    expect(brief).toMatch(/approve nothing/i)
    expect(brief).toMatch(/reply in this thread/i)
    expect(brief).toMatch(/normal reply, never a pop-up/i)
    expect(brief).toMatch(/no git in the main agent folder/i)
    expect(brief).toContain('Rules carried from main')
    expect(brief).not.toContain('{{')
    const board = readFileSync(join(dir, 'BOARD.md'), 'utf8')
    for (const h of ['Now', 'Next', 'Waiting on', 'Note to next session']) expect(board).toContain(h)
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toMatch(/append-only/i)
  })

  test("running it again is a no-op: the owner's edits stay, the fence is rewritten, the thread folder is the same", () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    writeFileSync(join(dir, 'CLAUDE.md'), 'my own brief')
    writeFileSync(join(dir, 'decisions.md'), 'a decision')
    rmSync(join(dir, '.claude/settings.json'))
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('my own brief')
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe('a decision')
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true)
    expect(cwdOf(s.cfgPath)).toBe(dir)
  })

  test('a folder with files it did not create is refused and nothing is written or changed', () => {
    const s = setup()
    const dir = join(s.base, 'mine')
    mkdirSync(dir)
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/not empty/)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
    expect(cwdOf(s.cfgPath)).toBeUndefined()
  })

  test('a lead folder made for another thread is refused', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    expect(s.run(['init', 'garden', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/another thread|belongs to/)
  })

  test('an empty existing folder is fine; the main agent folder, or a folder inside it, is refused', () => {
    const s = setup()
    const empty = join(s.base, 'empty')
    mkdirSync(empty)
    expect(s.run(['init', 'trip', '--folder', empty, '--agent-dir', s.agentDir])).toBe(0)
    const s2 = setup()
    expect(s2.run(['init', 'trip', '--folder', s2.agentDir, '--agent-dir', s2.agentDir])).toBe(1)
    expect(s2.run(['init', 'trip', '--folder', join(s2.agentDir, 'leads', 'trip'), '--agent-dir', s2.agentDir])).toBe(1)
    expect(s2.lines.join('\n')).toMatch(/outside the main agent folder/)
    expect(existsSync(join(s2.agentDir, 'leads'))).toBe(false)
  })

  test('an unknown thread, a missing or relative folder, or a missing agent folder is a usage error and writes nothing', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    expect(s.run(['init', 'nope', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.run(['init', 'trip', '--agent-dir', s.agentDir])).toBe(2)
    expect(s.run(['init', 'trip', '--folder', 'rel/dir', '--agent-dir', s.agentDir])).toBe(2)
    expect(s.run(['init', 'trip', '--folder', dir])).toBe(2)
    expect(existsSync(dir)).toBe(false)
    expect(cwdOf(s.cfgPath)).toBeUndefined()
  })

  test('the default thread is refused: it is always the main session', () => {
    const s = setup()
    const def = (JSON.parse(readFileSync(s.cfgPath, 'utf8')) as { default_thread: string }).default_thread
    expect(s.run(['init', def, '--folder', join(s.base, 'd'), '--agent-dir', s.agentDir])).toBe(1)
  })

  test('it is an owner-terminal command: refused when stdin or stdout is not a terminal', () => {
    expect(terminalOnly(['lead', 'init', 'trip'])).toBe('lead init')
    expect(COMMANDS.find((c) => c.name === 'lead init')?.agent_may_run).toBe(false)
    expect(terminalOnly(['lead', 'check', 'x'])).toBeUndefined()
  })
})

describe('lead init: safety', () => {
  const noFiles = (d: string) => expect(existsSync(d), `${d} must not exist`).toBe(false)

  test('a folder inside ~/.claude is refused before anything is written, not even the folder', () => {
    const s = setup()
    const dir = join(s.base, '.claude', 'leads', 'trip')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/\.claude/)
    noFiles(join(s.base, '.claude'))
    expect(cwdOf(s.cfgPath)).toBeUndefined()
  })
  test('a folder inside the Talos home, or the home itself, or outside $HOME, is refused with nothing written', () => {
    const s = setup()
    const inTalos = join(s.talosHome, 'leads', 'trip')
    expect(s.run(['init', 'trip', '--folder', inTalos, '--agent-dir', s.agentDir])).toBe(1)
    noFiles(join(s.talosHome, 'leads'))
    expect(s.run(['init', 'trip', '--folder', s.base, '--agent-dir', s.agentDir])).toBe(1)
    expect(readdirSync(s.base).sort()).toEqual([])
    const outside = join(tmp('tl-out-'), 'trip')
    expect(s.run(['init', 'trip', '--folder', outside, '--agent-dir', s.agentDir])).toBe(1)
    noFiles(outside)
  })
  test('a folder under a symlink that leads into ~/.claude is refused with nothing written', () => {
    const s = setup()
    mkdirSync(join(s.base, '.claude'))
    symlinkSync(join(s.base, '.claude'), join(s.base, 'innocent'))
    expect(s.run(['init', 'trip', '--folder', join(s.base, 'innocent', 'trip'), '--agent-dir', s.agentDir])).toBe(1)
    expect(readdirSync(join(s.base, '.claude'))).toEqual([])
  })
  test('a folder that holds a protected root, or sits inside one the owner added, is refused', () => {
    const s = setup()
    const docs = join(s.base, 'Documents')
    mkdirSync(join(docs, 'taxes'), { recursive: true })
    expect(s.run(['init', 'trip', '--folder', docs, '--agent-dir', s.agentDir, '--protect', join(docs, 'taxes')])).toBe(
      1,
    )
    expect(
      s.run([
        'init',
        'trip',
        '--folder',
        join(docs, 'taxes', 'trip'),
        '--agent-dir',
        s.agentDir,
        '--protect',
        join(docs, 'taxes'),
      ]),
    ).toBe(1)
    noFiles(join(docs, 'taxes', 'trip'))
    expect(existsSync(join(docs, 'CLAUDE.md'))).toBe(false)
  })
  test('init re-run over a symlinked hook script is refused, the link target is untouched and nothing else is rewritten', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    const victim = join(s.base, 'victim.sh')
    writeFileSync(victim, 'precious')
    const hook = join(dir, '.claude/hooks/board-stop.sh')
    rmSync(hook)
    symlinkSync(victim, hook)
    const settingsBefore = readFileSync(join(dir, '.claude/settings.json'), 'utf8')
    writeFileSync(join(dir, '.claude/settings.json'), `${settingsBefore} `) // a marker that a rewrite would remove
    s.lines.length = 0
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/symlink|link/i)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(lstatSync(hook).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).toBe(`${settingsBefore} `)
  })
  test('a symlinked settings.json, marker, brief, .claude folder or lead folder is refused and never followed', () => {
    for (const rel of ['.claude/settings.json', '.talos-lead', 'CLAUDE.md', '.claude/hooks', '.claude', '']) {
      const s = setup()
      const dir = join(s.base, 'trip')
      expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
      const victimDir = tmp('tl-victim-')
      const victim = join(victimDir, 'v')
      writeFileSync(victim, 'precious')
      const target = rel ? join(dir, rel) : dir
      const isDir = rel === '.claude' || rel === '.claude/hooks' || rel === ''
      const aim = isDir ? victimDir : victim
      if (rel === '') {
        const moved = `${dir}-real`
        renameSync(dir, moved)
        symlinkSync(moved, dir)
      } else {
        rmSync(target, { recursive: true, force: true })
        symlinkSync(aim, target)
      }
      s.lines.length = 0
      expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir]), rel || 'folder').toBe(1)
      expect(readFileSync(victim, 'utf8')).toBe('precious')
      expect(readdirSync(victimDir), rel).toEqual(['v'])
    }
  })
  test('a typo in --agent-dir is refused: a missing folder, or a folder that is not an agent folder', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', `${s.agentDir}-typo`])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/agent folder/)
    const plain = tmp('tl-plain-')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', plain])).toBe(1)
    noFiles(dir)
    expect(cwdOf(s.cfgPath)).toBeUndefined()
    // a CLAUDE.md alone is enough to be an agent folder
    writeFileSync(join(plain, 'CLAUDE.md'), '# me')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', plain])).toBe(0)
  })
  test('--agent-dir defaults from TALOS_AGENT_DIR; with neither it is a usage error', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    expect(s.run(['init', 'trip', '--folder', dir])).toBe(2)
    noFiles(dir)
    expect(s.run(['init', 'trip', '--folder', dir], { agentDir: s.agentDir })).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, '.talos-lead'), 'utf8')).agent_dir).toBe(s.agentDir)
  })
  test('--protect adds a root, keeps it on a re-run, and must be absolute', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    const extra = join(s.base, 'Documents', 'taxes')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--protect', extra])).toBe(0)
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, '.talos-lead'), 'utf8')).protect).toContain(extra)
    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).permissions.deny).toContain(
      `Read(/${extra}/**)`,
    )
    expect(s.run(['init', 'trip', '--folder', join(s.base, 'x'), '--agent-dir', s.agentDir, '--protect', 'rel'])).toBe(
      2,
    )
  })
  test("the owner's servers in ~/.claude.json are not turned into deny rules: the Mac app applies the thread's list", () => {
    const s = setup()
    writeFileSync(
      join(s.base, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'talos-browser': {}, blender: {} },
        projects: { [s.agentDir]: { disabledMcpServers: ['old-mail'] } },
      }),
    )
    const dir = join(s.base, 'trip')
    expect(s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])).toBe(0)
    const d = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).permissions.deny as string[]
    expect(d.filter((r) => r.startsWith('mcp__')).sort()).toEqual(['mcp__claude-in-chrome__*', 'mcp__computer-use__*'])
  })
})

describe('lead check', () => {
  test('reports an oversize brief or board and an unmarked folder, and passes a fresh one', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    s.lines.length = 0
    expect(s.run(['check', dir])).toBe(0)
    writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(LEAD_BRIEF_MAX + 1))
    writeFileSync(join(dir, 'BOARD.md'), 'y'.repeat(LEAD_BOARD_MAX + 1))
    expect(s.run(['check', dir])).toBe(1)
    const out = s.lines.join('\n')
    expect(out).toMatch(/CLAUDE\.md.*over/)
    expect(out).toMatch(/BOARD\.md.*over/)
    expect(s.run(['check', s.base])).toBe(1)
  })
  test('a folder whose fence rules were removed is reported', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    writeFileSync(join(dir, '.claude/settings.json'), '{}')
    s.lines.length = 0
    expect(s.run(['check', dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.lines.join('\n')).toMatch(/fence/)
  })
  test('a fresh folder passes, and needs no guard script', () => {
    const s = setup()
    const dir = join(s.base, 'trip')
    s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir])
    s.lines.length = 0
    expect(s.run(['check', dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(s.lines.join('\n')).not.toMatch(/guard/)
  })

  describe('the sandbox settings', () => {
    const fresh = () => {
      const s = setup()
      const dir = join(s.base, 'trip')
      s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--sandbox'])
      const sp = join(dir, '.claude/settings.json')
      const edit = (f: (j: never) => void) => {
        const j = JSON.parse(readFileSync(sp, 'utf8'))
        f(j as never)
        writeFileSync(sp, JSON.stringify(j))
      }
      const check = () => {
        s.lines.length = 0
        return { code: s.run(['check', dir, '--agent-dir', s.agentDir]), out: s.lines.join('\n') }
      }
      return { s, dir, edit, check }
    }
    type J = { sandbox: Record<string, unknown>; permissions: { deny: string[] } }
    const drop = (name: string) => (j: J) => {
      j.permissions.deny = j.permissions.deny.filter((d) => d !== name)
    }
    const cases: Array<[string, (j: J) => void, RegExp]> = [
      ['sandbox.enabled is not true', (j) => (j.sandbox.enabled = false), /sandbox\.enabled/],
      ['sandbox missing', (j) => delete (j as Partial<J>).sandbox, /sandbox\.enabled/],
      ['failIfUnavailable is not true', (j) => (j.sandbox.failIfUnavailable = false), /failIfUnavailable/],
      [
        'allowUnsandboxedCommands is not false',
        (j) => delete j.sandbox.allowUnsandboxedCommands,
        /allowUnsandboxedCommands/,
      ],
      ['excludedCommands is not empty', (j) => (j.sandbox.excludedCommands = ['git']), /excludedCommands/],
      ['filesystem.allowRead is not empty', (j) => (j.sandbox.filesystem = { allowRead: ['/x'] }), /allowRead/],
      ['filesystem.allowWrite is not empty', (j) => (j.sandbox.filesystem = { allowWrite: ['/x'] }), /allowWrite/],
      ['filesystem.disabled is set', (j) => (j.sandbox.filesystem = { disabled: true }), /filesystem\.disabled/],
      ['the computer-use MCP deny is missing', drop('mcp__computer-use__*'), /computer-use/],
      [
        'an autostart file deny is missing',
        (j) => {
          j.permissions.deny = j.permissions.deny.filter((d) => !(d.startsWith('Edit(//') && d.endsWith('/.zshrc)')))
        },
        /deny rule/,
      ],
      [
        'an autostart folder deny is missing',
        (j) => {
          j.permissions.deny = j.permissions.deny.filter(
            (d) => !(d.startsWith('NotebookEdit(//') && d.includes('/.ssh')),
          )
        },
        /deny rule/,
      ],
      ['Monitor deny missing', drop('Monitor'), /Monitor/],
      ['Tmux deny missing', drop('Tmux'), /Tmux/],
      ['PowerShell deny missing', drop('PowerShell'), /PowerShell/],
      ['SendMessage deny missing', drop('SendMessage'), /SendMessage/],
      ['ListAgents deny missing', drop('ListAgents'), /ListAgents/],
      ['RemoteTrigger deny missing', drop('RemoteTrigger'), /RemoteTrigger/],
      [
        'a root Read deny missing',
        (j) => {
          j.permissions.deny = j.permissions.deny.filter(
            (d) => !(d.startsWith('Read(//') && d.includes('.claude.json.backup')),
          )
        },
        /deny rule/,
      ],
    ]
    test.each(cases)('a problem when %s', (_name, change, re) => {
      const f = fresh()
      f.edit(change)
      const r = f.check()
      expect(r.code).toBe(1)
      expect(r.out).toMatch(re)
    })
    test('a settings.local.json in the lead folder that sets a sandbox key or permissions.allow is a problem', () => {
      for (const local of [{ sandbox: { enabled: false } }, { permissions: { allow: ['Bash(*)'] } }]) {
        const f = fresh()
        writeFileSync(join(f.dir, '.claude/settings.local.json'), JSON.stringify(local))
        const r = f.check()
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/settings\.local\.json/)
      }
      const f = fresh()
      writeFileSync(join(f.dir, '.claude/settings.local.json'), JSON.stringify({ model: 'sonnet' }))
      expect(f.check().code).toBe(0)
    })
    test("the owner's user settings that weaken the sandbox are reported as weakening every lead", () => {
      for (const user of [
        { sandbox: { excludedCommands: ['docker'] } },
        { sandbox: { filesystem: { allowRead: ['/Users/alex'] } } },
        { sandbox: { filesystem: { allowWrite: ['/Users/alex'] } } },
        { sandbox: { filesystem: { disabled: true } } },
      ]) {
        const f = fresh()
        mkdirSync(f.s.claudeDir, { recursive: true })
        writeFileSync(join(f.s.claudeDir, 'settings.json'), JSON.stringify(user))
        const r = f.check()
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/every lead/)
      }
      const f = fresh()
      mkdirSync(f.s.claudeDir, { recursive: true })
      writeFileSync(join(f.s.claudeDir, 'settings.json'), JSON.stringify({ sandbox: { enabled: true }, theme: 'dark' }))
      expect(f.check().code).toBe(0)
    })
    test("a user sandbox.enabled: false is not reported: the lead's own true wins", () => {
      const f = fresh()
      mkdirSync(f.s.claudeDir, { recursive: true })
      writeFileSync(join(f.s.claudeDir, 'settings.json'), JSON.stringify({ sandbox: { enabled: false } }))
      expect(f.check().code).toBe(0)
    })
    test('lead check reads the Claude folder from the marker first, then the env, then ~/.claude', () => {
      const s = setup()
      const dir = join(s.base, 'trip')
      const cfgDir = join(s.base, 'cfg')
      s.run(['init', 'trip', '--folder', dir, '--agent-dir', s.agentDir, '--sandbox'], { claudeDir: cfgDir })
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['docker'] } }))
      s.lines.length = 0
      // the check is run with a different folder in its env: the marker's wins
      expect(s.run(['check', dir], { claudeDir: join(s.base, 'elsewhere') })).toBe(1)
      expect(s.lines.join('\n')).toMatch(/every lead/)
      // a marker without claude_dir (an older init) falls back to the folder the check was given
      const mp = join(dir, '.talos-lead')
      const m = JSON.parse(readFileSync(mp, 'utf8'))
      delete m.claude_dir
      writeFileSync(mp, JSON.stringify(m))
      s.lines.length = 0
      expect(s.run(['check', dir], { claudeDir: cfgDir })).toBe(1)
      expect(s.lines.join('\n')).toMatch(/every lead/)
    })
    test('a missing or broken user settings file is not a problem', () => {
      const f = fresh()
      mkdirSync(f.s.claudeDir, { recursive: true })
      writeFileSync(join(f.s.claudeDir, 'settings.json'), '{ nope')
      expect(f.check().code).toBe(0)
    })
  })
})

void homedir
