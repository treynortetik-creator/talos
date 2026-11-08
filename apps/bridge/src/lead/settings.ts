// The lead's `.claude/settings.json` (docs/OPTION-C.md "Leads and the fence"). Two profiles share one fence. LIGHT (the
// default) denies whole roots to the file tools (Read, Grep, Glob; Edit, Write, NotebookEdit), which Claude Code also
// applies to Bash's cat, head, tail, sed, tee and redirections, closes the cross-session tools, denies the browser and screen
// servers, switches the claude.ai connectors off and registers the two hooks. It has no sandbox: it stops accidents, not a determined
// process. SANDBOX (opt-in) adds Claude Code's OS sandbox, locked (no way out for a command, no start without it), which
// turns the same rules into kernel-enforced limits for Bash and every child process. Which MCP servers a lead may use is the
// thread's one allow list (`session_opts.mcp_allow`), which the Mac app applies when it starts the session (a strict MCP
// config); nothing here is written from it. See src/lead/fence.ts for the roots.
import { isAbsolute } from 'node:path'
import { defaultLeadRoots } from './fence.ts'

export const LEAD_BRIEF_MAX = 6144
export const LEAD_BOARD_MAX = 4096

export type LeadProfile = 'light' | 'sandbox'

/** MCP servers no allow list can open: they drive the owner's browser and screen. */
export const LEAD_NEVER_MCP = ['claude-in-chrome', 'computer-use'] as const

/** The servers the first version of the allow list denied by name in the lead's settings, before the Mac app applied the list. Only `stopgapMcpDenies` reads this. */
const STOPGAP_DEFAULT_DISABLED_MCP = [...LEAD_NEVER_MCP, 'Claude_Browser', 'playwright', 'puppeteer'] as const

/** The one server a lead always keeps. */
const LEAD_KEPT_MCP = 'talos-app'

/** A claude.ai account connector, as Claude Code names it (`claude.ai Gmail`). A lead's settings turn them all off. */
export const isClaudeAiConnector = (name: string) => /^claude\.ai /i.test(name)

/** Tools a lead never gets in the sandbox profile: they run outside the sandbox, or reach other sessions. A lead talks to main through the talos-app hand-off tool. */
export const LEAD_DENIED_TOOLS = [
  'Monitor',
  'Tmux',
  'PowerShell',
  'SendMessage',
  'ListAgents',
  'RemoteTrigger',
] as const
/** The light profile lifts `SendMessage` only: a Talos lead must reach the builders main names to it. */
const LEAD_LIGHT_DENIED_TOOLS = LEAD_DENIED_TOOLS.filter((t) => t !== 'SendMessage')

/** The tools the profile denies. */
export const deniedToolsFor = (profile: LeadProfile): readonly string[] =>
  profile === 'sandbox' ? LEAD_DENIED_TOOLS : LEAD_LIGHT_DENIED_TOOLS

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
  /** `light` is the default profile of `lead init`; the caller always says which. */
  profile: LeadProfile
  /** The main agent folder. */
  agentDir: string
  /** The Talos app home ($TALOS_APP_HOME). */
  talosHome: string
  /** The owner's home. */
  home: string
  /** Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else `<home>/.claude` (see `claudeConfigDir`). Read once by the caller. */
  claudeDir: string
  /** The lead's own folder: its `.claude` is closed to its own Edit and Write, and (sandbox) its package caches live in `.cache` there. */
  folder?: string
  /** The folders on the owner's PATH (the CLI reads PATH once). Relative, tmp, glob and too-broad ones are left out. */
  pathDirs?: readonly string[]
  /** More tmp folders to leave out of `pathDirs` ($TMPDIR; the CLI reads it once). */
  tmpDirs?: readonly string[]
  /** More roots to protect (`--protect`). */
  protect?: readonly string[]
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
function mcpPrefix(name: string): string {
  return (name.startsWith('plugin:') ? `plugin_${name.slice('plugin:'.length)}` : name).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** `mcp__<server>__*` for each server named. */
const mcpDenyRules = (names: readonly string[]): string[] => uniq(names.map((n) => `mcp__${mcpPrefix(n)}__*`))

/** The cache folders a sandboxed lead uses instead of the shared ones, which are outside the sandbox's writable area. */
const CACHE_ENV = {
  npm_config_cache: 'npm',
  npm_config_store_dir: 'pnpm-store',
  BUN_INSTALL_CACHE_DIR: 'bun',
  XDG_CACHE_HOME: 'xdg',
  XDG_STATE_HOME: 'state',
  PNPM_HOME: 'pnpm',
  npm_config_devdir: 'node-gyp',
  PLAYWRIGHT_BROWSERS_PATH: 'playwright',
} as const

/**
 * What the first version of the allow list wrote into a lead's settings, before the Mac app applied the list at launch: a deny
 * rule for every server the owner has (user scope, what main switched off), the defaults, every claude.ai connector and every
 * plugin server, and the same names in `disabledMcpjsonServers`. These are only the PROBABLE entries of an older folder (the owner
 * may have written the same rule himself): `lead check` lists them, and `lead init --remove-stopgap` takes out the ones that are
 * there. The browser and screen denies are not among them, they stay. `talos-app` is never in the list.
 */
export function stopgapMcpDenies(ownerMcp: { disabled: readonly string[]; userScope: readonly string[] }): {
  rules: string[]
  disabled: string[]
} {
  const disabled = uniq<string>(STOPGAP_DEFAULT_DISABLED_MCP, ownerMcp.disabled, ownerMcp.userScope).filter(
    (n) => n !== LEAD_KEPT_MCP,
  )
  const keep = new Set(mcpDenyRules(LEAD_NEVER_MCP))
  return {
    rules: uniq(mcpDenyRules(disabled), ['mcp__claude_ai_*', 'mcp__plugin_*']).filter((r) => !keep.has(r)),
    disabled,
  }
}

export function leadSettings(o: LeadSettingsOpts) {
  const agentDir = needAbs(o.agentDir, 'the main agent folder')
  const talosHome = needAbs(o.talosHome, 'the Talos home')
  const home = needAbs(o.home, 'the home folder')
  const claudeDir = needAbs(o.claudeDir, "Claude Code's config folder")
  const protect = (o.protect ?? []).map((p) => needAbs(p, 'a protected root'))
  const roots = defaultLeadRoots({ agentDir, talosHome, home, claudeDir, protect })
  const sandboxed = o.profile === 'sandbox'

  const deny: string[] = []
  // each root in whole, in the spelling given and in lower case (macOS compares names without case)
  const forms = (r: string) => uniq([r, r.toLowerCase()])
  for (const tool of READERS)
    for (const r of roots) for (const f of forms(r)) deny.push(`${tool}(${abs(f)}/**)`, `${tool}(${abs(f)})`)
  for (const tool of WRITERS)
    for (const r of roots) for (const f of forms(r)) deny.push(`${tool}(${abs(f)}/**)`, `${tool}(${abs(f)})`)
  const env: Record<string, string> = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
  const own = o.folder ? needAbs(o.folder, 'the lead folder') : undefined
  if (own) {
    for (const tool of WRITERS) deny.push(`${tool}(${abs(own)}/.claude/**)`, `${tool}(${abs(own)}/.talos-lead)`)
    // the shared package caches are outside the sandbox's writable area (and must stay so): caches go in the lead's folder.
    // The light profile has no sandbox, so it keeps the shared caches.
    if (sandboxed) for (const [k, dir] of Object.entries(CACHE_ENV)) env[k] = `${own}/.cache/${dir}`
  }
  // autostart and exec paths: closed to the file tools in the spelling given and in lower case
  const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)
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
  deny.push(...deniedToolsFor(o.profile))
  // the browser and screen servers are never open; every other server is the thread's allow list, applied by the Mac app
  deny.push(...mcpDenyRules(LEAD_NEVER_MCP))

  return {
    ...(sandboxed ? { sandbox: { ...LEAD_SANDBOX } } : {}),
    permissions: { deny: uniq(deny) },
    // no auto-approval of project servers
    enableAllProjectMcpServers: false,
    // claude.ai account connectors are off for this session. This holds from every settings scope, so a connector cannot be
    // allowed for a lead (`lead init --mcp` refuses one); a thread that is not a lead has no such setting.
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
 * A re-run: keep what the owner added (other keys, his own deny and allow rules, his env) and put every fence rule back. It
 * never weakens: a rule is only added, except the MCP denies the thread's allow list now opens. The profile changes only when `from` says the owner asked for the other one: going
 * from sandbox to light removes the sandbox keys, the `SendMessage` deny and the cache variables this tool wrote (the
 * ones that point into the lead's folder); going to the sandbox just writes it. The sandbox is rebuilt from the safe keys
 * (only the owner's `network` object stays). The hooks are the kit's, so they are replaced, not appended to; the old
 * PreToolUse guard (`lead-guard.sh`) is dropped and the owner's own PreToolUse entries stay.
 */
export function mergeLeadSettings(
  existing: unknown,
  fresh: LeadSettings,
  o: {
    toLightFrom?: 'sandbox'
    folder?: string
    /** The entries to take out because the owner asked (`lead init --remove-stopgap`): exactly these, and nothing else. */
    removeStopgap?: { rules: readonly string[]; disabled: readonly string[] }
  } = {},
): Record<string, unknown> {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const old = obj(existing)
  const perms = obj(old.permissions)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  let env = obj(old.env) as Record<string, string>
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
  // The Mac app applies the thread's allow list now, and the stopgap's denies are no longer needed. They cannot be told apart from
  // the owner's own (`mcp__playwright__*` is both), so they go only when he asks, and then only the entries named.
  const stale = new Set(o.removeStopgap?.rules ?? [])
  let denied = uniq(
    (list(perms.deny) ?? []).filter((d) => !stale.has(d)),
    fresh.permissions.deny,
  )
  const out: Record<string, unknown> = { ...old }
  if (fresh.sandbox) {
    // the sandbox is rebuilt from the safe keys; only an owner `network` object (domains the lead may reach) is kept
    const oldNet = obj(old.sandbox).network
    out.sandbox = {
      ...fresh.sandbox,
      ...(oldNet && typeof oldNet === 'object' && !Array.isArray(oldNet) ? { network: oldNet } : {}),
    }
  } else if (o.toLightFrom === 'sandbox') {
    // the owner asked for light: the sandbox this tool wrote goes, and so does the one deny it only had for the sandbox
    delete out.sandbox
    denied = denied.filter((d) => d !== 'SendMessage')
    const cache = o.folder ? `${o.folder}/.cache/` : undefined
    if (cache)
      env = Object.fromEntries(Object.entries(env).filter(([, v]) => !(typeof v === 'string' && v.startsWith(cache))))
  }
  // the stopgap's `disabledMcpjsonServers` go the same way; with no request they stay as they are
  if (o.removeStopgap) {
    const disabledJson = (list(old.disabledMcpjsonServers) ?? []).filter((n) => !o.removeStopgap?.disabled.includes(n))
    if (disabledJson.length) out.disabledMcpjsonServers = disabledJson
    else delete out.disabledMcpjsonServers
  }
  return {
    ...out,
    permissions: { ...perms, deny: denied },
    enableAllProjectMcpServers: false,
    disableClaudeAiConnectors: true,
    env: { ...env, ...fresh.env },
    hooks: { ...hooks, ...fresh.hooks },
  }
}
