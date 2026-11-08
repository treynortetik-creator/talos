// The lead's settings.json: the OS sandbox switched on and locked, whole-root deny rules (the sandbox turns them into
// kernel-enforced read and write limits), connectors off including the owner's own MCP servers, and the two hooks.
// Fictional paths only.
import { describe, expect, test } from 'bun:test'
import {
  LEAD_AUTOSTART_FILES,
  LEAD_AUTOSTART_FOLDERS,
  LEAD_BOARD_MAX,
  LEAD_DENIED_TOOLS,
  leadSettings,
  mergeLeadSettings,
  stopgapMcpDenies,
} from '../src/lead/settings.ts'

const opts = {
  profile: 'sandbox' as const,
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

describe('leadSettings: MCP servers (the Mac app applies the thread allow list)', () => {
  const owner = {
    disabled: ['old-mail', 'plugin:zoom-plugin:zoom-mcp'],
    userScope: ['talos-browser', 'blender', 'talos-app'],
  }
  /** A lead's settings as the first version of the allow list wrote them: a deny per server the owner has, and the blanket ones. */
  const stopgapFile = (deny: string[] = []) => ({
    permissions: {
      deny: [
        'mcp__claude_ai_*',
        'mcp__plugin_*',
        'mcp__claude-in-chrome__*',
        'mcp__computer-use__*',
        'mcp__Claude_Browser__*',
        'mcp__playwright__*',
        'mcp__puppeteer__*',
        'mcp__talos-browser__*',
        'mcp__blender__*',
        'mcp__old-mail__*',
        'mcp__plugin_zoom-plugin_zoom-mcp__*',
        ...deny,
      ],
    },
    disabledMcpjsonServers: ['old-mail', 'talos-browser', 'blender', 'playwright', 'mine-json'],
  })

  test('only the browser and screen servers are denied by name; connectors are switched off by the setting; talos-app never is', () => {
    for (const profile of ['light', 'sandbox'] as const) {
      const s = leadSettings({ ...opts, profile })
      for (const r of ['mcp__claude-in-chrome__*', 'mcp__computer-use__*']) expect(s.permissions.deny, r).toContain(r)
      expect(s.permissions.deny.filter((r) => r.startsWith('mcp__')).sort()).toEqual([
        'mcp__claude-in-chrome__*',
        'mcp__computer-use__*',
      ])
      expect(s.disableClaudeAiConnectors).toBe(true)
      expect(s.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
      expect(s.enableAllProjectMcpServers).toBe(false)
      expect('disabledMcpjsonServers' in s).toBe(false)
    }
  })
  test("a plain re-run removes nothing: the stopgap is told apart from the owner's own denies only when he says so", () => {
    const fresh = leadSettings(opts)
    // `mcp__playwright__*` is what the stopgap wrote, and also what an owner may have written himself
    const old = stopgapFile(['Bash(rm -rf*)', 'mcp__mine__*'])
    const m = mergeLeadSettings(old, fresh) as {
      permissions: { deny: string[] }
      disabledMcpjsonServers?: string[]
    }
    expect(m.permissions.deny).toEqual(expect.arrayContaining(old.permissions.deny))
    expect(m.disabledMcpjsonServers).toEqual(old.disabledMcpjsonServers)
  })
  test('with removeStopgap, exactly the entries named go; every other deny stays, an identical owner deny not named stays too', () => {
    const fresh = leadSettings(opts)
    const old = stopgapFile(['Bash(rm -rf*)', 'mcp__mine__*'])
    const named = {
      rules: ['mcp__blender__*', 'mcp__old-mail__*', 'mcp__claude_ai_*'],
      disabled: ['old-mail', 'blender'],
    }
    const m = mergeLeadSettings(old, fresh, { removeStopgap: named }) as {
      permissions: { deny: string[] }
      disabledMcpjsonServers?: string[]
    }
    for (const r of named.rules) expect(m.permissions.deny, r).not.toContain(r)
    expect(m.permissions.deny).toEqual(
      expect.arrayContaining([
        'mcp__playwright__*',
        'mcp__plugin_*',
        'mcp__talos-browser__*',
        'mcp__mine__*',
        'Bash(rm -rf*)',
        'mcp__claude-in-chrome__*',
        'mcp__computer-use__*',
      ]),
    )
    expect(m.disabledMcpjsonServers).toEqual(['talos-browser', 'playwright', 'mine-json'])
  })
  test('a re-run of a file with nothing of the stopgap in it changes no deny and adds no disabledMcpjsonServers', () => {
    const fresh = leadSettings(opts)
    const once = mergeLeadSettings({}, fresh) as Record<string, unknown>
    const twice = mergeLeadSettings(once, fresh)
    expect(twice).toEqual(once)
    expect('disabledMcpjsonServers' in twice).toBe(false)
  })
  test('what the stopgap would have written is a function of the owner servers, and talos-app is never in it', () => {
    const g = stopgapMcpDenies(owner)
    expect(g.rules).toEqual(
      expect.arrayContaining([
        'mcp__claude_ai_*',
        'mcp__plugin_*',
        'mcp__blender__*',
        'mcp__plugin_zoom-plugin_zoom-mcp__*',
      ]),
    )
    expect(g.rules.some((r) => r.startsWith('mcp__talos-app'))).toBe(false)
    expect(g.rules).not.toContain('mcp__claude-in-chrome__*')
    expect(g.disabled).not.toContain('talos-app')
  })
  test('server names with odd characters get the prefix Claude Code gives their tools', () => {
    expect(stopgapMcpDenies({ disabled: ['My Server.v2', 'plugin:a b:c.d'], userScope: [] }).rules).toEqual(
      expect.arrayContaining(['mcp__My_Server_v2__*', 'mcp__plugin_a_b_c_d__*']),
    )
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
    expect(d.some((r) => r.startsWith('Read(') && /\.zshrc|LaunchAgents|\/usr\/local\/bin/.test(r))).toBe(false)
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
      XDG_CACHE_HOME: '/home/alex/work/trip/.cache/xdg',
      XDG_STATE_HOME: '/home/alex/work/trip/.cache/state',
      PNPM_HOME: '/home/alex/work/trip/.cache/pnpm',
      npm_config_devdir: '/home/alex/work/trip/.cache/node-gyp',
      PLAYWRIGHT_BROWSERS_PATH: '/home/alex/work/trip/.cache/playwright',
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
