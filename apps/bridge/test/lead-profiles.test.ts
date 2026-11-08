// The two lead profiles (docs/OPTION-C.md "Leads and the fence"). LIGHT is the default: the deny rules (the agent folder,
// ~/.claude*, the whole Talos home, the vault, --protect and the credential folders), no OS
// sandbox, SendMessage allowed. `--sandbox` is the opt-in profile: the same rules plus the locked OS sandbox, the cache
// variables and SendMessage denied. A re-run keeps the profile and never weakens; `lead check` accepts both and says plainly
// what each does not stop. The MCP choice is the thread's one allow list (session_opts.mcp_allow), not a deny list.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { paths } from '../src/config.ts'
import { cmdLead } from '../src/lead/cli.ts'

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
  const talosHome = tmp('lp-home-')
  const agentDir = tmp('lp-agent-')
  writeFileSync(join(agentDir, '.talos-version'), '1')
  const base = tmp('lp-base-')
  const cfgPath = paths(talosHome).configJson
  writeFileSync(
    cfgPath,
    JSON.stringify({
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
      ],
    }),
  )
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), isTerminal: true }
  const claudeDir = join(base, '.claude')
  const dir = join(base, 'leads', 'trip')
  const run = (args: string[]) =>
    cmdLead({ home: talosHome } as never, args, io, { home: base, claudeDir, agentDir, pathDirs: [] })
  const init = (...flags: string[]) => run(['init', 'trip', '--folder', dir, ...flags])
  const settings = () => JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  const marker = () => JSON.parse(readFileSync(join(dir, '.talos-lead'), 'utf8'))
  const trip = () =>
    (
      JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        threads: Array<{ id: string; session_opts?: Record<string, unknown> }>
      }
    ).threads.find((t) => t.id === 'trip')
  const out = () => lines.join('\n')
  /** The owner's own MCP setup, as ~/.claude.json holds it: user-scope servers, and what main's project switched off. */
  const ownerMcp = (userScope: string[], disabled: string[] = []) =>
    writeFileSync(
      join(base, '.claude.json'),
      JSON.stringify({
        mcpServers: Object.fromEntries(userScope.map((n) => [n, {}])),
        projects: { [agentDir]: { disabledMcpServers: disabled } },
      }),
    )
  const edit = (
    change: (s: { env: Record<string, string>; permissions: { deny: string[] }; [k: string]: unknown }) => void,
  ) => {
    const s = settings()
    change(s)
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(s))
  }
  return { talosHome, agentDir, base, dir, lines, run, init, settings, marker, trip, out, edit, claudeDir, ownerMcp }
}

const SECRETS = ['.ssh', '.config/gh', '.aws', '.npmrc', '.netrc']

describe('lead init: the light profile is the default', () => {
  test('no sandbox, SendMessage is not denied, the rest of the cross-session tools are', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir)).toBe(0)
    const st = s.settings()
    expect(st.sandbox).toBeUndefined()
    expect(st.permissions.deny).not.toContain('SendMessage')
    expect(st.permissions.deny).toEqual(
      expect.arrayContaining(['Monitor', 'Tmux', 'PowerShell', 'ListAgents', 'RemoteTrigger']),
    )
    expect(s.marker().profile).toBe('light')
    expect(s.out()).toMatch(/profile: light/)
  })
  test('read and write denies for the agent folder, ~/.claude*, the Talos home, the vault and --protect', () => {
    const s = setup()
    const extra = join(s.base, 'taxes')
    expect(s.init('--agent-dir', s.agentDir, '--protect', extra)).toBe(0)
    const d = s.settings().permissions.deny as string[]
    const vault = join(s.base, 'private-agent-vault')
    for (const root of [s.agentDir, s.claudeDir, join(s.base, '.claude'), s.talosHome, vault, extra]) {
      for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) {
        expect(d, `${tool} ${root}`).toContain(`${tool}(/${root}/**)`)
        expect(d, `${tool} ${root} bare`).toContain(`${tool}(/${root})`)
      }
    }
    for (const f of ['.claude.json', '.claude.json.backup'])
      for (const tool of ['Read', 'Edit']) expect(d).toContain(`${tool}(/${join(s.base, f)})`)
  })
  test('the credential folders are read-denied (and written-denied): ~/.ssh, ~/.config/gh, ~/.aws, ~/.npmrc, ~/.netrc', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    const d = s.settings().permissions.deny as string[]
    for (const p of SECRETS)
      for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) {
        expect(d, `${tool} ${p}`).toContain(`${tool}(/${join(s.base, p)}/**)`)
        expect(d, `${tool} ${p} bare`).toContain(`${tool}(/${join(s.base, p)})`)
      }
    expect(s.marker().protect).toEqual(expect.arrayContaining(SECRETS.map((p) => join(s.base, p))))
  })
  test('the Talos home is denied whole: there is no carve-out in the settings (the inbox is outside the home)', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    const d = s.settings().permissions.deny as string[]
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) {
      expect(d).toContain(`${tool}(/${s.talosHome}/**)`)
      expect(d).toContain(`${tool}(/${s.talosHome})`)
    }
    expect(d.filter((r) => r.startsWith('!'))).toEqual([])
    expect(JSON.stringify(s.settings())).not.toMatch(/inbox/)
  })
  test("the MCP denies are the browser and screen servers only; the allow list is the Mac app's, not a list of denies", () => {
    const s = setup()
    s.ownerMcp(['my-mail', 'talos-app', 'plugin:zoom:zoom-mcp'], ['old-bank'])
    s.init('--agent-dir', s.agentDir)
    const st = s.settings()
    const d = st.permissions.deny as string[]
    expect(d.filter((r) => r.startsWith('mcp__')).sort()).toEqual(['mcp__claude-in-chrome__*', 'mcp__computer-use__*'])
    expect('disabledMcpjsonServers' in st).toBe(false)
    expect(st.disableClaudeAiConnectors).toBe(true)
    expect(st.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(st.enableAllProjectMcpServers).toBe(false)
  })
  test('the servers picked with --mcp go into the thread list and change nothing in the settings', () => {
    const s = setup()
    s.ownerMcp(['my-mail', 'github', 'playwright'])
    const before = s.init('--agent-dir', s.agentDir)
    expect(before).toBe(0)
    const plain = s.settings()
    s.init('--agent-dir', s.agentDir, '--mcp', 'github,playwright')
    expect(s.trip()?.session_opts?.mcp_allow).toEqual(['github', 'playwright'])
    expect(s.settings()).toEqual(plain)
    expect(s.out()).toMatch(/Mac app applies it when the session starts/)
    expect(s.out()).not.toMatch(/Until the Mac app/)
  })
  test('the browser and screen tools can never be picked, and a connector is refused with the reason', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir, '--mcp', 'claude-in-chrome')).toBe(2)
    expect(s.out()).toMatch(/claude-in-chrome.*never/)
    s.lines.length = 0
    expect(s.init('--agent-dir', s.agentDir, '--mcp', 'github,claude.ai Gmail')).toBe(2)
    expect(s.out()).toMatch(/claude\.ai connectors cannot be on a lead's list/)
    expect(s.out()).toMatch(/disableClaudeAiConnectors/)
    expect(s.trip()?.session_opts).toBeUndefined() // nothing was written
  })
  test('a plugin server on the list says nothing about other plugin servers staying on', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--mcp', 'plugin:zoom:zoom-mcp')
    expect(s.out()).not.toMatch(/other plugin servers/i)
    expect(s.settings().permissions.deny).not.toContain('mcp__plugin_*')
  })
  test('the cache redirects are not written: light has no sandbox and keeps the shared caches', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    const env = s.settings().env
    expect(Object.keys(env)).toEqual(['ENABLE_CLAUDEAI_MCP_SERVERS'])
  })
  test('the hooks are registered', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    expect(JSON.stringify(s.settings().hooks)).toMatch(
      /board-stop\.sh[\s\S]*turn-start\.sh|turn-start\.sh[\s\S]*board-stop\.sh/,
    )
  })
})

describe('lead init --sandbox', () => {
  test('writes the locked OS sandbox, denies SendMessage, redirects every cache, and keeps the same fence', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir, '--sandbox')).toBe(0)
    const st = s.settings()
    expect(st.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    expect(st.permissions.deny).toEqual(
      expect.arrayContaining(['SendMessage', 'Monitor', 'Tmux', 'PowerShell', 'ListAgents', 'RemoteTrigger']),
    )
    const c = (n: string) => join(s.dir, '.cache', n)
    expect(st.env).toMatchObject({
      npm_config_cache: c('npm'),
      npm_config_store_dir: c('pnpm-store'),
      BUN_INSTALL_CACHE_DIR: c('bun'),
      XDG_CACHE_HOME: c('xdg'),
      XDG_STATE_HOME: c('state'),
      PNPM_HOME: c('pnpm'),
      npm_config_devdir: c('node-gyp'),
      PLAYWRIGHT_BROWSERS_PATH: c('playwright'),
    })
    expect(st.permissions.deny.filter((r: string) => r.startsWith('!'))).toEqual([])
    expect(st.permissions.deny).toContain(`Read(/${join(s.base, '.ssh')}/**)`)
    expect(s.marker().profile).toBe('sandbox')
    expect(s.out()).toMatch(/profile: sandbox/)
  })
  test('--sandbox with --light is a usage error and writes nothing', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir, '--sandbox', '--light')).toBe(2)
    expect(() => readFileSync(join(s.dir, '.talos-lead'))).toThrow()
  })
})

describe('lead init: re-runs keep the profile and never weaken', () => {
  test('a re-run with no flag keeps light as light and a sandbox as a sandbox', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.init('--agent-dir', s.agentDir)
    expect(s.settings().sandbox).toBeUndefined()
    const t = setup()
    t.init('--agent-dir', t.agentDir, '--sandbox')
    t.init('--agent-dir', t.agentDir)
    expect(t.settings().sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    expect(t.settings().permissions.deny).toContain('SendMessage')
    expect(t.marker().profile).toBe('sandbox')
  })
  test("the owner's extra env, deny rules and keys survive", () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.edit((st) => {
      st.env.MY_VAR = '1'
      st.permissions.deny.push('Bash(rm -rf*)')
      st.model = 'sonnet'
    })
    s.init('--agent-dir', s.agentDir)
    const st = s.settings()
    expect(st.env.MY_VAR).toBe('1')
    expect(st.permissions.deny).toContain('Bash(rm -rf*)')
    expect(st.model).toBe('sonnet')
  })
  test('removed fence rules (and the sandbox of a sandbox lead) come back', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--sandbox')
    s.edit((st) => {
      st.permissions.deny = st.permissions.deny.filter((r: string) => !r.includes('.ssh') && r !== 'SendMessage')
      st.sandbox = { enabled: false }
    })
    s.init('--agent-dir', s.agentDir)
    const st = s.settings()
    expect(st.sandbox.enabled).toBe(true)
    expect(st.permissions.deny).toContain('SendMessage')
    expect(st.permissions.deny).toContain(`Read(/${join(s.base, '.ssh')}/**)`)
  })
  test("--light switches a sandbox lead to light, and only then: the sandbox, the SendMessage deny and the cache variables go; the owner's env stays", () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--sandbox')
    s.edit((st) => {
      st.env.MY_VAR = '1'
    })
    expect(s.init('--agent-dir', s.agentDir, '--light')).toBe(0)
    const st = s.settings()
    expect(st.sandbox).toBeUndefined()
    expect(st.permissions.deny).not.toContain('SendMessage')
    expect(st.permissions.deny).toContain(`Read(/${s.talosHome}/**)`)
    expect(st.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false', MY_VAR: '1' })
    expect(s.marker().profile).toBe('light')
    expect(s.out()).toMatch(/profile: light \(changed, as you asked\)/)
  })
  test('--sandbox switches a light lead to the sandbox', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    expect(s.init('--agent-dir', s.agentDir, '--sandbox')).toBe(0)
    expect(s.settings().sandbox.enabled).toBe(true)
    expect(s.settings().permissions.deny).toContain('SendMessage')
    expect(s.marker().profile).toBe('sandbox')
  })
  test('a folder made before profiles (no profile in its marker) is a sandbox lead, and a re-run keeps it one', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--sandbox')
    const m = s.marker()
    delete m.profile
    writeFileSync(join(s.dir, '.talos-lead'), JSON.stringify(m))
    s.init('--agent-dir', s.agentDir)
    expect(s.settings().sandbox.enabled).toBe(true)
    expect(s.marker().profile).toBe('sandbox')
  })
})

describe('lead init: the one MCP allow list', () => {
  test('it writes an empty list (talos-app only) into the thread, and keeps it on a re-run', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    expect(s.trip()?.session_opts?.mcp_allow).toEqual([])
    expect(s.trip()?.session_opts?.cwd).toBe(s.dir)
    expect(s.out()).toMatch(/MCP: talos-app only/)
  })
  test('--mcp names what the owner picks, without talos-app, and replaces the list', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--mcp', 'github, plugin:zoom:zoom-mcp,talos-app')
    expect(s.trip()?.session_opts?.mcp_allow).toEqual(['github', 'plugin:zoom:zoom-mcp'])
    s.init('--agent-dir', s.agentDir) // no --mcp: the list stays
    expect(s.trip()?.session_opts?.mcp_allow).toEqual(['github', 'plugin:zoom:zoom-mcp'])
    s.init('--agent-dir', s.agentDir, '--mcp', 'slack')
    expect(s.trip()?.session_opts?.mcp_allow).toEqual(['slack'])
  })
  test('--mcp "" clears the list', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--mcp', 'github')
    expect(s.init('--agent-dir', s.agentDir, '--mcp', '')).toBe(0)
    expect(s.trip()?.session_opts?.mcp_allow).toEqual([])
  })
  test('a bad --mcp is a usage error and nothing is written', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir, '--mcp', `${'x'.repeat(81)}`)).toBe(2)
    expect(s.init('--agent-dir', s.agentDir, '--mcp', 'a,a')).toBe(2)
    expect(s.trip()?.session_opts).toBeUndefined()
  })
  test('--disable-mcp is gone, and says what replaced it', () => {
    const s = setup()
    expect(s.init('--agent-dir', s.agentDir, '--disable-mcp', 'mail')).toBe(2)
    expect(s.out()).toMatch(/--disable-mcp is gone[\s\S]*--mcp/)
    expect(s.trip()?.session_opts).toBeUndefined()
  })
  const stopgapDenies = [
    'mcp__claude_ai_*',
    'mcp__plugin_*',
    'mcp__Claude_Browser__*',
    'mcp__playwright__*',
    'mcp__my-mail__*',
    'mcp__github__*',
  ]
  /** A folder as the first version of the allow list left it, plus two denies of the owner's own. */
  const oldFolder = () => {
    const s = setup()
    s.ownerMcp(['my-mail', 'github'])
    s.init('--agent-dir', s.agentDir)
    s.edit((st) => {
      st.permissions.deny.push(...stopgapDenies, 'Bash(rm -rf*)', 'mcp__mine__*')
      st.disabledMcpjsonServers = ['my-mail', 'github', 'mine-json']
    })
    return s
  }
  test("a plain re-run of a folder from before removes nothing: it cannot tell the stopgap from the owner's own denies", () => {
    const s = oldFolder()
    s.lines.length = 0
    s.init('--agent-dir', s.agentDir, '--mcp', 'github')
    const st = s.settings()
    for (const r of [...stopgapDenies, 'Bash(rm -rf*)', 'mcp__mine__*']) expect(st.permissions.deny, r).toContain(r)
    expect(st.disabledMcpjsonServers).toEqual(['my-mail', 'github', 'mine-json'])
    expect(s.out()).not.toMatch(/removed/)
    expect(s.marker().stopgap_removed).toBeUndefined()
  })
  test('lead check lists the probable stopgap denies for the owner to delete, and does not fail over them', () => {
    const s = oldFolder()
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(s.out()).toMatch(/denies MCP servers the way the first version of the allow list wrote them/)
    expect(s.out()).toMatch(/mcp__playwright__\*/)
    expect(s.out()).toMatch(/--remove-stopgap/)
    expect(s.out()).not.toMatch(/mcp__mine__/) // not one the stopgap would have written
  })
  test('--remove-stopgap removes exactly the probable stopgap denies, records them, and leaves every other deny', () => {
    const s = oldFolder()
    s.lines.length = 0
    s.init('--agent-dir', s.agentDir, '--remove-stopgap')
    const st = s.settings()
    expect((st.permissions.deny as string[]).filter((r) => r.startsWith('mcp__')).sort()).toEqual([
      'mcp__claude-in-chrome__*',
      'mcp__computer-use__*',
      'mcp__mine__*',
    ])
    expect(st.permissions.deny).toContain('Bash(rm -rf*)')
    expect(st.disabledMcpjsonServers).toEqual(['mine-json'])
    expect(s.out()).toMatch(/removed 6 MCP deny rule\(s\)/)
    expect(s.marker().stopgap_removed.rules).toEqual(expect.arrayContaining(stopgapDenies))
    // the owner puts one of his own back later: a plain re-run keeps it, and the record is not used again
    s.edit((x) => {
      x.permissions.deny.push('mcp__playwright__*')
    })
    s.lines.length = 0
    s.init('--agent-dir', s.agentDir)
    expect(s.settings().permissions.deny).toContain('mcp__playwright__*')
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
  })
  test("the owner's own deny rules and servers outside the allow list stay on a re-run", () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.edit((st) => {
      st.permissions.deny.push('mcp__old-mail__*', 'Bash(rm -rf*)')
    })
    s.init('--agent-dir', s.agentDir)
    expect(s.settings().permissions.deny).toEqual(expect.arrayContaining(['mcp__old-mail__*', 'Bash(rm -rf*)']))
  })
})

describe('lead check', () => {
  test('accepts a light lead and says plainly what light does not stop', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
    const o = s.out()
    expect(o).toMatch(/is fine \(brief, board, decisions, fence in place\)/)
    expect(o).toMatch(/profile: light/)
    expect(o).toMatch(/does not stop: a Bash command such as sqlite3, python or grep -r/)
    expect(o).toMatch(/the network is open/)
    expect(o).not.toMatch(/SendMessage/)
  })
  test("accepts a sandbox lead and lists what a sandboxed lead can't do", () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--sandbox')
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
    const o = s.out()
    expect(o).toMatch(/profile: sandbox/)
    for (const t of ['git over SSH', 'gh', 'tmux integration suites', 'xcodebuild', 'ci-local.sh', 'SendMessage'])
      expect(o, t).toContain(t)
  })
  test('flags a missing credential-folder read deny, by name, on both profiles', () => {
    for (const flags of [[], ['--sandbox']]) {
      const s = setup()
      s.init('--agent-dir', s.agentDir, ...flags)
      s.edit((st) => {
        st.permissions.deny = st.permissions.deny.filter((r: string) => !r.includes('/.aws'))
      })
      s.lines.length = 0
      expect(s.run(['check', s.dir, '--agent-dir', s.agentDir]), flags.join()).toBe(1)
      expect(s.out()).toContain(`does not deny reading ${join(s.base, '.aws')}`)
    }
  })
  test('a lead made before the credential folders were added is flagged for every one of them', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir, '--sandbox')
    s.edit((st) => {
      st.permissions.deny = st.permissions.deny.filter((r: string) => !SECRETS.some((p) => r.includes(`/${p}`)))
    })
    const m = s.marker()
    m.protect = m.protect.filter((r: string) => !SECRETS.some((p) => r.endsWith(`/${p}`)))
    delete m.profile
    writeFileSync(join(s.dir, '.talos-lead'), JSON.stringify(m))
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(1)
    for (const p of SECRETS) expect(s.out(), p).toContain(`does not deny reading ${join(s.base, p)}`)
  })
  test('flags a missing Talos home deny', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.edit((st) => {
      st.permissions.deny = st.permissions.deny.filter((r: string) => !r.includes(s.talosHome))
    })
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.out()).toMatch(/missing \d+ deny rule\(s\)/)
  })
  test('a sandbox lead without its SendMessage deny is flagged; a light lead without it is not', () => {
    const sb = setup()
    sb.init('--agent-dir', sb.agentDir, '--sandbox')
    sb.edit((st) => {
      st.permissions.deny = st.permissions.deny.filter((r: string) => r !== 'SendMessage')
    })
    expect(sb.run(['check', sb.dir, '--agent-dir', sb.agentDir])).toBe(1)
    expect(sb.out()).toMatch(/the SendMessage tool is not denied/)
    const lt = setup()
    lt.init('--agent-dir', lt.agentDir)
    expect(lt.run(['check', lt.dir, '--agent-dir', lt.agentDir])).toBe(0)
  })
  test('a light lead is not asked for the sandbox keys', () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(s.out()).not.toMatch(/sandbox\.enabled/)
  })
  test("lead check no longer reads the MCP denies against the thread's allow list", () => {
    const s = setup()
    s.ownerMcp(['my-mail', 'github'])
    s.init('--agent-dir', s.agentDir)
    // the list names a server; the settings have no deny for any server, and nothing is flagged
    const cfg = JSON.parse(readFileSync(join(s.talosHome, 'config.json'), 'utf8'))
    cfg.threads = cfg.threads.map((t: { id: string }) =>
      t.id === 'trip'
        ? { ...t, session_opts: { ...(t as { session_opts?: object }).session_opts, mcp_allow: ['github'] } }
        : t,
    )
    writeFileSync(join(s.talosHome, 'config.json'), JSON.stringify(cfg))
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
    expect(s.out()).not.toMatch(/denies it|allow list but/)
    // a settings file that still carries the stopgap's denies is not a failure either (it is listed as a note, above)
    s.edit((st) => {
      st.permissions.deny.push('mcp__github__*')
    })
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(0)
  })
  test("a claude.ai connector on the allow list is flagged: a lead's connectors are off", () => {
    const s = setup()
    s.init('--agent-dir', s.agentDir)
    const cfg = JSON.parse(readFileSync(join(s.talosHome, 'config.json'), 'utf8'))
    cfg.threads = cfg.threads.map((t: { id: string }) =>
      t.id === 'trip'
        ? { ...t, session_opts: { ...(t as { session_opts?: object }).session_opts, mcp_allow: ['claude.ai Gmail'] } }
        : t,
    )
    writeFileSync(join(s.talosHome, 'config.json'), JSON.stringify(cfg))
    s.lines.length = 0
    expect(s.run(['check', s.dir, '--agent-dir', s.agentDir])).toBe(1)
    expect(s.out()).toMatch(/claude\.ai Gmail.*connectors are off/)
  })
})
