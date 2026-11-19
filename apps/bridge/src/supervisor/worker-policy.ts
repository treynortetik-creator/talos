// What keeps a thread session (a worker) inside its lane, for the Linux supervisor: the TypeScript port of the Mac's
// WorkerFence.swift, GuardsSettings.swift, InstructionFiles.swift, PrivilegeCeiling.swift, SubThreadFolder.swift and the folder
// checks of WorkerSpec.swift. Paths are compared exactly: Linux file systems tell case apart (the Mac folds case as APFS does);
// a home or folder on a file system that folds case (a Windows drive under WSL, casefold ext4) is refused (foldsCase).

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { mainLaunchArgs } from '../guards/main-launch.ts'
import { realFileSync } from '../real-file.ts'

type Json = Record<string, unknown>

const readJson = (path: string): Json | null => {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

const isFolder = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---- the Talos-home fence ---------------------------------------------------------------------------------------------------

/**
 * The Talos-home deny on every worker (docs/OPTION-C.md "Leads and the fence"): Read, Grep, Glob, Edit, Write and NotebookEdit
 * denied on the whole home, in the spelling the bridge's lead fence uses (`Tool(//abs/**)` and `Tool(//abs)`), as given and
 * where it really is. No `!` rule of any kind.
 */
export const FENCE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit'] as const

/**
 * A home a deny rule can name exactly: absolute, no glob characters (`* ? [ ] { }`), no `(` `)` (they end the pattern), no `\`
 * (gitignore-style matching escapes with it), no trailing space (trimmed), no control characters, and no empty, `.` or `..`
 * part (an unnormalised spelling would be fenced, not the folder).
 */
export function fenceSafe(talosHome: string): boolean {
  if (!talosHome.startsWith('/') || talosHome.length < 2 || talosHome.endsWith(' ')) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[*?[\]{}()\\\u0000-\u001f\u007f]/.test(talosHome)) return false
  const parts = trimSlash(talosHome).split('/').slice(1)
  return parts.every((p) => p !== '' && p !== '.' && p !== '..')
}

/**
 * The folder sits on a file system that folds case (a Windows drive under WSL, ext4 with casefold, vfat, exfat, ntfs3, CIFS):
 * the same file answers to another spelling, so an exact-case fence or folder check does not hold. Tested part by part (a
 * case-folding mount sits under a case-sensitive root): a part whose name with its letters' case swapped is the same inode
 * folds. Parts without letters, and parts that are not there, are not judged (false).
 */
export function foldsCase(
  path: string,
  stat: (p: string) => { dev: number; ino: number } | null = (p) => {
    try {
      const st = statSync(p)
      return { dev: st.dev, ino: st.ino }
    } catch {
      return null
    }
  },
): boolean {
  // part by part from the root: the first part whose name with its letters' case swapped is the same file folds case
  const parts = trimSlash(path)
    .split('/')
    .filter((x) => x !== '')
  let parent = ''
  for (const name of parts) {
    const here = `${parent}/${name}`
    const swapped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')
    if (swapped !== name) {
      const a = stat(here)
      const b = stat(`${parent}/${swapped}`)
      if (a && b && a.dev === b.dev && a.ino === b.ino) return true
    }
    parent = here
  }
  return false
}

export function spellings(talosHome: string): string[] {
  const given = trimSlash(talosHome)
  const real = realOrNull(given)
  return [...new Set([given, ...(real ? [trimSlash(real)] : [])])]
}

/** The file tools a session could change a settings file with. */
const SETTINGS_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

/** In a config folder (`~/.claude`, a CLAUDE_CONFIG_DIR) no session may edit these, fence on or off: they change a session's own permissions. */
export const CONFIG_ALWAYS_DENIED = ['settings.json', 'settings.local.json', 'plugins/**', 'hooks/**'] as const
/** In a config folder these are denied with the thread fence on, and ask the owner by card with it off. */
export const CONFIG_ASK_WHEN_FENCE_OFF = [
  'skills/**',
  'commands/**',
  'agents/**',
  'CLAUDE.md',
  'rules/**',
  'output-styles/**',
  'workflows/**',
  'routines/**',
] as const
// the order the rules are written in (kept as it was before the split: a plan's spec hash covers it)
const CONFIG_ORDER = [
  'settings.json',
  'settings.local.json',
  'skills/**',
  'commands/**',
  'agents/**',
  'plugins/**',
  'hooks/**',
  'CLAUDE.md',
  'rules/**',
  'output-styles/**',
  'workflows/**',
  'routines/**',
] as const

/**
 * No file-tool edit of what Claude Code reads from a folder or a config folder: each project folder's whole `.claude` (its
 * settings, skills, commands, subagents), its `.mcp.json` and its `.env*` files; each config folder's (`~/.claude`, a
 * CLAUDE_CONFIG_DIR) CONFIG_ALWAYS_DENIED and CONFIG_ASK_WHEN_FENCE_OFF paths; and each named file (`~/.claude.json`, which holds
 * user-scope MCP servers). With the thread fence off (`fenceOff`) the CONFIG_ASK_WHEN_FENCE_OFF paths are returned as `ask` rules
 * (the owner decides on a card) and everything else stays in `deny`; with it on they are all `deny`, as before. A layer, not the
 * boundary: a Bash write is no file tool, and under acceptEdits it goes to an owner card, so it holds only while the hook answering
 * that card is the real one. Folders that cannot be named in a rule are left out.
 */
export function settingsFileRules(
  projectFolders: readonly string[],
  configFolders: readonly string[],
  files: readonly string[] = [],
  opts: { fenceOff?: boolean; home?: string } = {},
): { deny: string[]; ask: string[] } {
  const askPaths: readonly string[] = opts.fenceOff ? CONFIG_ASK_WHEN_FENCE_OFF : []
  const at: Array<[string, string, boolean]> = [
    ...projectFolders.flatMap((d) =>
      ['.claude', '.claude/**', '.mcp.json', '.env*'].map((f): [string, string, boolean] => [d, f, false]),
    ),
    ...configFolders.flatMap((d) => CONFIG_ORDER.map((f): [string, string, boolean] => [d, f, askPaths.includes(f)])),
    ...files.map((f): [string, string, boolean] => [dirname(f), basename(f), false]),
  ]
  const deny: string[] = []
  const ask: string[] = []
  for (const [dir, file, asks] of at) {
    if (!fenceSafe(dir) || /[()\\]/.test(file)) continue
    const into = asks ? ask : deny
    for (const form of spellings(dir))
      for (const tool of SETTINGS_EDIT_TOOLS) {
        const rule = `${tool}(/${form}/${file})`
        if (!into.includes(rule)) into.push(rule)
      }
  }
  // and what each config folder's own settings run (a hook script in a skills folder is no less a script): denied fence on or off,
  // after the rest, so a config folder with no hooks gives the same rules as before
  const home = opts.home ?? homedir()
  for (const dir of configFolders) {
    if (!fenceSafe(dir)) continue
    const scripts = new Set<string>()
    for (const file of ['settings.json', 'settings.local.json']) {
      const settings = readJson(join(dir, file))
      if (!settings) continue
      const commands: string[] = []
      commandsOf(settings.hooks, commands)
      commandsOf(settings.statusLine, commands)
      for (const c of commands) for (const rel of commandScripts(c, dir, home)) scripts.add(rel)
    }
    for (const rel of scripts) {
      if (rel.includes('..') || /[()\\]/.test(rel)) continue
      for (const form of spellings(dir))
        for (const tool of SETTINGS_EDIT_TOOLS) {
          const rule = `${tool}(/${form}/${rel})`
          if (!deny.includes(rule) && !ask.includes(rule)) deny.push(rule)
        }
    }
  }
  return { deny, ask }
}

/** The deny rules alone, with the thread fence on (see settingsFileRules). */
export function settingsFileDenyRules(
  projectFolders: readonly string[],
  configFolders: readonly string[],
  files: readonly string[] = [],
  home?: string,
): string[] {
  return settingsFileRules(projectFolders, configFolders, files, home === undefined ? {} : { home }).deny
}

/** Every `command` string anywhere in a settings value (hooks, status line). */
function commandsOf(v: unknown, out: string[]): void {
  if (Array.isArray(v)) for (const x of v) commandsOf(x, out)
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.command === 'string') out.push(o.command)
    for (const x of Object.values(o)) if (x && typeof x === 'object') commandsOf(x, out)
  }
}

/**
 * No file-tool edit of what the agent folder's own settings run: each hook command's and the status line's script (a path
 * under the agent folder, written `$CLAUDE_PROJECT_DIR/...` or absolute), and the agent folder's `hooks/**` and `kit/hooks/**`.
 * The agent folder's sessions load those settings (Main's, and a thread there), and a PreToolUse hook can answer "allow", so no
 * session may edit what one of them runs.
 */
export function agentScriptDenyRules(agentDir: string, home: string = homedir()): string[] {
  const dir = trimSlash(agentDir)
  if (!fenceSafe(dir)) return []
  // and every .claude folder anywhere below the agent folder: Claude Code picks up a nested one's skills once a file under it
  // is touched
  const scripts = new Set<string>(['hooks/**', 'kit/hooks/**', '**/.claude/**'])
  for (const file of ['settings.json', 'settings.local.json']) {
    const s = readJson(join(dir, '.claude', file))
    if (!s) continue
    const commands: string[] = []
    commandsOf(s.hooks, commands)
    commandsOf(s.statusLine, commands)
    for (const c of commands) for (const rel of commandScripts(c, dir, home)) scripts.add(rel)
  }
  const out: string[] = []
  for (const rel of scripts) {
    if (rel.includes('..') || /[()\\]/.test(rel)) continue
    for (const form of spellings(dir))
      for (const tool of SETTINGS_EDIT_TOOLS) {
        const rule = `${tool}(/${form}/${rel})`
        if (!out.includes(rule)) out.push(rule)
      }
  }
  return out
}

/**
 * The paths under `dir` a hook or status-line command names, relative to `dir`: the command split into words as a shell
 * would (quotes kept together, `;` `&` `|` `(` `)` between words), the value of a `name=...` word, and in each
 * `$CLAUDE_PROJECT_DIR` (with braces, quotes or a `:-` default), `$HOME`, `${HOME}` and a leading `~/` expanded; a relative
 * word with a `/` in it, or a script's name, taken from `dir`. A word with another `$` left in it is not guessed at.
 */
export function commandScripts(command: string, dir: string, home: string): string[] {
  const words: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/[\s;&|()]/.test(ch)) {
      if (started || cur !== '') words.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (started || cur !== '') words.push(cur)
  const out: string[] = []
  for (let w of words) {
    const eq = w.indexOf('=')
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w.slice(0, eq))) w = w.slice(eq + 1)
    w = w
      .replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}|\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])/g, dir)
      .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home)
    if (w.startsWith('~/')) w = join(home, w.slice(2))
    if (w === '' || w.includes('$') || w.includes('`')) continue
    if (!w.startsWith('/')) {
      if (!w.includes('/') && !/\.(py|sh|bash|js|mjs|cjs|ts|rb|pl)$/.test(w)) continue
      w = join(dir, w)
    }
    const norm = join(w)
    if (norm.startsWith(`${dir}/`)) out.push(norm.slice(dir.length + 1))
  }
  return out
}

export function fenceDenyRules(talosHome: string): string[] {
  const forms = spellings(talosHome)
  return FENCE_TOOLS.flatMap((tool) => forms.flatMap((f) => [`${tool}(/${f}/**)`, `${tool}(/${f})`]))
}

/**
 * The supervisor's own files for every thread session, closed to the file tools whatever the developer thread fence says (Delphi's
 * review): the permission hook copy (`workers/_hook`), each session's `--settings`, its mcp.json, its nonce and folder check. A
 * session that could edit them could make its own hook answer "allow", which Main itself cannot do (its hook is the guarded kit
 * release). Only the supervisor and the bridge write there, never a session's tools.
 */
export const WORKER_WRITERS = ['Edit', 'Write', 'NotebookEdit'] as const
export function workerFilesDenyRules(talosHome: string): string[] {
  const forms = spellings(talosHome)
  return WORKER_WRITERS.flatMap((tool) => forms.flatMap((f) => [`${tool}(/${f}/workers/**)`, `${tool}(/${f}/workers)`]))
}

/**
 * The two rules that let a thread's session edit its own live state file (`<agentDir>/threads/<id>.state.md`) without a prompt:
 * that exact path, as given and as it really is, for Edit and Write. No glob, no folder: a sibling (another thread's file, a
 * `.bak`, a `..` path) is not covered. A folder name that holds a rule metacharacter, a quote or a control character gets none
 * (the session then asks, the safe side), as `fenceSafe` refuses such a home.
 */
export function stateFileAllowRules(agentDir: string, threadId: string): string[] {
  return stateFileRules(agentDir, threadId, '')
}

/**
 * The matching deny rules: Claude Code reads a path rule gitignore-style, where a pattern that names a file also names everything
 * under it, so the allow rule would let a session write `<id>.state.md/anything` (Write makes parent folders). Deny wins over allow,
 * and `<file>/**` leaves the file itself alone.
 */
export function stateFileDenyRules(agentDir: string, threadId: string): string[] {
  return stateFileRules(agentDir, threadId, '/**')
}

function stateFileRules(agentDir: string, threadId: string, tail: string): string[] {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(threadId)) return []
  const forms = spellings(trimSlash(agentDir))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    .filter((f) => f.startsWith('/') && !/[*?[\]{}()!\\"'`\0-\x1f\x7f]/.test(f))
    .map((f) => `${f}/threads/${threadId}.state.md${tail}`)
  return (['Edit', 'Write'] as const).flatMap((tool) => forms.map((f) => `${tool}(/${f})`))
}

/** `settings` with `rules` added to `permissions.deny` (a union, nothing repeats); null when either is a shape it can't add to. */
export function addingDeny(rules: readonly string[], settings: Json): Json | null {
  const out: Json = { ...settings }
  let perms: Json = {}
  if (out.permissions !== undefined) {
    if (out.permissions === null || typeof out.permissions !== 'object' || Array.isArray(out.permissions)) return null
    perms = { ...(out.permissions as Json) }
  }
  let deny: string[] = []
  if (perms.deny !== undefined) {
    if (!Array.isArray(perms.deny) || !perms.deny.every((r) => typeof r === 'string')) return null
    deny = [...(perms.deny as string[])]
  }
  for (const r of rules) if (!deny.includes(r)) deny.push(r)
  perms.deny = deny
  out.permissions = perms
  return out
}

/** The fence rules a settings text lacks (all of them when it cannot be read). */
export function fenceMissing(settingsJSON: string, talosHome: string, fenceOn = true): string[] {
  const want = [...(fenceOn ? fenceDenyRules(talosHome) : []), ...workerFilesDenyRules(talosHome)]
  let have: unknown
  try {
    have = ((JSON.parse(settingsJSON) as Json).permissions as Json | undefined)?.deny ?? []
  } catch {
    return want
  }
  return Array.isArray(have) ? want.filter((r) => !have.includes(r)) : want
}

// ---- path rules made absolute -------------------------------------------------------------------------------------------------

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'MultiEdit'])

/**
 * A path rule in the absolute `//` form, anchored where it was defined: `/path` at the settings source, `path` and `./path` at
 * the current folder, and one with no slash in it (`.env`, `*.pem`) at any depth below it, as gitignore matches it. A relative
 * rule copied as it is would mean something else in a worker's folder.
 */
export function absolutize(rule: string, slashAnchor: string, cwdAnchor: string): string {
  const open = rule.indexOf('(')
  if (!rule.endsWith(')') || open < 0) return rule
  const tool = rule.slice(0, open)
  if (!PATH_TOOLS.has(tool)) return rule
  const pattern = rule.slice(open + 1, -1)
  // `Tool()` and `Tool(*)` deny the whole tool in Claude Code: never narrowed to a folder
  if (pattern === '' || pattern === '*') return rule
  if (pattern.startsWith('//') || pattern.startsWith('~')) return rule
  if (pattern.startsWith('/')) return `${tool}(/${trimSlash(slashAnchor)}${pattern})`
  const rel = pattern.replace(/^(\.\/)+/, '')
  // no slash in it (a trailing one aside): gitignore matches it at any depth below the folder, not only at its top
  if (!rel.replace(/\/+$/, '').includes('/')) return `${tool}(/${trimSlash(cwdAnchor)}/**/${rel})`
  return `${tool}(/${trimSlash(cwdAnchor)}/${rel})`
}

/** `settings` with every path rule of `permissions.deny` made absolute where it was defined. */
export function anchoring(settings: Json, slashAnchor: string, cwdAnchor: string): Json {
  const perms = settings.permissions as Json | undefined
  if (!perms || typeof perms !== 'object' || !Array.isArray(perms.deny)) return settings
  return {
    ...settings,
    permissions: {
      ...perms,
      deny: (perms.deny as unknown[]).map((r) => (typeof r === 'string' ? absolutize(r, slashAnchor, cwdAnchor) : r)),
    },
  }
}

// ---- the optional guards ------------------------------------------------------------------------------------------------------

/** Where `talos-app install-guards` writes its settings (a PreToolUse hook and deny rules). */
export const guardsPath = (talosHome: string) => join(talosHome, 'guards', 'settings.json')

/** `settings` with the guards' hooks and permissions added; null when the guards' file exists but cannot be read. */
export function withGuards(settings: Json, talosHome: string): Json | null {
  const p = guardsPath(talosHome)
  if (!existsSync(p)) return settings
  const g = readJson(p)
  if (!g) return null
  const out: Json = { ...settings }
  if (g.hooks !== undefined) out.hooks = g.hooks
  if (g.permissions !== undefined) out.permissions = g.permissions
  return out
}

/**
 * Main's args: one `--settings` with the guards (when installed) and Claude Code's own computer use turned off, the same as the
 * Mac's GuardsSettings.applyingToMain (guards/main-launch.ts). The owner's own `--settings` is kept, with the deny merged into a
 * copy; `warning` says what was missed (the guards off for that launch, or the deny).
 */
export function mainArgsWithGuards(
  args: string[],
  talosHome: string,
  cwd?: string,
): { args: string[]; warning: string | null } {
  const r = mainLaunchArgs(args, talosHome, cwd ? { cwd } : {})
  return { args: r.args, warning: r.warnings.length ? r.warnings.join('; ') : null }
}

// ---- AGENTS.md next to CLAUDE.md ----------------------------------------------------------------------------------------------

/** The built-in plugin that loads a folder's AGENTS.md next to its CLAUDE.md (its current id and its older one). */
export const INSTRUCTION_PLUGINS = ['cc-plugin-agents-md@builtin', 'agents-md@builtin'] as const

/** The instruction files a worker session reads (the plugin's option, and the files the supervisor hands a thread-folder session). */
export const INSTRUCTION_FILES_MODE = 'claude-md-and-agents-md'

export function withInstructionFiles(settings: Json): Json {
  const configs: Json = { ...((settings.pluginConfigs as Json | undefined) ?? {}) }
  for (const id of INSTRUCTION_PLUGINS) {
    const plugin = { ...((configs[id] as Json | undefined) ?? {}) }
    plugin.options = { ...((plugin.options as Json | undefined) ?? {}), instructionFiles: INSTRUCTION_FILES_MODE }
    configs[id] = plugin
  }
  return { ...settings, pluginConfigs: configs }
}

// ---- the privilege ceiling ----------------------------------------------------------------------------------------------------

export const CEILING_CODE = 'mode_escalation_denied'
export type CeilingAxis = 'permission_mode' | 'mcp' | 'deny_rules'
export type CeilingDenial = { axis: CeilingAxis; detail: string }

/** What Main has: its permission arguments and default mode, the servers it can use and the deny rules it runs under. */
export type MainCeiling = {
  permissionArgs: string[]
  defaultMode: string | null
  mcpServers: string[]
  denyRules: string[]
}

const MODE_RANKS: Record<string, number> = {
  plan: 0,
  dontAsk: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
}
const WIDEST = 4
const VALUED = new Set([
  '--settings',
  '--setting-sources',
  '--name',
  '--model',
  '--append-system-prompt',
  '--system-prompt',
  '--mcp-config',
  '--session-id',
  '--effort',
  '--add-dir',
  '--agent',
  '--agents',
  '--allowedTools',
  '--disallowedTools',
  '--fallback-model',
  '--plugin-dir',
  '--managed-settings',
  '-n',
  '--allowed-tools',
  '--disallowed-tools',
  '--tools',
  '--system-prompt-file',
  '--append-system-prompt-file',
  '--json-schema',
  '--permission-prompt-tool',
  '--debug-file',
  '--betas',
  '--file',
  '--output-format',
  '--input-format',
])
/** Flags whose value is optional: the next word is theirs only when it does not start with `-`. */
const OPTIONAL_VALUED = new Set(['-r', '--resume', '--debug', '-w', '--worktree', '--from-pr', '--remote', '--rc'])

/** Whether the argument at `k` takes the next word as its value (as Claude Code reads them). */
function skipsNext(args: readonly string[], k: number): boolean {
  const a = args[k] as string
  if (VALUED.has(a)) return true
  const next = args[k + 1]
  return OPTIONAL_VALUED.has(a) && next !== undefined && !next.startsWith('-')
}

/** Whether a flag with no value is given in Main's arguments, read as Claude Code reads them (nothing after `--`). */
export function hasFlag(args: readonly string[], flag: string): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--') return false
    if (a === flag) return true
    if (skipsNext(args, k)) k++
  }
  return false
}

/**
 * The last value of a flag in Main's arguments (`--flag value` or `--flag=value`), as Claude Code's own scan finds it: it stops
 * at `--` (the rest is the prompt) and never reads another flag's value as a flag. Undefined when it is not given.
 */
export function lastFlagValue(args: readonly string[], flag: string): string | undefined {
  let value: string | undefined
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--') break
    if (a === flag) {
      value = args[k + 1] ?? ''
      k++
    } else if (a.startsWith(`${flag}=`)) value = a.slice(flag.length + 1)
    else if (skipsNext(args, k)) k++
  }
  return value
}

/**
 * The mode a launch starts in and how wide it is: the last mode flag, else `settingsDefault`, else the default mode. A name this
 * build does not know is the widest; a flag that only makes bypass reachable by key counts as bypass.
 */
export function modeOf(args: string[], settingsDefault: string | null): { rank: number; name: string | null } {
  let named: string | null = null
  let reachable = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--dangerously-skip-permissions') named = 'bypassPermissions'
    else if (a === '--allow-dangerously-skip-permissions') reachable = true
    else if (a === '--permission-mode') {
      if (i + 1 < args.length) named = args[i + 1] as string
      i++
    } else if (a.startsWith('--permission-mode=')) named = a.slice('--permission-mode='.length)
    else if (a === '--') break
    else if (skipsNext(args, i)) i++
  }
  let name = named ?? settingsDefault
  if (name === 'manual') name = 'default'
  const base = MODE_RANKS[name ?? 'default'] ?? WIDEST
  return { rank: reachable ? Math.max(base, WIDEST) : base, name }
}

/** A mode name the ceiling can rank ('manual' is 'default'); anything else is no mode Claude Code would run in. */
export const knownMode = (m: string): boolean => m === 'manual' || MODE_RANKS[m] !== undefined

/**
 * What Main's own `--settings` (in the owner's arguments for Main) says about how Main runs: its mode, if it names one, and its
 * deny rules (made absolute where they were defined: a file's folder, or the agent folder for settings given inline).
 */
export type MainSettings =
  | { kind: 'none' }
  | { kind: 'mode'; mode: string; deny: string[]; bypassOff: boolean }
  | { kind: 'no_mode'; deny: string[]; bypassOff: boolean }
  | { kind: 'unreadable'; what: string }

/**
 * Where Claude Code puts settings given inline (a file in `<tmp>/claude-<uid>`, `<tmp>` being CLAUDE_CODE_TMPDIR or the temp
 * folder), so where their /-rules are rooted; with the agent folder and the plain temp folder too: a superset of every place
 * Main's own temp folder can be.
 */
function inlineSettingsFolders(agentDir: string, env: Record<string, string | undefined> = {}): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  // this process's temp folder and Main's own (its TMPDIR, else /tmp; its CLAUDE_CODE_TMPDIR): a superset of where it writes them
  // Main's own temp folder as Bun's tmpdir() picks it: TMPDIR, else TMP, else TEMP, else /tmp
  const mainTmp = env.TMPDIR || env.TMP || env.TEMP || '/tmp'
  const tmps = [tmpdir(), process.env.CLAUDE_CODE_TMPDIR, mainTmp, env.CLAUDE_CODE_TMPDIR].filter(
    (t): t is string => typeof t === 'string' && t !== '',
  )
  const out = [agentDir, ...tmps]
  if (uid !== null) for (const t of tmps) out.push(join(t, `claude-${uid}`))
  return [...new Set(out)]
}

/** A regular file's text, never anything else: a FIFO or a device would block or never end, and is not settings. */
function readRegularFile(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Main's own `--settings` value (the last one, as a later flag overrides an earlier): a JSON object given inline, or a file,
 * relative to Main's folder (the agent folder). Its permissions.defaultMode is the mode Main runs in (flag settings outrank the
 * project's and the user's), and its permissions.deny are rules Main runs under. A file that is not a regular file, cannot be
 * read, is not a JSON object, or has a defaultMode or deny of the wrong kind is `unreadable`: the caller does not guess (a
 * guess can be wider than Main). Read only.
 */
export function mainSettings(
  args: readonly string[],
  agentDir: string,
  env: Record<string, string | undefined> = {},
): MainSettings {
  const value = lastFlagValue(args, '--settings')
  if (value === undefined) return { kind: 'none' }
  // inline as Claude Code takes it: text that starts with { and ends with }
  const inline = value.trim().startsWith('{') && value.trim().endsWith('}')
  const what = inline ? 'the settings given inline' : value
  // a file is the one Claude Code reads: through its links, so its rules are rooted at the folder it really is in
  let file: string | null = null
  if (!inline) {
    try {
      // a relative path is opened from Main's folder as the kernel has it (its real path), so `..` climbs from there
      // walked by hand (real-file.ts): on macOS the realpath of a file can report another hard-linked name, which would root
      // its /-rules at that other name's folder
      file = realFileSync(isAbsolute(value) ? value : join(realOrNull(agentDir) ?? agentDir, value))
    } catch {
      return { kind: 'unreadable', what }
    }
  }
  const text = file === null ? value : readRegularFile(file)
  if (text === null) return { kind: 'unreadable', what }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', what }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { kind: 'unreadable', what }
  const perms = (root as Json).permissions
  if (perms === undefined) return { kind: 'no_mode', deny: [], bypassOff: false }
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return { kind: 'unreadable', what }
  const rawDeny = (perms as Json).deny
  if (rawDeny !== undefined && !Array.isArray(rawDeny)) return { kind: 'unreadable', what }
  // relative rules match from Main's folder as the kernel has it (its real path); /-rooted ones from the file's real folder,
  // or for settings given inline from both the agent folder and the temp folder Claude Code writes them to (a superset)
  const cwd = realOrNull(agentDir) ?? agentDir
  const bases = file === null ? inlineSettingsFolders(agentDir, env) : [dirname(file)]
  const deny: string[] = []
  for (const r of (rawDeny as unknown[] | undefined) ?? []) {
    if (typeof r !== 'string') continue
    for (const base of bases) {
      const a = absolutize(r, base, cwd)
      if (!deny.includes(a)) deny.push(a)
    }
  }
  const bypassOff = bypassLocked(perms as Json)
  const m = (perms as Json).defaultMode
  if (m === undefined) return { kind: 'no_mode', deny, bypassOff }
  return typeof m === 'string' ? { kind: 'mode', mode: m, deny, bypassOff } : { kind: 'unreadable', what }
}

/** The MCP server the Talos app itself is (always allowed). */
export const TALOS_MCP = 'talos-app'

/** null when the spec is within Main's ceiling; else the first axis it is wider on. */
export function checkCeiling(
  args: string[],
  settings: Json,
  mcpAllowed: string[],
  mcpOwnFolder: string[],
  main: MainCeiling,
): CeilingDenial | null {
  const perms = settings.permissions as Json | undefined
  const worker = modeOf(args, typeof perms?.defaultMode === 'string' ? perms.defaultMode : null)
  if (worker.rank > modeOf(main.permissionArgs, main.defaultMode).rank)
    return {
      axis: 'permission_mode',
      detail: 'this session would run in a wider permission mode than the main session',
    }
  const extra = mcpAllowed.filter((s) => s !== TALOS_MCP && !main.mcpServers.includes(s) && !mcpOwnFolder.includes(s))
  if (extra.length > 0)
    return { axis: 'mcp', detail: `the main session cannot use these MCP servers: ${extra.join(', ')}` }
  const deny = Array.isArray(perms?.deny) ? (perms.deny as string[]) : []
  const lacking = main.denyRules.filter((r) => !deny.includes(r))
  if (lacking.length > 0)
    return {
      axis: 'deny_rules',
      detail: `this session lacks deny rules the main session has: ${lacking.slice(0, 3).join(', ')}`,
    }
  return null
}

/** The deny rules Main runs under: the guards' file and the agent folder's shared and local project settings, made absolute. */
export function mainDenyRules(agentDir: string, talosHome: string): string[] {
  const out: string[] = []
  for (const src of [
    { path: guardsPath(talosHome), slash: join(talosHome, 'guards') },
    { path: join(agentDir, '.claude', 'settings.json'), slash: agentDir },
    { path: join(agentDir, '.claude', 'settings.local.json'), slash: agentDir },
  ]) {
    const deny = (readJson(src.path)?.permissions as Json | undefined)?.deny
    if (!Array.isArray(deny)) continue
    for (const r of deny) {
      if (typeof r !== 'string') continue
      const a = absolutize(r, src.slash, agentDir)
      if (!out.includes(a)) out.push(a)
    }
  }
  return out
}

/** A setting source `--setting-sources` can leave out (policy and flag settings are always read). */
export type SettingSource = 'user' | 'project' | 'local'

/**
 * The setting sources Main loads, from its own `--setting-sources` (the last one given; a comma-separated list of user, project
 * and local), or null when it names none (all of them). A name Claude Code does not know is not a source.
 */
export function settingSources(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Set<SettingSource> | null {
  // restricted mode (the flag, or CLAUDE_CODE_RESTRICTED in Main's environment) reads no user, project or local settings
  if (restricted(args, env)) return new Set()
  const value = lastFlagValue(args, '--setting-sources')
  if (value === undefined) return null
  const out = new Set<SettingSource>()
  for (const n of value.split(',').map((x) => x.trim()))
    if (n === 'user' || n === 'project' || n === 'local') out.add(n)
  return out
}

/** An environment switch as Claude Code reads one: 1, true, yes or on (any case). */
export const envOn = (v: string | undefined): boolean =>
  v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())

/** Restricted mode: --restricted in Main's arguments, or CLAUDE_CODE_RESTRICTED in its environment. */
export const restricted = (args: readonly string[], env: Record<string, string | undefined> = {}): boolean =>
  hasFlag(args, '--restricted') || envOn(env.CLAUDE_CODE_RESTRICTED)

/**
 * A mode that narrows Main in a way nothing passes on to a thread session (the worker's environment drops these switches and
 * its arguments never carry the flags), so the session would be wider than Main: its name for the thread's line, or null.
 * - restricted: no user, project or local settings, no bypass, no code-running tools;
 * - CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: the owner's own skills, commands and agents cannot widen permissions;
 * - safe and bare modes: no plugins, no auto-discovered MCP servers, no customizations.
 */
export function mainNarrowedMode(args: readonly string[], env: Record<string, string | undefined> = {}): string | null {
  if (restricted(args, env)) return 'restricted mode (--restricted or CLAUDE_CODE_RESTRICTED)'
  if (envOn(env.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG)) return 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG'
  if (hasFlag(args, '--safe-mode') || envOn(env.CLAUDE_CODE_SAFE_MODE))
    return 'safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)'
  if (hasFlag(args, '--bare') || envOn(env.CLAUDE_CODE_SIMPLE)) return 'bare mode (--bare or CLAUDE_CODE_SIMPLE)'
  // a config folder that is not an absolute path: Claude Code reads it from each session's own folder, a different one for each
  const ccd = env.CLAUDE_CONFIG_DIR
  if (ccd && !isAbsolute(ccd)) return 'a CLAUDE_CONFIG_DIR that is not an absolute path'
  return null
}

/** Claude Code's managed settings folder for this OS (read only; outranks every other source, always read). */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * What the managed settings say (managed-settings.json, then each managed-settings.d/*.json in name order): every
 * permissions.defaultMode they name, and every deny rule, made absolute where it was defined. Regular files only; one that
 * cannot be read is left out (Claude Code leaves it out too, for Main and its workers alike).
 */
export function managedSettings(
  dir: string,
  agentDir: string,
): { modes: string[]; deny: string[]; unreadable: number; bypassDisabled: boolean } {
  const files = [join(dir, 'managed-settings.json')]
  try {
    const d = join(dir, 'managed-settings.d')
    // as Claude Code lists them: *.json, never a dotfile, in name order
    for (const n of readdirSync(d).sort()) if (n.endsWith('.json') && !n.startsWith('.')) files.push(join(d, n))
  } catch {
    // no drop-in folder
  }
  const cwd = realOrNull(agentDir) ?? agentDir
  const modes: string[] = []
  const deny: string[] = []
  let unreadable = 0
  let bypassDisabled = false
  const listOfText = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  for (const f of files) {
    if (!existsSync(f)) continue
    const text = readRegularFile(f)
    let root: unknown = null
    try {
      root = text === null ? null : text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      root = null
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      unreadable++
      continue
    }
    const raw = (root as Json).permissions
    // a permissions value it cannot read holds its locks at their restrictive values
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      bypassDisabled = true
      continue
    }
    const perms = raw as Json | undefined
    if (!perms) continue
    // any value but false (an invalid one is read as the restrictive one, "disable")
    if (bypassLocked(perms)) bypassDisabled = true
    // the mode this document gives, as Claude Code reads it: one it cannot read (not text, not a mode it knows), or one next to
    // a deny or ask list it cannot read, is withheld and "default" stands in for it
    if (perms.defaultMode !== undefined) {
      const m = perms.defaultMode
      const rulesUnread =
        (perms.deny !== undefined && !listOfText(perms.deny)) || (perms.ask !== undefined && !listOfText(perms.ask))
      modes.push(typeof m === 'string' && knownMode(m) && !rulesUnread ? m : 'default')
    }
    if (Array.isArray(perms.deny))
      for (const r of perms.deny) {
        if (typeof r !== 'string') continue
        const a = absolutize(r, dirname(f), cwd)
        if (!deny.includes(a)) deny.push(a)
      }
  }
  return { modes, deny, unreadable, bypassDisabled }
}

/** A settings object's permissions turn bypass off (disableBypassPermissionsMode present and not false). */
export const bypassLocked = (perms: Json | undefined): boolean =>
  !!perms && perms.disableBypassPermissionsMode !== undefined && perms.disableBypassPermissionsMode !== false

/**
 * Whether a settings source Main loads turns bypass off (the guards' file when it is Main's --settings, the agent folder's local
 * and shared project settings, the user's), as Claude Code reads the switch from its merged settings.
 */
export function chainBypassLocked(
  agentDir: string,
  talosHome: string,
  claudeDir: string,
  guardsActive: boolean,
  sources: Set<SettingSource> | null,
): boolean {
  const loads = (src: SettingSource) => sources === null || sources.has(src)
  const files: string[] = []
  if (guardsActive) files.push(guardsPath(talosHome))
  if (loads('local')) files.push(join(agentDir, '.claude', 'settings.local.json'))
  if (loads('project')) files.push(join(agentDir, '.claude', 'settings.json'))
  if (loads('user')) files.push(join(claudeDir, 'settings.json'))
  return files.some((f) => bypassLocked(readJson(f)?.permissions as Json | undefined))
}

/** The narrowest of these mode names by rank; a name Claude Code does not know stands as "default", as it does there. */
export function narrowestMode(modes: readonly string[]): string | null {
  let best: string | null = null
  let rank = Number.POSITIVE_INFINITY
  for (const raw of modes) {
    const m = knownMode(raw) ? raw : 'default'
    const r = MODE_RANKS[m === 'manual' ? 'default' : m] ?? MODE_RANKS.default
    if (r < rank) {
      rank = r
      best = m
    }
  }
  return best
}

/**
 * The `permissions.defaultMode` Main starts in when its launch names no mode: the guards' file (when it is Main's --settings),
 * the agent folder's local and shared project settings, then the user's. `auto` and `bypassPermissions` do not take effect in
 * project files (the built-in default applies). Null when there is none.
 */
export function mainDefaultMode(
  agentDir: string,
  talosHome: string,
  claudeDir: string,
  guardsActive = true,
  sources: Set<SettingSource> | null = null,
): string | null {
  const loads = (src: SettingSource) => sources === null || sources.has(src)
  const mode = (p: string) => {
    const m = (readJson(p)?.permissions as Json | undefined)?.defaultMode
    return typeof m === 'string' ? m : null
  }
  if (guardsActive) {
    const g = mode(guardsPath(talosHome))
    if (g) return g
  }
  // only the sources Main loads (--setting-sources): one it leaves out is not where its mode comes from
  for (const [src, project] of [
    ['local', join(agentDir, '.claude', 'settings.local.json')],
    ['project', join(agentDir, '.claude', 'settings.json')],
  ] as const) {
    if (!loads(src)) continue
    const m = mode(project)
    if (m) return m === 'auto' || m === 'bypassPermissions' ? null : m
  }
  return loads('user') ? mode(join(claudeDir, 'settings.json')) : null
}

// ---- folders ------------------------------------------------------------------------------------------------------------------
export {
  existingSubThreadFolder,
  ownSubThreadFolder,
  prepareSubThreadFolder,
  subThreadCheck,
  subThreadFence,
  subThreadProblem,
  subThreadTarget,
} from './sub-thread-folder.ts'

/**
 * The folder re-check before every start: resolved, an existing folder under the owner's home (not the home itself), not inside
 * ~/.claude (as named or where it really is) or the Talos home, and fit for workers.json (at most 512 UTF-16 units, no control
 * characters). Null = fine, else why not.
 */
/** A folder no permission rule can name exactly: its start is refused, never fenced by rules that match nothing. */
export const FOLDER_NOT_NAMEABLE =
  "the folder's path has a character a permission rule can't name (* ? [ ] { } ( ) \\ or a trailing space): rename it or move this thread's folder"

export function workerFolderProblem(cwd: string, home: string, talosHome: string): string | null {
  if (!cwd.startsWith('/') || cwd.split('/').some((p) => p === '.' || p === '..'))
    return 'the folder must be an absolute path without . or ..'
  const r = realOrNull(cwd)
  if (!r) return 'the folder does not exist'
  if (!isFolder(r)) return 'not a folder'
  // an exact-case check means nothing where the file system folds case (the home, or this folder, in another spelling)
  if (foldsCase(r)) return 'the folder is on a file system that ignores letter case (a Windows drive?)'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (r.length > 512 || /[\u0000-\u001f\u007f]/.test(r)) return 'the folder path is too long or has control characters'
  // the deny rules that fence a session name its folder; Claude Code reads these characters in a rule as a pattern (Fable R1-4)
  if (!fenceSafe(r)) return FOLDER_NOT_NAMEABLE
  const norm = (p: string) => trimSlash(realOrNull(p) ?? p)
  const h = norm(home)
  const under = (root: string) => r === root || r.startsWith(`${root}/`)
  if (!under(h) || r === h) return 'the folder must be inside your home folder'
  if (under(`${h}/.claude`) || under(norm(join(home, '.claude')))) return "the folder can't be inside ~/.claude"
  if (under(norm(talosHome))) return "the folder can't be inside the Talos data folder"
  return null
}

/** "One worker per folder": the folder's real path, no trailing slash (exact: Linux tells case apart). */
export const folderKey = (cwd: string) => trimSlash(realOrNull(cwd) ?? cwd)
