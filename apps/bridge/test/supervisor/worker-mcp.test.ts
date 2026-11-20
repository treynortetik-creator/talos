// A thread session's MCP allow list at launch (P3d3, part 7): the port of the Mac's WorkerMcp.swift and its use in
// WorkerSpec.swift, with the Mac's cases (apps/desktop/Tests/TalosDesktopCoreTests/LeadFenceCoreTests.swift, WorkerMcpTests).
// A throwaway tree: a fake home with a fake `.claude.json` and `.claude`, an agent folder, a thread folder and a Talos home.
// Fictional servers and fake secrets only. Nothing is launched.
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { usageRecorderCommand, WORKER_MCP_APP, workerUsagePath } from '@talos-app/protocol'
import {
  claudeJsonHome,
  isChannelPlugin,
  mcpCatalog,
  planWorkerMcp,
  visibleMcpNames,
  type WorkerMcpPlan,
  WorkerMcpWriteError,
  writeWorkerMcp,
} from '../../src/supervisor/worker-mcp.ts'
import { foldsCase } from '../../src/supervisor/worker-policy.ts'
import { defaultPreamble } from '../../src/supervisor/worker-preamble.ts'
import {
  buildWorkerSpec,
  STRIPPED_ENV,
  STRIPPED_PREFIXES,
  validateSpec,
  type WorkerInputs,
  WorkerSpecRefused,
} from '../../src/supervisor/worker-spec.ts'
import { dedicatedThreads, workerPlanner } from '../../src/supervisor/workers-wiring.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

// the sealed kit releases this file made: writable again and removed (kit-release-fixture.ts)
afterAll(cleanupReleases)

/** No managed settings: the ceiling never reads the machine's own (managedDir is required in production code). */
const NO_MANAGED = join(tmpdir(), 'talos-test-no-managed-settings')

const TMP_FOLDS = foldsCase(realpathSync(tmpdir()))
const onCaseExactTmp = it.skipIf(TMP_FOLDS) // the fence refuses a case-folding temp folder (a Mac's): see worker-spec.test.ts

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON read in the assertions
type Json = Record<string, any>
/** A placeholder as Claude Code writes it in a plugin's server (`${NAME}`). */
const ph = (name: string) => `\${${name}}`
const SECRET = 'ghp_FICTIONAL_SECRET_0123456789'
const PROJECT_SECRET = 'db_FICTIONAL_PROJECT_SECRET_42'
const SID = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'

class Tree {
  readonly root: string
  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-mcp-')))
    dirs.push(this.root)
    for (const d of [this.home, this.claudeDir, this.agentDir, this.cwd, join(this.talosHome, 'guards')])
      mkdirSync(d, { recursive: true })
  }
  get home() {
    return join(this.root, 'home')
  }
  get claudeDir() {
    return join(this.home, '.claude')
  }
  get agentDir() {
    return join(this.home, 'agent')
  }
  get cwd() {
    return join(this.home, 'proj')
  }
  get talosHome() {
    return join(this.home, '.talos')
  }
  get mcpFile() {
    return join(this.talosHome, 'workers', 'trip', 'mcp', 'mcp.json')
  }
  write(path: string, json: unknown) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(json))
  }
  /** The owner's record for the thread folder in the global config: a local-scope server, and what he approved of the folder's .mcp.json. */
  projectEntry(o: { approve?: string[]; disable?: string[]; enableAll?: boolean }): Json {
    const e: Json = { mcpServers: { scoped: { command: 'scoped-mcp' } } }
    if (o.approve?.length) e.enabledMcpjsonServers = o.approve
    if (o.disable?.length) e.disabledMcpjsonServers = o.disable
    if (o.enableAll) e.enableAllProjectMcpServers = true
    return e
  }
  /** The agent folder defines talos-app (with things a worker must never get); the user scope has two servers, one with a secret; the thread folder a project server and a local one. */
  standard(o: { approve?: string[]; disable?: string[]; enableAll?: boolean } = {}) {
    this.write(join(this.agentDir, '.mcp.json'), {
      mcpServers: {
        'talos-app': {
          command: 'bun',
          args: ['server.ts'],
          env: { TALOS_APP_BRIDGE: '1', TELEGRAM_BOT_TOKEN: '123:abc', KEEP: 'yes' },
        },
        'agent-only': { command: 'agent-mcp' },
      },
    })
    this.write(join(this.home, '.claude.json'), {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: SECRET } },
        notes: { command: 'notes-mcp' },
      },
      projects: { [this.cwd]: this.projectEntry(o) },
    })
    this.write(join(this.cwd, '.mcp.json'), {
      mcpServers: { 'local-db': { command: 'db-mcp', args: ['--ro'], env: { DB_PASSWORD: PROJECT_SECRET } } },
    })
  }
  plan(allow: string[]): WorkerMcpPlan | null {
    return planWorkerMcp({
      allow,
      agentDir: this.agentDir,
      cwd: this.cwd,
      home: this.home,
      claudeDir: this.claudeDir,
      talosHome: this.talosHome,
      threadId: 'trip',
    })
  }
  mustPlan(allow: string[]): WorkerMcpPlan {
    const p = this.plan(allow)
    if (!p) throw new Error('no plan')
    return p
  }
  inputs(mcp: WorkerMcpPlan | null, over: Partial<WorkerInputs> = {}): WorkerInputs {
    return {
      threadId: 'trip',
      sessionId: SID,
      resume: false,
      claudePath: '/usr/bin/claude',
      baseEnv: { PATH: '/usr/bin:/bin', HOME: this.home },
      permissionHook: {
        script: join(this.talosHome, 'workers', '_hook', 'permission-relay.py'),
        python: '/usr/bin/python3',
      },
      talosHome: this.talosHome,
      agentDir: this.agentDir,
      cwd: this.cwd,
      parentCwd: null,
      model: 'inherit',
      effort: null,
      nonce: 'ab'.repeat(16),
      permissionFlag: '--dangerously-skip-permissions',
      preamble: 'Be the trip thread.',
      mcpConfigPath: null,
      main: {
        permissionArgs: ['--dangerously-skip-permissions'],
        defaultMode: null,
        mcpServers: visibleMcpNames(this.agentDir, this.home, this.claudeDir),
        denyRules: [],
      },
      mcp,
      ...over,
    }
  }
  /** zoom (enabled), notes-plugin (installed, not listed), telegram (a channel plugin). */
  installPlugins(zoomServer?: Json): string {
    const zoom = join(this.claudeDir, 'plugins', 'cache', 'market', 'zoom', '1.0.0')
    const rec = (path: string) => [{ scope: 'user', installPath: path, version: '1.0.0' }]
    this.write(join(this.claudeDir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'zoom@market': rec(zoom),
        'notes-plugin@market': rec(join(this.claudeDir, 'plugins', 'cache', 'market', 'notes', '1.0.0')),
        'telegram@claude-plugins-official': rec(join(this.claudeDir, 'plugins', 'cache', 'o', 'telegram', '1.0.0')),
      },
    })
    this.write(join(this.claudeDir, 'settings.json'), {
      enabledPlugins: { 'zoom@market': true, 'notes-plugin@market': true, 'telegram@claude-plugins-official': true },
    })
    this.write(join(zoom, '.mcp.json'), {
      mcpServers: { 'zoom-mcp': zoomServer ?? { command: `${ph('CLAUDE_PLUGIN_ROOT')}/bin/zoom` } },
    })
    this.write(join(this.claudeDir, 'plugins', 'cache', 'o', 'telegram', '1.0.0', '.mcp.json'), {
      mcpServers: { telegram: { command: `${ph('CLAUDE_PLUGIN_ROOT')}/bin/tg` } },
    })
    return zoom
  }
}

const fileOf = (p: WorkerMcpPlan) => JSON.parse(p.configJSON) as { mcpServers: Record<string, Json> }
const settingsOf = (s: { settingsJSON: string }) => JSON.parse(s.settingsJSON) as Json
const denyOf = (s: { settingsJSON: string }) => (settingsOf(s).permissions?.deny ?? []) as string[]
const trustedOf = (t: Tree, i: WorkerInputs, cwd: string, mcp: WorkerMcpPlan | null) => ({
  talosHome: t.talosHome,
  main: i.main,
  claudePath: i.claudePath,
  cwd,
  mcp,
})
/** Everything the plan carries but the file: none of it may hold a value from a definition. */
const planButFile = (p: WorkerMcpPlan) => JSON.stringify({ ...p, configJSON: undefined })

describe('where the servers come from', () => {
  it('precedence is local over user over project: a planted .mcp.json never shadows the owner’s own', () => {
    const t = new Tree()
    t.standard({ approve: ['github', 'scoped'] })
    t.write(join(t.cwd, '.mcp.json'), {
      mcpServers: { github: { command: 'evil-gh' }, scoped: { command: 'evil-scoped' }, 'local-db': { command: 'db' } },
    })
    // a user-scope server of the same name as a local one: the local one wins
    const cj = JSON.parse(readFileSync(join(t.home, '.claude.json'), 'utf8'))
    cj.mcpServers.scoped = { command: 'user-scoped' }
    t.write(join(t.home, '.claude.json'), cj)
    const plan = t.mustPlan(['github', 'scoped'])
    const servers = fileOf(plan).mcpServers
    expect(servers.github?.command).toBe('npx')
    expect(servers.github?.env?.GITHUB_TOKEN).toBe(SECRET)
    expect(servers.scoped?.command).toBe('scoped-mcp')
    expect(plan.configJSON).not.toContain('evil')
    expect(plan.configJSON).not.toContain('user-scoped')
    expect(plan.ownFolder).toEqual({ scoped: 'local' })
    const cat = mcpCatalog(t.cwd, t.home, t.claudeDir)
    expect(cat.get('github')?.command).toBe('npx')
    expect(cat.get('local-db')?.command).toBe('db')
  })
  it('the local table is found under the folder as given and as it really is; a link to the folder counts', () => {
    const t = new Tree()
    t.standard()
    const link = join(t.home, 'proj-link')
    symlinkSync(t.cwd, link)
    const cj = JSON.parse(readFileSync(join(t.home, '.claude.json'), 'utf8'))
    cj.projects = { [t.cwd]: { mcpServers: { scoped: { command: 'scoped-mcp' } } } }
    t.write(join(t.home, '.claude.json'), cj)
    expect(mcpCatalog(link, t.home, t.claudeDir).get('scoped')?.command).toBe('scoped-mcp')
  })
  it('the global config Claude Code reads: <CLAUDE_CONFIG_DIR>/.claude.json whenever it is set (even to ~/.claude), else ~/.claude.json', () => {
    const t = new Tree()
    t.write(join(t.home, '.claude.json'), { mcpServers: { a: { command: 'a' } } })
    // a stale ~/.claude/.claude.json is not Claude Code's: it defines nothing here
    t.write(join(t.claudeDir, '.claude.json'), { mcpServers: { b: { command: 'b' } } })
    expect([...mcpCatalog(t.cwd, claudeJsonHome({}, t.home, t.claudeDir), t.claudeDir).keys()].sort()).toEqual(['a'])
    const other = join(t.root, 'cfg')
    t.write(join(other, '.claude.json'), { mcpServers: { c: { command: 'c' } } })
    expect([...mcpCatalog(t.cwd, claudeJsonHome({ CLAUDE_CONFIG_DIR: other }, t.home, other), other).keys()]).toEqual([
      'c',
    ])
    // CLAUDE_CONFIG_DIR set to ~/.claude itself: Claude Code reads ~/.claude/.claude.json then, not ~/.claude.json
    const set = claudeJsonHome({ CLAUDE_CONFIG_DIR: t.claudeDir }, t.home, t.claudeDir)
    expect([...mcpCatalog(t.cwd, set, t.claudeDir).keys()]).toEqual(['b'])
  })
  it('entries that are not objects, and `type: sdk` ones, are left out; both shapes of .mcp.json are read', () => {
    const t = new Tree()
    t.write(join(t.home, '.claude.json'), {
      mcpServers: { s: { type: 'sdk', name: 'x' }, n: 5, l: ['x'], ok: { command: 'ok' } },
    })
    t.write(join(t.cwd, '.mcp.json'), { bare: { command: 'bare' } })
    expect([...mcpCatalog(t.cwd, t.home, t.claudeDir).keys()].sort()).toEqual(['bare', 'ok'])
    // what Main can really use: the folder's own server only once approved
    expect(visibleMcpNames(t.cwd, t.home, t.claudeDir).sort()).toEqual(['ok', WORKER_MCP_APP])
  })
  it('Main’s ceiling leaves out what the owner switched off for the agent folder, and keeps approved folder servers', () => {
    const t = new Tree()
    t.write(join(t.home, '.claude.json'), {
      mcpServers: { on: { command: 'on' }, off: { command: 'off' } },
      projects: { [t.cwd]: { disabledMcpServers: ['off'], enabledMcpjsonServers: ['mine'] } },
    })
    t.write(join(t.cwd, '.mcp.json'), { mcpServers: { mine: { command: 'mine' }, theirs: { command: 'theirs' } } })
    expect(visibleMcpNames(t.cwd, t.home, t.claudeDir).sort()).toEqual(['mine', 'on', WORKER_MCP_APP].sort())
  })
  it('a server named __proto__ is a server like any other, never the prototype', () => {
    const t = new Tree()
    t.standard()
    writeFileSync(
      join(t.home, '.claude.json'),
      '{"mcpServers":{"__proto__":{"command":"proto-mcp"},"github":{"command":"npx"}}}',
    )
    const plan = t.mustPlan(['__proto__'])
    expect(plan.allowed).toEqual(['__proto__'])
    expect(Object.hasOwn(fileOf(plan).mcpServers, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(fileOf(plan).mcpServers)).toBe(Object.prototype)
  })
})

describe('the plan', () => {
  it('an empty list: talos-app only, copied from the agent folder with what a worker must never get taken out', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan([])
    expect(plan.configPath).toBe(t.mcpFile)
    expect(Object.keys(fileOf(plan).mcpServers)).toEqual(['talos-app'])
    const talos = fileOf(plan).mcpServers['talos-app'] as Json
    expect(talos.command).toBe('bun')
    expect(talos.env).toEqual({ KEEP: 'yes' })
    expect(plan.allowed).toEqual([])
    expect(plan.missing).toEqual([])
  })
  it('no talos-app in the agent folder: no plan (a session without it cannot read its messages)', () => {
    const t = new Tree()
    t.write(join(t.agentDir, '.mcp.json'), { mcpServers: { other: { command: 'x' } } })
    expect(t.plan([])).toBeNull()
  })
  it('a user server is copied, credentials byte for byte; the servers not listed are denied by Claude Code’s prefix', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    const servers = fileOf(plan).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['github', 'talos-app'])
    expect(servers.github).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: SECRET } })
    expect(plan.allowed).toEqual(['github'])
    expect(plan.denyRules).toContain('mcp__notes__*')
    expect(plan.denyRules).toContain('mcp__agent-only__*')
    expect(plan.denyRules).toContain('mcp__local-db__*')
    expect(plan.denyRules).toContain('mcp__claude-in-chrome__*')
    expect(plan.denyRules).toContain('mcp__computer-use__*')
    expect(plan.denyRules).toContain('mcp__claude_ai_*')
    expect(plan.denyRules).not.toContain('mcp__github__*')
    expect(plan.denyRules).not.toContain('mcp__talos-app__*')
    expect(new Set(plan.denyRules).size).toBe(plan.denyRules.length)
    expect(planButFile(plan)).not.toContain(SECRET)
  })
  it('a deny rule uses Claude Code’s prefix: a character outside the BMP is two `_`', () => {
    const t = new Tree()
    t.write(join(t.agentDir, '.mcp.json'), { mcpServers: { 'talos-app': { command: 'bun' } } })
    t.write(join(t.home, '.claude.json'), {
      mcpServers: { github: { command: 'gh' }, 'mail\u{1F4E7}': { command: 'm' }, 'my notes.v2': { command: 'n' } },
    })
    const deny = t.mustPlan(['github']).denyRules
    expect(deny).toContain('mcp__mail____*')
    expect(deny).not.toContain('mcp__mail___*')
    expect(deny).toContain('mcp__my_notes_v2__*')
  })
  it('an approved project server comes from the thread folder’s .mcp.json; a local one needs no approval', () => {
    const t = new Tree()
    t.standard({ approve: ['local-db'] })
    const plan = t.mustPlan(['local-db', 'scoped'])
    expect(plan.refusal).toBeNull()
    const servers = fileOf(plan).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['local-db', 'scoped', 'talos-app'])
    expect(servers['local-db']?.args).toEqual(['--ro'])
    expect(plan.ownFolder).toEqual({ 'local-db': 'project', scoped: 'local' })
    t.standard()
    const local = t.mustPlan(['scoped'])
    expect(local.allowed).toEqual(['scoped'])
    expect(local.refusal).toBeNull()
  })
  it('an unapproved project server is refused with how to fix it, and never a value from its definition', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github', 'local-db'])
    expect(plan.refusal).toContain('local-db')
    expect(plan.refusal).toContain('claude mcp add -s local local-db')
    expect(plan.refusal).toContain('approve it once in Claude Code')
    expect(plan.refusal).not.toContain('db-mcp')
    expect(plan.refusal).not.toContain(PROJECT_SECRET)
    expect(plan.configJSON).not.toContain(PROJECT_SECRET)
    expect(planButFile(plan)).not.toContain(PROJECT_SECRET)
    t.standard({ approve: ['local-db'] })
    expect(t.mustPlan(['local-db']).refusal).toBeNull()
    t.standard({ enableAll: true })
    expect(t.mustPlan(['local-db']).refusal).toBeNull()
    t.standard({ approve: ['local-db'], disable: ['local-db'] })
    expect(t.mustPlan(['local-db']).refusal).not.toBeNull() // a rejection beats an approval
  })
  it('an approval in the owner’s user settings counts; the folder’s own settings never do', () => {
    const t = new Tree()
    t.standard()
    t.write(join(t.cwd, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['local-db'] })
    t.write(join(t.cwd, '.claude', 'settings.json'), { enableAllProjectMcpServers: true })
    expect(t.mustPlan(['local-db']).refusal).not.toBeNull()
    t.write(join(t.claudeDir, 'settings.json'), { enabledMcpjsonServers: ['local-db'] })
    expect(t.mustPlan(['local-db']).refusal).toBeNull()
  })
  it('every copied definition has what a worker must never get taken out', () => {
    const t = new Tree()
    t.standard()
    t.write(join(t.home, '.claude.json'), {
      mcpServers: { tg: { command: 'x', env: { TELEGRAM_BOT_TOKEN: '123:abc', IMESSAGE_ACCESS: '1', KEEP: 'yes' } } },
      projects: {
        [t.cwd]: {
          mcpServers: {
            scoped: { command: 's', env: { TELEGRAM_STATE_DIR: '/x', TALOS_APP_BRIDGE: '1', KEEP: 'yes' } },
          },
          enabledMcpjsonServers: ['local-db'],
        },
      },
    })
    t.write(join(t.cwd, '.mcp.json'), {
      mcpServers: { 'local-db': { command: 'd', env: { MCP_PROTOCOL_NEGOTIATION: 'legacy', KEEP: 'yes' } } },
    })
    const servers = fileOf(t.mustPlan(['tg', 'scoped', 'local-db'])).mcpServers
    for (const name of ['tg', 'scoped', 'local-db']) {
      const env = servers[name]?.env as Json
      expect(env.KEEP).toBe('yes')
      for (const k of Object.keys(env)) {
        expect(STRIPPED_ENV.has(k)).toBe(false)
        expect(STRIPPED_PREFIXES.some((p) => k.startsWith(p))).toBe(false)
      }
    }
  })
  it('a listed server that exists nowhere is skipped and named; duplicates and talos-app itself are not listed twice', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github', 'nope', 'github', 'talos-app', 'nope'])
    expect(plan.missing).toEqual(['nope'])
    expect(plan.allowed).toEqual(['github'])
    expect(Object.keys(fileOf(plan).mcpServers).sort()).toEqual(['github', 'talos-app'])
  })
  it('the connectors and the browser and screen servers can never be on a list', () => {
    const t = new Tree()
    t.standard()
    // even when the owner defined one of that name
    const cj = JSON.parse(readFileSync(join(t.home, '.claude.json'), 'utf8'))
    cj.mcpServers['claude-in-chrome'] = { command: 'chrome' }
    cj.mcpServers['claude.ai Gmail'] = { command: 'gmail' }
    t.write(join(t.home, '.claude.json'), cj)
    const plan = t.mustPlan(['claude.ai Gmail', 'Claude.AI Drive', 'claude-in-chrome', 'computer-use', 'github'])
    expect(plan.allowed).toEqual(['github'])
    expect(plan.missing).toEqual([])
    expect(plan.refused).toEqual(['claude.ai Gmail', 'Claude.AI Drive', 'claude-in-chrome', 'computer-use'])
    expect(Object.keys(fileOf(plan).mcpServers).sort()).toEqual(['github', 'talos-app'])
    expect(plan.configJSON).not.toContain('chrome')
    expect(plan.configJSON).not.toContain('gmail')
  })
  it('a channel plugin can never be on the list', () => {
    const t = new Tree()
    t.standard()
    t.installPlugins()
    const plan = t.mustPlan(['plugin:telegram:telegram', 'plugin:imessage:imessage', 'plugin:zoom:zoom-mcp'])
    expect(plan.allowed).toEqual(['plugin:zoom:zoom-mcp'])
    expect(plan.refused).toEqual(['plugin:telegram:telegram', 'plugin:imessage:imessage'])
    expect(plan.configJSON).not.toContain('telegram')
    expect(plan.configJSON).not.toContain('/bin/tg')
    expect(isChannelPlugin('plugin:telegram:x')).toBe(true)
    expect(isChannelPlugin('plugin:zoom:x')).toBe(false)
    expect(isChannelPlugin('telegram')).toBe(false)
  })
  it('a plugin server is copied from its install folder when the plugin is on, its placeholders filled', () => {
    const t = new Tree()
    t.standard()
    const zoom = t.installPlugins({
      command: `${ph('CLAUDE_PLUGIN_ROOT')}/bin/zoom`,
      args: ['--project', `${ph('CLAUDE_PROJECT_DIR')}`],
      env: { HOME_DIR: `${ph('CLAUDE_PROJECT_DIR')}`, KEEP: 'yes' },
    })
    const plan = t.mustPlan(['plugin:zoom:zoom-mcp'])
    expect(plan.allowed).toEqual(['plugin:zoom:zoom-mcp'])
    const def = fileOf(plan).mcpServers['plugin:zoom:zoom-mcp'] as Json
    expect(def.command).toBe(`${zoom}/bin/zoom`)
    expect(def.args).toEqual(['--project', t.cwd])
    expect(def.env).toEqual({ HOME_DIR: t.cwd, KEEP: 'yes', CLAUDE_PLUGIN_ROOT: zoom })
    expect(plan.configJSON).not.toContain(ph('CLAUDE_PLUGIN_').slice(0, -1))
    // a plugin that is not on is not found
    t.write(join(t.claudeDir, 'settings.json'), { enabledPlugins: { 'zoom@market': false } })
    expect(t.mustPlan(['plugin:zoom:zoom-mcp']).missing).toEqual(['plugin:zoom:zoom-mcp'])
  })
  it('a plugin server naming a path this app cannot fill in is refused, never copied broken', () => {
    const t = new Tree()
    t.standard()
    for (const server of [
      { command: 'node', args: [`${ph('CLAUDE_PLUGIN_DATA')}/server.js`] },
      { command: 'node', env: { DATA: `${ph('CLAUDE_PLUGIN_DATA')}` } },
      { command: 'node', args: [`${ph('CLAUDE_PLUGIN_SOMETHING_NEW')}`] },
      { url: `https://example.invalid/${ph('user_config.api_host')}/mcp` },
    ]) {
      t.installPlugins(server)
      const plan = t.mustPlan(['plugin:zoom:zoom-mcp'])
      expect(plan.allowed).toEqual([])
      expect(plan.refused).toEqual(['plugin:zoom:zoom-mcp'])
      expect(plan.configJSON).not.toContain('zoom')
    }
  })
  it('every installed plugin not on the list is switched off; the instruction-file plugins never are', () => {
    const t = new Tree()
    t.standard()
    t.installPlugins()
    const ip = JSON.parse(readFileSync(join(t.claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    ip.plugins['agents-md@builtin'] = [{ installPath: join(t.claudeDir, 'plugins', 'b') }]
    t.write(join(t.claudeDir, 'plugins', 'installed_plugins.json'), ip)
    const plan = t.mustPlan(['plugin:zoom:zoom-mcp'])
    expect(plan.disabledPlugins.sort()).toEqual(['notes-plugin@market', 'telegram@claude-plugins-official'])
  })
})

describe('the generated file', () => {
  const mode = (p: string) => lstatSync(p).mode & 0o777
  it('is 0600 in a 0700 folder, replaced whole, its folder made private again', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    writeWorkerMcp(plan)
    expect(mode(t.mcpFile)).toBe(0o600)
    expect(mode(dirname(t.mcpFile))).toBe(0o700)
    expect(readFileSync(t.mcpFile, 'utf8')).toBe(plan.configJSON)
    expect(JSON.parse(readFileSync(t.mcpFile, 'utf8')).mcpServers.github.env.GITHUB_TOKEN).toBe(SECRET)
    const again = t.mustPlan([])
    writeWorkerMcp(again)
    expect(readFileSync(t.mcpFile, 'utf8')).toBe(again.configJSON)
    expect(readdirSync(dirname(t.mcpFile))).toEqual(['mcp.json']) // nothing left beside it
    chmodSync(dirname(t.mcpFile), 0o755)
    writeWorkerMcp(plan)
    expect(mode(dirname(t.mcpFile))).toBe(0o700)
  })
  it('a link in the way (the file, its folder, the worker’s folder) is refused and nothing is written through it', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    writeWorkerMcp(plan)
    const target = join(t.root, 'elsewhere.json')
    writeFileSync(target, 'keep')
    unlinkSync(t.mcpFile)
    symlinkSync(target, t.mcpFile)
    expect(() => writeWorkerMcp(plan)).toThrow(WorkerMcpWriteError)
    expect(readFileSync(target, 'utf8')).toBe('keep')
    unlinkSync(t.mcpFile)
    rmSync(dirname(t.mcpFile), { recursive: true })
    const elsewhere = join(t.root, 'elsewhere-dir')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, dirname(t.mcpFile))
    expect(() => writeWorkerMcp(plan)).toThrow(WorkerMcpWriteError)
    expect(readdirSync(elsewhere)).toEqual([])
    rmSync(join(t.talosHome, 'workers'), { recursive: true })
    mkdirSync(join(t.talosHome, 'workers'))
    symlinkSync(elsewhere, join(t.talosHome, 'workers', 'trip'))
    expect(() => writeWorkerMcp(plan)).toThrow(WorkerMcpWriteError)
    expect(readdirSync(elsewhere)).toEqual([])
    // a folder where the file goes is refused too
    rmSync(join(t.talosHome, 'workers'), { recursive: true })
    mkdirSync(t.mcpFile, { recursive: true })
    expect(() => writeWorkerMcp(plan)).toThrow(WorkerMcpWriteError)
  })
  it('a write error names our paths only, never a value', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    mkdirSync(t.mcpFile, { recursive: true })
    try {
      writeWorkerMcp(plan)
      throw new Error('wrote')
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerMcpWriteError)
      expect(String((e as Error).message)).not.toContain(SECRET)
      expect(String((e as Error).stack)).not.toContain(SECRET)
    }
  })
})

describe('the launch with a list', () => {
  const strictArgs = (t: Tree, session: string[] = ['--session-id', SID]) => [
    '--dangerously-skip-permissions',
    '--settings',
    join(t.talosHome, 'workers', 'trip', 'settings.json'),
    '--name',
    'talos-trip',
    '--system-prompt-snapshot=off',
    '--append-system-prompt=Be the trip thread.',
    '--strict-mcp-config',
    `--mcp-config=${t.mcpFile}`,
    '--no-chrome',
    ...session,
  ]
  onCaseExactTmp('an empty list is strict with talos-app only', () => {
    const t = new Tree()
    t.standard()
    const spec = buildWorkerSpec(t.inputs(t.mustPlan([]), { resume: true }))
    expect(spec.args).toEqual(strictArgs(t, ['--resume', SID]))
    expect(spec.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  })
  onCaseExactTmp(
    'a user server: the connectors off, the browser denied, the unlisted servers denied, no secret outside the file',
    () => {
      const t = new Tree()
      t.standard()
      const plan = t.mustPlan(['github'])
      const i = t.inputs(plan, { baseEnv: { PATH: '/usr/bin', HOME: t.home, ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } })
      const spec = buildWorkerSpec(i)
      expect(spec.args).toEqual(strictArgs(t))
      expect(spec.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false') // the login env’s own value never wins
      const s = settingsOf(spec)
      expect(s.disableClaudeAiConnectors).toBe(true)
      expect(s.deniedMcpServers).toEqual([{ serverName: 'claude-in-chrome' }, { serverName: 'computer-use' }])
      expect(denyOf(spec)).toContain('mcp__notes__*')
      expect(denyOf(spec)).toContain('mcp__claude_ai_*')
      expect(denyOf(spec)).not.toContain('mcp__github__*')
      expect(denyOf(spec)).toContain(`Read(/${t.talosHome}/**)`) // the fence is still there
      const everything = JSON.stringify(spec)
      expect(everything).not.toContain(SECRET)
      expect(everything).not.toContain('gh-mcp')
      validateSpec(spec, trustedOf(t, i, spec.cwd, plan))
    },
  )
  onCaseExactTmp(
    'the plugins not on the list are off in the worker’s settings; with no list only the channel plugins are',
    () => {
      const t = new Tree()
      t.standard()
      t.installPlugins()
      const plan = t.mustPlan(['plugin:zoom:zoom-mcp'])
      const spec = buildWorkerSpec(t.inputs(plan))
      const plugins = settingsOf(spec).enabledPlugins
      expect(plugins['notes-plugin@market']).toBe(false)
      expect(plugins['telegram@claude-plugins-official']).toBe(false)
      expect(plugins['imessage@claude-plugins-official']).toBe(false)
      expect(plugins['zoom@market']).toBeUndefined()
      const none = buildWorkerSpec(t.inputs(null))
      expect(Object.keys(settingsOf(none).enabledPlugins).sort()).toEqual([
        'imessage@claude-plugins-official',
        'telegram@claude-plugins-official',
      ])
    },
  )
  onCaseExactTmp('an unapproved project server: refused on the mcp axis, the text without any value', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github', 'local-db'])
    let err: unknown
    try {
      buildWorkerSpec(t.inputs(plan))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(WorkerSpecRefused)
    const r = err as WorkerSpecRefused
    expect(r.code).toBe('escalation')
    expect(r.axis).toBe('mcp')
    expect(r.detail).toContain('claude mcp add -s local local-db')
    expect(r.message).not.toContain(PROJECT_SECRET)
    expect(r.message).not.toContain('db-mcp')
  })
  onCaseExactTmp('a listed server Main cannot see and that is not the folder’s own: refused on the mcp axis', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    const i = t.inputs(plan)
    let err: unknown
    try {
      buildWorkerSpec({ ...i, main: { ...i.main, mcpServers: ['notes'] } })
    } catch (e) {
      err = e
    }
    expect((err as WorkerSpecRefused).axis).toBe('mcp')
    // the folder's own (local) one is allowed though Main cannot see it
    const own = t.mustPlan(['scoped'])
    expect(() => buildWorkerSpec({ ...t.inputs(own), main: { ...i.main, mcpServers: ['github'] } })).not.toThrow()
  })
})

describe('the last check with a list', () => {
  onCaseExactTmp('accepts exactly the strict flags and the env var, and refuses anything else', () => {
    const t = new Tree()
    t.standard()
    const plan = t.mustPlan(['github'])
    const i = t.inputs(plan)
    const spec = buildWorkerSpec(i)
    const trusted = trustedOf(t, i, spec.cwd, plan)
    expect(() => validateSpec(spec, trusted)).not.toThrow()
    const broken = (f: (c: typeof spec) => void, code: string, tr: typeof trusted = trusted) => {
      const c = structuredClone(spec)
      f(c)
      expect(() => validateSpec(c, tr)).toThrow(new RegExp(`^${code}`))
    }
    const at = (c: typeof spec, a: string) => c.args.indexOf(a)
    // a different MCP config path, in either spelling
    broken((c) => {
      c.args[at(c, `--mcp-config=${t.mcpFile}`)] = `--mcp-config=${join(t.root, 'other.json')}`
    }, 'forbidden_arg')
    broken((c) => {
      c.args.splice(at(c, `--mcp-config=${t.mcpFile}`), 1, '--mcp-config', t.mcpFile)
    }, 'forbidden_arg')
    // a second config next to it
    broken((c) => c.args.splice(at(c, '--no-chrome'), 0, `--mcp-config=${join(t.root, 'x.json')}`), 'forbidden_arg')
    // a strict flag dropped, or moved
    for (const flag of ['--strict-mcp-config', '--no-chrome']) {
      broken((c) => c.args.splice(at(c, flag), 1), 'forbidden_arg')
      broken((c) => {
        c.args.splice(at(c, flag), 1)
        c.args.push(flag)
      }, 'forbidden_arg')
    }
    broken((c) => c.args.splice(at(c, `--mcp-config=${t.mcpFile}`), 1), 'forbidden_arg')
    // the env var gone or anything but false
    broken((c) => {
      delete c.env.ENABLE_CLAUDEAI_MCP_SERVERS
    }, 'forbidden_env')
    broken((c) => {
      c.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'true'
    }, 'forbidden_env')
    // the settings must keep the connectors off, the never-open servers denied, every deny rule of the plan, the plugins off
    broken((c) => {
      c.settingsJSON = JSON.stringify({ ...settingsOf(c), disableClaudeAiConnectors: false })
    }, 'forbidden_env')
    broken((c) => {
      c.settingsJSON = JSON.stringify({ ...settingsOf(c), deniedMcpServers: [] })
    }, 'forbidden_env')
    broken((c) => {
      const s = settingsOf(c)
      s.permissions.deny = s.permissions.deny.filter((r: string) => r !== 'mcp__claude_ai_*')
      c.settingsJSON = JSON.stringify(s)
    }, 'forbidden_env')
    // the strict flags where the supervisor has no list: refused
    broken(() => {}, 'forbidden_arg', { ...trusted, mcp: null })
    // a trusted plan whose path is not the worker's own: refused
    broken(() => {}, 'forbidden_arg', { ...trusted, mcp: { ...plan, configPath: join(t.root, 'other.json') } })
    // a refusal is refused here too
    broken(() => {}, 'escalation', { ...trusted, mcp: { ...plan, refusal: 'x' } })
  })
  onCaseExactTmp('the plugins the plan switches off must stay off', () => {
    const t = new Tree()
    t.standard()
    t.installPlugins()
    const plan = t.mustPlan(['plugin:zoom:zoom-mcp'])
    const i = t.inputs(plan)
    const spec = buildWorkerSpec(i)
    const c = structuredClone(spec)
    const s = settingsOf(c)
    s.enabledPlugins['notes-plugin@market'] = true
    c.settingsJSON = JSON.stringify(s)
    expect(() => validateSpec(c, trustedOf(t, i, spec.cwd, plan))).toThrow(/^forbidden_env/)
  })
  onCaseExactTmp(
    'no list: the strict flags and a list-only mcp config are refused, the old --mcp-config still taken',
    () => {
      const t = new Tree()
      t.standard()
      const i = t.inputs(null)
      const spec = buildWorkerSpec(i)
      const trusted = trustedOf(t, i, spec.cwd, null)
      for (const flag of ['--strict-mcp-config', '--no-chrome']) {
        const c = structuredClone(spec)
        c.args.splice(c.args.indexOf('--session-id'), 0, flag)
        expect(() => validateSpec(c, trusted)).toThrow(/^forbidden_arg/)
      }
      const withPath = buildWorkerSpec({ ...i, mcpConfigPath: '/abs/mcp.json' })
      expect(() => validateSpec(withPath, trusted)).not.toThrow()
    },
  )
})

describe("Claude Code's own computer use is denied to every thread session", () => {
  onCaseExactTmp('no list: denied in the settings, and a spec without the deny is refused', () => {
    const t = new Tree()
    t.standard()
    const i = t.inputs(null)
    const spec = buildWorkerSpec(i)
    expect(settingsOf(spec).deniedMcpServers).toEqual([{ serverName: 'computer-use' }])
    expect(settingsOf(spec).disableClaudeAiConnectors).toBeUndefined()
    const trusted = trustedOf(t, i, spec.cwd, null)
    expect(() => validateSpec(spec, trusted)).not.toThrow()
    for (const denied of [[], [{ serverName: 'claude-in-chrome' }], undefined]) {
      const c = structuredClone(spec)
      const s = settingsOf(c)
      if (denied === undefined) delete s.deniedMcpServers
      else s.deniedMcpServers = denied
      c.settingsJSON = JSON.stringify(s)
      expect(() => validateSpec(c, trusted)).toThrow(/^forbidden_env/)
    }
  })
})

describe('no list: the launch is today’s, byte for byte', () => {
  /** The launch as it was before the usage recorder and the computer-use deny: both are checked here, then taken out. */
  function lessRecorder<T extends { settingsJSON: string }>(o: T, talosHome: string): T {
    const s = JSON.parse(o.settingsJSON) as Record<string, unknown>
    expect(s.statusLine).toEqual({
      type: 'command',
      command: usageRecorderCommand('/usr/bin/python3', workerUsagePath(talosHome, 'trip')),
      padding: 0,
    })
    delete s.statusLine
    // and the deny of Claude Code's own computer use, which every session has now, list or no list
    expect(s.deniedMcpServers).toEqual([{ serverName: 'computer-use' }])
    delete s.deniedMcpServers
    return { ...o, settingsJSON: JSON.stringify(s) }
  }
  // captured from the build before the list existed (origin/main c6e5e419), the temp root as <root>
  const GOLDEN_SPEC = String.raw`{"threadId":"trip","program":"/usr/bin/claude","args":["--dangerously-skip-permissions","--settings","<root>/talos/workers/trip/settings.json","--name","talos-trip","--system-prompt-snapshot=off","--model=sonnet","--append-system-prompt=Be the trip thread.","--session-id","11111111-2222-3333-4444-555555555555"],"env":{"PATH":"/usr/bin","HOME":"/home/alex","ENABLE_CLAUDEAI_MCP_SERVERS":"true","TALOS_APP_WORKER_THREAD":"trip","TALOS_SESSION_ROLE":"worker","TALOS_APP_HOME":"<root>/talos","TALOS_APP_WORKER_NONCE":"abababababababababababababababab","TELEGRAM_STATE_DIR":"<root>/talos/workers/_nochannel","IMESSAGE_STATE_DIR":"<root>/talos/workers/_nochannel"},"cwd":"<root>/proj","settingsJSON":"{\"disableSkillShellExecution\":true,\"effortLevel\":\"high\",\"enabledPlugins\":{\"imessage@claude-plugins-official\":false,\"telegram@claude-plugins-official\":false},\"env\":{\"IMESSAGE_STATE_DIR\":\"<root>/talos/workers/_nochannel\",\"TELEGRAM_STATE_DIR\":\"<root>/talos/workers/_nochannel\"},\"hooks\":{\"PermissionRequest\":[{\"hooks\":[{\"command\":\"f='<root>/talos/workers/_hook/permission-relay.py'; exec /usr/bin/env -i HOME='/home/alex' PATH=/usr/bin:/bin LANG=C.UTF-8 TALOS_APP_HOME='<root>/talos' TALOS_APP_WORKER_THREAD='trip' TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_HOOK_CHECK_DIR='<root>/proj' TALOS_APP_HOOK_CHECK_HOOKS=1 TALOS_APP_WORKER_NONCE=\\\"${'${'}TALOS_APP_WORKER_NONCE-}\\\" TALOS_PERMISSION_RELAY_OFF=\\\"${'${'}TALOS_PERMISSION_RELAY_OFF-}\\\" TALOS_PERMISSION_HOOK_WAIT_S=\\\"${'${'}TALOS_PERMISSION_HOOK_WAIT_S-}\\\" CLAUDE_PID=\\\"${'${'}CLAUDE_PID-}\\\" CLAUDE_CODE_SESSION_ATTENDED=\\\"${'${'}CLAUDE_CODE_SESSION_ATTENDED-}\\\" CLAUDE_PROJECT_DIR=\\\"${'${'}CLAUDE_PROJECT_DIR-}\\\" XDG_STATE_HOME=\\\"${'${'}XDG_STATE_HOME-}\\\" CHRONOS_CONFIG=\\\"${'${'}CHRONOS_CONFIG-}\\\" /bin/sh -c '[ -f \\\"$0\\\" ] || exit 0; exec \\\"$1\\\" -I -S \\\"$0\\\"' \\\"$f\\\" '/usr/bin/python3'\",\"timeout\":3600,\"type\":\"command\"}]}]},\"permissions\":{\"defaultMode\":\"bypassPermissions\",\"deny\":[\"Read(/<root>/talos/**)\",\"Read(/<root>/talos)\",\"Edit(/<root>/talos/**)\",\"Edit(/<root>/talos)\",\"Edit(/<root>/talos/workers/**)\",\"Edit(/<root>/talos/workers)\",\"Bash(talos-app post:*)\",\"Bash(*talos-app post*)\",\"Bash(*cli.ts post*)\",\"EnterWorktree\"],\"disableAutoMode\":\"disable\"},\"pluginConfigs\":{\"agents-md@builtin\":{\"options\":{\"instructionFiles\":\"claude-md-and-agents-md\"}},\"cc-plugin-agents-md@builtin\":{\"options\":{\"instructionFiles\":\"claude-md-and-agents-md\"}}}}","main":{"permissionArgs":["--dangerously-skip-permissions"],"defaultMode":null,"mcpServers":["github"],"denyRules":[]}}`
  const GOLDEN_PLAN = String.raw`{"launch":{"session":"t-trip","argv":["/usr/bin/claude","--permission-mode=default","--settings","<root>/u/.talos/workers/trip/settings.json","--name","talos-trip","--setting-sources=user","--system-prompt-snapshot=off","--append-system-prompt-file=<root>/u/.talos/workers/trip/system-prompt.md","--mcp-config=<root>/u/.talos/workers/trip/mcp.json","--resume","11111111-2222-3333-4444-555555555555"],"cwd":"<root>/u/trip","env":{"PATH":"/usr/bin","HOME":"<root>/u","TALOS_APP_WORKER_THREAD":"trip","TALOS_SESSION_ROLE":"worker","TALOS_APP_THREAD_STATE":"1","TALOS_APP_HOME":"<root>/u/.talos","TALOS_APP_WORKER_NONCE":"abababababababababababababababab","TELEGRAM_STATE_DIR":"<root>/u/.talos/workers/_nochannel","IMESSAGE_STATE_DIR":"<root>/u/.talos/workers/_nochannel"}},"settingsJSON":"{\"disableSkillShellExecution\":true,\"enabledPlugins\":{\"imessage@claude-plugins-official\":false,\"telegram@claude-plugins-official\":false},\"env\":{\"IMESSAGE_STATE_DIR\":\"<root>/u/.talos/workers/_nochannel\",\"TELEGRAM_STATE_DIR\":\"<root>/u/.talos/workers/_nochannel\"},\"hooks\":{\"PermissionRequest\":[{\"hooks\":[{\"command\":\"f='<root>/u/.talos/workers/_hook/permission-relay.py'; exec /usr/bin/env -i HOME='<root>/u' PATH=/usr/bin:/bin LANG=C.UTF-8 TALOS_APP_HOME='<root>/u/.talos' TALOS_APP_WORKER_THREAD='trip' TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_HOOK_CHECK_DIR='<root>/u/trip' TALOS_APP_HOOK_CHECK_HOOKS=1 TALOS_APP_WORKER_NONCE=\\\"${'${'}TALOS_APP_WORKER_NONCE-}\\\" TALOS_PERMISSION_RELAY_OFF=\\\"${'${'}TALOS_PERMISSION_RELAY_OFF-}\\\" TALOS_PERMISSION_HOOK_WAIT_S=\\\"${'${'}TALOS_PERMISSION_HOOK_WAIT_S-}\\\" CLAUDE_PID=\\\"${'${'}CLAUDE_PID-}\\\" CLAUDE_CODE_SESSION_ATTENDED=\\\"${'${'}CLAUDE_CODE_SESSION_ATTENDED-}\\\" CLAUDE_PROJECT_DIR=\\\"${'${'}CLAUDE_PROJECT_DIR-}\\\" XDG_STATE_HOME=\\\"${'${'}XDG_STATE_HOME-}\\\" CHRONOS_CONFIG=\\\"${'${'}CHRONOS_CONFIG-}\\\" /bin/sh -c '[ -f \\\"$0\\\" ] || exit 0; exec \\\"$1\\\" -I -S \\\"$0\\\"' \\\"$f\\\" '/usr/bin/python3'\",\"timeout\":3600,\"type\":\"command\"}]}],\"PreCompact\":[{\"hooks\":[{\"command\":\"f='<root>/u/.talos/workers/_hook/thread-state.py'; exec /usr/bin/env -i HOME='<root>/u' PATH=/usr/bin:/bin LANG=C.UTF-8 TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_THREAD='trip' CLAUDE_PROJECT_DIR='<root>/u/agent' XDG_STATE_HOME=\\\"${'${'}XDG_STATE_HOME-}\\\" /bin/sh -c '[ -f \\\"$0\\\" ] || exit 0; exec \\\"$1\\\" -B -X \\\"pycache_prefix=$4\\\" -I -S \\\"$0\\\" \\\"$2\\\" \\\"$3\\\"' \\\"$f\\\" '/usr/bin/python3' save '<root>/u/agent' '/nonexistent'\",\"timeout\":5,\"type\":\"command\"}]}],\"SessionStart\":[{\"hooks\":[{\"command\":\"f='<root>/u/.talos/workers/_hook/thread-state.py'; exec /usr/bin/env -i HOME='<root>/u' PATH=/usr/bin:/bin LANG=C.UTF-8 TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_THREAD='trip' CLAUDE_PROJECT_DIR='<root>/u/agent' XDG_STATE_HOME=\\\"${'${'}XDG_STATE_HOME-}\\\" /bin/sh -c '[ -f \\\"$0\\\" ] || exit 0; exec \\\"$1\\\" -B -X \\\"pycache_prefix=$4\\\" -I -S \\\"$0\\\" \\\"$2\\\" \\\"$3\\\"' \\\"$f\\\" '/usr/bin/python3' inject '<root>/u/agent' '/nonexistent'\",\"timeout\":5,\"type\":\"command\"}],\"matcher\":\"startup|resume|clear|compact|fork\"}]},\"permissions\":{\"allow\":[\"Edit(/<root>/u/agent/threads/trip.state.md)\"],\"defaultMode\":\"default\",\"deny\":[\"Read(/<root>/u/.talos/**)\",\"Read(/<root>/u/.talos)\",\"Edit(/<root>/u/.talos/**)\",\"Edit(/<root>/u/.talos)\",\"Edit(/<root>/u/.talos/workers/**)\",\"Edit(/<root>/u/.talos/workers)\",\"Bash(talos-app post:*)\",\"Bash(*talos-app post*)\",\"Bash(*cli.ts post*)\",\"EnterWorktree\",\"Edit(/<root>/u/agent/hooks/**)\",\"Edit(/<root>/u/agent/kit/hooks/**)\",\"Edit(/<root>/u/agent/**/.claude/**)\",\"Edit(/<root>/u/trip/.claude)\",\"Edit(/<root>/u/trip/.claude/**)\",\"Edit(/<root>/u/trip/.mcp.json)\",\"Edit(/<root>/u/trip/.env*)\",\"Edit(/<root>/u/agent/.claude)\",\"Edit(/<root>/u/agent/.claude/**)\",\"Edit(/<root>/u/agent/.mcp.json)\",\"Edit(/<root>/u/agent/.env*)\",\"Edit(/<root>/u/.claude/settings.json)\",\"Edit(/<root>/u/.claude/settings.local.json)\",\"Edit(/<root>/u/.claude/skills/**)\",\"Edit(/<root>/u/.claude/commands/**)\",\"Edit(/<root>/u/.claude/agents/**)\",\"Edit(/<root>/u/.claude/plugins/**)\",\"Edit(/<root>/u/.claude/hooks/**)\",\"Edit(/<root>/u/.claude/CLAUDE.md)\",\"Edit(/<root>/u/.claude/rules/**)\",\"Edit(/<root>/u/.claude/output-styles/**)\",\"Edit(/<root>/u/.claude/workflows/**)\",\"Edit(/<root>/u/.claude/routines/**)\",\"Edit(/<root>/u/.claude.json)\",\"Edit(/<root>/u/agent/threads/trip.state.md/**)\"],\"disableAutoMode\":\"disable\"},\"pluginConfigs\":{\"agents-md@builtin\":{\"options\":{\"instructionFiles\":\"claude-md-and-agents-md\"}},\"cc-plugin-agents-md@builtin\":{\"options\":{\"instructionFiles\":\"claude-md-and-agents-md\"}}}}","cwd":"<root>/u/trip"}`

  onCaseExactTmp('the spec', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-golden-')))
    dirs.push(root)
    for (const d of ['agent', 'talos', 'proj']) mkdirSync(join(root, d))
    const s = buildWorkerSpec({
      threadId: 'trip',
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      claudePath: '/usr/bin/claude',
      baseEnv: { PATH: '/usr/bin', HOME: '/home/alex', ENABLE_CLAUDEAI_MCP_SERVERS: 'true' },
      talosHome: join(root, 'talos'),
      agentDir: join(root, 'agent'),
      permissionHook: {
        script: join(root, 'talos', 'workers', '_hook', 'permission-relay.py'),
        python: '/usr/bin/python3',
      },
      cwd: join(root, 'proj'),
      parentCwd: null,
      model: 'sonnet',
      effort: 'high',
      nonce: 'ab'.repeat(16),
      permissionFlag: '--dangerously-skip-permissions',
      preamble: 'Be the trip thread.',
      mcpConfigPath: null,
      main: {
        permissionArgs: ['--dangerously-skip-permissions'],
        defaultMode: null,
        mcpServers: ['github'],
        denyRules: [],
      },
      mcp: null,
    })
    expect(JSON.stringify(lessRecorder(s, join(root, 'talos'))).replaceAll(root, '<root>')).toBe(GOLDEN_SPEC)
  })
  onCaseExactTmp(
    'the planner’s launch, with servers in ~/.claude.json and the thread folder, and no mcp.json written',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-golden-')))
      dirs.push(root)
      const userHome = join(root, 'u')
      const agentDir = join(userHome, 'agent')
      const talosHome = join(userHome, '.talos')
      const trip = join(userHome, 'trip')
      for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { command: 'bun' } } }))
      writeFileSync(
        join(userHome, '.claude.json'),
        JSON.stringify({ mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_FICTIONAL' } } } }),
      )
      writeFileSync(join(trip, '.mcp.json'), JSON.stringify({ mcpServers: { 'local-db': { command: 'db' } } }))
      const planner = workerPlanner({
        threadFolders: () => [],
        kitVendor: sealedRelease(),
        talosHome,
        userHome,
        agentDir,
        resolvePython: () => '/usr/bin/python3',
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => ['--permission-mode=default'],
        managedDir: NO_MANAGED,
      })
      const p = planner({
        thread: { id: 'trip', cwd: trip, model: 'inherit', effort: null, parentCwd: null },
        sessionId: '11111111-2222-3333-4444-555555555555',
        resume: true,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: userHome },
      })
      // the preamble is today's default text (worker-preamble.test.ts pins it): here only where it goes
      const preamble = JSON.stringify(`--append-system-prompt=${defaultPreamble('trip')}`)
      // the launch byte for byte; its spec hash and instructions digest (restart-on-update, launch-spec.ts) are checked on their
      // own, never part of the launch
      const { specHash, instructionsHash, ...launch } = p as {
        settingsJSON: string
        specHash?: string
        instructionsHash?: string
      }
      expect(specHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(instructionsHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(
        JSON.stringify(lessRecorder(launch, talosHome))
          .replaceAll(root, '<root>')
          .replace(preamble, '"--append-system-prompt=<preamble>"'),
      ).toBe(GOLDEN_PLAN)
      expect(() => statSync(join(talosHome, 'workers', 'trip', 'mcp'))).toThrow()
    },
  )
})

describe('the planner with a list', () => {
  function world() {
    const t = new Tree()
    t.standard()
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome: t.talosHome,
      userHome: t.home,
      agentDir: t.agentDir,
      claudeDir: t.claudeDir,
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--permission-mode=default'],
      managedDir: NO_MANAGED,
    })
    const plan = (mcpAllow: string[] | undefined) =>
      planner({
        thread: {
          id: 'trip',
          cwd: t.cwd,
          model: 'inherit',
          effort: null,
          parentCwd: null,
          ...(mcpAllow ? { mcpAllow } : {}),
        },
        sessionId: SID,
        resume: false,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: t.home },
      })
    return { t, plan }
  }
  onCaseExactTmp('writes the generated file and launches strict: user servers Main can see are allowed', () => {
    const { t, plan } = world()
    const p = plan(['github'])
    if ('refused' in p) throw new Error(p.refused.detail)
    expect(p.launch.argv).toContain('--strict-mcp-config')
    expect(p.launch.argv).toContain(`--mcp-config=${t.mcpFile}`)
    expect(p.launch.argv).toContain('--no-chrome')
    expect(p.launch.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(statSync(t.mcpFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(t.mcpFile, 'utf8')).mcpServers.github.env.GITHUB_TOKEN).toBe(SECRET)
    expect(JSON.stringify(p)).not.toContain(SECRET)
  })
  onCaseExactTmp(
    'an unapproved project server: mode_escalation_denied on the mcp axis, nothing written, no value said',
    () => {
      const { t, plan } = world()
      const p = plan(['local-db'])
      expect(p).toMatchObject({ refused: { code: 'mode_escalation_denied', axis: 'mcp' } })
      const detail = 'refused' in p ? p.refused.detail : ''
      expect(detail).toContain('claude mcp add -s local local-db')
      expect(JSON.stringify(p)).not.toContain(PROJECT_SECRET)
      expect(JSON.stringify(p)).not.toContain('db-mcp')
      expect(() => statSync(t.mcpFile)).toThrow()
    },
  )
  onCaseExactTmp('no talos-app to copy: a failed start that says so', () => {
    const { t, plan } = world()
    writeFileSync(join(t.agentDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    expect(plan([])).toMatchObject({ refused: { code: 'start_failed' } })
  })
  onCaseExactTmp('the generated file a link: a failed start, nothing written through it', () => {
    const { t, plan } = world()
    mkdirSync(dirname(t.mcpFile), { recursive: true })
    const target = join(t.root, 'elsewhere.json')
    writeFileSync(target, 'keep')
    symlinkSync(target, t.mcpFile)
    expect(plan(['github'])).toMatchObject({ refused: { code: 'start_failed' } })
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
})

describe('the list as config.json has it', () => {
  const config = (opts: unknown) => ({
    default_thread: 'general',
    dedicated: { enabled: true },
    threads: [
      { id: 'general', kind: 'fixed' },
      { id: 'trip', kind: 'user', session: 'dedicated', ...(opts === undefined ? {} : { session_opts: opts }) },
    ],
  })
  const read = (opts: unknown) => dedicatedThreads(config(opts), '/home/alex/agent')?.[0]?.mcpAllow
  it('absent is no list; a list is the list; junk is the empty list, never none', () => {
    expect(read(undefined)).toBeUndefined()
    expect(read({})).toBeUndefined()
    expect(read(null)).toBeUndefined()
    expect(read({ mcp_allow: [] })).toEqual([])
    expect(read({ mcp_allow: ['github', 'plugin:zoom:zoom-mcp'] })).toEqual(['github', 'plugin:zoom:zoom-mcp'])
    for (const junk of ['github', 5, null, ['a', 'a'], ['a,b'], [1], ['a\u0000b'], [' a']])
      expect(read({ mcp_allow: junk })).toEqual([])
    expect(read({ mcp_allow: Array.from({ length: 33 }, (_, k) => `s${k}`) })).toEqual([])
    expect(read('x')).toEqual([]) // a session_opts that is not an object
    expect(read(['x'])).toEqual([])
  })
})
