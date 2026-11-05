// The lead's settings.json: the OS sandbox switched on and locked, whole-root deny rules (the sandbox turns them into
// kernel-enforced read and write limits), connectors off including the owner's own MCP servers, and the two hooks.
// Fictional paths only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOwnerMcp } from '../src/lead/fence.ts'
import {
  LEAD_AUTOSTART_FILES,
  LEAD_AUTOSTART_FOLDERS,
  LEAD_BOARD_MAX,
  LEAD_DENIED_TOOLS,
  leadSettings,
  mcpDenyRules,
  mergeLeadSettings,
} from '../src/lead/settings.ts'

const opts = {
  agentDir: '/home/alex/My-Agent',
  talosHome: '/home/alex/.talos-app',
  home: '/home/alex',
  claudeDir: '/home/alex/.claude',
}
const deny = (extra = {}) => leadSettings({ ...opts, ...extra }).permissions.deny

describe('leadSettings: deny rules for whole roots', () => {
  test('Read, Grep and Glob are denied for each protected root as //<root>/**', () => {
    const d = deny({ protect: ['/home/alex/Documents/taxes'] })
    for (const tool of ['Read', 'Grep', 'Glob'])
      for (const root of [
        '/home/alex/My-Agent',
        '/home/alex/.claude',
        '/home/alex/.talos-app',
        '/home/alex/private-agent-vault',
        '/home/alex/Documents/taxes',
      ]) {
        expect(d, `${tool} ${root}`).toContain(`${tool}(/${root}/**)`)
        expect(d, `${tool} ${root} bare`).toContain(`${tool}(/${root})`)
      }
  })
  test('the lower-case spelling is denied too, where it differs', () => {
    expect(deny()).toContain('Read(//home/alex/my-agent/**)')
    expect(deny()).toContain('Glob(//home/alex/.talos-app/**)')
  })
  test('the roots cannot be written either, and the lead cannot edit its own .claude', () => {
    const d = deny({ folder: '/home/alex/work/trip' })
    expect(d).toContain('Edit(//home/alex/My-Agent/**)')
    expect(d).toContain('Write(//home/alex/.talos-app/**)')
    expect(d).toContain('Edit(//home/alex/work/trip/.claude/**)')
    expect(d).toContain('Write(//home/alex/work/trip/.claude/**)')
  })
  test('no list of single files is left: the old per-file rules are gone', () => {
    const d = deny().join('\n')
    expect(d).not.toMatch(/STATE\.md|HANDOFF|memory\/personal|history\.sqlite|sqlite3/)
  })
  test('a root that is not absolute is refused, so the fence never points at nothing', () => {
    expect(() => leadSettings({ ...opts, agentDir: 'my-agent' })).toThrow(/absolute/)
    expect(() => leadSettings({ ...opts, talosHome: '' })).toThrow(/absolute/)
    expect(() => leadSettings({ ...opts, protect: ['rel/dir'] })).toThrow(/absolute/)
  })
})

describe('leadSettings: connectors', () => {
  test('account connectors are off by setting and by deny rule; only talos-app is kept', () => {
    const s = leadSettings({ ...opts, ownerMcp: { disabled: [], userScope: ['talos-app'] } })
    expect(s.disableClaudeAiConnectors).toBe(true)
    expect(s.permissions.deny).toContain('mcp__claude_ai_*')
    expect(s.enableAllProjectMcpServers).toBe(false)
    expect(s.permissions.deny.join('\n')).not.toContain('mcp__talos-app')
  })
  test('every plugin MCP server is denied by one rule, and talos-app still is not', () => {
    const d = leadSettings(opts).permissions.deny
    expect(d).toContain('mcp__plugin_*')
    expect(d.some((r) => r.startsWith('mcp__talos-app'))).toBe(false)
    expect('mcp__plugin_zoom-plugin_zoom-mcp__x'.startsWith('mcp__plugin_')).toBe(true)
    expect('mcp__talos-app__reply'.startsWith('mcp__plugin_')).toBe(false)
  })
  test("the owner's user-scope servers and main's disabled servers become mcp__<name>__* deny rules", () => {
    const d = leadSettings({
      ...opts,
      ownerMcp: {
        disabled: ['old-mail', 'plugin:zoom-plugin:zoom-mcp'],
        userScope: ['talos-browser', 'blender', 'talos-app'],
      },
    }).permissions.deny
    for (const r of [
      'mcp__talos-browser__*',
      'mcp__blender__*',
      'mcp__old-mail__*',
      'mcp__plugin_zoom-plugin_zoom-mcp__*',
      'mcp__claude-in-chrome__*',
      'mcp__computer-use__*',
    ])
      expect(d, r).toContain(r)
    expect(d.some((r) => r.startsWith('mcp__talos-app'))).toBe(false)
  })
  test('server names with odd characters get the prefix Claude Code gives their tools', () => {
    expect(mcpDenyRules(['My Server.v2', 'plugin:a b:c.d'])).toEqual(['mcp__My_Server_v2__*', 'mcp__plugin_a_b_c_d__*'])
  })
  test("readOwnerMcp reads the owner's main project entry and user scope from ~/.claude.json", () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'lm-'))
    // Inside the test's own home and never created: readOwnerMcp resolves it on disk, and a path under /home can stall on macOS (autofs).
    const agent = join(home, 'My-Agent')
    try {
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: { 'talos-browser': {}, blender: {}, 'talos-app': {} },
          projects: {
            [agent]: {
              disabledMcpServers: ['old-mail', 'plugin:zoom-plugin:zoom-mcp'],
              mcpServers: { x: {} },
            },
            [join(home, 'other')]: { disabledMcpServers: ['nope'] },
          },
        }),
      )
      const r = readOwnerMcp(home, agent, join(home, '.claude'))
      expect(r.disabled.sort()).toEqual(['old-mail', 'plugin:zoom-plugin:zoom-mcp'])
      expect(r.userScope.sort()).toEqual(['blender', 'talos-app', 'talos-browser'])
      expect(readOwnerMcp(join(home, 'none'), '/x', join(home, 'none', '.claude'))).toEqual({
        disabled: [],
        userScope: [],
      })
      writeFileSync(join(home, '.claude.json'), '{ not json')
      expect(readOwnerMcp(home, '/x', join(home, '.claude'))).toEqual({ disabled: [], userScope: [] })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readOwnerMcp: the Claude config dir', () => {
  test('with CLAUDE_CONFIG_DIR it reads <claudeDir>/.claude.json and not ~/.claude.json', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'lm-'))
    try {
      mkdirSync(join(home, 'cfg'))
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { homeOne: {} } }))
      writeFileSync(join(home, 'cfg', '.claude.json'), JSON.stringify({ mcpServers: { cfgOne: {} } }))
      expect(readOwnerMcp(home, '/x', join(home, 'cfg')).userScope).toEqual(['cfgOne'])
      expect(readOwnerMcp(home, '/x', join(home, '.claude')).userScope).toEqual(['homeOne'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

const EDITORS = ['Edit', 'Write', 'NotebookEdit']

describe('leadSettings: autostart and exec paths are closed to the file tools', () => {
  test('the fixed list is one exported constant', () => {
    expect(([...LEAD_AUTOSTART_FILES] as string[]).sort()).toEqual(
      [
        '~/.zshrc',
        '~/.zprofile',
        '~/.zshenv',
        '~/.zlogin',
        '~/.bashrc',
        '~/.bash_profile',
        '~/.profile',
        '~/.npmrc',
        '~/.bunfig.toml',
        '~/.gitconfig',
      ].sort(),
    )
    expect(([...LEAD_AUTOSTART_FOLDERS] as string[]).sort()).toEqual(
      [
        '~/.config/fish',
        '~/Library/LaunchAgents',
        '~/Library/LaunchDaemons',
        '~/.ssh',
        '~/.config/git',
        '~/.local/bin',
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ].sort(),
    )
  })
  test('a file gets its exact path, a folder gets /** and the bare path; Edit, Write and NotebookEdit; never Read', () => {
    const d = deny()
    for (const tool of EDITORS) {
      for (const f of [
        '.zshrc',
        '.zprofile',
        '.zshenv',
        '.zlogin',
        '.bashrc',
        '.bash_profile',
        '.profile',
        '.npmrc',
        '.bunfig.toml',
        '.gitconfig',
      ])
        expect(d, `${tool} ${f}`).toContain(`${tool}(//home/alex/${f})`)
      for (const f of [
        '.config/fish',
        'Library/LaunchAgents',
        'Library/LaunchDaemons',
        '.ssh',
        '.config/git',
        '.local/bin',
      ]) {
        expect(d, `${tool} ${f}`).toContain(`${tool}(//home/alex/${f}/**)`)
        expect(d, `${tool} ${f} bare`).toContain(`${tool}(//home/alex/${f})`)
      }
      for (const f of ['/opt/homebrew/bin', '/usr/local/bin']) {
        expect(d, `${tool} ${f}`).toContain(`${tool}(/${f}/**)`)
        expect(d, `${tool} ${f} bare`).toContain(`${tool}(/${f})`)
      }
    }
    expect(d.some((r) => r.startsWith('Read(') && /\.zshrc|\.ssh|LaunchAgents|\/usr\/local\/bin/.test(r))).toBe(false)
  })
  test('lower-case forms too, like the roots', () => {
    const d = deny()
    expect(d).toContain('Edit(//home/alex/library/launchagents/**)')
    expect(d).toContain('NotebookEdit(//home/alex/.zshrc)')
  })
  test('PATH folders are added; tmp, lead-folder, glob, relative and too-broad ones are left out; no duplicates', () => {
    const d = deny({
      folder: '/home/alex/work/trip',
      tmpDirs: ['/home/alex/tmpd'],
      pathDirs: [
        '/home/alex/.cargo/bin',
        '/home/alex/.cargo/bin',
        '/usr/bin',
        '/home/alex/.local/bin', // already in the fixed list
        'relative/bin',
        '',
        '/tmp/x',
        '/private/tmp/y',
        '/var/folders/ab/cd/T',
        '/private/var/folders/ab',
        '/home/alex/tmpd/bin',
        '/home/alex/work/trip/bin',
        '/home/alex/work/trip',
        '/home/alex/work',
        '/',
        '/odd[1]/bin',
        '/odd*/bin',
      ],
    })
    for (const tool of EDITORS) {
      expect(d, tool).toContain(`${tool}(//home/alex/.cargo/bin/**)`)
      expect(d, tool).toContain(`${tool}(//home/alex/.cargo/bin)`)
      expect(d, tool).toContain(`${tool}(//usr/bin/**)`)
    }
    const text = d.join('\n')
    for (const left of ['relative', '(//tmp/', '/private/tmp', '/var/folders', 'tmpd', 'work/trip/bin', 'odd'])
      expect(text, left).not.toContain(left)
    expect(d).not.toContain('Edit(//home/alex/work/**)') // a folder around the lead's own would lock it out
    expect(d).not.toContain('Edit(///**)')
    expect(new Set(d).size).toBe(d.length)
  })
  test("NotebookEdit joins Edit and Write on the roots and on the lead's own .claude and marker", () => {
    const d = deny({ folder: '/home/alex/work/trip' })
    for (const r of [
      'NotebookEdit(//home/alex/My-Agent/**)',
      'NotebookEdit(//home/alex/.claude/**)',
      'NotebookEdit(//home/alex/.claude.json)',
      'NotebookEdit(//home/alex/work/trip/.claude/**)',
      'NotebookEdit(//home/alex/work/trip/.talos-lead)',
    ])
      expect(d, r).toContain(r)
  })
})

describe('leadSettings: hooks', () => {
  test('no PreToolUse hook; the Stop hook and turn marker are registered once each', () => {
    const s = leadSettings(opts)
    expect(s.hooks).not.toHaveProperty('PreToolUse')
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.UserPromptSubmit).toHaveLength(1)
    expect(s.hooks.Stop[0]?.hooks[0]?.command).toContain('.claude/hooks/board-stop.sh')
    expect(s.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain('.claude/hooks/turn-start.sh')
    expect(JSON.stringify(s)).not.toContain('lead-guard')
    expect(LEAD_BOARD_MAX).toBe(4096)
  })
})

describe('leadSettings: the OS sandbox', () => {
  test('on, fail-closed when it cannot run, and no way out of it', () => {
    expect(leadSettings(opts).sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    })
  })
  test('Monitor, Tmux and PowerShell are denied outright, and so are the cross-session tools', () => {
    const d = deny()
    for (const t of ['Monitor', 'Tmux', 'PowerShell', 'SendMessage', 'ListAgents', 'RemoteTrigger'])
      expect(d, t).toContain(t)
    expect(([...LEAD_DENIED_TOOLS] as string[]).sort()).toEqual(
      ['ListAgents', 'Monitor', 'PowerShell', 'RemoteTrigger', 'SendMessage', 'Tmux'].sort(),
    )
  })
  test('the whole Claude config folder is a root, so transcripts, history, settings, hooks and skills are all in it', () => {
    const d = deny()
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) {
      expect(d, tool).toContain(`${tool}(//home/alex/.claude/**)`)
      expect(d, `${tool} bare`).toContain(`${tool}(//home/alex/.claude)`)
    }
    // no per-file entries any more
    expect(d.some((r) => /file-history|history\.jsonl|\/projects\//.test(r))).toBe(false)
    // the global config files are roots too, as exact paths, for reads and for writes
    for (const f of ['/home/alex/.claude.json', '/home/alex/.claude.json.backup'])
      for (const tool of ['Read', 'Edit', 'Write']) expect(d, `${tool} ${f}`).toContain(`${tool}(/${f})`)
  })
  test('with CLAUDE_CONFIG_DIR that folder is the root, and ~/.claude and ~/.claude.json stay roots', () => {
    const d = deny({ claudeDir: '/Volumes/x/cfg' })
    for (const tool of ['Read', 'Edit', 'Write']) {
      expect(d, tool).toContain(`${tool}(//Volumes/x/cfg/**)`)
      expect(d, `${tool} home`).toContain(`${tool}(//home/alex/.claude/**)`)
      expect(d, `${tool} json`).toContain(`${tool}(//home/alex/.claude.json)`)
      expect(d, `${tool} backup`).toContain(`${tool}(//home/alex/.claude.json.backup)`)
    }
  })
  test('claudeDir at the default spot adds no duplicate rule', () => {
    const d = deny()
    expect(new Set(d).size).toBe(d.length)
    expect(d.filter((r) => r === 'Read(//home/alex/.claude/**)')).toHaveLength(1)
  })
  test('a relative claudeDir is refused', () => {
    expect(() => leadSettings({ ...opts, claudeDir: '.claude' })).toThrow(/absolute/)
  })
  test("package caches live in the lead's own folder, so no shared cache is writable", () => {
    const s = leadSettings({ ...opts, folder: '/home/alex/work/trip' })
    expect(s.env).toMatchObject({
      npm_config_cache: '/home/alex/work/trip/.cache/npm',
      npm_config_store_dir: '/home/alex/work/trip/.cache/pnpm-store',
      BUN_INSTALL_CACHE_DIR: '/home/alex/work/trip/.cache/bun',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    })
    expect(JSON.stringify(s)).not.toContain('allowWrite')
  })
})

describe("mergeLeadSettings: a re-run keeps the owner's edits and never drops a fence rule", () => {
  test("the owner's extra deny and unrelated keys survive; the fence rules are put back if removed", () => {
    const fresh = leadSettings(opts)
    const edited = {
      model: 'sonnet',
      disableClaudeAiConnectors: false,
      permissions: { deny: ['Bash(rm -rf*)'], allow: ['Bash(ls*)'] },
    }
    const m = mergeLeadSettings(edited, fresh) as typeof fresh & { model: string; permissions: { allow: string[] } }
    expect(m.model).toBe('sonnet')
    expect(m.permissions.allow).toEqual(['Bash(ls*)'])
    expect(m.permissions.deny).toContain('Bash(rm -rf*)')
    for (const d of fresh.permissions.deny) expect(m.permissions.deny).toContain(d)
    expect(m.disableClaudeAiConnectors).toBe(true)
    expect(new Set(m.permissions.deny).size).toBe(m.permissions.deny.length)
  })
  test('the sandbox keys are forced back whatever the old file said', () => {
    const fresh = leadSettings(opts)
    for (const sandbox of [
      undefined,
      { enabled: false, failIfUnavailable: false, allowUnsandboxedCommands: true },
      { enabled: 'yes', allowUnsandboxedCommands: 'true' },
    ]) {
      const m = mergeLeadSettings({ sandbox }, fresh) as { sandbox: Record<string, unknown> }
      expect(m.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    }
  })
  test('the sandbox is rebuilt from the safe keys: only the owner network object survives, everything else is dropped', () => {
    const fresh = leadSettings(opts)
    const m = mergeLeadSettings(
      {
        sandbox: {
          enabled: false,
          excludedCommands: ['docker'],
          filesystem: { allowRead: ['/Users/alex'], allowWrite: ['/Users/alex'], disabled: true },
          autoAllowBashIfSandboxed: true,
          somethingNew: 1,
          network: { allowedDomains: ['example.com'] },
        },
      },
      fresh,
    ) as { sandbox: Record<string, unknown> }
    expect(m.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['example.com'] },
    })
    const noNet = mergeLeadSettings({ sandbox: { network: 'x', excludedCommands: ['a'] } }, fresh) as {
      sandbox: Record<string, unknown>
    }
    expect(noNet.sandbox).toEqual({ ...fresh.sandbox })
  })
  test("the old lead-guard PreToolUse entry is dropped, the owner's own PreToolUse entries stay", () => {
    const fresh = leadSettings(opts)
    const guard = {
      matcher: 'Read|Bash',
      hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/lead-guard.sh' }],
    }
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }
    const both = mergeLeadSettings({ hooks: { PreToolUse: [guard, mine] } }, fresh) as {
      hooks: { PreToolUse: unknown[]; Stop: unknown[] }
    }
    expect(both.hooks.PreToolUse).toEqual([mine])
    expect(both.hooks.Stop).toEqual(fresh.hooks.Stop)
    // an owner hook in the same group as the old guard stays; the group goes only when nothing is left in it
    const ownerHook = { type: 'command', command: 'echo mine' }
    const shared = { matcher: 'Bash', hooks: [guard.hooks[0], ownerHook] }
    const kept = mergeLeadSettings({ hooks: { PreToolUse: [shared, guard] } }, fresh) as {
      hooks: { PreToolUse: unknown[] }
    }
    expect(kept.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [ownerHook] }])
    const only = mergeLeadSettings({ hooks: { PreToolUse: [guard] } }, fresh) as { hooks: Record<string, unknown> }
    expect(only.hooks).not.toHaveProperty('PreToolUse')
    expect(only.hooks).toHaveProperty('Stop')
  })
  test('the cache variables are put back; an owner env key stays', () => {
    const fresh = leadSettings({ ...opts, folder: '/home/alex/work/trip' })
    const m = mergeLeadSettings({ env: { FOO: '1', npm_config_cache: '/home/alex/.npm' } }, fresh) as {
      env: Record<string, string>
    }
    expect(m.env.FOO).toBe('1')
    expect(m.env.npm_config_cache).toBe('/home/alex/work/trip/.cache/npm')
  })
})

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
void mkdirSync
