// The MCP allow list at a thread session's launch (docs/OPTION-C.md "Leads and the fence", `session_opts.mcp_allow`), for the
// Linux supervisor: the port of the Mac's WorkerMcp.swift. No list: the session gets what Claude Code gives it, as before. A
// list, even an empty one: `--strict-mcp-config` with a generated config holding `talos-app` (always) and the definition of
// each listed server, copied from where the owner defined it; the claude.ai connectors and Chrome off; the browser and screen
// servers denied; `mcp__<server>__*` denied for the servers that exist but are not on the list.
//
// A server definition can carry credentials (`env`, `headers`). They are copied byte for byte into one file this supervisor
// writes (0600, in a 0700 folder, atomically, never through a link), and no value from a definition is ever put in a log line,
// an audit field, a notice or an error: only server names (the owner's own list) and our own paths are.
//
// Where the owner defined servers, read only (Claude Code may be running, and it owns those files):
//   user     `mcpServers` of Claude Code's global config: `.claude.json` in CLAUDE_CONFIG_DIR when it is set (even to
//            ~/.claude itself), else `~/.claude.json` (globalConfigFiles)
//   local    `projects[<folder>].mcpServers` of the same file(s), under the folder as given and as it really is
//   project  the thread folder's `.mcp.json` (both shapes: `{ "mcpServers": {…} }` and the table itself), only once approved
//   plugin   `plugin:<plugin>:<server>`, from an installed plugin that is switched on in the owner's settings.json
// Precedence is Claude Code's: local over user over project, so a `.mcp.json` the folder ships never shadows the owner's own.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isMcpConnector,
  MCP_CHANNEL_PLUGINS,
  MCP_CONNECTOR_DENY,
  MCP_NEVER_OPEN,
  mcpToolPrefix,
  WORKER_MCP_APP,
  workerMcpConfigPath,
} from '@talos-app/protocol'
import { INSTRUCTION_PLUGINS } from './worker-policy.ts'
import { cleanMcpEntry } from './worker-spec.ts'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

function object(path: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** A server table with the entries that are not objects, and the ones only an SDK host can register, left out. */
function table(raw: unknown): Map<string, Json> {
  const out = new Map<string, Json>()
  if (!isObject(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (isObject(v) && v.type !== 'sdk') out.set(k, v)
  return out
}

const tableOrSelf = (o: Json) => table(Object.hasOwn(o, 'mcpServers') ? o.mcpServers : o)

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const folderKeys = (cwd: string) => [...new Set([cwd, real(cwd)])]

const childOf = (o: Json | undefined | null, k: string): Json | undefined => {
  if (!o || !Object.hasOwn(o, k)) return undefined
  const v = o[k]
  return isObject(v) ? v : undefined
}

export type McpScope = 'user' | 'local' | 'project' | 'plugin'
/** A server and where it was defined. `unfillable`: a plugin server that names a path this supervisor cannot fill in. */
export type McpEntry = { def: Json; scope: McpScope; unfillable: boolean }

/**
 * The global config Claude Code itself reads (2.1.322): `join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json")`. `configHome` is
 * that folder: CLAUDE_CONFIG_DIR when it is set (even to ~/.claude itself, where the file is ~/.claude/.claude.json), else the
 * home folder. Nothing else (a stale file elsewhere is not Claude Code's, and must not define or approve a server).
 */
export function globalConfigFiles(configHome: string, _claudeDir?: string): string[] {
  return [join(configHome.replace(/\/+$/, ''), '.claude.json')]
}

/** The folder Claude Code reads `.claude.json` from, for an environment: its CLAUDE_CONFIG_DIR when set, else the home folder. */
export function claudeJsonHome(env: Record<string, string | undefined>, userHome: string, claudeDir: string): string {
  return env.CLAUDE_CONFIG_DIR ? claudeDir : userHome
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Every server a session started in `cwd` could use, by name. Holds credentials: never log it. */
export function mcpEntries(cwd: string, home: string, claudeDir: string): Map<string, McpEntry> {
  const out = new Map<string, McpEntry>()
  const project = object(join(cwd, '.mcp.json'))
  if (project) for (const [k, v] of tableOrSelf(project)) out.set(k, { def: v, scope: 'project', unfillable: false })
  const local = new Map<string, Json>()
  for (const file of globalConfigFiles(home, claudeDir)) {
    const j = object(file)
    if (!j) continue
    for (const [k, v] of table(j.mcpServers)) out.set(k, { def: v, scope: 'user', unfillable: false })
    const projects = childOf(j, 'projects')
    for (const key of folderKeys(cwd)) for (const [k, v] of table(childOf(projects, key)?.mcpServers)) local.set(k, v)
  }
  for (const [k, v] of local) out.set(k, { def: v, scope: 'local', unfillable: false })
  for (const [k, v] of pluginServers(claudeDir, cwd)) out.set(k, v)
  return out
}

/** Every server a session started in `cwd` could use, by name, with its definition. */
export function mcpCatalog(cwd: string, home: string, claudeDir: string): Map<string, Json> {
  return new Map([...mcpEntries(cwd, home, claudeDir)].map(([k, e]) => [k, e.def]))
}

/** The names a session started in `cwd` could use (Main's, for the ceiling, with `cwd` the agent folder). */
export function visibleMcpNames(cwd: string, home: string, claudeDir: string): string[] {
  // what that session can really use: not the servers the owner switched off for the folder (/mcp's toggle), and of the
  // folder's own .mcp.json only what was approved, so a worker's ceiling is never wider than Main's
  const off = new Set<string>()
  for (const file of globalConfigFiles(home, claudeDir)) {
    const projects = childOf(object(file), 'projects')
    for (const key of folderKeys(cwd)) for (const n of strings(childOf(projects, key)?.disabledMcpServers)) off.add(n)
  }
  const names = [...mcpEntries(cwd, home, claudeDir)]
    .filter(([n, e]) => !off.has(n) && (e.scope !== 'project' || projectApproved(n, cwd, home, claudeDir)))
    .map(([n]) => n)
  return [...new Set([...names, WORKER_MCP_APP])]
}

/**
 * What the owner approved of the folder's `.mcp.json`: the folder's entry in the global config and the owner's own
 * settings.json. The folder's own settings files are NOT read, so a cloned repository's settings can't approve its servers;
 * but an approval the owner gave by name in settings.json holds for a server of that name in any folder (as in Claude Code
 * itself). A rejection beats an approval.
 */
export function projectApproved(name: string, cwd: string, home: string, claudeDir: string): boolean {
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  let all = false
  const take = (o: Json | undefined | null) => {
    if (!o) return
    for (const s of strings(o.enabledMcpjsonServers)) enabled.add(s)
    for (const s of strings(o.disabledMcpjsonServers)) disabled.add(s)
    if (o.enableAllProjectMcpServers === true) all = true
  }
  for (const file of globalConfigFiles(home, claudeDir)) {
    const projects = childOf(object(file), 'projects')
    for (const key of folderKeys(cwd)) take(childOf(projects, key))
  }
  take(object(join(claudeDir, 'settings.json')))
  return !disabled.has(name) && (all || enabled.has(name))
}

export type InstalledPlugin = { key: string; name: string; root: string; enabled: boolean }

/** The installed plugins (`<name>@<marketplace>`), from both layouts of installed_plugins.json, and whether each is on. */
export function installedPlugins(claudeDir: string): InstalledPlugin[] {
  const plugins = childOf(object(join(claudeDir, 'plugins', 'installed_plugins.json')), 'plugins')
  if (!plugins) return []
  const enabled = childOf(object(join(claudeDir, 'settings.json')), 'enabledPlugins')
  const out: InstalledPlugin[] = []
  for (const key of Object.keys(plugins).sort()) {
    const value = plugins[key]
    const entry = Array.isArray(value) ? value.filter(isObject).at(-1) : isObject(value) ? value : undefined
    const root = entry?.installPath
    if (typeof root !== 'string' || !root.startsWith('/')) continue
    const name = key.split('@')[0] ?? ''
    if (!name) continue
    out.push({
      key,
      name,
      root,
      enabled: enabled !== undefined && Object.hasOwn(enabled, key) && enabled[key] === true,
    })
  }
  return out
}

/** Claude Code's placeholders in a plugin's server definition (`${NAME}`), spelled without being a template. */
const placeholder = (name: string) => `\${${name}}`
const PLUGIN_ROOT = placeholder('CLAUDE_PLUGIN_ROOT')
const PROJECT_DIR = placeholder('CLAUDE_PROJECT_DIR')
/** What is left after the fill that this supervisor cannot name: `${CLAUDE_PLUGIN_DATA}`, any newer plugin path, an option. */
const UNFILLABLE = [placeholder('CLAUDE_PLUGIN_').slice(0, -1), placeholder('user_config.').slice(0, -1)]

function substitute(v: unknown, root: string, project: string): unknown {
  if (typeof v === 'string') return v.replaceAll(PLUGIN_ROOT, root).replaceAll(PROJECT_DIR, project)
  if (Array.isArray(v)) return v.map((x) => substitute(x, root, project))
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, root, project)]))
  return v
}

/** A placeholder left after the fill: a plugin path or option this supervisor cannot name. Keys and values both. */
function hasPlaceholder(v: unknown): boolean {
  const bad = (s: string) => UNFILLABLE.some((u) => s.includes(u))
  if (typeof v === 'string') return bad(v)
  if (Array.isArray(v)) return v.some(hasPlaceholder)
  if (isObject(v)) return Object.entries(v).some(([k, x]) => bad(k) || hasPlaceholder(x))
  return false
}

/**
 * Servers of plugins that are installed and switched on, named `plugin:<plugin>:<server>`, from the plugin's install folder
 * (`.mcp.json`, or `mcpServers` in `.claude-plugin/plugin.json`). `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are
 * filled in and CLAUDE_PLUGIN_ROOT is set in a stdio server's environment; any other plugin placeholder is unfillable.
 */
export function pluginServers(claudeDir: string, projectDir: string): Map<string, McpEntry> {
  const out = new Map<string, McpEntry>()
  for (const plugin of installedPlugins(claudeDir)) {
    if (!plugin.enabled) continue
    const mcp = object(join(plugin.root, '.mcp.json'))
    let defs = mcp ? tableOrSelf(mcp) : new Map<string, Json>()
    if (defs.size === 0) defs = table(object(join(plugin.root, '.claude-plugin', 'plugin.json'))?.mcpServers)
    for (const [server, def] of defs) {
      let filled = substitute(def, plugin.root, projectDir) as Json
      if (Object.hasOwn(def, 'command')) {
        const env = isObject(filled.env) ? filled.env : {}
        filled = { ...filled, env: { ...env, CLAUDE_PLUGIN_ROOT: plugin.root } }
      }
      out.set(`plugin:${plugin.name}:${server}`, { def: filled, scope: 'plugin', unfillable: hasPlaceholder(filled) })
    }
  }
  return out
}

/** The plugins that carry a messaging channel into a session: never on a thread session's list. */
export function isChannelPlugin(name: string): boolean {
  const parts = name.split(':')
  return (
    parts.length >= 3 && parts[0] === 'plugin' && (MCP_CHANNEL_PLUGINS as readonly string[]).includes(parts[1] ?? '')
  )
}

const isNeverOpen = (name: string) => (MCP_NEVER_OPEN as readonly string[]).includes(name)

export type WorkerMcpPlan = {
  configPath: string
  /** The bytes of the generated mcp.json (keys sorted). The only place a definition's values go. */
  configJSON: string
  /** The listed servers whose definitions are in the file, in the order listed. talos-app is always in it and not named here. */
  allowed: string[]
  /** Listed servers that exist nowhere: skipped. */
  missing: string[]
  /** Listed servers a thread session can never have (connectors, the browser, channel plugins) or that cannot be set up. */
  refused: string[]
  /** `mcp__<prefix>__*` for the servers that exist but are not on the list, the never-open ones and the connectors. */
  denyRules: string[]
  /** Listed servers that are the owner's own for the thread folder, with their scope (`local` or `project`). */
  ownFolder: Record<string, 'local' | 'project'>
  /** Set when a listed server of the folder's `.mcp.json` has not been approved: not launched, and this says how to fix it. */
  refusal: string | null
  /** Every installed plugin that is not on the list (`<name>@<marketplace>`): switched off in the worker's settings. */
  disabledPlugins: string[]
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObject(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    )
  return v
}

/** The plan for a list. null when the agent folder has no talos-app definition to copy: a session without it cannot read its messages. */
export function planWorkerMcp(o: {
  allow: readonly string[]
  agentDir: string
  cwd: string
  home: string
  claudeDir: string
  talosHome: string
  threadId: string
}): WorkerMcpPlan | null {
  const agent = object(join(o.agentDir, '.mcp.json'))
  const talos = agent ? table(agent.mcpServers).get(WORKER_MCP_APP) : undefined
  if (!talos) return null
  const cat = mcpEntries(o.cwd, o.home, o.claudeDir)
  const servers = new Map<string, Json>([[WORKER_MCP_APP, cleanMcpEntry(talos)]])
  const allowed: string[] = []
  const missing: string[] = []
  const refused: string[] = []
  const unapproved: string[] = []
  const own: Record<string, 'local' | 'project'> = Object.create(null)
  for (const name of o.allow) {
    if (name === WORKER_MCP_APP || allowed.includes(name) || missing.includes(name) || refused.includes(name)) continue
    if (unapproved.includes(name)) continue
    if (isMcpConnector(name) || isNeverOpen(name) || isChannelPlugin(name)) {
      refused.push(name)
      continue
    }
    const entry = cat.get(name)
    if (!entry) {
      missing.push(name)
      continue
    }
    if (entry.unfillable) {
      refused.push(name)
      continue
    }
    if (entry.scope === 'project' && !projectApproved(name, o.cwd, o.home, o.claudeDir)) {
      unapproved.push(name)
      continue
    }
    if (entry.scope === 'local' || entry.scope === 'project') own[name] = entry.scope
    // whatever the definition says, nothing a worker must never get goes with it
    servers.set(name, cleanMcpEntry(entry.def))
    allowed.push(name)
  }
  // the servers that exist for Main or for this folder, less the ones the list opens
  const known = new Set([...cat.keys(), ...mcpEntries(o.agentDir, o.home, o.claudeDir).keys()])
  for (const a of allowed) known.delete(a)
  known.delete(WORKER_MCP_APP)
  const rules = [
    ...[...known].sort().map((n) => `mcp__${mcpToolPrefix(n)}__*`),
    ...MCP_NEVER_OPEN.map((n) => `mcp__${mcpToolPrefix(n)}__*`),
    MCP_CONNECTOR_DENY,
  ]
  // every installed plugin whose servers are not on the list is off for this session
  const listed = new Set(
    allowed.flatMap((n) => {
      const p = n.split(':')
      return p.length >= 3 && p[0] === 'plugin' ? [p[1] as string] : []
    }),
  )
  const disabledPlugins = installedPlugins(o.claudeDir)
    .filter((p) => !listed.has(p.name) && !(INSTRUCTION_PLUGINS as readonly string[]).includes(p.key))
    .map((p) => p.key)
  const refusal =
    unapproved.length === 0
      ? null
      : unapproved
          .map(
            (n) =>
              `\`${n}\` is defined only in ${o.cwd}/.mcp.json and has not been approved there. Run \`claude mcp add -s local ${n} …\` in that folder, or approve it once in Claude Code there (start \`claude\` in it and answer the question), then save the thread again.`,
          )
          .join(' ')
  return {
    configPath: workerMcpConfigPath(o.talosHome, o.threadId),
    configJSON: JSON.stringify(sortKeys({ mcpServers: Object.fromEntries(servers) })),
    allowed,
    missing,
    refused,
    denyRules: [...new Set(rules)],
    ownFolder: { ...own },
    refusal,
    disabledPlugins,
  }
}

// ---- writing it ---------------------------------------------------------------------------------------------------------

/** Why the file was not written. The message names our own paths only, never a value. */
export class WorkerMcpWriteError extends Error {
  constructor(
    readonly kind: 'link_refused' | 'failed',
    readonly path: string,
  ) {
    super(kind === 'link_refused' ? `a link is in the way at ${path}` : `cannot write ${path}`)
  }
}

function kindOf(p: string): 'link' | 'dir' | 'file' | 'other' | null {
  try {
    const s = lstatSync(p)
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
  } catch {
    return null
  }
}

/**
 * The generated file: its folder is 0700 (made so, or made private again), the file is 0600 and replaces the old one whole.
 * A link in the way, at workers/, at the worker's folder, at mcp/ or at the file itself, is refused before anything is
 * written; the temp file is created exclusively, so it is never opened through a link either.
 */
export function writeWorkerMcp(plan: WorkerMcpPlan): void {
  const file = plan.configPath
  const dir = dirname(file)
  const parent = dirname(dir)
  const workers = dirname(parent)
  for (const p of [workers, parent, dir, file])
    if (kindOf(p) === 'link') throw new WorkerMcpWriteError('link_refused', p)
  const k = kindOf(file)
  if (k !== null && k !== 'file') throw new WorkerMcpWriteError('failed', file)
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  } catch {
    throw new WorkerMcpWriteError('failed', parent)
  }
  if (kindOf(dir) === null) {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch {
      throw new WorkerMcpWriteError('failed', dir)
    }
  }
  if (kindOf(dir) !== 'dir') throw new WorkerMcpWriteError('failed', dir)
  try {
    chmodSync(dir, 0o700)
  } catch {
    throw new WorkerMcpWriteError('failed', dir)
  }
  const tmp = join(dir, `.mcp.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(tmp, plan.configJSON, { mode: 0o600, flag: 'wx' })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // never made
    }
    throw new WorkerMcpWriteError('failed', file)
  }
}
