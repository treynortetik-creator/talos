// The lead's `.claude/settings.json` (docs/OPTION-C.md "Leads"). It switches on Claude Code's OS sandbox and locks it (no
// way out for a command, no start without it), denies whole roots to Read, Grep and Glob and writes to them (the sandbox
// turns these rules into kernel-enforced limits for Bash and every child process), switches off every connector the
// owner's main agent has, and registers the two hooks. See src/lead/fence.ts for the roots.
import { isAbsolute } from 'node:path'
import { defaultLeadRoots } from './fence.ts'

export const LEAD_BRIEF_MAX = 6144
export const LEAD_BOARD_MAX = 4096

/** MCP servers a lead never gets. The owner's own (from ~/.claude.json, or `--disable-mcp`) are added to these. */
export const LEAD_DEFAULT_DISABLED_MCP = [
  'claude-in-chrome',
  'computer-use',
  'Claude_Browser',
  'playwright',
  'puppeteer',
] as const

/** The one server a lead keeps. */
export const LEAD_KEPT_MCP = 'talos-app'

/** Tools a lead never gets: they run outside the sandbox, or reach other sessions. A lead talks to main through the talos-app hand-off tool. */
export const LEAD_DENIED_TOOLS = [
  'Monitor',
  'Tmux',
  'PowerShell',
  'SendMessage',
  'ListAgents',
  'RemoteTrigger',
] as const

/**
 * Files and folders the file tools (Edit, Write, NotebookEdit) never touch in a lead: shell start-up files, launch agents,
 * ssh and git config, the places commands are found, package-manager config. `~` is the owner's home. Best effort: the
 * Bash sandbox already confines writes to the lead's folder and tmp. A file gets its exact path, a folder `/**` and the
 * bare path. The folders on the owner's PATH when `lead init` runs are added to these.
 */
export const LEAD_AUTOSTART_FILES = [
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
] as const
export const LEAD_AUTOSTART_FOLDERS = [
  '~/.config/fish',
  '~/Library/LaunchAgents',
  '~/Library/LaunchDaemons',
  '~/.ssh',
  '~/.config/git',
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
] as const

/** Folders whose contents are throw-away: never added from PATH. */
const TMP_DIRS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
const GLOB_CHARS = /[*?[\]{}]/

/** The sandbox keys a lead must have; a re-run puts them back whatever the old file said. */
export const LEAD_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } as const

export type LeadSettingsOpts = {
  /** The main agent folder. */
  agentDir: string
  /** The Talos app home ($TALOS_APP_HOME). */
  talosHome: string
  /** The owner's home. */
  home: string
  /** Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else `<home>/.claude` (see `claudeConfigDir`). Read once by the caller. */
  claudeDir: string
  /** The lead's own folder: its `.claude` is closed to its own Edit and Write, and its package caches live in `.cache` there. */
  folder?: string
  /** The folders on the owner's PATH (the CLI reads PATH once). Relative, tmp, glob and too-broad ones are left out. */
  pathDirs?: readonly string[]
  /** More tmp folders to leave out of `pathDirs` ($TMPDIR; the CLI reads it once). */
  tmpDirs?: readonly string[]
  /** More roots to protect (`--protect`). */
  protect?: readonly string[]
  /** More MCP servers to switch off, by the name they have in the owner's setup. */
  disableMcp?: readonly string[]
  /** What the owner's main project switched off, and the servers at user scope (from ~/.claude.json). */
  ownerMcp?: { disabled: readonly string[]; userScope: readonly string[] }
}

const READERS = ['Read', 'Grep', 'Glob'] as const
const WRITERS = ['Edit', 'Write', 'NotebookEdit'] as const

function needAbs(p: string, what: string): string {
  if (!p || !isAbsolute(p)) throw new Error(`${what} must be an absolute path`)
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Claude Code's rule for an absolute path starts with two slashes. */
const abs = (p: string) => `/${p}`
const uniq = <T>(...lists: Array<readonly T[] | undefined>) => [...new Set(lists.flatMap((l) => l ?? []))]

/** The prefix Claude Code gives a server's tools: anything outside letters, digits, `_` and `-` becomes `_`; a plugin's server is `plugin_<plugin>_<server>`. */
export function mcpPrefix(name: string): string {
  return (name.startsWith('plugin:') ? `plugin_${name.slice('plugin:'.length)}` : name).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** `mcp__<server>__*` for each server except the one a lead keeps. */
export function mcpDenyRules(names: readonly string[]): string[] {
  return uniq(names.filter((n) => n !== LEAD_KEPT_MCP).map((n) => `mcp__${mcpPrefix(n)}__*`))
}

export function leadSettings(o: LeadSettingsOpts) {
  const agentDir = needAbs(o.agentDir, 'the main agent folder')
  const talosHome = needAbs(o.talosHome, 'the Talos home')
  const home = needAbs(o.home, 'the home folder')
  const claudeDir = needAbs(o.claudeDir, "Claude Code's config folder")
  const protect = (o.protect ?? []).map((p) => needAbs(p, 'a protected root'))
  const roots = defaultLeadRoots({ agentDir, talosHome, home, claudeDir, protect })

  const deny: string[] = []
  // each root in whole, in the spelling given and in lower case (macOS compares names without case)
  const forms = (r: string) => uniq([r, r.toLowerCase()])
  for (const tool of READERS)
    for (const r of roots) for (const f of forms(r)) deny.push(`${tool}(${abs(f)}/**)`, `${tool}(${abs(f)})`)
  for (const tool of WRITERS)
    for (const r of roots) for (const f of forms(r)) deny.push(`${tool}(${abs(f)}/**)`, `${tool}(${abs(f)})`)
  const env: Record<string, string> = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
  if (o.folder) {
    const own = needAbs(o.folder, 'the lead folder')
    for (const tool of WRITERS) deny.push(`${tool}(${abs(own)}/.claude/**)`, `${tool}(${abs(own)}/.talos-lead)`)
    // the shared package caches are outside the sandbox's writable area (and must stay so): caches go in the lead's folder
    env.npm_config_cache = `${own}/.cache/npm`
    env.npm_config_store_dir = `${own}/.cache/pnpm-store`
    env.BUN_INSTALL_CACHE_DIR = `${own}/.cache/bun`
  }
  // autostart and exec paths: closed to the file tools in the spelling given and in lower case
  const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)
  const own = o.folder ? needAbs(o.folder, 'the lead folder') : undefined
  const tmp = uniq(
    TMP_DIRS,
    (o.tmpDirs ?? []).filter((d) => isAbsolute(d)).map((d) => d.replace(/\/+$/, '')),
  )
  const pathDirs = (o.pathDirs ?? [])
    .filter((d) => isAbsolute(d) && !GLOB_CHARS.test(d))
    .map((d) => (d.length > 1 ? d.replace(/\/+$/, '') : d))
    .filter((d) => d !== '/' && !tmp.some((t) => under(d, t)) && !(own && (under(d, own) || under(own, d))))
  const expand = (p: string) => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p)
  for (const tool of WRITERS) {
    for (const f of LEAD_AUTOSTART_FILES) for (const x of forms(expand(f))) deny.push(`${tool}(${abs(x)})`)
    for (const d of [...LEAD_AUTOSTART_FOLDERS.map(expand), ...pathDirs])
      for (const x of forms(d)) deny.push(`${tool}(${abs(x)}/**)`, `${tool}(${abs(x)})`)
  }
  deny.push(...LEAD_DENIED_TOOLS)

  const owner = o.ownerMcp ?? { disabled: [], userScope: [] }
  const disabled = uniq<string>(LEAD_DEFAULT_DISABLED_MCP, o.disableMcp, owner.disabled, owner.userScope).filter(
    (n) => n !== LEAD_KEPT_MCP,
  )
  // every plugin's MCP servers are off too (the one server a lead keeps comes from --mcp-config, not a plugin)
  deny.push(...mcpDenyRules(disabled), 'mcp__claude_ai_*', 'mcp__plugin_*')

  return {
    sandbox: { ...LEAD_SANDBOX },
    permissions: { deny: uniq(deny) },
    // server names from .mcp.json files that stay off, and no auto-approval of project servers
    disabledMcpjsonServers: disabled,
    enableAllProjectMcpServers: false,
    // claude.ai account connectors are off for this session
    disableClaudeAiConnectors: true as const,
    env,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/turn-start.sh' }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/board-stop.sh' }],
        },
      ],
    },
  }
}

export type LeadSettings = ReturnType<typeof leadSettings>

/**
 * A re-run: keep what the owner added (other keys, his own deny and allow rules, his disabled servers) and put every fence
 * rule back. The sandbox is rebuilt from the safe keys (only the owner's `network` object stays). The hooks are the kit's, so they are replaced, not
 * appended to; the old PreToolUse guard (`lead-guard.sh`) is dropped and the owner's own PreToolUse entries stay.
 */
export function mergeLeadSettings(existing: unknown, fresh: LeadSettings): Record<string, unknown> {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const old = obj(existing)
  const perms = obj(old.permissions)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  const env = obj(old.env) as Record<string, string>
  // the old guard goes at the inner-hook level: an owner hook in the same group stays, an empty group and key do not
  const hooks = { ...obj(old.hooks) }
  const isGuard = (h: unknown) => JSON.stringify(h).includes('lead-guard.sh')
  const pre = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse.flatMap((g: unknown) => {
        const group = obj(g)
        if (!Array.isArray(group.hooks)) return isGuard(g) ? [] : [g]
        const left = group.hooks.filter((h: unknown) => !isGuard(h))
        return left.length === group.hooks.length ? [g] : left.length ? [{ ...group, hooks: left }] : []
      })
    : []
  if (pre.length) hooks.PreToolUse = pre
  else delete hooks.PreToolUse
  // the sandbox is rebuilt from the safe keys; only an owner `network` object (domains the lead may reach) is kept
  const oldNet = obj(old.sandbox).network
  const sandbox = {
    ...fresh.sandbox,
    ...(oldNet && typeof oldNet === 'object' && !Array.isArray(oldNet) ? { network: oldNet } : {}),
  }
  return {
    ...old,
    sandbox,
    permissions: { ...perms, deny: uniq(list(perms.deny), fresh.permissions.deny) },
    disabledMcpjsonServers: uniq(list(old.disabledMcpjsonServers), fresh.disabledMcpjsonServers),
    enableAllProjectMcpServers: false,
    disableClaudeAiConnectors: true,
    env: { ...env, ...fresh.env },
    hooks: { ...hooks, ...fresh.hooks },
  }
}
