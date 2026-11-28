// Main's environment: the port of the Mac's LoginShellEnv.build (apps/desktop/Sources/TalosDesktopCore/LoginShellEnv.swift),
// the one place a Main launch builds it. Built again at every start (never captured once): an owner who changes a profile and
// restarts gets the change.
//   the login shell's environment, only the names in MAIN_LOGIN_ENV (and LC_*), minus the terminal's own variables, minus a
//   thread session's channel switches, minus inherited Claude Code markers; then the settings' `env` on top (any of the
//   owner's own, never a session marker); then TERM and COLORTERM; then MAIN_ENV, which Main always carries. A thread session
//   still takes the whole login environment (buildLaunchEnv): it is never started with a warning answered for it.
import { readFileSync } from 'node:fs'
import { MAIN_ENV } from '@talos-app/protocol'
import { ALWAYS_DROP, isInheritedClaudeVar, SESSION_MARKERS } from '../claude-env.ts'

/** The terminal's own variables: never the agent's. */
export const TERMINAL_ONLY = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'SHLVL',
  'PWD',
  'OLDPWD',
  '_',
])

/**
 * What a worker launch sets for itself (the claude.ai connectors switch, the no-channel state dirs). Leaked into the login
 * environment (install.sh run from a thread session) they would reach Main; the owner's own state dirs stay.
 */
/** isWorkerChannelSwitch as data (the launch spec's strip rule): always dropped, and dropped when pointed at the no-channel dir. */
/**
 * What makes Claude Code run the turn that was cut off again when its session is resumed (measured on 2.1.332: with both it
 * re-ran after SIGTERM and SIGKILL, without them it waits at "Interrupted"). Set only by a resume of a cut turn
 * (cut-turn.ts); never part of the launch spec hash (launch-spec.ts LAUNCH_SPEC_EXCLUDED_ENV), or the next update check
 * would see a changed spec and restart the session again.
 */
export const RESUME_TURN_ENV = {
  CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
  CLAUDE_CODE_RESUME_REASON: 'user_resume',
} as const

export const CHANNEL_SWITCH_ALWAYS = ['ENABLE_CLAUDEAI_MCP_SERVERS'] as const
export const CHANNEL_SWITCH_NOCHANNEL = ['IMESSAGE_STATE_DIR', 'TELEGRAM_STATE_DIR'] as const
export const NOCHANNEL_SUFFIX = '/workers/_nochannel'
export function isWorkerChannelSwitch(name: string, value: string): boolean {
  if ((CHANNEL_SWITCH_ALWAYS as readonly string[]).includes(name)) return true
  return (CHANNEL_SWITCH_NOCHANNEL as readonly string[]).includes(name) && value.endsWith(NOCHANNEL_SUFFIX)
}

/** What identifies one running session or terminal: no source may set it, the settings included. CLAUDE_EFFORT may be set. */
export function isSessionMarker(name: string): boolean {
  return (ALWAYS_DROP.has(name) && name !== 'CLAUDE_EFFORT') || SESSION_MARKERS.has(name)
}

/**
 * What Main takes from the login shell: these names only (and LC_*). A login profile is the agent's to write, and Main may be
 * started and its warning answered with nobody at the pane, so nothing else a profile sets (ANTHROPIC_BASE_URL, a preload, a
 * config folder) reaches it; what Main needs beyond these goes in supervisor.json's `env`, which root's approval covers.
 * TALOS_APP_HOME and the token's file are the supervisor's own, set after this (cli.ts).
 */
export const MAIN_LOGIN_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'TALOS_APP_HOME',
  'TALOS_APP_OAUTH_TOKEN_FILE',
])

export function buildMainEnv(
  shellEnv: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const login: Record<string, string> = {}
  for (const [k, v] of Object.entries(shellEnv)) if (MAIN_LOGIN_ENV.has(k) || k.startsWith('LC_')) login[k] = v
  return { ...buildLaunchEnv(login, overrides), ...MAIN_ENV }
}

/**
 * A session's environment, Main's or a thread session's (the Mac's LoginShellEnv.build): the login shell's, less what only a
 * terminal or another Claude session sets, with the owner's `env` from the settings on top (never a session marker), and a
 * colour terminal. Main adds MAIN_ENV; a thread session's spec strips what a worker must not have.
 */
export function buildLaunchEnv(
  shellEnv: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(shellEnv))
    if (!TERMINAL_ONLY.has(k) && !isWorkerChannelSwitch(k, v) && !isInheritedClaudeVar(k)) env[k] = v
  for (const [k, v] of Object.entries(overrides)) if (!isSessionMarker(k)) env[k] = v
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

/**
 * The environment a running process was started with, from /proc/<pid>/environ (Linux, the same user): what an adopted Main
 * really runs under, never a rebuild from today's settings. Null when it cannot be read (no /proc, another user, gone).
 */
export function processEnviron(
  pid: number,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): Record<string, string> | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  let raw: Buffer
  try {
    raw = read(`/proc/${pid}/environ`)
  } catch {
    return null
  }
  const env: Record<string, string> = {}
  for (const entry of raw.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

/**
 * An adopted Main's environment (one this supervisor did not start): the one its process really has (it may have been started
 * with other settings than today's) while the pid is still Main's own process; else a rebuild, said in the audit log and marked
 * not known (a guess: no thread session is held to it).
 */
export function adoptedMainEnv(
  pid: number,
  d: {
    processEnv?: (pid: number) => Record<string, string> | null
    audit: (event: string, fields?: Record<string, string>) => void
    config: () => { env: Record<string, string> } | { error: string }
    loginEnv: () => Record<string, string>
  },
  stillMain: () => boolean,
  previous: Record<string, string> | null = null,
): { env: Record<string, string>; known: boolean } {
  const real = (d.processEnv ?? processEnviron)(pid)
  // checked after the read: a pid Main left and another process took in between is not Main's environment
  if (real && stillMain()) return { env: real, known: true }
  // a retry that fails again keeps the guess it had, quietly (no line per look, no second login-shell read)
  if (previous) return { env: previous, known: false }
  d.audit('main_env_rebuilt', { pid: String(pid) })
  const cfg = d.config()
  return { env: 'error' in cfg ? d.loginEnv() : buildMainEnv(d.loginEnv(), cfg.env), known: false }
}

/** This process's own environment, without the variables that are unset. */
export const processEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
