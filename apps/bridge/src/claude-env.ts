// Keeps another Claude session's identity out of the agent session the owner runs. Claude Code 2.1.317 reads an
// inherited CLAUDE_CODE_CHILD_SESSION as "I am a child session" and stops saving the transcript (seen 2026-11-03: nine
// hours of the owner's main session were not saved). The Mac app does the same in ClaudeEnvScrub (apps/desktop); keep
// the two lists in step (a test on each side reads the other file and fails on any difference).
//
// Deny by pattern, keep by name: every CLAUDE_CODE_* variable goes unless it is a setting an owner puts in a shell
// profile on purpose, so a marker a later Claude Code adds goes too.
import { spawn, spawnSync } from 'node:child_process'

type Env = Record<string, string | undefined>

export const ALWAYS_DROP = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'TMUX', 'TMUX_PANE'])
export const KEEP = new Set([
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
])
export const KEEP_PREFIXES = ['CLAUDE_CODE_MAX_']
/** What identifies one running session: dropped even when the pattern would keep it. */
export const SESSION_MARKERS = new Set([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
])

export function isInheritedClaudeVar(name: string): boolean {
  if (ALWAYS_DROP.has(name) || SESSION_MARKERS.has(name)) return true
  if (!name.startsWith('CLAUDE_CODE_')) return false
  return !KEEP.has(name) && !KEEP_PREFIXES.some((p) => name.startsWith(p))
}

/** A copy of `env` without the inherited markers. */
export function stripClaudeMarkers(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isInheritedClaudeVar(k)) out[k] = v
  return out
}

/** The environment a launched claude gets: the scrubbed parent environment, then the variables the app sets on purpose. */
export function launchEnv(parent: Env, extra: Record<string, string>): Record<string, string> {
  return { ...stripClaudeMarkers(parent), ...extra }
}

/** How to look at other processes; replaceable so a test can fake an unreadable tree. */
export interface ProcReader {
  /** Parent pid of `pid`, undefined when it is gone or unreadable. */
  parentOf(pid: number): number | undefined
  /** The command line plus environment text of `pid` (`ps eww`), '' when unreadable. */
  envText(pid: number): string
  /** Can this OS show another process's environment at all? Absent means yes (a test double that reads a fake tree). */
  canReadEnv?(): boolean
}

function ps(args: string[]): string {
  try {
    return spawnSync('ps', args, { encoding: 'utf8', timeout: 1500 }).stdout ?? ''
  } catch {
    return ''
  }
}

/** Start a short child with a known variable and see whether `ps eww` shows it. Some hosts (a launchd service on CI) never do. */
export function psShowsChildEnv(): boolean {
  const child = spawn('sleep', ['5'], { env: { ...process.env, TALOS_PROBE: '1' }, stdio: 'ignore' })
  try {
    if (!child.pid) return false
    return /(^|\s)TALOS_PROBE=1(\s|$)/.test(ps(['eww', '-p', String(child.pid), '-o', 'command=']))
  } catch {
    return false
  } finally {
    child.kill()
  }
}

let probed: boolean | undefined
const psReader: ProcReader = {
  canReadEnv: () => (probed ??= psShowsChildEnv()),
  parentOf(pid) {
    const n = Number.parseInt(ps(['-o', 'ppid=', '-p', String(pid)]).trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : undefined
  },
  envText: (pid) => ps(['eww', '-p', String(pid), '-o', 'command=']),
}

const MARKER_IN_TEXT = /(^|\s)CLAUDE_CODE_CHILD_SESSION=\S/
/** The command word of `ps eww` output is claude (a path ending in /claude, or bare claude). */
const IS_CLAUDE = /^\s*(\S*\/)?claude(\s|$)/
/** How far up to look: shell, node, claude, terminal, with room to spare. */
const MAX_ANCESTORS = 12
/** All the `ps` calls together; the bridge asks once at start-up and must not stall it. */
const WALK_BUDGET_MS = 6000

/**
 * Does the Claude session this process runs under carry the child-session marker? Claude Code leaves its markers out
 * of the MCP servers it starts, so our own environment and our parent's are clean even when claude itself was launched
 * polluted. The marker is on an ancestor: walk up (starting at CLAUDE_PID when it is set, as that is the claude
 * process) and read each one's environment with `ps eww`. Where the OS will not show process environments (probed with a
 * child of known environment) a clean-looking walk cannot be trusted: that answer is 'unknown', not false.
 */
export function sessionMarkerInherited(
  env: Env = process.env,
  proc: ProcReader = psReader,
  startPid: number = process.pid,
  maxAncestors: number = MAX_ANCESTORS,
): boolean | 'unknown' {
  if (env.CLAUDE_CODE_CHILD_SESSION) return true
  const clean = (): false | 'unknown' => {
    try {
      return proc.canReadEnv?.() === false ? 'unknown' : false
    } catch {
      return 'unknown'
    }
  }
  const deadline = Date.now() + WALK_BUDGET_MS
  try {
    // Only the claude process itself counts: a marker further up (a tmux server or app started from a Claude shell, which
    // a71c66dd scrubs before launching claude) does not stop claude saving its transcript, and a restart can't clear it.
    const claudePid = Number.parseInt(env.CLAUDE_PID ?? '', 10)
    if (Number.isInteger(claudePid) && claudePid > 1) return MARKER_IN_TEXT.test(proc.envText(claudePid)) || clean()
    let pid = proc.parentOf(startPid)
    for (let depth = 0; pid !== undefined && pid > 1 && depth < maxAncestors && Date.now() < deadline; depth++) {
      const text = proc.envText(pid)
      if (MARKER_IN_TEXT.test(text)) return true
      if (IS_CLAUDE.test(text)) return clean() // reached claude, clean: anything above it is not ours to judge
      pid = proc.parentOf(pid)
    }
  } catch {
    return 'unknown'
  }
  return clean()
}
