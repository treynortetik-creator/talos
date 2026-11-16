// The owner's view of one thread session: `supervise threads --json` (the threads with a session of their own, for the Windows
// tray's "Open a thread's session") and `supervise attach` (the tmux command onto one, or a window of its own with --window).
// Moved out of cli.ts, which stays under the size budget (scripts/size-budget.json).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadId, TMUX_SOCKET } from '@talos-app/protocol'
import type { CliIO } from '../cli-main.ts'
import { readSupervisorConfig, resolveOnPath, SUPERVISOR_FILES, testSocket } from './cli.ts'
import { processEnv } from './launch-env.ts'
import { viewCommand } from './notices.ts'
import { cleanTitle } from './worker-notices.ts'
import { dedicatedThreads } from './workers-wiring.ts'

/** The threads with a session of their own, from config.json as the supervisor reads it; null when it cannot be read. */
function ownSessionThreads(home: string, userHome: string): ReturnType<typeof dedicatedThreads> {
  const cfg = readSupervisorConfig(home, userHome)
  if ('error' in cfg) return null
  try {
    return dedicatedThreads(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), cfg.agentDir)
  } catch {
    return null
  }
}

/** The tmux socket the owner's commands use (the list and the attach alike, so the two never disagree), by the supervisor's own
 * check: a TALOS_SUPERVISOR_TMUX_SOCKET it would refuse (not a plain name, or `default`) is never used here either. */
const ownerSocket = (): string => testSocket(() => {}) ?? TMUX_SOCKET

/** Whether thread `id`'s tmux session is there now, on this supervisor's socket. */
function threadSessionLive(tmux: string | null, socket: string, id: string): boolean {
  if (!tmux) return false
  return spawnSync(tmux, ['-L', socket, 'has-session', '-t', `=t-${id}`], { stdio: 'ignore' }).status === 0
}

/**
 * `supervise threads --json`: every thread with a session of its own, its name as a line may show it (cleanTitle) and whether
 * its session is running now. The Windows tray's "Open a thread's session" reads it (apps/windows/tray.ps1); ids only ever
 * go back to `supervise attach`.
 */
export function superviseThreads(home: string, userHome: string, args: string[], io: CliIO): number {
  if (args.length !== 1 || args[0] !== '--json') {
    io.err('usage: talos-app supervise threads --json')
    return 2
  }
  const threads = ownSessionThreads(home, userHome)
  if (threads === null) {
    io.err('talos-app: the thread list cannot be read (config.json or the supervisor settings)')
    return 1
  }
  const socket = ownerSocket()
  const tmux = resolveOnPath('tmux', processEnv())
  const list = threads
    .filter((t) => ThreadId.safeParse(t.id).success)
    .map((t) => ({ id: t.id, name: cleanTitle(t.name) ?? t.id, running: threadSessionLive(tmux, socket, t.id) }))
  io.out(JSON.stringify({ threads: list }))
  return 0
}

/** What `supervise attach --window` says first, in the window's title and as its first line. */
export const attachWindowLine = (name: string): string =>
  `Talos — ${name}. To leave, close this window: the thread keeps running.`

/**
 * `supervise attach <thread>`: the owner's way onto a thread session's screen (what the notices name). It runs the tmux command
 * on this supervisor's socket and config; `--print` shows it instead. Main's screen is not a thread: `supervise status` names it.
 * `--window` is for a window of its own (the Windows tray's "Open a thread's session"): the thread's name in the title and the
 * first line, with how to leave (tmux.conf has no prefix, so no detach key: closing the window ends only this viewer), and on
 * any end a line saying why that waits for Enter, so the window never vanishes unread.
 */
export function superviseAttach(home: string, userHome: string, args: string[], io: CliIO): number {
  const print = args.includes('--print')
  const window = args.includes('--window')
  const rest = args.filter((a) => a !== '--print' && a !== '--window')
  const id = rest[0]
  if (!id || !ThreadId.safeParse(id).success || rest.length !== 1 || (print && window)) {
    io.err('usage: talos-app supervise attach <thread> [--print | --window]')
    return 2
  }
  const socket = ownerSocket()
  const conf = join(home, SUPERVISOR_FILES.tmuxConf)
  const view = viewCommand(socket, conf, `t-${id}`)
  if (print) {
    io.out(view)
    return 0
  }
  const tmux = resolveOnPath('tmux', processEnv())
  // the window's own end: its reason, then a wait for Enter, only when someone can type it
  const end = (why: string, code: number): number => {
    io.out(why)
    if (process.stdin.isTTY) {
      io.out('Press Enter to close this window.')
      prompt('')
    }
    return code
  }
  if (window) {
    const thread = ownSessionThreads(home, userHome)?.find((t) => t.id === id)
    if (!thread) return end('This thread has no session of its own, so there is nothing to open.', 1)
    const line = attachWindowLine(cleanTitle(thread.name) ?? id)
    // cleanTitle drops every control character, so the name cannot end the title sequence or start another
    process.stdout.write(`\x1b]0;${line}\x07`)
    io.out(line)
    if (!tmux) return end('Talos cannot open sessions here: tmux is missing.', 1)
    if (!threadSessionLive(tmux, socket, id)) return end("This thread's session is not running now.", 1)
    // tmux takes the whole screen at once: the line stays readable a moment first (the title keeps saying it all along)
    if (process.stdin.isTTY) Bun.sleepSync(2500)
  }
  if (!tmux) {
    io.err('talos-app: tmux is not on PATH')
    return 1
  }
  const r = spawnSync(tmux, ['-L', socket, '-f', conf, '-u', 'attach-session', '-t', `=t-${id}`], { stdio: 'inherit' })
  if (window) return end("This thread's session has ended or was parked.", r.status ?? 1)
  return r.status ?? 1
}
