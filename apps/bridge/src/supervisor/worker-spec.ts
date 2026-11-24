// How a thread's own Claude Code session (a worker) is launched, for the Linux supervisor: the TypeScript port of the Mac's
// WorkerSpec.swift (docs/OPTION-C.md 4.3). Pure: it builds argv, env and the per-worker settings file, and `validateSpec`
// refuses anything that could load a channel, run headless, reach Telegram, or start wider than Main. The supervisor never
// launches a worker without it passing. The launch itself goes through the tmux host's launch file (the contract's launch
// rule), so no value here ever reaches an argv of its own.
// The MCP allow list (worker-mcp.ts, the Mac's WorkerMcp): with one, the launch is strict (only the generated config, the
// connectors and Chrome off); without one, a worker gets the agent folder's servers or the given --mcp-config, as before.
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  jcs,
  MCP_ALWAYS_DENIED,
  MCP_CONNECTOR_DENY,
  MCP_NEVER_OPEN,
  ThreadId,
  usageRecorderCommand,
  WORKER_FORBIDDEN_ARGS,
  workerMcpConfigPath,
  workerUsagePath,
} from '@talos-app/protocol'
import {
  ALWAYS_DROP,
  INHERITED_CLAUDE_PREFIX,
  isInheritedClaudeVar,
  KEEP,
  KEEP_PREFIXES,
  SESSION_MARKERS,
  stripClaudeMarkers,
} from '../claude-env.ts'
import { type OsSandboxPieces, withOsSandbox } from '../guards/os-sandbox.ts'
import { realFileSync } from '../real-file.ts'
import { pathIssue } from '../secrets/platform.ts'
import { CHANNEL_SWITCH_ALWAYS, CHANNEL_SWITCH_NOCHANNEL, NOCHANNEL_SUFFIX, TERMINAL_ONLY } from './launch-env.ts'
import { STATE_HOOK, workerHookDir } from './worker-hook.ts'
import type { WorkerMcpPlan } from './worker-mcp.ts'

/**
 * A best-effort layer: a thread session's shell is not to run `talos-app post`, since a post from there speaks in any thread
 * as the agent. These rules match the command's text, so a spelling they do not see gets past them; the CLI's own refusal
 * knows a thread session by its variables and a lead's marker, and both can be shed. The real fix is the ROADMAP's
 * "Agent isolation" (a worker with no key). Added to every worker's settings; not part of the checked Talos-home fence, so a
 * spec built by an older Mac app without it still starts.
 */
export const WORKER_EXTRA_DENY: readonly string[] = [
  'Bash(talos-app post:*)',
  'Bash(*talos-app post*)',
  'Bash(*cli.ts post*)',
  // a worktree moves the session's folder, and with it the project settings it loads, away from the folder the start checked
  'EnterWorktree',
]

import {
  addingDeny,
  anchoring,
  type CeilingAxis,
  checkCeiling,
  fenceDenyRules,
  fenceMissing,
  fenceSafe,
  foldsCase,
  guardsPath,
  INSTRUCTION_PLUGINS,
  type MainCeiling,
  modeOf,
  stateFileAllowRules,
  stateFileDenyRules,
  subThreadProblem,
  withGuards,
  withInstructionFiles,
  workerFilesDenyRules,
} from './worker-policy.ts'

type Json = Record<string, unknown>

export const workerTmuxName = (threadId: string) => `t-${threadId}`
export const workerSessionName = (threadId: string) => `talos-${threadId}`

/** Never in a worker's argv (OPTION-C 4.3): the protocol's own list, never a copy. */
export const FORBIDDEN_ARGS = WORKER_FORBIDDEN_ARGS
/** Stripped from a worker's environment, on top of every TELEGRAM_* and IMESSAGE_* key. */
export const STRIPPED_ENV = new Set(['TALOS_APP_BRIDGE', 'MCP_PROTOCOL_NEGOTIATION', 'TELEGRAM_BOT_TOKEN'])
export const STRIPPED_PREFIXES = ['TELEGRAM_', 'IMESSAGE_']
export const TELEGRAM_PLUGIN = 'telegram@claude-plugins-official'
export const IMESSAGE_PLUGIN = 'imessage@claude-plugins-official'

/** The protocol's ThreadId (`all` is a view, not a thread). */
export const isThreadId = (s: string) => ThreadId.safeParse(s).success
const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const isModel = (m: string) => /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(m)

export const workerSettingsPath = (talosHome: string, threadId: string) =>
  `${talosHome}/workers/${threadId}/settings.json`
/** The empty folder the channel plugins' state dirs point at: a plugin that starts anyway finds no token and exits. */
export const noChannelDir = (talosHome: string) => `${talosHome}/workers/_nochannel`

export type WorkerSpecError =
  | 'bad_thread'
  | 'bad_session_id'
  | 'bad_model'
  | 'bad_effort'
  | 'relative_cwd'
  | 'unsafe_talos_home'
  | 'sub_thread_folder'
  | 'guards_unreadable'
  | 'fence_unmergeable'
  | 'fence_missing'
  | 'forbidden_arg'
  | 'forbidden_env'
  | 'escalation'

export class WorkerSpecRefused extends Error {
  constructor(
    readonly code: WorkerSpecError,
    readonly detail: string,
    /** With `escalation`: the axis of the privilege ceiling it was over, when there is one. */
    readonly axis?: CeilingAxis,
  ) {
    super(`${code}: ${detail}`)
  }
}

/** The env var that keeps Claude Code from fetching the claude.ai connectors: set (to `false`) only with a list. */
export const CONNECTORS_ENV = 'ENABLE_CLAUDEAI_MCP_SERVERS'

const isInstructionPlugin = (key: string) => (INSTRUCTION_PLUGINS as readonly string[]).includes(key)

/** A server definition with what a worker must never get taken out of its env. Keys copied as data (a `__proto__` key too). */
export function cleanMcpEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const env = entry.env
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return { ...entry }
  return { ...entry, env: Object.fromEntries(Object.entries(env).filter(([k]) => !strippedKey(k))) }
}

export type WorkerInputs = {
  threadId: string
  sessionId: string
  /** `--resume` (true) or `--session-id` (false): the manager decides (the session-not-saved rule). */
  resume: boolean
  claudePath: string
  /** The login-shell environment Main uses, read again at every start. */
  baseEnv: Record<string, string>
  /**
   * The developer thread fence (protocol dev.ts): false only when the owner turned it off, and then the settings carry no
   * Talos-home deny. Absent or true: the fence is on.
   */
  threadFence?: boolean
  talosHome: string
  agentDir: string
  /**
   * The PermissionRequest hook the session's settings run: its script and the python3 that runs it, both absolute (worker-hook.ts).
   * `state` (HookPlace.state): the thread-state hook was staged beside it, so the settings run it (never on a Talos distro).
   */
  permissionHook: { script: string; python: string; state?: unknown }
  /** The thread's folder; null = the agent folder. */
  cwd: string | null
  /** A sub-thread's parent thread folder; null = not a sub-thread. */
  parentCwd: string | null
  /** `inherit` = no --model. */
  model: string
  effort: string | null
  nonce: string
  /** The owner's permission flag (e.g. --dangerously-skip-permissions), when Main uses it. */
  permissionFlag: string | null
  /** The worker preamble (--append-system-prompt). */
  preamble: string | null
  /** --mcp-config for a folder other than the agent folder (only without a list). */
  mcpConfigPath: string | null
  /** What Main has: the ceiling the spec is checked against. */
  main: MainCeiling
  /** The MCP allow list's plan (worker-mcp.ts); absent or null = no list, the launch as before. */
  mcp?: WorkerMcpPlan | null
  /** A Talos distro: the hook runs root's file in place (HookFixed.rooted), and the guards may not bring hooks. */
  rooted?: boolean
  /** The owner's home folder: the hook's HOME (else the login environment's). */
  userHome?: string
  /** Deny rules for the Claude Code settings files a session must not edit (settingsFileDenyRules, worker-policy.ts). */
  settingsDeny?: readonly string[]
  /** The --setting-sources value (`user` outside the agent folder; in it Main's own, or null for none). */
  settingSources?: string | null
  /** The preamble is in the worker's system-prompt file (workerSystemPromptPath), not one argument. */
  systemPromptFile?: boolean
  /** Ask rules copied in from the thread folder's own settings (made absolute; they only narrow). */
  settingsAsk?: readonly string[]
  /**
   * The opt-in OS sandbox (guards/os-sandbox.ts), built by the supervisor for this start when config.json says `os_sandbox: true`:
   * its block and environment go into the settings. Absent or null: the switch is off and the launch is as before.
   */
  osSandbox?: OsSandboxPieces | null
}

export type WorkerSpec = {
  threadId: string
  program: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Written to workers/<id>/settings.json and passed with --settings. */
  settingsJSON: string
  main: MainCeiling
}

/** What the supervisor itself knows, never read from the spec it judges: the home, Main's ceiling, the program and folder. */
export type Trusted = {
  talosHome: string
  /**
   * The developer thread fence as the supervisor itself read it for this start: false only when the owner turned it off. Absent
   * or true: the Talos-home deny must be in the settings.
   */
  threadFence?: boolean
  main: MainCeiling
  claudePath: string
  cwd: string
  /** The plan the supervisor made itself for this start (null or absent: no list). */
  mcp?: WorkerMcpPlan | null
  /** The --setting-sources value the supervisor chose (null: none, Main's own default). */
  settingSources?: string | null
  /** With the switch on (the supervisor's own read), what it built: the settings must carry exactly this sandbox. Absent or null: off. */
  osSandbox?: OsSandboxPieces | null
  /**
   * A sub-thread in its own folder outside its parent's: the parent folder's deny rules as the supervisor read them, every one of
   * which must be in the settings (the parent's fence holds in a folder the parent does not contain).
   */
  parentDeny?: readonly string[]
  /** The session's folder is not the agent folder: only `user` settings may load. */
  outsideAgentFolder?: boolean
  /**
   * A Talos distro (rooted-kit.ts rootedHookDir): the permission hook the settings run must be root's own file under this folder,
   * never a copy (Fable R2-3). Absent or null: a box that is no Talos distro.
   */
  rootedHookDir?: string | null
  /** With rootedHookDir: the hook's script and the whole command the supervisor built for it (workerHookFixed). */
  rootedHook?: { script: string; command: string; statusLine: string } | null
}

/** The only permission flags a worker may carry: the ones Main's own launch can have, each one argv element. */
export const PERMISSION_FLAGS =
  /^(--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--permission-mode=(plan|dontAsk|default|manual|acceptEdits|auto|bypassPermissions))$/

/** In a worker's environment (value `1`) exactly when its settings register the kit's thread-state hook. */
export const THREAD_STATE_ENV = 'TALOS_APP_THREAD_STATE'

/** The worker identity keys the build sets itself (Claude's marker rule names them too: here they are wanted). */
const WORKER_KEYS = new Set(['TALOS_APP_WORKER_THREAD', 'TALOS_SESSION_ROLE', 'TALOS_APP_WORKER_NONCE'])

/** A worker's argv must never look like Main's (the takeover check): channels on the command line are a bug. */
export const argvLooksLikeMain = (argv: string[]) =>
  argv.some((a) => FORBIDDEN_ARGS.slice(0, 2).some((f) => a === f || a.startsWith(`${f}=`))) ||
  argv.includes('server:talos-app')

const shq = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

/** What the hook is started with, fixed by the supervisor at the start: never read from the session's own environment. */
export type HookFixed = {
  talosHome: string
  home: string
  thread: string
  /**
   * The session's own folder, whose Claude Code settings the hook reads again at every prompt (TALOS_APP_HOOK_CHECK_DIR, the
   * Mac's too: kit/hooks/permission-relay.py), and whether hooks of its own count there (not in the agent folder).
   */
  folder?: string
  folderHooksCount?: boolean
  /**
   * A Talos distro (rooted-kit.ts): the hook runs root's file in place, reads no cache from the talos user's home, and a hook
   * file that is gone (an "Update the kit" removed its release) denies the prompt with words, never lets it wait unseen (Fable R3).
   */
  rooted?: boolean
}

/**
 * What the hook takes from the session's environment as it runs: only what could at worst stop its own hook (its prompts then
 * stay at the terminal, the safe side) or shorten its wait. Everything that says WHO answers a prompt (the Talos home, so the
 * bridge's socket and bridge.pid; the thread; the copy's mark) is fixed in the command instead, and nothing else reaches the
 * interpreter: a thread folder's settings `env` (LD_PRELOAD, PYTHONPATH, PYTHONHOME, a TALOS_APP_HOME of a stand-in bridge)
 * never reaches the process that answers its own prompts.
 */
export const HOOK_PASS_ENV = [
  'TALOS_APP_WORKER_NONCE',
  'TALOS_PERMISSION_RELAY_OFF',
  'TALOS_PERMISSION_HOOK_WAIT_S',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PROJECT_DIR',
  'XDG_STATE_HOME',
  // the Control Room's file (its permission-relay.off switch): the login environment's, since a folder's settings may not set it
  'CHRONOS_CONFIG',
] as const

/**
 * The hook's command: `script` run by `python` (both absolute, resolved by the planner: worker-hook.ts), isolated (`-I`: no
 * PYTHON* variables, no user site, no script folder on the path; the hook adds its own folder for its helper), in a CLEAN
 * environment (`env -i`): PATH=/usr/bin:/bin, LANG, the fixed values and the few in HOOK_PASS_ENV. No `command -v`: the PATH
 * Claude Code runs hooks with can differ from the one checked (a folder's settings may set `env.PATH`).
 *
 * The shell Claude Code starts it in has the session's environment, so that shell does nothing a function or an option could
 * take over: one assignment, then `exec` (a special builtin, which an imported function of the same name never replaces in
 * bash's POSIX mode or in dash). The test for the copy and the start of python run in a second `/bin/sh` that `env -i` starts
 * clean. What a loader variable does to the first shell no command can stop: the thread folder's project settings are checked
 * for that at each start and at every request (worker/project-settings.ts).
 */
export function permissionHookCommand(script: string, python: string, fixed: HookFixed): string {
  const check =
    fixed.folder === undefined
      ? []
      : [
          `TALOS_APP_HOOK_CHECK_DIR=${shq(fixed.folder)}`,
          `TALOS_APP_HOOK_CHECK_HOOKS=${fixed.folderHooksCount === false ? '0' : '1'}`,
        ]
  const set = [
    `HOME=${shq(fixed.home)}`,
    'PATH=/usr/bin:/bin',
    `LANG=${HOOK_LANG}`,
    `TALOS_APP_HOME=${shq(fixed.talosHome)}`,
    `TALOS_APP_WORKER_THREAD=${shq(fixed.thread)}`,
    'TALOS_APP_PERM_HOOK_SOURCE=worker',
    ...check,
    ...(fixed.rooted ? ['TALOS_APP_HOOK_ROOTED=1'] : []),
    ...HOOK_PASS_ENV.map((k) => `${k}="\${${k}-}"`),
  ]
  const line = fixed.rooted ? HOOK_CLEAN_LINE_ROOTED : HOOK_CLEAN_LINE
  return `f=${shq(script)}; exec /usr/bin/env -i ${set.join(' ')} /bin/sh -c ${shq(line)} "$f" ${shq(python)}`
}

/** What a rooted session's prompt gets when root's hook file is gone: a deny that says why, never a silent wait at the terminal. */
export const ROOTED_HOOK_GONE = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'deny',
      message:
        "Talos's kit was updated while this thread's session was running, so this request could not reach your phone: restart the thread's session from the app, then ask again.",
    },
  },
})
/** HOOK_CLEAN_LINE for a rooted session: a missing hook file prints ROOTED_HOOK_GONE instead of exiting quietly. */
export const HOOK_CLEAN_LINE_ROOTED = `[ -f "$0" ] || { printf '%s\\n' ${shq(ROOTED_HOOK_GONE)}; exit 0; }; exec "$1" -I -S "$0"`

/** The line the clean second shell runs: `$0` the copy, `$1` the interpreter (the Mac's WorkerHook.cleanLine, word for word). */
export const HOOK_CLEAN_LINE = '[ -f "$0" ] || exit 0; exec "$1" -I -S "$0"'
/** The hook's locale: the Mac names en_US.UTF-8; a Linux box may have no such locale, and C.UTF-8 is always there. */
export const HOOK_LANG = 'C.UTF-8'

/**
 * Rooted mode (Fable R2-3, R3-1): the settings' hooks are exactly one PermissionRequest entry running exactly `command`, the one
 * the supervisor built itself from root's `script` (never read from the spec); `script` is its own real path under root's
 * releases folder `dir`; and permissions only narrow (deny, ask). No other hook event, no second entry, no other command.
 */
export function rootedHookOnly(
  settings: Json,
  r: { dir: string; script: string; command: string; statusLine: string },
): void {
  const no = (code: WorkerSpecError, detail: string): never => {
    throw new WorkerSpecRefused(code, detail)
  }
  const bad = (why: string): never =>
    no('forbidden_env', `the permission hook ${why}; it must be root's own, under ${r.dir}`)
  let real = ''
  try {
    // a FILE: resolved by walking its path (realFileSync), never by realpath, which on a Mac may answer with another of a
    // hard-linked file's names. A second name of root's sealed hook elsewhere (a hard link in the talos user's home) changes
    // nothing here: the script is checked by the name it was found under, and its bytes are root's inode, checked root's
    // and read-only by the release check (worker-hook.ts checkRelease), which no other name can write through.
    real = realFileSync(r.script)
  } catch {}
  if (!real || real !== r.script || !real.startsWith(`${r.dir}/`)) bad(`script ${r.script} is not root's file`)
  for (const k of Object.keys(settings))
    if (!WORKER_SETTINGS_KEYS.has(k)) no('forbidden_env', `the settings key ${k} on a Talos distro`)
  if (settings.disableSkillShellExecution !== true) no('forbidden_env', 'disableSkillShellExecution')
  const line = { type: 'command', command: r.statusLine, padding: 0 }
  if (JSON.stringify(sortKeys(settings.statusLine ?? null)) !== JSON.stringify(sortKeys(line)))
    no('forbidden_env', 'the status line is not the one Talos built')
  const want = { PermissionRequest: [{ hooks: [{ type: 'command', timeout: 3600, command: r.command }] }] }
  if (JSON.stringify(sortKeys(settings.hooks ?? null)) !== JSON.stringify(sortKeys(want)))
    bad('settings run hooks other than the one Talos built')
  const p = settings.permissions
  if (p !== undefined && (p === null || typeof p !== 'object' || Array.isArray(p))) no('forbidden_env', 'permissions')
  for (const k of Object.keys((p ?? {}) as Json))
    if (!NARROWING_PERMISSION_KEYS.has(k)) no('forbidden_env', `permissions.${k} on a Talos distro`)
  if ((p as Json | undefined)?.disableAutoMode !== 'disable') no('forbidden_env', 'permissions.disableAutoMode')
}

/** The line the thread-state hook's clean shell runs: `$0` the copy, `$1` the interpreter, `$2` the mode, `$3` the agent folder, `$4` the bytecode prefix. */
export const STATE_HOOK_CLEAN_LINE = '[ -f "$0" ] || exit 0; exec "$1" -B -X "pycache_prefix=$4" -I -S "$0" "$2" "$3"'
/** Where the thread-state hook's bytecode would go: nowhere (-B writes none, and none is read from workers/_hook beside the script). */
const STATE_HOOK_PYCACHE = '/nonexistent'

/**
 * The thread-state hook's command (kit/hooks/thread-state.py), built like the permission hook's: a copy from the verified release
 * run by the resolved python3, isolated, in a clean environment where the role, the thread, the agent folder and the home are fixed
 * here and never the session's own (a thread folder's settings `env` cannot change whose state it reads). Only XDG_STATE_HOME
 * passes through, as it picks where the thread's compaction carry is kept, the same folder Main's hooks use.
 */
export function threadStateHookCommand(
  script: string,
  python: string,
  mode: 'inject' | 'save',
  fixed: HookFixed,
  agentDir: string,
): string {
  const set = [
    `HOME=${shq(fixed.home)}`,
    'PATH=/usr/bin:/bin',
    `LANG=${HOOK_LANG}`,
    'TALOS_SESSION_ROLE=worker',
    `TALOS_APP_WORKER_THREAD=${shq(fixed.thread)}`,
    `CLAUDE_PROJECT_DIR=${shq(agentDir)}`,
    `XDG_STATE_HOME="\${XDG_STATE_HOME-}"`,
  ]
  return `f=${shq(script)}; exec /usr/bin/env -i ${set.join(' ')} /bin/sh -c ${shq(STATE_HOOK_CLEAN_LINE)} "$f" ${shq(python)} ${mode} ${shq(agentDir)} ${shq(STATE_HOOK_PYCACHE)}`
}

/** `settings` with the thread-state hook under hooks.SessionStart and hooks.PreCompact, next to the hooks already there. */
export function withThreadStateHooks(settings: Json, i: WorkerInputs, script: string): Json | null {
  const hooks = settings.hooks
  if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) return null
  const out: Json = { ...((hooks as Json | undefined) ?? {}) }
  const fixed = workerHookFixed(i)
  const add = (event: string, mode: 'inject' | 'save', matcher?: string) => {
    const had = out[event]
    if (had !== undefined && !Array.isArray(had)) throw new Error(event)
    out[event] = [
      ...((had as unknown[] | undefined) ?? []),
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: 'command',
            timeout: 5,
            command: threadStateHookCommand(script, i.permissionHook.python, mode, fixed, i.agentDir),
          },
        ],
      },
    ]
  }
  try {
    add('SessionStart', 'inject', 'startup|resume|clear|compact|fork')
    add('PreCompact', 'save')
  } catch {
    return null
  }
  return { ...settings, hooks: out }
}

/** `base` with the thread-state hooks and the allow rules for its own state file (`perms` is the permissions object in it), or why not. */
function addThreadState(base: Json, perms: Json, i: WorkerInputs, script: string): Json | string {
  const hooked = withThreadStateHooks(base, i, script)
  if (!hooked) return 'the settings hooks cannot take the thread-state hook'
  const allow = perms.allow
  if (allow !== undefined && (!Array.isArray(allow) || !allow.every((r) => typeof r === 'string')))
    return 'the settings permissions.allow is not a list of rules'
  perms.allow = [
    ...new Set([...((allow as string[] | undefined) ?? []), ...stateFileAllowRules(i.agentDir, i.threadId)]),
  ]
  // the file's own allow rule also names what is under it (gitignore-style): its children are denied (`<file>/*`, never `/**`)
  const deny = Array.isArray(perms.deny) ? (perms.deny as string[]) : []
  perms.deny = [...new Set([...deny, ...stateFileDenyRules(i.agentDir, i.threadId)])]
  return { ...hooked, permissions: perms }
}

/** What the hook's command is started with, fixed here, never the session's own (the home a folder's env could repoint). */
export function workerHookFixed(i: WorkerInputs): HookFixed {
  return {
    talosHome: i.talosHome,
    home: i.userHome ?? i.baseEnv.HOME ?? '/',
    thread: i.threadId,
    // the folder the hook reads again at every prompt; the agent folder's own hooks are the kit's
    folder: i.cwd ?? i.agentDir,
    folderHooksCount: i.cwd !== null,
    ...(i.rooted ? { rooted: true } : {}),
  }
}

/** The guards' file is there in any form (a link or a folder included): only "no such file" is absent. */
function guardsPresent(talosHome: string): boolean {
  try {
    lstatSync(guardsPath(talosHome))
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** The status line command the worker's settings run (the plan-usage recorder), from the supervisor's own values. */
export const workerStatusLineCommand = (i: WorkerInputs): string =>
  usageRecorderCommand(i.permissionHook.python, workerUsagePath(i.talosHome, i.threadId))

/** The top-level keys buildWorkerSpec writes: a rooted session's settings hold no other (Fable R4-2). */
const WORKER_SETTINGS_KEYS = new Set([
  'enabledPlugins',
  'env',
  'pluginConfigs',
  'effortLevel',
  'disableClaudeAiConnectors',
  'deniedMcpServers',
  'hooks',
  'permissions',
  'disableSkillShellExecution',
  'statusLine',
  'sandbox',
])

/**
 * The permission keys a rooted session's settings may carry: deny and ask only narrow, and defaultMode is the mode the supervisor
 * set from Main's, held to Main's ceiling by validateSpec's own check; disableAutoMode is the supervisor's own "disable" (and
 * must be). Anything else (allow, additionalDirectories) is refused.
 */
const NARROWING_PERMISSION_KEYS = new Set(['deny', 'ask', 'defaultMode', 'disableAutoMode'])

/** `settings` with the permission hook under hooks.PermissionRequest, next to the hooks already there; another shape is left. */
export function withPermissionHook(settings: Json, script: string, python: string, fixed: HookFixed): Json {
  if (
    settings.hooks !== undefined &&
    (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
  )
    return settings
  const hooks: Json = { ...((settings.hooks as Json | undefined) ?? {}) }
  const entries = Array.isArray(hooks.PermissionRequest) ? [...hooks.PermissionRequest] : []
  entries.push({ hooks: [{ type: 'command', timeout: 3600, command: permissionHookCommand(script, python, fixed) }] })
  hooks.PermissionRequest = entries
  return { ...settings, hooks }
}

const strippedKey = (k: string) =>
  STRIPPED_ENV.has(k) || STRIPPED_PREFIXES.some((p) => k.startsWith(p)) || shellSteeringKey(k)

/**
 * What steers the shell Claude Code runs a hook's command in before that command runs (startup files, imported functions,
 * xtrace and its prompt, the loader, a charset module, a prefix Claude Code wraps every command in): never in a worker's
 * environment, whatever the login shell had.
 */
export const SHELL_STEERING_ENV = new Set([
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'ENV',
  'BASH_ENV',
  // what loads code into that shell, or wraps every hook and command Claude Code runs
  'GCONV_PATH',
  'CLAUDE_CODE_SHELL_PREFIX',
])
/** The prefixes of what steers that shell (imported functions, the loader). */
export const SHELL_STEERING_PREFIXES = ['BASH_FUNC_', 'LD_', 'DYLD_'] as const
export const shellSteeringKey = (k: string) =>
  SHELL_STEERING_ENV.has(k) || SHELL_STEERING_PREFIXES.some((p) => k.startsWith(p))

/**
 * The rule a thread session's environment is stripped by, as data (built from the very lists strippedKey and
 * stripClaudeMarkers use, so it cannot drift from them): its JCS text is part of the launch spec (launch-spec.ts), so a release
 * that strips a new name restarts sessions on update, while a login environment that happens to gain or lose a stripped
 * variable changes nothing (Delphi).
 */
export const WORKER_ENV_STRIP_RULES = {
  claude_markers: {
    always_drop: [...ALWAYS_DROP].sort(),
    session_markers: [...SESSION_MARKERS].sort(),
    prefix: INHERITED_CLAUDE_PREFIX,
    keep: [...KEEP].sort(),
    keep_prefixes: [...KEEP_PREFIXES].sort(),
  },
  // buildLaunchEnv's own (launch-env.ts), applied to the login environment before the start sees it (Fable R1-5)
  launch_env: {
    terminal_only: [...TERMINAL_ONLY].sort(),
    channel_switch_always: [...CHANNEL_SWITCH_ALWAYS].sort(),
    channel_switch_nochannel: [...CHANNEL_SWITCH_NOCHANNEL].sort(),
    nochannel_suffix: NOCHANNEL_SUFFIX,
  },
  names: [...STRIPPED_ENV].sort(),
  prefixes: [...STRIPPED_PREFIXES].sort(),
  shell_steering: [...SHELL_STEERING_ENV].sort(),
  shell_steering_prefixes: [...SHELL_STEERING_PREFIXES].sort(),
}
/** WORKER_ENV_STRIP_RULES as the launch spec hashes it. */
export const workerEnvStripRulesText = (): string => jcs(WORKER_ENV_STRIP_RULES)

/** Every worker's: the system prompt this start writes, never one a resume replays (Claude Code's snapshot is on by default). */
export const SYSTEM_PROMPT_SNAPSHOT_OFF = '--system-prompt-snapshot=off'

/** Where the worker's system-prompt text (preamble and instruction files) is written for --append-system-prompt-file. */
export const workerSystemPromptPath = (talosHome: string, threadId: string) =>
  `${talosHome}/workers/${threadId}/system-prompt.md`

export function buildWorkerSpec(i: WorkerInputs): WorkerSpec {
  const no = (code: WorkerSpecError, detail: string, axis?: CeilingAxis): never => {
    throw new WorkerSpecRefused(code, detail, axis)
  }
  const mcp = i.mcp ?? null
  if (!isThreadId(i.threadId)) no('bad_thread', i.threadId)
  if (!isUUID(i.sessionId)) no('bad_session_id', i.sessionId)
  if (!isModel(i.model)) no('bad_model', i.model)
  if (i.effort !== null && !/^[a-z]{1,16}$/.test(i.effort)) no('bad_effort', i.effort)
  const given = i.cwd ?? i.agentDir
  if (!given.startsWith('/')) no('relative_cwd', given)
  if (!fenceSafe(i.talosHome)) no('unsafe_talos_home', i.talosHome)
  // an exact-case fence holds only where names are exact: never a home on a Windows drive or a case-folding file system
  // where the home really is, too: a link from ~/.talos to a vfat stick folds case though its own name does not
  const realHome = (() => {
    try {
      return realpathSync(i.talosHome)
    } catch {
      return i.talosHome
    }
  })()
  if (pathIssue(i.talosHome) !== null || foldsCase(i.talosHome) || foldsCase(realHome))
    no('unsafe_talos_home', `${i.talosHome} is on a file system that ignores letter case`)
  if (i.permissionFlag !== null && !PERMISSION_FLAGS.test(i.permissionFlag)) no('forbidden_arg', i.permissionFlag)
  if (i.mcpConfigPath !== null && (!i.mcpConfigPath.startsWith('/') || i.mcpConfigPath.includes('\0')))
    no('forbidden_arg', '--mcp-config must be an absolute path')
  if (i.parentCwd !== null) {
    const why = subThreadProblem(given, i.parentCwd)
    if (why) no('sub_thread_folder', why)
  }
  // the folder as it really is: the path checked is the path launched (a link swapped later does not move the worker)
  let cwd = given
  try {
    cwd = realpathSync(given)
  } catch {
    no('relative_cwd', `${given} does not exist`)
  }
  const env: Record<string, string> = {}
  // TALOS_APP_THREAD_STATE is set below, and only with the thread-state hook registered: never inherited
  for (const [k, v] of Object.entries(stripClaudeMarkers(i.baseEnv)))
    if (!strippedKey(k) && k !== THREAD_STATE_ENV) env[k] = v
  const noChannel = noChannelDir(i.talosHome)
  env.TALOS_APP_WORKER_THREAD = i.threadId
  env.TALOS_SESSION_ROLE = 'worker'
  // the kit's session-start and compaction-guard leave Main's state to Main only for a session whose own state hook is registered
  // (addThreadState below): a worker without it (a Talos distro, the Mac app) keeps today's behaviour exactly
  if (i.permissionHook.state && !i.rooted) env[THREAD_STATE_ENV] = '1'
  env.TALOS_APP_HOME = i.talosHome
  env.TALOS_APP_WORKER_NONCE = i.nonce
  env.TELEGRAM_STATE_DIR = noChannel
  env.IMESSAGE_STATE_DIR = noChannel
  // with a list, claude.ai connectors are not fetched (the setting below says the same; some versions read only one of them)
  if (mcp) env[CONNECTORS_ENV] = 'false'

  const args: string[] = []
  if (i.permissionFlag) args.push(i.permissionFlag)
  args.push('--settings', workerSettingsPath(i.talosHome, i.threadId))
  args.push('--name', workerSessionName(i.threadId))
  // the settings sources: outside the agent folder only the user's (its folder's settings, skills, commands, subagents and
  // instruction files are never loaded), in it Main's own (the files are the ones Main loads)
  if (i.settingSources !== undefined && i.settingSources !== null) args.push(`--setting-sources=${i.settingSources}`)
  // the system prompt as this start writes it, never the first one replayed on a resume (the snapshot is on by default and
  // keeps a session on its old preamble and Instructions until compaction)
  args.push(SYSTEM_PROMPT_SNAPSHOT_OFF)
  // values that could start with `-` go in one element (`--flag=value`): never read as a flag of their own
  if (i.model !== 'inherit') args.push(`--model=${i.model}`)
  // the preamble, and outside the agent folder the thread's instruction files: from the worker's own file (it can be longer
  // than one argument may be on Linux), else as one argument
  if (i.systemPromptFile) args.push(`--append-system-prompt-file=${workerSystemPromptPath(i.talosHome, i.threadId)}`)
  else if (i.preamble) args.push(`--append-system-prompt=${i.preamble}`)
  // with a list: only the servers in the generated file, Chrome off
  if (mcp) args.push('--strict-mcp-config', `--mcp-config=${mcp.configPath}`, '--no-chrome')
  else if (i.mcpConfigPath) args.push(`--mcp-config=${i.mcpConfigPath}`)
  const sid = i.sessionId.toLowerCase()
  args.push(...(i.resume ? ['--resume', sid] : ['--session-id', sid]))

  // both channel plugins off for this session only (never the owner's user settings)
  // the settings' own env points the channel state dirs at the empty folder too: --settings outranks project and user env
  const plugins: Record<string, boolean> = { [TELEGRAM_PLUGIN]: false, [IMESSAGE_PLUGIN]: false }
  // with a list, every installed plugin that is not on it is off too
  for (const key of mcp?.disabledPlugins ?? []) if (!isInstructionPlugin(key)) plugins[key] = false
  let settings: Json = withInstructionFiles({
    enabledPlugins: plugins,
    env: { TELEGRAM_STATE_DIR: noChannel, IMESSAGE_STATE_DIR: noChannel },
  })
  if (i.effort !== null) settings.effortLevel = i.effort
  // Claude Code's own computer use is off for every session; a list also turns off the browser server
  settings.deniedMcpServers = (mcp ? MCP_NEVER_OPEN : MCP_ALWAYS_DENIED).map((serverName) => ({ serverName }))
  if (mcp) settings.disableClaudeAiConnectors = true
  // on a Talos distro the guards' file is the talos user's, whatever it holds: a hook (its PreToolUse one can answer "allow"), an
  // allow rule, or a defaultMode, which also sets Main's ceiling (so "held by the ceiling" would be circular). Present at all:
  // refused, naming the file, never dropped unseen and never read (Fable R3-1, R4-1).
  if (i.rooted && guardsPresent(i.talosHome))
    return no(
      'forbidden_env',
      `the guards file ${guardsPath(i.talosHome)} is there, and a thread session on this PC cannot run with it beside Talos's own permission hook; remove it with: talos-app install-guards --remove`,
    )
  // the optional guards ride in the same file, since Claude Code takes one --settings
  const guarded = withGuards(settings, i.talosHome)
  if (!guarded) return no('guards_unreadable', 'talos-app install-guards ran but its settings file cannot be read')
  // the fence AFTER the guards, as a union (the guards' file replaces permissions and hooks wholesale), with Main's own deny rules
  const fenced = addingDeny(
    [
      ...(i.threadFence === false ? [] : fenceDenyRules(i.talosHome)),
      // the supervisor's own files for the sessions (hook copy, settings, mcp.json, nonce): closed fence on or off
      ...workerFilesDenyRules(i.talosHome),
      ...WORKER_EXTRA_DENY,
      ...(i.settingsDeny ?? []),
      ...i.main.denyRules,
      ...(mcp?.denyRules ?? []),
    ],
    withPermissionHook(
      anchoring(guarded, `${i.talosHome}/guards`, i.agentDir),
      i.permissionHook.script,
      i.permissionHook.python,
      workerHookFixed(i),
    ),
  )
  if (!fenced) return no('fence_unmergeable', 'the settings permissions cannot take the Talos-home deny')
  // Main's real mode as the default mode: it outranks the thread folder's project settings, so a folder asking for more
  // cannot widen the start. With no named mode, the built-in default is written explicitly.
  const perms: Json = { ...((fenced.permissions as Json | undefined) ?? {}) }
  const mainMode = modeOf(i.main.permissionArgs, i.main.defaultMode)
  if (mainMode.name) perms.defaultMode = mainMode.name
  else if (perms.defaultMode === undefined) perms.defaultMode = 'default'
  // no auto mode (a classifier in the owner's place: an agent file's `permissionMode: auto` would take it otherwise), and no
  // shell lines run by a skill or a custom slash command (`!` commands run under the skill's own allowed tools once its card
  // is approved, and that card shows only the skill's name)
  perms.disableAutoMode = 'disable'
  // the thread folder's own ask rules (it does not load its settings: they are copied here, made absolute; they only narrow)
  if (i.settingsAsk && i.settingsAsk.length > 0) {
    const had = Array.isArray(perms.ask)
      ? (perms.ask as unknown[]).filter((r): r is string => typeof r === 'string')
      : []
    perms.ask = [...new Set([...had, ...i.settingsAsk])]
  }
  // the thread-state hook (its own live state file, put back at every boundary) and the one edit it lets the session make
  let withState: Json = { ...fenced, permissions: perms }
  if (i.permissionHook.state && !i.rooted) {
    const added = addThreadState(withState, perms, i, join(workerHookDir(i.talosHome), STATE_HOOK))
    if (typeof added === 'string') return no('fence_unmergeable', added)
    withState = added
  }
  // the status line records the session's plan-usage reading for the hub (protocol usage-readings.ts), run by the hook's python3;
  // it takes the place of any other status line, which a thread session outside the agent folder does not load anyway
  settings = {
    ...withState,
    permissions: perms,
    disableSkillShellExecution: true,
    statusLine: {
      type: 'command',
      command: workerStatusLineCommand(i),
      padding: 0,
    },
  }
  // the opt-in OS sandbox rides in the same file (the switch is on: the supervisor built it for this start)
  if (i.osSandbox) settings = withOsSandbox(settings, i.osSandbox)
  // an MCP server of the thread folder the owner has not approved there is not launched
  if (mcp?.refusal) no('escalation', `mcp: ${mcp.refusal}`, 'mcp')
  const spec: WorkerSpec = {
    threadId: i.threadId,
    program: i.claudePath,
    args,
    env,
    cwd,
    settingsJSON: JSON.stringify(sortKeys(settings)),
    main: i.main,
  }
  validateSpec(spec, {
    talosHome: i.talosHome,
    threadFence: i.threadFence !== false,
    main: i.main,
    claudePath: i.claudePath,
    cwd,
    mcp,
    settingSources: i.settingSources ?? null,
    outsideAgentFolder: i.cwd !== null && i.settingSources !== undefined,
    osSandbox: i.osSandbox ?? null,
  })
  return spec
}

/**
 * The last line of defence, on the finished spec and against what the supervisor itself knows (`trusted`), never the spec's own
 * fields: a spec that could load a channel, run headless, carry a token, skip its settings, lose its role, reach the Talos home
 * or start wider than Main never runs.
 */
export function validateSpec(spec: WorkerSpec, trusted: Trusted): void {
  const no = (code: WorkerSpecError, detail: string, axis?: CeilingAxis): never => {
    throw new WorkerSpecRefused(code, detail, axis)
  }
  const home = trusted.talosHome
  const mcp = trusted.mcp ?? null
  if (!fenceSafe(home)) no('unsafe_talos_home', home)
  if (!isThreadId(spec.threadId)) no('bad_thread', spec.threadId)
  // the args are exactly the shape the build emits, nothing else (a flag nobody listed, a second session flag, a resume of
  // another conversation, a safe mode that drops the hooks: all refused):
  //   [permission flag] --settings <pinned> --name <pinned> [--setting-sources=<chosen>] --system-prompt-snapshot=off [--model=<m>]
  //   [--append-system-prompt=<t> | --append-system-prompt-file=<pinned>]
  //   (with a list: --strict-mcp-config --mcp-config=<the worker's own mcp.json> --no-chrome | without: [--mcp-config=/abs])
  //   (--resume | --session-id) <uuid>
  const args = [...spec.args]
  let k = 0
  const at = () => args[k]
  if (at() !== undefined && PERMISSION_FLAGS.test(at() as string)) k++
  if (at() !== '--settings' || args[k + 1] !== workerSettingsPath(home, spec.threadId))
    no('forbidden_arg', '--settings must be the worker settings file, once, in its place')
  k += 2
  if (at() !== '--name' || args[k + 1] !== workerSessionName(spec.threadId)) no('forbidden_arg', '--name')
  k += 2
  // the sources the supervisor chose, exactly, in their place (outside the agent folder only `user`)
  const sources = trusted.settingSources ?? null
  if (trusted.outsideAgentFolder && sources !== 'user')
    no('forbidden_arg', '--setting-sources=user outside the agent folder')
  if (sources !== null) {
    if (at() !== `--setting-sources=${sources}`)
      no('forbidden_arg', `--setting-sources=${sources} must follow --name, once`)
    k++
  }
  if (at() !== SYSTEM_PROMPT_SNAPSHOT_OFF) no('forbidden_arg', `${SYSTEM_PROMPT_SNAPSHOT_OFF} must follow, once`)
  k++
  // outside the agent folder the system prompt is the worker's own file (the preamble and the instruction files)
  if (
    trusted.outsideAgentFolder &&
    !args.includes(`--append-system-prompt-file=${workerSystemPromptPath(home, spec.threadId)}`)
  )
    no('forbidden_arg', 'outside the agent folder the system prompt is the worker’s own file')
  const optional: Array<[string, (v: string) => boolean]> = [
    ['--model=', (v) => isModel(v)],
    ['--append-system-prompt=', () => true],
    ['--append-system-prompt-file=', (v) => v === workerSystemPromptPath(home, spec.threadId)],
  ]
  if (!mcp) optional.push(['--mcp-config=', (v) => v.startsWith('/') && !v.includes('\0')])
  for (const [prefix, ok] of optional) {
    const a = at()
    if (a?.startsWith(prefix)) {
      if (!ok(a.slice(prefix.length))) no('forbidden_arg', prefix)
      k++
    }
  }
  if (mcp) {
    // the path is the worker's own, from the home and thread the supervisor knows, never the plan's word alone
    const own = workerMcpConfigPath(home, spec.threadId)
    if (mcp.configPath !== own) no('forbidden_arg', '--mcp-config must be the worker’s own MCP file')
    if (at() !== '--strict-mcp-config' || args[k + 1] !== `--mcp-config=${own}` || args[k + 2] !== '--no-chrome')
      no('forbidden_arg', 'the MCP list: --strict-mcp-config --mcp-config=<its file> --no-chrome, once, in its place')
    k += 3
  }
  if ((at() !== '--resume' && at() !== '--session-id') || !isUUID(args[k + 1] ?? ''))
    no('forbidden_arg', 'the session flag')
  k += 2
  if (k !== args.length) no('forbidden_arg', String(args[k]))
  for (const a of args) for (const f of FORBIDDEN_ARGS) if (a === f || a.startsWith(`${f}=`)) no('forbidden_arg', f)
  if (
    args.some((a) => a.startsWith('--append-system-prompt=')) &&
    args.some((a) => a.startsWith('--append-system-prompt-file='))
  )
    no('forbidden_arg', 'one system prompt: the text or the file, never both')
  if (spec.program !== trusted.claudePath) no('forbidden_arg', 'the program')
  if (spec.cwd !== trusted.cwd) no('relative_cwd', 'the folder')
  for (const k of Object.keys(spec.env)) {
    if (STRIPPED_ENV.has(k) || shellSteeringKey(k)) no('forbidden_env', k)
    if (STRIPPED_PREFIXES.some((p) => k.startsWith(p)) && k !== 'TELEGRAM_STATE_DIR' && k !== 'IMESSAGE_STATE_DIR')
      no('forbidden_env', k)
    if (!WORKER_KEYS.has(k) && isInheritedClaudeVar(k)) no('forbidden_env', k)
  }
  if (spec.env.TALOS_APP_HOME !== home) no('forbidden_env', 'TALOS_APP_HOME')
  if (mcp && spec.env[CONNECTORS_ENV] !== 'false') no('forbidden_env', CONNECTORS_ENV)
  // the state dirs may only ever be the empty folder: the plugins read a token from there
  const empty = noChannelDir(home)
  for (const k of ['TELEGRAM_STATE_DIR', 'IMESSAGE_STATE_DIR']) if (spec.env[k] !== empty) no('forbidden_env', k)
  if (spec.env.TALOS_APP_WORKER_THREAD !== spec.threadId) no('forbidden_env', 'TALOS_APP_WORKER_THREAD')
  if (spec.env.TALOS_SESSION_ROLE !== 'worker') no('forbidden_env', 'TALOS_SESSION_ROLE')
  if (!/^[0-9a-f]{32,}$/.test(spec.env.TALOS_APP_WORKER_NONCE ?? '')) no('forbidden_env', 'TALOS_APP_WORKER_NONCE')
  if (!spec.cwd.startsWith('/')) no('relative_cwd', spec.cwd)
  let settings: Json = {}
  try {
    const v = JSON.parse(spec.settingsJSON) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    settings = v as Json
  } catch {
    no('forbidden_env', 'settings')
  }
  // TALOS_APP_THREAD_STATE=1 exactly when the settings run both thread-state commands (the kit's session-start and compaction-guard
  // leave Main's state to Main only then): neither without the other
  const stateCmd = (event: string, mode: string) => {
    const list = (settings.hooks as Json | undefined)?.[event]
    const script = join(workerHookDir(home), STATE_HOOK)
    return (
      Array.isArray(list) &&
      list.some((e) =>
        ((e as Json | null)?.hooks as unknown[] | undefined)?.some((h) => {
          const c = (h as Json | null)?.command
          return typeof c === 'string' && c.startsWith(`f=${shq(script)}; `) && c.includes(` ${mode} `)
        }),
      )
    )
  }
  const stateRegistered = stateCmd('SessionStart', 'inject') && stateCmd('PreCompact', 'save')
  const stateVar = spec.env[THREAD_STATE_ENV]
  if (stateVar !== undefined && stateVar !== '1') no('forbidden_env', THREAD_STATE_ENV)
  if ((stateVar === '1') !== stateRegistered)
    no('forbidden_env', `${THREAD_STATE_ENV} must be set exactly when the settings run the thread-state hook`)
  if (trusted.rootedHookDir) {
    if (!trusted.rootedHook) no('forbidden_env', 'the permission hook is not root’s')
    rootedHookOnly(settings, {
      dir: trusted.rootedHookDir,
      ...(trusted.rootedHook as { script: string; command: string; statusLine: string }),
    })
  }
  // a setting that switches every hook off drops the guards' hook and the permission relay: wider than Main
  if (settings.disableAllHooks !== undefined && settings.disableAllHooks !== false) no('escalation', 'disableAllHooks')
  const plugins = (settings.enabledPlugins ?? {}) as Json
  if (plugins[TELEGRAM_PLUGIN] !== false || plugins[IMESSAGE_PLUGIN] !== false) no('forbidden_env', 'enabledPlugins')
  const deniedServers = Array.isArray(settings.deniedMcpServers) ? (settings.deniedMcpServers as unknown[]) : []
  for (const n of MCP_ALWAYS_DENIED)
    if (!deniedServers.some((d) => (d as Json | null)?.serverName === n)) no('forbidden_env', 'deniedMcpServers')
  if (mcp) {
    for (const key of mcp.disabledPlugins)
      if (!isInstructionPlugin(key) && plugins[key] !== false) no('forbidden_env', 'enabledPlugins')
    if (settings.disableClaudeAiConnectors !== true) no('forbidden_env', 'disableClaudeAiConnectors')
    const denied = Array.isArray(settings.deniedMcpServers) ? (settings.deniedMcpServers as unknown[]) : []
    for (const n of MCP_NEVER_OPEN)
      if (!denied.some((d) => (d as Json | null)?.serverName === n)) no('forbidden_env', 'deniedMcpServers')
    const deny = (settings.permissions as Json | undefined)?.deny
    for (const r of [...mcp.denyRules, MCP_CONNECTOR_DENY])
      if (!Array.isArray(deny) || !deny.includes(r)) no('forbidden_env', 'the MCP deny rules')
  }
  const senv = (settings.env ?? {}) as Json
  if (typeof senv !== 'object' || senv === null || Array.isArray(senv)) no('forbidden_env', 'settings.env')
  for (const k of Object.keys(senv)) {
    const v = senv[k]
    if (k === 'TELEGRAM_STATE_DIR' || k === 'IMESSAGE_STATE_DIR') {
      if (v !== empty) no('forbidden_env', `settings.env.${k}`)
    } else if (strippedKey(k) || isInheritedClaudeVar(k)) no('forbidden_env', `settings.env.${k}`)
  }
  // with the developer switch off (the supervisor's own read) the session has Main's access: no Talos-home fence is asked for, but the
  // write deny on the sessions' own files (workers/) always is
  if (fenceMissing(spec.settingsJSON, home, trusted.threadFence !== false).length > 0)
    no('fence_missing', 'the Talos-home deny is not in the settings')
  if (trusted.parentDeny && trusted.parentDeny.length > 0) {
    const deny = (settings.permissions as { deny?: unknown } | undefined)?.deny
    const have = new Set(Array.isArray(deny) ? deny : [])
    const lost = trusted.parentDeny.filter((r) => !have.has(r))
    if (lost.length > 0)
      no('fence_missing', `the parent thread folder's deny rules are not in the settings: ${lost.join(', ')}`)
  }
  // the switch is on (the supervisor's own read): the settings carry the sandbox it built, locked, and its environment
  if (trusted.osSandbox) {
    const have = JSON.stringify(sortKeys(settings.sandbox ?? null))
    if (have !== JSON.stringify(sortKeys(trusted.osSandbox.sandbox)))
      no('fence_missing', 'the OS sandbox block is not in the settings as the supervisor built it')
    for (const [k, v] of Object.entries(trusted.osSandbox.env))
      if (senv[k] !== v) no('fence_missing', `the OS sandbox environment ${k} is not in the settings`)
  }
  if (mcp?.refusal) no('escalation', `mcp: ${mcp.refusal}`, 'mcp')
  const d = checkCeiling(spec.args, settings, mcp?.allowed ?? [], Object.keys(mcp?.ownFolder ?? {}), trusted.main)
  if (d) no('escalation', `${d.axis}: ${d.detail}`, d.axis)
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    // no prototype: a `__proto__` member is copied as the plain key it is, never taken as the prototype (Fable R4-4)
    const out: Json = Object.create(null)
    for (const k of Object.keys(v as Json).sort()) out[k] = sortKeys((v as Json)[k])
    return out
  }
  return v
}
