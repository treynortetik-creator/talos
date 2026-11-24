// `talos-app supervise`: the Linux (and WSL) supervisor's command. Runs Main under tmux and keeps it running (main.ts), with its
// settings in <TALOS_APP_HOME>/supervisor.json, its status in supervisor-status.json and its log in supervisor.log.
//   talos-app supervise            run in the foreground (what the systemd user unit runs)
//   talos-app supervise status     print the last status
//   talos-app supervise unit       print the systemd user unit
//   talos-app supervise stop       ask the running supervisor to stop Main (it stays stopped, across reboots, until `start`)
//   talos-app supervise start      ask it to start Main again (--anyway: past another session holding the channels, once)
// One supervisor per Talos home: supervisor.lock holds the pid and start token of the one that runs.
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { MAIN_TMUX_SESSION, type MainLaunchConfig, ThreadId, TMUX_SOCKET } from '@talos-app/protocol'
import { claudeConfigDir } from '../claude-dir.ts'
import type { CliIO } from '../cli-main.ts'
import type { BridgeEnv } from '../config.ts'
import { DeviceStore } from '../devices.ts'
import { processStartTime } from '../proc-identity.ts'
import { bridgeLiveness, readStatusFile } from '../status-file.ts'
import { postSystemRow } from '../system-post.ts'
import { writeControl } from '../worker/files.ts'
import { ENV_MARKER, LoginEnvCache, loginShellEnvAsync, parseLoginEnv } from './login-env.ts'

export { parseLoginEnv }

import { isSessionId } from './launch-approval.ts'

export { isSessionId }

import { machineName } from '../owner-words.ts'
import { ownerHost } from '../platform.ts'
import { BRIDGE_COMMIT } from '../version.ts'
import { firstStartWiring } from './first-start-wiring.ts'
import { buildLaunchEnv, processEnv } from './launch-env.ts'
import { MainSupervisor } from './main.ts'
import type { MainStateExtras } from './main-state.ts'
import { type MainEvent, ownerTeller, viewCommand } from './notices.ts'
import { supervisorPlan } from './plan-wiring.ts'
import { runTool, systemIdentity } from './proc.ts'
import { restartActorWiring } from './restart-wiring.ts'
import { kitAnchor } from './rooted-kit.ts'
import type { SignInDriver } from './signin.ts'
import { signInDriverFor } from './signin-wiring.ts'
import { checkTakeover, parseAgents, procOf, readBotPid, readBridgePid } from './takeover.ts'
import { superviseAttach, superviseThreads } from './thread-view.ts'
import { TmuxPtyHost } from './tmux-host.ts'
import { threadFolderReader, workerConfigReaders } from './worker-config.ts'
import { readSmallFile } from './worker-dialogs.ts'
import { kitVendor, releaseHook } from './worker-hook.ts'
import { postOutcome } from './worker-notices.ts'
import { WorkerManager } from './workers.ts'
import { setWorkersOn } from './workers-file.ts'
import { dedicatedThreads, MAIN_ENV_UNKNOWN } from './workers-wiring.ts'

export const SUPERVISOR_FILES = {
  config: 'supervisor.json',
  status: 'supervisor-status.json',
  log: 'supervisor.log',
  lock: 'supervisor.lock',
  control: 'supervisor-control',
  /** The owner stopped Main: no start at the next supervisor start, until their `start`. */
  stopped: 'supervisor-stopped',
  tmuxConf: 'tmux.conf',
  launchDir: 'launch',
} as const

/** The Mac's bundled tmux.conf (apps/desktop/Resources/tmux.conf), byte for byte; a test keeps the two the same. */
export const TMUX_CONF = `# Used only by Talos: tmux -L talos -f <this file>. The owner's ~/.tmux.conf is never read.
# A dead agent pane stays on screen so the supervisor can read its exit status and last screen.
set -g remain-on-exit on
set -g status off
set -g history-limit 50000
set -g default-terminal "xterm-256color"
set -g mouse on
# The supervised session is a viewer, not a workspace (D1-REVIEW finding 1): no prefix key, so no split, new window,
# kill or respawn from the keyboard, and no right-click menus. Mouse stays on for scrolling and selection.
set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
# -q: a tmux that does not know a key name (3.4, Ubuntu 24.04's and the Windows PC's, has no MouseDown3Empty or
# MouseDown1Control9) skips it silently. Without it the error is kept and shown to the first client that attaches, in a view
# that takes the keys, so the owner's answer would go into it (Titan, 2026-11-14).
unbind-key -qn MouseDown3Pane
unbind-key -qn M-MouseDown3Pane
unbind-key -qn MouseDown3Status
unbind-key -qn M-MouseDown3Status
unbind-key -qn MouseDown3StatusLeft
unbind-key -qn M-MouseDown3StatusLeft
unbind-key -qn MouseDown3Empty
unbind-key -qn M-MouseDown3Empty
unbind-key -qn MouseDown1Control9
# The root table (tmux 3.8 ships structural mouse bindings: Ctrl-drag adds a pane with a shell, middle click pastes a Return,
# Alt-drag moves panes). Clear it, then give back only what a viewer needs: click to focus, wheel and drag to scroll and
# select. A tmux upgrade can't add a root binding that way.
unbind-key -a -T root
bind-key -T root MouseDown1Pane select-pane -t = \\; send-keys -M
bind-key -T root MouseDrag1Pane if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"
bind-key -T root WheelUpPane if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -e"
bind-key -T root WheelDownPane select-pane -t = \\; send-keys -M
`

// ---- settings ---------------------------------------------------------------------------------------------------------------

/**
 * supervisor.json as the owner writes it; everything but `agent_dir` has a default. A field of the wrong type is an error,
 * never quietly the default (settings that cannot be read start nothing). Unknown fields are ignored.
 */
export function readSupervisorConfig(home: string, userHome: string): MainLaunchConfig | { error: string } {
  const path = join(home, SUPERVISOR_FILES.config)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { error: existsSync(path) ? `${path} is not valid JSON` : `no ${path} (it needs at least "agent_dir")` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${path} is not a JSON object` }
  const o = raw as Record<string, unknown>
  const bad = (field: string, want: string) => ({ error: `${path}: "${field}" must be ${want}` })
  const isStrs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  for (const f of ['agent_dir', 'claude_path'] as const)
    if (o[f] !== undefined && typeof o[f] !== 'string') return bad(f, 'a string')
  for (const f of ['auto_restart', 'auto_confirm_restart', 'start_on_launch', 'workers'] as const)
    if (o[f] !== undefined && typeof o[f] !== 'boolean') return bad(f, 'true or false')
  if (o.args !== undefined && !isStrs(o.args)) return bad('args', 'a list of strings')
  if (o.env !== undefined) {
    if (o.env === null || typeof o.env !== 'object' || Array.isArray(o.env)) return bad('env', 'an object of strings')
    if (!Object.values(o.env as Record<string, unknown>).every((v) => typeof v === 'string'))
      return bad('env', 'an object of strings')
    // the token is the tray's, read from its own file by the launch (oauth-token.ts): never named here
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'TALOS_APP_OAUTH_TOKEN_FILE'])
      if (k in (o.env as Record<string, unknown>))
        return {
          error: `${path}: "env" may not set ${k} (the token comes from the tray's sign-in, ${'$'}TALOS_APP_HOME/claude-oauth-token)`,
        }
  }
  const session = (o.session ?? {}) as Record<string, unknown>
  if (typeof session !== 'object' || Array.isArray(session)) return bad('session', 'an object')
  // a session id goes into Claude Code's argv: only ever a UUID, never something that could read as a flag (Fable R3-4)
  if (session.id !== undefined && session.id !== null && !isSessionId(session.id))
    return bad('session.id', "a session's id (a lowercase UUID)")
  if (
    session.previous_ids !== undefined &&
    !(isStrs(session.previous_ids) && (session.previous_ids as string[]).every(isSessionId))
  )
    return bad('session.previous_ids', 'a list of session ids (lowercase UUIDs)')
  // `conversation_seen` (the Mac's name, written here too); `had_turn` is what this supervisor wrote before, still read
  for (const f of ['conversation_seen', 'had_turn'] as const)
    if (session[f] !== undefined && typeof session[f] !== 'boolean') return bad(`session.${f}`, 'true or false')
  const agentDir = o.agent_dir as string | undefined
  if (!agentDir) return { error: `${path} has no "agent_dir"` }
  const tilde = (p: string) => (p === '~' ? userHome : p.startsWith('~/') ? join(userHome, p.slice(2)) : p)
  // a relative folder would mean "wherever the supervisor happened to start"
  if (!isAbsolute(tilde(agentDir))) return bad('agent_dir', 'an absolute path (or one starting with ~/)')
  return {
    agentDir: resolve(tilde(agentDir)),
    claudePath: tilde((o.claude_path as string | undefined) ?? 'auto'),
    args: (o.args as string[] | undefined) ?? ['--dangerously-load-development-channels', 'server:talos-app'],
    env: { ...((o.env as Record<string, string> | undefined) ?? {}) },
    host: 'tmux',
    autoRestart: (o.auto_restart as boolean | undefined) ?? true,
    autoConfirmRestart: (o.auto_confirm_restart as boolean | undefined) ?? true,
    startOnLaunch: (o.start_on_launch as boolean | undefined) ?? true,
    workers: o.workers !== false,
    session: {
      id: (session.id as string | null | undefined) ?? null,
      previousIds: (session.previous_ids as string[] | undefined) ?? [],
      conversationSeen: session.conversation_seen === true || session.had_turn === true,
    },
  }
}

/** The last session ids kept (the Mac keeps 5). */
const PREVIOUS_IDS_KEPT = 5

/** Records a new session id (the old one, if any, joins previous_ids), keeping every other field as the owner wrote it. */
export function saveSessionId(home: string, id: string): void {
  const path = join(home, SUPERVISOR_FILES.config)
  const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const s = (o.session ?? {}) as { id?: string; previous_ids?: string[] }
  const previous = [...(s.previous_ids ?? []), ...(s.id && s.id !== id ? [s.id] : [])].slice(-PREVIOUS_IDS_KEPT)
  // a new id has had no conversation yet (the old name goes)
  o.session = { id, previous_ids: previous, conversation_seen: false }
  writePrivate(path, `${JSON.stringify(o, null, 2)}\n`)
}

/** Records that the session `id` has had a conversation, only while it is still the configured one; every other field as written. */
export function markConversationSeen(home: string, id: string): void {
  const path = join(home, SUPERVISOR_FILES.config)
  const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const s = (o.session ?? {}) as { id?: string; conversation_seen?: boolean; had_turn?: boolean }
  if (s.id !== id || s.conversation_seen === true) return
  const { had_turn: _old, ...rest } = s
  o.session = { ...rest, conversation_seen: true }
  writePrivate(path, `${JSON.stringify(o, null, 2)}\n`)
}

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

// ---- one supervisor per home ------------------------------------------------------------------------------------------------

type LockHolder = { pid: number; start: string }

function readLock(home: string): LockHolder | null {
  try {
    const held = JSON.parse(readFileSync(join(home, SUPERVISOR_FILES.lock), 'utf8')) as {
      pid?: unknown
      start?: unknown
    }
    return typeof held.pid === 'number' && typeof held.start === 'string' ? { pid: held.pid, start: held.start } : null
  } catch {
    return null
  }
}

/** The supervisor that holds the lock, when it is still that process; null when none runs. */
export function lockHolder(
  home: string,
  startOf: (pid: number) => string | null = (p) => processStartTime(p),
): LockHolder | null {
  const held = readLock(home)
  return held && held.pid > 1 && startOf(held.pid) === held.start ? held : null
}

/**
 * Takes supervisor.lock: refused while another supervisor runs (its pid with the start token it wrote); a dead one's is taken
 * over. Two supervisors taking a stale lock at once both unlink and create, so the lock is read back after: only the one
 * whose pid and token it holds goes on (and each tick checks that again, `holdsLock`).
 */
export function takeLock(home: string, startOf: (pid: number) => string | null = (p) => processStartTime(p)): boolean {
  const path = join(home, SUPERVISOR_FILES.lock)
  const mine = startOf(process.pid)
  if (mine === null) return false // a lock nobody could check would read as stale to everyone
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, start: mine }))
      } finally {
        closeSync(fd)
      }
      return holdsLock(home, startOf)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
    if (lockHolder(home, startOf)) return false
    try {
      unlinkSync(path)
    } catch {
      // another supervisor took it over first: the create above fails again, and its lock is read
    }
  }
  return false
}

/** The lock still names this process (a supervisor that lost a takeover race finds out here and steps back). */
export function holdsLock(home: string, startOf: (pid: number) => string | null = (p) => processStartTime(p)): boolean {
  const held = readLock(home)
  return held !== null && held.pid === process.pid && held.start === startOf(process.pid)
}

export function releaseLock(home: string, startOf: (pid: number) => string | null = (p) => processStartTime(p)): void {
  if (holdsLock(home, startOf)) {
    try {
      unlinkSync(join(home, SUPERVISOR_FILES.lock))
    } catch {
      // gone
    }
  }
}

// ---- the owner's environment --------------------------------------------------------------------------------------------------

/**
 * The owner's login environment, as the Mac reads it: an interactive login shell (so .bashrc/.zshrc, where installers put
 * their PATH lines, are read too) prints a marker and then `env -0`; only what follows the marker counts, so a profile that
 * prints a greeting cannot glue it onto a variable. Null when the shell is missing, fails or takes over 5 s; the caller then
 * uses its own environment.
 */
export function loginShellEnv(
  shell = process.env.SHELL || '/bin/bash',
  env: Record<string, string> = processEnv(),
): Record<string, string> | null {
  let r: ReturnType<typeof Bun.spawnSync>
  try {
    r = Bun.spawnSync([shell, '-l', '-i', '-c', `printf '%s\\0' ${ENV_MARKER}; env -0`], {
      env,
      // its own session, no controlling terminal: from a terminal's background process group an interactive shell would be
      // stopped by job control (SIGTTIN/SIGTTOU), and this whole process with it (see loginShellEnvAsync)
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5_000,
    })
  } catch {
    return null
  }
  if (r.exitCode !== 0) return null
  return parseLoginEnv(r.stdout?.toString() ?? '')
}

/** `auto` = `claude` on the launch PATH; an absolute path must be an executable file. */
export function resolveOnPath(program: string, env: Record<string, string>): string | null {
  const name = program === 'auto' ? 'claude' : program
  const isExec = (p: string) => {
    try {
      const st = statSync(p)
      return st.isFile() && (st.mode & 0o111) !== 0
    } catch {
      return false
    }
  }
  if (isAbsolute(name)) return isExec(name) ? name : null
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir && isExec(join(dir, name))) return join(dir, name)
  return null
}

/**
 * Why the talos-app MCP server did not start, from Claude Code's own log for this folder. On Linux it keeps it under
 * `$XDG_CACHE_HOME/claude-cli-nodejs/<folder, every non-alphanumeric as "-">/mcp-logs-talos-app/*.jsonl` (the Mac's is under
 * ~/Library/Caches), one JSON object per line with `error` or `debug` text. The newest log's newest error wins over its debug
 * lines; with no error, its newest debug line; nothing readable is null. At most 300 characters.
 */
export function mcpLogReason(agentDir: string, cacheHome: string): string | null {
  // Claude Code names the folder after its own working folder, which on Linux is the physical path (links resolved)
  let real = agentDir
  try {
    real = realpathSync(agentDir)
  } catch {
    // gone: the name as given
  }
  for (const d of new Set([real, agentDir])) {
    const found = mcpLogReasonIn(
      join(cacheHome, 'claude-cli-nodejs', d.replace(/[^A-Za-z0-9]/g, '-'), 'mcp-logs-talos-app'),
    )
    if (found !== undefined) return found
  }
  return null
}

/** undefined when the folder has no log; null when it has logs but nothing readable in them. */
function mcpLogReasonIn(dir: string): string | null | undefined {
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined
  for (const name of names) {
    let lines: string[]
    try {
      lines = readFileSync(join(dir, name), 'utf8').split('\n').reverse()
    } catch {
      continue
    }
    let debug: string | null = null
    for (const line of lines) {
      let o: unknown
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      const rec = (o ?? {}) as { error?: unknown; debug?: unknown }
      if (typeof rec.error === 'string' && rec.error) return rec.error.slice(0, 300)
      if (debug === null && typeof rec.debug === 'string' && rec.debug) debug = rec.debug.slice(0, 300)
    }
    if (debug !== null) return debug
  }
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Main's Claude Code config folder: its own CLAUDE_CONFIG_DIR (from the login shell or the settings), else ~/.claude. */
export function mainClaudeDir(mainEnv: Record<string, string>, userHome: string): string {
  try {
    return claudeConfigDir(userHome, mainEnv.CLAUDE_CONFIG_DIR || undefined)
  } catch {
    return join(userHome, '.claude')
  }
}

/**
 * Claude Code's transcript of `sessionId`: `<config>/projects/<folder name>/<id>.jsonl`, written once the session has its first
 * message (or an /exit). The folder name is the real path with non-alphanumerics as "-" (Claude Code shortens one over 200
 * characters with a hash), so the exact name is tried first and then every folder: the id is a UUID, so a hit anywhere is
 * this session (also after an agent_dir change, where resuming gives the explicit resume error instead of a quiet new
 * conversation under the old id). Null when there is none.
 */
export function findTranscript(agentDir: string, sessionId: string, claudeDir: string): string | null {
  const projects = join(claudeDir, 'projects')
  let real = agentDir
  try {
    real = realpathSync(agentDir)
  } catch {
    // gone: the name as given
  }
  for (const d of new Set([real, agentDir])) {
    const p = join(projects, d.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  try {
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // no projects folder yet
  }
  return null
}

/** Saved: a transcript exists anywhere. An id that is not a UUID is never looked up and counts as saved (it is resumed). */
export function sessionSaved(agentDir: string, sessionId: string, claudeDir: string): boolean {
  if (!UUID.test(sessionId)) return true
  return findTranscript(agentDir, sessionId, claudeDir) !== null
}

/** A user line that is only a slash command's own markup (`<command-name>`, `<local-command-stdout>`, ...). */
function isCommandOnly(content: unknown): boolean {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
        : ''
  return /^\s*(<(command-[a-z]+|local-command-[a-z]+)>[\s\S]*?<\/\2>\s*)+$/.test(text)
}

/** A transcript that exists but holds no conversation (no assistant line, no user line of the owner's): it can't be resumed. */
export function conversationEmpty(agentDir: string, sessionId: string, claudeDir: string): boolean {
  if (!UUID.test(sessionId)) return false
  const p = findTranscript(agentDir, sessionId, claudeDir)
  if (p === null) return false
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { type?: unknown; isMeta?: unknown; message?: { content?: unknown } }
        if (rec.type === 'assistant') return false
        // Claude Code records slash commands (/exit) and their output as meta or command-only user lines: not a conversation
        if (rec.type === 'user' && rec.isMeta !== true && !isCommandOnly(rec.message?.content)) return false
      } catch {
        // a line being written
      }
    }
    return true
  } catch {
    return false
  }
}

/** The exit status of a supervisor refused because another one runs (the unit does not respawn it). */
export const ANOTHER_RUNS_EXIT = 3

// ---- the systemd user unit ------------------------------------------------------------------------------------------------

/**
 * The user unit that starts the supervisor at login (and, with linger, at boot; on WSL only with `systemd=true` in
 * /etc/wsl.conf). KillMode=process: stopping or restarting the supervisor must not take the tmux server (and Main in it) down
 * with it; the next supervisor adopts Main. Values are quoted, and `%` and `$` (systemd expands both) doubled.
 */
export function systemdUnit(bun: string, cli: string, talosHome: string): string {
  const q = (s: string) =>
    `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`
  return `[Unit]
Description=Talos supervisor (keeps your agent running)
After=default.target

[Service]
Type=simple
Environment=TALOS_APP_HOME=${q(talosHome)}
ExecStart=${q(bun)} ${q(cli)} supervise
Restart=on-failure
RestartSec=5
# ${ANOTHER_RUNS_EXIT}: another supervisor already runs for this Talos home; respawning would only be refused again
RestartPreventExitStatus=${ANOTHER_RUNS_EXIT}
KillMode=process

[Install]
WantedBy=default.target
`
}

// ---- the command ------------------------------------------------------------------------------------------------------------

export async function cmdSupervise(env: BridgeEnv, args: string[], io: CliIO): Promise<number> {
  const home = env.home
  const [sub] = args
  if (sub === 'unit') {
    io.out(systemdUnit(process.execPath, resolve(import.meta.dir, '../cli.ts'), home))
    return 0
  }
  if (sub === 'status') {
    let text: string
    try {
      text = readFileSync(join(home, SUPERVISOR_FILES.status), 'utf8').trim()
    } catch {
      io.err('talos-app: no supervisor has run yet')
      return 1
    }
    io.out(text)
    if (!lockHolder(home)) io.err('talos-app: no supervisor is running now; this is the last status it wrote')
    return 0
  }
  if (sub === 'stop' || sub === 'start') {
    const ask = sub === 'start' && args.includes('--anyway') ? 'start-anyway' : sub
    // Pantheon 2026-11-14: the agent may stop and start Main when asked; what stays the owner's is his own Stop. While it stands
    // (SUPERVISOR_FILES.stopped), the owner at a real terminal (a tty and not inside Claude Code) starts Main as before; from a
    // session (CLAUDECODE set, a faked tty or not: Fable R1-2) a start needs his recent words in a thread, or is refused in words.
    const realTerminal = io.isTerminal !== false && !process.env.CLAUDECODE
    if (
      sub === 'start' &&
      !realTerminal &&
      existsSync(join(home, SUPERVISOR_FILES.stopped)) &&
      !(await import('../on-request-cli.ts')).ownerAskedRecently(env)
    ) {
      io.err(
        'talos-app: the owner stopped Main; he can start it from the phone, or ask for it in a thread first (a terminal alone does not count: one can be faked).',
      )
      return 1
    }
    // the request is for the supervisor running NOW: one left for a later boot would act days after it was typed
    if (!lockHolder(home)) {
      io.err(`talos-app: no supervisor is running (start it with: systemctl --user start talos-supervisor)`)
      return 1
    }
    const control = join(home, SUPERVISOR_FILES.control)
    writePrivate(control, `${ask}\n`)
    // said as done only once the running supervisor took it (it looks every second): never claimed for a request it did not take
    for (let i = 0; i < CONTROL_TAKE_WAIT_MS / 250 && existsSync(control); i++)
      await new Promise((r) => setTimeout(r, 250))
    if (existsSync(control)) {
      rmSync(control, { force: true })
      io.err(
        `talos-app: the supervisor did not take the request in ${CONTROL_TAKE_WAIT_MS / 1000} s; nothing was asked (see: talos-app supervise status)`,
      )
      return 1
    }
    io.out(`the supervisor took the request to ${sub} Main`)
    return 0
  }
  if (sub === 'attach') return superviseAttach(home, env.userHome, args.slice(1), io)
  if (sub === 'threads') return superviseThreads(home, env.userHome, args.slice(1), io)
  if (sub === 'restart-thread') return superviseRestartThread(home, env.userHome, args.slice(1), io)
  if (sub !== undefined) {
    io.err(
      `talos-app supervise: unknown ${sub} (status, unit, stop, start, attach, threads, restart-thread, or nothing to run it)`,
    )
    return 2
  }
  return runSupervisor(home, env.userHome, io)
}

/**
 * `supervise restart-thread <thread>`: one thread session restarted through the running supervisor's own path (a control
 * wake: the session is parked, then started again resuming its conversation). Main is not a thread and is refused; so is a
 * thread that has no session of its own.
 */
function superviseRestartThread(home: string, userHome: string, args: string[], io: CliIO): number {
  const [id, ...rest] = args
  if (!id || rest.length > 0 || !ThreadId.safeParse(id).success) {
    io.err('usage: talos-app supervise restart-thread <thread>')
    return 2
  }
  if (!lockHolder(home)) {
    io.err('talos-app: no supervisor is running (start it with: systemctl --user start talos-supervisor)')
    return 1
  }
  const cfg = readSupervisorConfig(home, userHome)
  let threads: ReturnType<typeof dedicatedThreads> = null
  try {
    if (!('error' in cfg))
      threads = dedicatedThreads(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), cfg.agentDir)
  } catch {
    threads = null
  }
  if (threads === null) {
    io.err('talos-app: the thread list cannot be read (config.json or the supervisor settings)')
    return 1
  }
  if (!threads.some((t) => t.id === id)) {
    io.err(
      `talos-app: ${id} has no session of its own (Main and shared threads are restarted with: talos-app supervise stop / start)`,
    )
    return 1
  }
  writeControl(
    home,
    {
      v: 1,
      thread_id: id,
      message_ids: [],
      at: new Date().toISOString(),
      reason: 'control',
      action: 'restart',
    },
    (msg, f) => io.err(`talos-app: ${msg}: ${String(f.error)}`),
  )
  io.out(`asked the supervisor to restart ${id}'s session`)
  return 0
}

/** The test seam's private tmux server, refused unless it is a plain name (and never the owner's `default`). */
export function testSocket(audit: (e: string, f?: Record<string, string>) => void): string | undefined | null {
  const s = process.env.TALOS_SUPERVISOR_TMUX_SOCKET
  if (s === undefined || s === '') return undefined
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s) || s === 'default') return null
  audit('test_socket', { socket: s })
  return s
}

/** Restart-on-update holds unless a LIVE bridge's fresh status.json says the governor is ok, off or unknown (update-restart.ts). */
function updateGovernorOf(home: string): string | null {
  const l = bridgeLiveness(join(home, 'status.json'), Date.now())
  return l.state === 'live' ? l.status.governor : null
}

/** The release this supervisor runs: its own commit, and the kit's (root's record on a Talos PC, else the sealed release's hook). */
function releaseIdNow(): string {
  const a = kitAnchor()
  if ('refused' in a) return `${BRIDGE_COMMIT ?? 'none'}|kit-refused`
  if (a.mode === 'rooted') return `${BRIDGE_COMMIT ?? 'none'}|${a.version}|${a.sha}`
  const r = releaseHook(kitVendor(process.env))
  return `${BRIDGE_COMMIT ?? 'none'}|${'verified' in r && r.verified ? `${r.verified.hook}|${r.verified.helper ?? ''}${r.verified.state ? `|${Object.values(r.verified.state).join('|')}` : ''}` : 'home'}`
}

async function runSupervisor(home: string, userHome: string, io: CliIO): Promise<number> {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const first = readSupervisorConfig(home, userHome)
  if ('error' in first) {
    io.err(`talos-app supervise: ${first.error}`)
    return 1
  }
  if (!takeLock(home)) {
    io.err('talos-app supervise: another supervisor already runs for this Talos home')
    return ANOTHER_RUNS_EXIT
  }
  const audit = (event: string, fields: Record<string, string> = {}) => {
    try {
      appendFileSync(
        join(home, SUPERVISOR_FILES.log),
        `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`,
        {
          mode: 0o600,
        },
      )
    } catch {
      // a full disk must not stop supervision
    }
  }
  const socket = testSocket(audit)
  if (socket === null) {
    releaseLock(home)
    io.err('talos-app supervise: TALOS_SUPERVISOR_TMUX_SOCKET must be a plain name, not default')
    return 1
  }
  const tmux = resolveOnPath('tmux', loginShellEnv() ?? processEnv())
  if (!tmux || !(await TmuxPtyHost.usable(tmux))) {
    releaseLock(home)
    io.err('talos-app supervise: tmux 3.2 or newer is needed (install the tmux package)')
    return 1
  }
  const conf = join(home, SUPERVISOR_FILES.tmuxConf)
  writePrivate(conf, TMUX_CONF)
  const host = new TmuxPtyHost({
    tmux,
    configPath: conf,
    session: MAIN_TMUX_SESSION,
    ...(socket ? { socket } : {}),
    identity: systemIdentity,
    launchDir: join(home, SUPERVISOR_FILES.launchDir),
  })
  const stoppedFlag = join(home, SUPERVISOR_FILES.stopped)
  /** `claude agents --json` of the owner's claude, with Main's environment; null when it cannot be read in 10 s. */
  const listAgents = async (mainEnv: Record<string, string>) => {
    const c = readSupervisorConfig(home, userHome)
    const claude = resolveOnPath('error' in c ? 'auto' : c.claudePath, mainEnv)
    if (!claude) return null
    const r = await runTool([claude, 'agents', '--json'], mainEnv, 10_000)
    return r.ok ? parseAgents(r.out) : null
  }
  /** A desktop notice (when this session has a notification service) and, for a stop, a line to the phone. Never waits. */
  const tellOwner = ownerTeller({
    home,
    view: viewCommand(socket ?? TMUX_SOCKET, conf, MAIN_TMUX_SESSION),
    notifySend: resolveOnPath('notify-send', processEnv()),
    audit,
  })
  const fsw = firstStartWiring(home, userHome, audit, {
    readConfig: readSupervisorConfig,
    configPath: join(home, SUPERVISOR_FILES.config),
    statusPath: join(home, SUPERVISOR_FILES.status),
    writePrivate,
  })
  let mainExtras: MainStateExtras | undefined
  const main: MainSupervisor = new MainSupervisor({
    host,
    identity: systemIdentity,
    session: MAIN_TMUX_SESSION,
    // read at every start; settings that cannot be read start nothing (never quietly the defaults)
    config: () => readSupervisorConfig(home, userHome),
    saveSessionId: (id) => saveSessionId(home, id),
    markConversationSeen: (id) => markConversationSeen(home, id),
    // built again at every start: an owner who changes a profile and restarts gets the change
    // Main's bridge uses this supervisor's Talos home (it writes the status.json read here), unless the settings name another
    // the tray's sign-in, read at every start (oauth-token.ts): never logged
    loginEnv: () => fsw.withToken({ ...(loginShellEnv() ?? processEnv()), TALOS_APP_HOME: home }),
    resolveClaude: (p, e) => resolveOnPath(p, e),
    isDir: (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    newSessionId: () => randomUUID(),
    now: () => performance.now() / 1000,
    wallMs: () => Date.now(),
    random: () => Math.random() * 2 - 1,
    publish: (s, x) => {
      mainExtras = x // what the restart actor reads Main waiting at (main-request.ts)
      fsw.publish(s, x)
    },
    firstStart: fsw.firstStart,
    notesShown: fsw.notesShown,
    audit,
    tell: (e) => tellOwner(e),
    takeover: async (ours, mainEnv) =>
      checkTakeover({
        // the thread sessions this supervisor runs are ours too: never "another session holding the channel"
        ourPgids: new Set([...ours, ...workers.ownedPgids()]),
        botPid: readBotPid(
          join(mainEnv.TELEGRAM_STATE_DIR || join(userHome, '.claude', 'channels', 'telegram'), 'bot.pid'),
        ),
        bridgePid: readBridgePid(join(mainEnv.TALOS_APP_HOME || home, 'bridge.pid')),
        agents: await listAgents(mainEnv),
        proc: (pid) => procOf(pid),
      }),
    listAgents: (mainEnv) => listAgents(mainEnv),
    // Main's own config folder (its CLAUDE_CONFIG_DIR), never the supervisor's
    sessionSaved: (dir, id, mainEnv) => sessionSaved(dir, id, mainClaudeDir(mainEnv, userHome)),
    conversationEmpty: (dir, id, mainEnv) => conversationEmpty(dir, id, mainClaudeDir(mainEnv, userHome)),
    readBridgeStatus: (talosHome) => readStatusFile(join(talosHome || home, 'status.json')),
    // Claude Code in Main writes its log under Main's XDG_CACHE_HOME (from the login shell), not the supervisor's
    mcpLogReason: (dir, mainEnv) => mcpLogReason(dir, mainEnv.XDG_CACHE_HOME || join(userHome, '.cache')),
  })
  // Thread sessions (P3d2): the manager runs, publishes workers.json (workers_supported: false until P3d3; true only under the sandbox seam) and adopts what a
  // supervisor before it left running; with no dedicated thread it starts nothing.
  const tokenRestart = fsw.tokenRestart(main, host, stoppedFlag)
  const loginEnv = new LoginEnvCache(
    () => loginShellEnvAsync(process.env.SHELL || '/bin/bash', processEnv()),
    () => performance.now() / 1000,
  )
  const launchCfg = () => {
    const c = readSupervisorConfig(home, userHome)
    return 'error' in c ? null : c
  }
  const pairedDevices = new DeviceStore(join(home, 'devices.json'))
  // Main's restart on request (agent-request.json) and its answer file (main-restart-check.json): only while this one holds the lock
  const restartActor = restartActorWiring({
    home,
    userHome,
    audit,
    main,
    host,
    stoppedFlag,
    configPath: join(home, SUPERVISOR_FILES.config),
    readConfig: readSupervisorConfig,
    resolveClaude: resolveOnPath,
    env: processEnv,
    extras: () => mainExtras,
    pinnedKey: (id) => pairedDevices.pinnedKey(id),
  })
  // the owner's switch for thread sessions (supervisor.json `workers`): off, every thread goes to Main and none is started
  const workersEnabled = () => launchCfg()?.workers !== false
  setWorkersOn(workersEnabled)
  if (!workersEnabled()) audit('workers_off', { why: 'supervisor.json workers: false' })
  // the hook's fences at each start: every configured thread's folder (the last read kept while config.json cannot be read)
  const fencedFolders = threadFolderReader(home)
  const configReaders = workerConfigReaders(home, userHome, launchCfg, audit, () => {
    const started = main.launchEnv()
    if (started) return started.known ? started.env : MAIN_ENV_UNKNOWN
    const e = loginEnv.current()
    return e ? buildLaunchEnv(e, launchCfg()?.env ?? {}) : {}
  })
  let signIn: SignInDriver | null = null // the supervisor's own sign-in (signin.ts)
  const workers: WorkerManager = new WorkerManager({
    home,
    signInLink: () => signIn?.link() ?? null,
    mainSignedIn: () => main.status().phase === 'running' && !main.signedOut(),
    agentDir: () => launchCfg()?.agentDir ?? null,
    hostFor: (id) =>
      new TmuxPtyHost({
        tmux,
        configPath: conf,
        session: `t-${id}`,
        ...(socket ? { socket } : {}),
        identity: systemIdentity,
        launchDir: join(home, SUPERVISOR_FILES.launchDir),
      }),
    ...configReaders,
    // restart-on-update (update-restart.ts): the governor a live bridge reports, and the release this runs
    updateGovernor: () => updateGovernorOf(home),
    releaseId: releaseIdNow,
    plan: supervisorPlan({
      home,
      userHome,
      launchCfg,
      fencedFolders,
      mainEnv: () => {
        const started = main.launchEnv()
        return started === null ? null : started.known ? started.env : MAIN_ENV_UNKNOWN
      },
      claudeDirOf: mainClaudeDir,
      resolveOnPath,
      audit,
    }),
    // a thread session's environment as the Mac builds it: the login shell's, with the settings' `env` on top
    loginEnv: {
      refreshIfDue: () => loginEnv.refreshIfDue(),
      current: () => {
        const e = loginEnv.current()
        return e ? fsw.withToken(buildLaunchEnv(e, launchCfg()?.env ?? {})) : null
      },
    },
    sessionSaved: (cwd, id, env) => sessionSaved(cwd, id, mainClaudeDir(env, userHome)),
    newSessionId: () => randomUUID(),
    now: () => performance.now() / 1000,
    wallMs: () => Date.now(),
    audit,
    mainPanePid: () => main.status().panePid ?? 0,
    supervisorPid: process.pid,
    // a worker's notice is a system row signed in this process, never `talos-app post` (an agent can run that)
    post: (thread, text) => postOutcome(() => postSystemRow({ ...processEnv(), TALOS_APP_HOME: home }, thread, text)),
    where: (id) => ({
      attach: `talos-app supervise attach ${id}`,
      restart: `talos-app supervise restart-thread ${id}`,
      machine: machineName(),
      ...(ownerHost() === 'windows' ? { windows: true } : {}),
    }),
    // a tap's proof is checked against the bridge's own paired devices (read fresh when the file changes)
    pinnedKey: (id) => pairedDevices.pinnedKey(id),
  })
  signIn = signInDriverFor({
    env: () => fsw.withToken({ ...(loginShellEnv() ?? processEnv()), TALOS_APP_HOME: home }),
    claude: (env) => resolveOnPath(launchCfg()?.claudePath ?? 'auto', env),
    main,
    stoppedFlag,
    threads: configReaders.threads,
    workers,
    audit,
  })
  let workersTicking = false
  audit('supervisor_start', { pid: String(process.pid) })
  const control = join(home, SUPERVISOR_FILES.control)
  rmSync(control, { force: true }) // a request no supervisor was there to take is not this one's
  // the owner's stop holds across supervisor restarts and reboots, until their start
  // the lock is read back once more right before Main is touched (a takeover race settles here, not a tick later)
  if (!holdsLock(home)) {
    audit('lock_lost')
    io.err('talos-app supervise: another supervisor took over')
    return ANOTHER_RUNS_EXIT
  }
  await main.attachOrStart(first.startOnLaunch && !existsSync(stoppedFlag))
  let stopping = false
  let done: () => void = () => {}
  const finished = new Promise<void>((r) => {
    done = r
  })
  const quit = async (why: string) => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    signIn?.cancel()
    main.halt() // a tick already queued does nothing once the lock goes
    // the supervisor quits, Main does not: the next supervisor adopts it. What is already queued finishes first (bounded);
    // no new pass is added (a supervisor that lost the lock must not touch Main again)
    await Promise.race([main.idle().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))])
    main.detach()
    // thread sessions run on too: the next supervisor adopts them from workers.json
    await Promise.race([workers.detach().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))])
    audit('supervisor_exit', { why })
    releaseLock(home)
    done()
  }
  const timer = setInterval(async () => {
    if (stopping) return
    try {
      if (!holdsLock(home)) {
        // another supervisor took the lock: two must never restart or signal one Main
        audit('lock_lost')
        await quit('lock lost')
        return
      }
      const ask = claimControl(control, audit)
      if (ask === 'stop') {
        writePrivate(stoppedFlag, `${new Date().toISOString()}\n`)
        await main.stop()
      } else if (ask === 'start' || ask === 'start-anyway') {
        rmSync(stoppedFlag, { force: true })
        await main.start({ anyway: ask === 'start-anyway' })
      }
      await tokenRestart.tick()
      await signIn?.tick()
      await restartActor.tick()
      await main.tick()
      // on its own queue, one pass at a time: a slow worker read never holds up Main's heartbeat
      if (!workersTicking) {
        workersTicking = true
        void workers
          .tick()
          .catch((e: unknown) => audit('workers_tick_failed', { error: String((e as Error)?.message ?? e) }))
          .finally(() => {
            workersTicking = false
          })
      }
    } catch (e) {
      // nothing in one pass may end supervision: it is logged, and the next pass runs
      audit('tick_failed', { error: String((e as Error)?.message ?? e) })
    }
  }, 1_000)
  process.once('SIGTERM', () => void quit('SIGTERM'))
  process.once('SIGINT', () => void quit('SIGINT'))
  await finished
  return 0
}

/** Takes the owner's request by renaming it first: a request written while this one is read is not lost. */
/** How long `talos-app supervise start|stop` waits for the running supervisor to take its request (it looks every second). */
const CONTROL_TAKE_WAIT_MS = 5_000
/** The last rename error said for the control file: said once until it changes or a take works. */
let lastControlError: string | null = null
const auditOnce = (audit: ((e: string, f?: Record<string, string>) => void) | undefined, code: string) => {
  if (lastControlError === code) return
  lastControlError = code
  audit?.('control_unreadable', { error: code })
}

/** The words `talos-app supervise start|stop` writes, each with one newline, and nothing else is ever acted on. */
export const CONTROL_WORDS = ['start', 'start-anyway', 'stop'] as const
const CONTROL_MAX_BYTES = 64

/**
 * Takes the owner's ask from the control file: renamed aside (so it is acted on once), then read with one open that refuses a
 * link (O_NOFOLLOW), only a regular file of at most CONTROL_MAX_BYTES, and only exactly one of CONTROL_WORDS with its newline;
 * anything else is removed unread and audited, never acted on. The guard keeps sessions from writing it (guards/rules.ts);
 * same-uid code outside the guards is not stopped by this (a root-owned boundary is the P3c2 note's).
 */
export function claimControl(path: string, audit?: (e: string, f?: Record<string, string>) => void): string | null {
  // a name nobody can guess and put a folder at beforehand (one that would fail every rename, silently)
  const mine = `${path}.${randomBytes(8).toString('hex')}`
  try {
    renameSync(path, mine)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error'
    if (code !== 'ENOENT') auditOnce(audit, code)
    return null
  }
  lastControlError = null
  try {
    const f = readSmallFile(mine, CONTROL_MAX_BYTES)
    const word = f.kind === 'data' ? /^([a-z-]+)\n?$/.exec(f.text)?.[1] : undefined
    if (word !== undefined && (CONTROL_WORDS as readonly string[]).includes(word)) return word
    audit?.('control_refused', { why: f.kind === 'data' ? 'not one of the control words' : 'not a small regular file' })
    return null
  } finally {
    rmSync(mine, { recursive: true, force: true })
  }
}
