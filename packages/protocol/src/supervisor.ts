// The supervisor contract: what a supervisor (the program that keeps Main and the thread sessions running, answers the
// development-channel warning and publishes workers.json) must do, written once for every platform. The Mac app's Swift
// supervisor is the reference implementation today; the TypeScript supervisor for Linux (and Windows, through WSL2) implements
// this, and the Mac can move onto the same interfaces later.
//
// Types and constants only, no runtime: this package also runs in the browser. The on-disk and socket formats this contract
// relies on are defined where they already live and are only referenced here:
//   workers.json        WorkersFile / WorkerEntry / WorkerState / WorkerFailure      (thread-sessions.ts)
//   workers/<id>/wake, workers/<id>/control   WakeFile (a pointer; a tap); workers/<id>/ready WorkerReady; WORKER_FILES       (thread-sessions.ts)
//   hub.sock            HubHello (the worker's first line) and the hub's checks      (thread-sessions.ts, bridge hub/server.ts)
//   dialog files        WorkerDialog, DialogAnswer, DialogResult, DialogCardFile     (dialog-files.ts)
// Timings shared with the bridge (heartbeat, staleness, backoff, crash loop) are the constants in thread-sessions.ts; the ones
// below are the supervisor's own.

import type { DialogKindT, WorkerDialogT } from './dialog-files.ts'
import type { WakeFileT, WorkerFailureT, WorkerStateT } from './thread-sessions.ts'

// ---- 1. The terminal host -------------------------------------------------------------------------------------------------

/** The tmux server every Talos session lives on: `tmux -L talos -f <bundled tmux.conf>`. Needs tmux 3.2 or newer. */
export const TMUX_SOCKET = 'talos'
export const TMUX_MIN_VERSION = '3.2'
/** Main's tmux session. Worker sessions are `workerTmuxName(threadId)` (`t-<id>`). Always targeted exactly: `=agent`. */
export const MAIN_TMUX_SESSION = 'agent'
/** A new session's size; attached clients resize it, and there is no resize call. */
export const PTY_COLS = 120
export const PTY_ROWS = 40
/** How often a host asks whether its pane is alive. Three unknown answers in a row with an empty process group = host lost. */
export const PTY_POLL_MS = 1_000
export const PTY_UNKNOWN_LIMIT = 3
/** Rows of scrollback read after an exit, to find why it ended (a resume error, a crash). */
export const PTY_EXIT_ROWS = 200

export type PtyHostKind = 'tmux' | 'direct'

/**
 * What to run. `env` is the WHOLE environment: the host passes nothing of its own (it removes TMUX, TMUX_PANE, TMUX_TMPDIR).
 *
 * The launch rule, for Main and workers alike: no environment value ever appears in an argv (tmux's, `env`'s or any other:
 * `ps` shows argv to every user), and the tmux server's environment never reaches the agent. So nothing is passed with
 * `-e K=V`, `set-environment -g` is never used, and there is no `sh -c` of a command line. The host writes a launch file
 * (0600, created O_EXCL in a 0700 folder of ours) that removes itself, `export`s each variable (a shell builtin), and `exec`s
 * the argv, every word single-quoted; tmux runs `/usr/bin/env -i /bin/sh <file>`, so the pane starts from an empty environment
 * and its pid is the agent's after the execs. A program name never starts with `-`.
 */
export interface PtyLaunch {
  session: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  /**
   * Run by the host as its last step before the process is started (after the launch file is written): a plain line refuses the
   * start (`start_failed`, nothing runs), null lets it go. Set only for a launch with the OS sandbox on (the re-check of its preflight).
   */
  beforeStart?: () => string | null
}

/**
 * `unknown` = the send timed out; callers treat it as sent (a key may have landed) and never press twice for it. `refused` = the
 * host's key guard sent nothing, because of what the pane shows (a menu Talos cannot name, an unreadable pane): like `failed`, no
 * key went, and a caller that owes the owner a message says why.
 */
export type PtySendResult = 'sent' | 'failed' | 'unknown' | 'refused'
/** No key went (failed or refused). `unknown` is not here: it may have landed. */
export const keyNotSent = (r: PtySendResult): boolean => r === 'failed' || r === 'refused'
/** The keys a dialog answer may press. Nothing else is ever sent to a dialog. */
export type PtyDialogKey = 'Up' | 'Down' | 'Enter'
/** The screen a dialog key is meant for: the host's key guard checks the live screen is exactly that one (no kind, no key). */
export type DialogKeyKind = 'theme' | 'security_notes' | 'trust' | 'mcp_consent' | 'dev_channels' | 'bypass'

export interface PtyExit {
  pid: number
  code: number | null
  signal: number | null
  /** The session or the whole server vanished (killed by hand, the server crashed): not the agent's own exit. */
  hostLost: boolean
  /** The last rows on screen, for the exit reason. */
  lastRows: string[]
}

/**
 * One session's terminal. The tmux host maps each call onto tmux (see the Swift TmuxCommands for the exact commands: start is
 * `new-session -d -P -F '#{pane_id}' -s <s> -x 120 -y 40 -c <cwd> -- /usr/bin/env -i /bin/sh <launch file>` (PtyLaunch), restart is `respawn-pane -k` plus
 * `clear-history`, rows are `capture-pane -p -J`, keys are `send-keys -H <hex>` after leaving copy mode). The direct host (no
 * tmux) owns a pty itself; its session dies with the supervisor.
 * The direct host differs on purpose: dialog keys are application cursor keys (`ESC O A`, `ESC O B`, CR), it has no clients
 * (clientActivities is []), markers live in memory, `restart` starts the new child without killing first (the caller has
 * already ended the old group), `detach` kills the agent (nothing outlives the supervisor), and a death by signal reports
 * `signal: 0` (the pty library does not pass the signal on).
 */
export interface PtyHost {
  readonly kind: PtyHostKind
  /** Starts the session; refuses when one of that name already runs. Resolves to the pane's process (group leader) pid. */
  start(launch: PtyLaunch): Promise<number>
  /** Adopts a session that outlived the previous supervisor. Null when there is none. */
  attachIfRunning(session: string): Promise<number | null>
  /** Raw bytes, typed as the owner would. */
  send(keys: Uint8Array): Promise<PtySendResult>
  sendDialogKey(key: PtyDialogKey, kind?: DialogKeyKind): Promise<PtySendResult>
  /**
   * tmux only: text typed literally (`send-keys -l`), then Enter as its own key. The worker pointer uses it; a direct host has
   * no workers and leaves it out.
   */
  sendLine?(text: string): Promise<PtySendResult>
  /**
   * The visible screen, bottom-anchored, one string per row; `scrollback` adds that many rows above it. Null when the screen
   * could not be read (a failed or timed-out capture): that says nothing about the screen and is never an empty one.
   */
  visibleRows(opts?: { scrollback?: number }): Promise<string[] | null>
  lastOutputAt(): Promise<number | null>
  /**
   * When each attached viewer last typed (ms epoch). Empty = nobody attached. Null = the clients could not be read, which the
   * typing guards treat as someone typing. A direct host has no clients and answers [].
   */
  clientActivities(): Promise<number[] | null>
  /** Kills what runs in the pane and starts `argv` again in the same session, with a cleared history. */
  restart(launch: PtyLaunch): Promise<number>
  /** SIGTERM to the pane's process group, `graceMs`, then SIGKILL. Only a group this host started (pgid plus start time). */
  terminate(graceMs: number): Promise<void>
  /** Ends the session (`kill-session`). */
  close(): Promise<void>
  /** Stops watching; the session keeps running (the supervisor quits, the agent does not). */
  detach(): void
  childPid(): number | null
  onExit(cb: (exit: PtyExit) => void): void
  /** A named value stored with the session (tmux user option `@talos_<name>`), so a later supervisor can read it. */
  setMarker(name: 'launch' | 'session' | 'pane', value: string): Promise<void>
  marker(name: 'launch' | 'session' | 'pane'): Promise<string | null>
}

/**
 * The command an owner types to watch a session: `tmux -L talos -f <conf> -u attach-session -t =<session>`. On WSL a Windows
 * terminal runs it through `wslViewerArgv`.
 */
export const viewerArgv = (conf: string, session: string) => [
  'tmux',
  '-L',
  TMUX_SOCKET,
  '-f',
  conf,
  '-u',
  'attach-session',
  '-t',
  `=${session}`,
]

/** The same viewer started from Windows: `wsl.exe -d <distro> -- tmux ...`. */
export const wslViewerArgv = (distro: string, conf: string, session: string) => [
  'wsl.exe',
  '-d',
  distro,
  '--',
  ...viewerArgv(conf, session),
]

// ---- 2. Main ----------------------------------------------------------------------------------------------------------------

export type MainPhase =
  | 'idle'
  | 'blocked' // a takeover check found another Main (bot.pid, bridge.pid, `claude agents`)
  | 'starting' // launched; the development-channel warning (if any) is not answered yet
  | 'running' // see MAIN_START: the input box is up and the warning is gone
  | 'cleaning_up' // after an exit: the old group is ended before a restart
  | 'waiting_to_restart'
  | 'stopping'
  | 'stopped'

export type MainStopReason =
  | 'user'
  | 'crash_loop'
  | 'resume_missing' // `No session found with ID` on screen
  | 'no_notice' // the ONE start stop: the warning still on screen AUTO_CONFIRM.gone_within_ms after our Enter
  | 'crashed_no_auto_restart'
  | 'start_failed'
  | 'clean_exit_loop' // more than MAIN_RESTART.clean_exits_per_hour exits with code 0 in an hour

/** Main needs the owner, but nothing is stopped. Each raises one card (and a notice); answering it clears it. */
export type MainNeedsYou =
  | { kind: 'dialog'; dialog: DialogKindT | 'unknown' } // a dialog the supervisor never answers, or the warning outside the guard
  | { kind: 'confirm_cold_start' } // the guard refused to auto-confirm a cold start: the owner presses Enter
  | { kind: 'restart_not_confirmed'; refusal: string } // the guard refused on a restart; refusal = the failed AutoConfirmInputs field
  | { kind: 'stuck' } // alive, but missing from `claude agents --json` for MAIN_RESTART.hang_polls polls
  | { kind: 'start_stalled' } // MAIN_START.stall_s after the spawn: neither the warning nor the input box
  | { kind: 'bridge_not_live'; reason: string | null } // see MAIN_START; reason = the last line of Claude Code's MCP log for talos-app
  // Claude Code's usage-limit screen, never answered (one option spends usage credits): the model and the reset in Talos's own words
  | { kind: 'usage_limit'; model: string | null; limit: string; resets: string | null; resets_at?: string }

/**
 * When a start has worked. There is NO registration-notice matcher: Claude Code 2.1.322 prints no "Channels (experimental)
 * messages from ..." notice on a resumed start, even with its MCP server connected, so a missing notice is never a failure.
 *   - Answered: our Enter was sent and, within AUTO_CONFIRM.gone_within_ms, the live warning (DEV_CHANNEL_SCREEN) left the
 *     screen and Claude's input box is up. Still there after that = stop `no_notice`, the only stop a start can end in.
 *   - No warning at all: the input box is up and AUTO_CONFIRM.gone_within_ms has passed since the spawn.
 *   - Then Main's bridge must write a live status.json, from a pid in Main's process group and stamped after this spawn, within
 *     MAIN_RESTART.bridge_alive_s of the answer (of the spawn when no warning was expected), stamped under
 *     MAIN_RESTART.bridge_status_max_age_s ago. If not: needs_you `bridge_not_live`, never a stop or a restart.
 * The input box: the last frame rule (a row of at least 10 non-blank characters, 80% box-drawing), a `❯` row, another rule, and
 * no selection cursor below the last rule. A dialog is a rule, its text, one `❯` cursor and `Enter to confirm · Esc to cancel`.
 */
/**
 * Main's status.json (`$TALOS_APP_HOME/status.json`, written by the live bridge, apps/bridge/src/status-file.ts) carries, besides
 * its liveness and `relay.connected`, `unseen_oldest_at`: the ISO time this session was first told about an owner message with no
 * tool call from it since (any tool counts), or null for none. Messages the router handed to a thread's own session are left out
 * until it falls back to Main. Read it only from a live file (mode `live`, fresh, Main's pid). A message that needs no answer
 * can leave it set, so a reader also wants the pane quiet since that time. A file without the field (an older bridge) says
 * nothing: no supervisor raises anything from it.
 */
export const MAIN_START = {
  stall_s: 120,
  frameRuleMinChars: 10,
  frameRuleBoxShare: 0.8,
} as const

export interface MainStatus {
  phase: MainPhase
  stopReason?: MainStopReason
  panePid: number | null
  sessionId: string | null
  restarts: string[] // ISO times, newest last, at most WORKER_CRASH_LOOP.count * 2
  dialog?: WorkerDialogT
  needsYou?: MainNeedsYou
  /** Seen live in this start (MAIN_START). */
  bridgeLive: boolean
  /** Phase blocked: who holds what (the takeover check). */
  blockers?: Array<{ resource: 'telegram' | 'bridge' | 'channels'; sessionPid: number; folder: string | null }>
}

/** Main's restart rules (the worker's are WORKER_BACKOFF_S and WORKER_CRASH_LOOP in thread-sessions.ts). */
export const MAIN_RESTART = {
  backoff_s: [2, 5, 15, 30, 60],
  jitter: 0.2,
  /**
   * An exit with code 0 (no signal, the host not lost) is not a crash: claude also exits 0 after a self-update, and Main is
   * always on, so it restarts at the first backoff step. It never counts toward the crash loop and never triggers
   * restore-last-good. Its own cap: more than this many in an hour stops Main (`clean_exit_loop`), one phone line, nothing
   * restored. An owner who wants Main off uses the menu or CLI stop, not /exit. With autoRestart off, no exit restarts Main, a
   * clean one included.
   */
  clean_exits_per_hour: 10,
  /**
   * The resume error ("No conversation found…", "No session found…") counts only on an exit this soon after the spawn; later
   * the same words on screen are a conversation quoting them. Seen on Hestia: the exit came 8.9 s after the spawn on a
   * loaded two-core machine, so 10 s is too tight. One number for every platform.
   */
  resume_error_within_s: 30,
  /**
   * A restart after an exit that cannot launch at all (no settings, no claude, no agent folder) backs off like a crash but
   * never counts toward the crash loop (nothing crashed). After this many tries it gives up: stop `start_failed`, one phone
   * line (restart_gave_up), nothing restored.
   */
  cannot_launch_tries: 5,
  /** A run this long resets the backoff. */
  healthy_after_s: 10 * 60,
  crash_loop: { count: 5, window_s: 15 * 60 },
  /** Auto-confirmed warnings on RESTARTS after a crash, per hour. Past it the next restart still happens and its warning waits
   * for the owner (the guard refuses: needs_you `restart_not_confirmed`). It is not a crash loop: only crash_loop.count is. */
  auto_confirms_per_hour: 3,
  /** Auto-confirmed warnings on COLD starts (owner reset, phone restart, launch change), per hour. They do not spend the crash
   * loop's three: three resets in an hour must not make the fourth wait for a human. Ten still stops a runaway self-restart. */
  cold_auto_confirms_per_hour: 10,
  /** After an exit: SIGTERM the old group, then wait this long or until the holders are gone, then SIGKILL. The holders are the
   * processes named in bot.pid and bridge.pid that are in Main's process group, matched by pid AND start time (a reused pid
   * is not a holder). */
  cleanup_grace_s: 10,
  /** An owner stop: SIGTERM, this long, SIGKILL, then the session is closed. */
  stop_grace_s: 5,
  /** Main's bridge must be live (MAIN_START) within this long of the warning's answer, or of the spawn when none was expected. */
  bridge_alive_s: 60,
  /** A status.json older than this is not live. */
  bridge_status_max_age_s: 45,
  /** A start whose screen shows a dialog that does not move this long is reported. */
  dialog_stall_s: 60,
  /** A bridge that was live and has not been connected to the relay this long is needs-you `bridge_not_live` (live = connected). */
  relay_down_s: 180,
  /**
   * An owner message Main was told about and no bridge tool call has followed for this long (the bridge's status.json
   * `unseen_oldest_at`, cleared by any bridge tool call) is needs-you `stuck` only while Main's screen has also printed
   * nothing for `unseen_quiet_s` AND nothing since `unseen_oldest_at`: a session hung on a call is still listed by
   * `claude agents`, and prints nothing. A long task that is still printing is not stuck, nor is a short answer that called
   * no bridge tool ("thanks", then a turn on the screen).
   */
  unseen_s: 300,
  unseen_quiet_s: 120,
  /**
   * An owner message told to Main with no bridge tool call since, while its working line shows no progress (the screen body with
   * the elapsed counter masked, and its transcript file, unchanged) this long: the model request may be stuck. Told to the owner
   * once per message. The Mac's watch (MainWatch.swift) follows it; its unstick setting (on by default) presses Esc once and asks the bridge
   * (main-resend.json, advertised as status.json's `main_resend`) to deliver the message again, once the message has waited this long.
   */
  model_stall_s: 180,
  /**
   * The same wait while the working line's label says "thinking" (a long think can leave the screen unchanged for minutes). The
   * wait runs from the newest user or tool_result record of Main's transcript that no assistant record follows; a Main running a
   * tool or a sub-agent (its newest record is the model's own tool_use) is never counted.
   */
  model_stall_thinking_s: 300,
  /**
   * The same wait when the pane shows NO working line at all but Main's transcript says the model's turn is pending (its newest user or
   * tool_result record, nothing from the model after it; a transcript that cannot be read never counts, that is an idle prompt). A
   * frozen request that drew no spinner (the owner's Mac, 2026-11-19: 186 s of nothing after a tool result). The bridge's own age check
   * for the Mac's resend request (apps/bridge/src/main-resend.ts) stays at `model_stall_s` unless the request says `blank: true`, then it accepts from this wait.
   */
  model_stall_blank_s: 90,
  /** `claude agents --json` this often; Main missing from it `hang_polls` times in a row = stuck. */
  agents_probe_s: 10,
  hang_polls: 2,
} as const

/** What starts Main: read from the supervisor's own config (desktop.json on the Mac). */
export interface MainLaunchConfig {
  agentDir: string
  /** `auto` = the `claude` on the owner's login PATH. */
  claudePath: string
  args: string[]
  env: Record<string, string>
  host: 'auto' | PtyHostKind
  autoRestart: boolean
  autoConfirmRestart: boolean
  startOnLaunch: boolean
  /** The owner's switch for thread sessions (`workers` in supervisor.json): false sends every thread to Main, and this
   * supervisor says it hosts none (workers_supported: false). Absent: on. */
  workers?: boolean
  /** `conversationSeen` (`session.conversation_seen` in the owner's settings file, desktop.json on the Mac and supervisor.json
   * on Linux): this id has had a conversation (its transcript was seen). It is then always resumed: a missing transcript means resume, never a new start. */
  session: { id: string | null; previousIds: string[]; conversationSeen?: boolean }
}

/** Main's environment always carries these; a worker's never does (WORKER_STRIPPED_ENV). */
export const MAIN_ENV = { TALOS_APP_BRIDGE: '1', MCP_PROTOCOL_NEGOTIATION: 'legacy' } as const

// ---- 3. Thread sessions (workers) ---------------------------------------------------------------------------------------------

/** The supervisor's own worker timings. */
export const WORKER_TIMING = {
  /** From start until workers/<id>/ready must exist (the hub writes it after a verified hello). */
  ready_s: 90,
  /** A dialog on screen at start: this long before the worker fails `needs_mac`. */
  start_dialog_s: 15 * 60,
  owner_stop_s: 15 * 60,
  park_grace_s: 5,
  /** Output newer than this marks a worker busy: never parked, never the cap's choice. */
  busy_window_s: 15,
  /** A dialog on a running worker counts only after the pane has been unchanged this long. */
  dialog_settle_s: 5,
  /** A dialog answer waits while an attached client typed this recently (the owner may be answering it at the screen). */
  dialog_client_quiet_s: 30,
  /** A pointer held back by a draft this long gets one line in its thread. */
  draft_notice_after_s: 120,
  /** How long a dialog card the supervisor offered lives: a day (DIALOG_TTL_S); the question leaving the screen closes it sooner.
   * (How long it waits for the card: DIALOG_CARD_WAIT_MS.) */
  card_lifetime_s: 24 * 3600,
  /** At most one notice per thread per kind of dialog in this time; prompts nobody named, this much. */
  notice_debounce_s: 10 * 60,
  prompt_debounce_s: 5,
  /** The longest a park, a stop or a restart waits for the current turn to end when nobody set a shorter limit: then the turn is
   * cut (TERM) and the thread told. Never without a limit (a turn that never ends would hold the session for good). */
  turn_wait_cap_s: 10 * 60,
  /** A notice whose post failed is tried again this much later (three tries, then the supervisor says so). */
  notice_retry_s: 30,
  /** A change to a running session's folder, model, effort or MCP list is acted on (a restart after its turn) once it has stood,
   * unchanged, this long (monotonic): two edits in a row are one restart with the final settings. */
  launch_change_settle_s: 30,
} as const

/**
 * The owed pointer (typing WORKER_POINTER_TEXT into a worker): the screen's lag before an empty box counts as "not typed",
 * the looks after typing for exactly our line before Enter, the late clears of our own line nobody read, and the oldest wake
 * still owed (a wake older than the longest claim the hub waits for is dropped). The guard is POINTER_CLIENT_QUIET_MS, the
 * deadlines CLAIM_DEADLINE_MS (10 min, a live session) and CLAIM_DEADLINE_COLD_MS (3 min, a session being started).
 */
export const WORKER_POINTER = {
  screen_lag_s: 5,
  looks_after_typing: 10,
  look_pause_ms: 30,
  late_clears: 3,
  longest_claim_s: 15 * 60,
} as const

/**
 * Legal moves of the worker state machine, as the Mac's WorkerManager makes them; anything else is a bug. A restart goes THROUGH
 * park (live/busy -> parking -> parked -> starting), never straight from live to starting. A crash or an immediate stop of a
 * live session parks it at once (live/busy -> parked); a crash loop while stopping fails it.
 */
export const WORKER_TRANSITIONS: Readonly<Record<WorkerStateT, readonly WorkerStateT[]>> = {
  off: ['starting'],
  starting: ['live', 'failed', 'stopping', 'parking'],
  live: ['busy', 'parking', 'parked', 'stopping', 'failed'],
  busy: ['live', 'parking', 'parked', 'stopping', 'failed'],
  parking: ['parked', 'failed'],
  parked: ['starting', 'off'],
  stopping: ['off', 'parked', 'parking', 'failed'],
  failed: ['starting', 'off', 'parked'],
}

/** What a supervisor does with one thread session. The wake file (WakeFile.action) asks for these. */
export interface WorkerControl {
  start(threadId: string, opts?: { fresh?: boolean }): Promise<void>
  /** Ends the session but keeps its session id, so the next start resumes it. */
  park(threadId: string, why: 'idle' | 'cap' | 'owner' | 'crash'): Promise<void>
  restart(threadId: string, opts?: { fresh?: boolean }): Promise<void>
  stop(threadId: string): Promise<void>
  /** Types WORKER_POINTER_TEXT when the pointer guard allows it (no viewer typed for POINTER_CLIENT_QUIET_MS). */
  pointer(threadId: string, wake: WakeFileT): Promise<void>
  state(threadId: string): WorkerStateT
  fail(threadId: string, code: WorkerFailureT, detail?: string): void
}

/**
 * What a supervisor says it can do, in workers.json `supervisor`: `workers_supported` (thread sessions at all) and
 * `subthreads_supported` (sub-threads, a thread with a `parent_id`). Missing or not a boolean reads as false; the bridge
 * refuses a new parent_id until `subthreads_supported` is true. The schema field itself lands in WorkersFile with that work.
 */
export interface SupervisorCapabilities {
  workers_supported: boolean
  subthreads_supported: boolean
  /** A dedicated sub-thread may keep its own existing folder outside its parent's. Absent reads as false. */
  subthreads_own_folder: boolean
  /** A dedicated sub-thread may run in its parent's folder (no folder, or the same one). Absent reads as false. */
  subthreads_shared_folder: boolean
  /** A dedicated sub-thread under a parent with no folder may have one of its own, judged against the agent folder. */
  subthreads_folderless_parent: boolean
}
/** Reads one capability the way the bridge must: only a literal `true` counts. */
export const capabilityOn = (supervisor: unknown, name: keyof SupervisorCapabilities): boolean =>
  typeof supervisor === 'object' && supervisor !== null && (supervisor as Record<string, unknown>)[name] === true

// `pointer_owed_until` and `enter_owed` (the pointer guard's debt) are each supervisor's own state: nothing outside a supervisor
// reads them, so they are not in WorkerEntry (which strips them); each supervisor keeps them in its own copy of workers.json.
// The numbers they run on are shared: WORKER_POINTER.

/**
 * Before each start the supervisor writes, in workers/<id>/: `nonce` (NONCE_BYTES random bytes as lowercase hex, mode 0600,
 * also passed as TALOS_APP_WORKER_NONCE), `settings.json`, and `launch.sh` (0600, deleted
 * once ready; written by the launch rule at PtyLaunch: `export`s, then `exec`, never `env -i K=V` in an argv). `nonce`, `ready`
 * and `launch.sh` go when the session ends. The hub checks the hello's nonce against the file and
 * the hello's pid's process group against `pane_pid`, so the pane must be its own process group leader.
 */
export const NONCE_BYTES = 16

// ---- 4. The development-channel warning -----------------------------------------------------------------------------------------

/**
 * The rule that recognises the warning on Main's screen. All of it must hold, and the bottom block must classify as the
 * development-channels dialog the way the whole-screen classifier does (one `❯` cursor; a numbered cursor row counts).
 */
export const DEV_CHANNEL_SCREEN = {
  title: 'WARNING: Loading development channels',
  channelsPrefix: 'Channels:',
  /** The last non-blank row starts with the first or contains the second: the dialog is live, not scrollback. */
  liveFooters: ['Enter to confirm', 'Esc to cancel'],
  /** The title must sit within this many rows from the bottom, with exactly one cursor row in that block. */
  titleWithinRows: 24,
  cursor: '❯',
  /** The only row Enter may confirm. */
  confirmRow: 'I am using this for local development',
  /** The only channel the supervisor ever answers for; shown and launched channels must both be exactly this. */
  channel: 'server:talos-app',
} as const

/** What the warning on screen says. Null where it could not be read: no single `Channels:` line, no single highlighted row. */
export interface DevChannelScreen {
  channels: string[] | null
  highlighted: string | null
  titleCount: number
  channelsRowCount: number
}

/**
 * Everything the auto-confirm decision reads. Enter (0x0d, once per start) only when every field allows it: the decision is
 * made twice, THEN the screen is read again and must still be the same warning, then Enter is sent. `rateLimitOk` uses the cap of the start's kind: MAIN_RESTART.auto_confirms_per_hour for a
 * restart after a crash, MAIN_RESTART.cold_auto_confirms_per_hour for a cold start; the two never share a count.
 */
export interface AutoConfirmInputs {
  enabled: boolean // MainLaunchConfig.autoConfirmRestart
  isMain: boolean
  enterSentThisStart: boolean
  /** Null when the screen is not the warning at all. */
  screen: DevChannelScreen | null
  launchChannels: string[]
  sealVerified: boolean
  /** ms on a clock that does not count sleep: macOS CLOCK_UPTIME_RAW, Linux CLOCK_MONOTONIC. */
  sinceSpawnMs: number
  sinceClientKeyMs: number | null
  startKind: 'cold' | 'crash_restart'
  rateLimitOk: boolean
}

export const AUTO_CONFIRM = {
  within_spawn_ms: 60_000,
  client_quiet_ms: 5_000,
  /** The warning still on screen this long after Enter: stop Main (`no_notice`). */
  gone_within_ms: 15_000,
} as const

/**
 * The kinds a supervisor raises as a card or a popup (DialogKind). On the Mac, dev_channels is the one Main kind it may
 * auto-answer. On Linux and WSL (no terminal at all), Main's first start may also answer trust and mcp_consent, and the theme
 * picker, only for the root-approved launch, the install's folder and exactly talos-app (apps/bridge/src/supervisor/first-start.ts).
 * REVIEW (Mac): the Mac shows those to the owner; nothing changes there unless a no-terminal Mac install is wanted.
 */
export const SUPERVISOR_DIALOG_KINDS: readonly DialogKindT[] = [
  'trust',
  'mcp_consent',
  'login',
  'dev_channels',
  'bypass',
]

/**
 * The launch seal: proof that the owner confirmed THIS launch (folder, program, flags, env) on a card or a popup. An Enter typed
 * in the pane never seals. HMAC-SHA256 with a 32-byte key kept by the SecretStore (LAUNCH_SEAL_SECRET), over
 * `[LAUNCH_SEAL_DOMAIN, fingerprint, ...sorted k=v parts].join('\n')`, with no trailing newline. A missing key, a missing MAC or a store that
 * cannot be read all mean "not confirmed".
 */
export const LAUNCH_SEAL_DOMAIN = 'talos-launch-seal/v1'
export const LAUNCH_SEAL_SECRET = { service: 'com.talos.app.launch-seal', account: 'confirmed-launch-v1' } as const

// ---- 5. Secrets ---------------------------------------------------------------------------------------------------------------

/**
 * Where the supervisor and the bridge keep secrets (the launch-seal key; the bridge's MCP OAuth tokens). One interface, three
 * backends: the macOS login Keychain (SecItem in the app; the bridge drives `/usr/bin/security`), the freedesktop Secret Service (`secret-tool`, libsecret: GNOME
 * Keyring, KWallet), and a 0600 file under the Talos config folder when neither exists (a headless WSL box). The file backend is
 * weaker (anything running as the owner can read it) and says so: `strength` is shown by doctor. On WSL the file is the only
 * backend that works headless (no Secret Service there), and only on the Linux disk: a file under /mnt/<drive> has no real
 * mode bits, so the store refuses one (`PlatformFacts.pathIssue`).
 */
export type SecretBackend = 'macos_keychain' | 'secret_service' | 'file_0600'

export type SecretErrorCode = 'unavailable' | 'locked' | 'bad_account' | 'not_ours'

export interface SecretStore {
  readonly backend: SecretBackend
  readonly strength: 'os_keyring' | 'file'
  /** `undefined` for a missing item. Throws a SecretErrorCode when the store cannot be read. Values go over stdin, never argv. */
  get(service: string, account: string): Promise<string | undefined>
  /** Never replaces an item it cannot read (`not_ours`, `locked`): that throws instead. */
  set(service: string, account: string, value: string): Promise<void>
  delete(service: string, account: string): Promise<void>
  /**
   * Is the item there? Asked WITHOUT reading its value (no secret is read into the process), and it never writes, moves or copies.
   * `undefined`: it could not be told (locked, unreachable). Throws only for a store that is unusable as a whole.
   */
  has(service: string, account: string): Promise<boolean | undefined>
}

// ---- 6. Telling the owner ------------------------------------------------------------------------------------------------------

/** The events a supervisor tells the owner about on the machine itself (the phone hears through `talos-app post`). */
/**
 * Each notice's tag (one live notification per tag: a new one replaces it) and whether it is quiet. Quiet means NO SOUND only:
 * the banner always shows (a restart after a crash, a setup put back, must never pass unseen). notify-send: low urgency, no
 * sound hint; never skip the notification.
 */
export const SUPERVISOR_NOTICES = {
  needs_you: { tag: 'sup:needs_you', quiet: false },
  restarted_after_crash: { tag: 'sup:restarted', quiet: true },
  crash_loop: { tag: 'sup:crash_loop', quiet: false },
  resume_failed: { tag: 'sup:resume_failed', quiet: false },
  confirm_failed: { tag: 'sup:confirm_failed', quiet: false },
  start_blocked: { tag: 'sup:blocked', quiet: false },
  could_not_start: { tag: 'sup:start_failed', quiet: false },
  crashed_no_auto_restart: { tag: 'sup:crashed', quiet: false },
  restored: { tag: 'sup:auto_restored', quiet: true },
  restore_failed: { tag: 'sup:restore_failed', quiet: false },
} as const
export type SupervisorNoticeT = keyof typeof SUPERVISOR_NOTICES

/**
 * Desktop notifications: UNUserNotificationCenter on the Mac, notify-send / org.freedesktop.Notifications on Linux, and on WSL
 * a Windows toast through `powershell.exe` (PlatformFacts.windowsInterop), or nothing when interop is off. Rate-limited and silent in the owner's quiet window. A notification
 * is a nudge only: an answer to a dialog never comes from a notification action, only from a verified card or popup click.
 */
export interface Notifier {
  notify(kind: SupervisorNoticeT, title: string, body: string): Promise<void>
}

// ---- 7. The rest of the platform ---------------------------------------------------------------------------------------------

/**
 * Starts the supervisor at login. One part on the Mac (SMAppService) and on Linux (a systemd user unit,
 * `systemctl --user enable`, plus `loginctl enable-linger` so it runs without a desktop session). Two on WSL: that same user
 * unit with linger inside the distro, AND a Windows logon task running `wsl.exe -d <distro> --exec <keepalive>`, without which
 * the VM neither boots at logon nor stays up once idle. `enabled` is true only when every part is.
 */
export type LoginStartPart = 'smappservice' | 'systemd_user' | 'linger' | 'windows_logon_task'
export interface LoginStart {
  readonly parts: readonly LoginStartPart[]
  enabled(): Promise<boolean>
  /** Which parts are on; doctor names a missing one. */
  partsEnabled(): Promise<Partial<Record<LoginStartPart, boolean>>>
  setEnabled(on: boolean): Promise<void>
}

/**
 * Keeps the machine awake while on AC power when the owner asked: an IOPMAssertion on the Mac, `systemd-inhibit` on Linux, and
 * on WSL a Windows-side hold (SetThreadExecutionState through `powershell.exe`): nothing inside the VM can stop Windows sleeping.
 */
export type KeepAwakeBackend = 'iopm' | 'systemd_inhibit' | 'windows_execution_state'
export interface KeepAwake {
  readonly backend: KeepAwakeBackend
  hold(reason: string): Promise<void>
  release(): Promise<void>
}

/**
 * Platform facts an implementation must not hard-code from the Mac: signal numbers (SIGUSR1 is 30 on macOS, 10 on Linux), the
 * awake clock, the login shell (`$SHELL -lic 'env -0'`, not /bin/zsh), and folder comparison (fold case only where the disk is
 * case-insensitive).
 */
export interface PlatformFacts {
  os: 'darwin' | 'linux'
  wsl: boolean
  /** WSL: the distro name (for wsl.exe -d) and powershell.exe's path, or null when Windows interop is off. */
  wslDistro: string | null
  windowsInterop: { powershell: string } | null
  caseInsensitivePaths: boolean
  loginShell: string
  signal(name: 'TERM' | 'KILL' | 'USR1' | 'USR2' | 'HUP'): number
  /**
   * Why a folder cannot hold the agent, the Talos config or a secret file, or null. On WSL a path on a Windows drive (its mount
   * is one of WSL_WINDOWS_FS_TYPES, wherever automount.root puts it) is a Windows disk: modes are not enforced (a 0600 file is
   * readable) and names fold case, so it is refused.
   */
  pathIssue(path: string): 'windows_drive' | null
}

/**
 * How a Windows drive shows up in WSL: the filesystem type of its mount in /proc/self/mountinfo, wherever
 * /etc/wsl.conf `automount.root` puts it (default /mnt/<drive>). drvfs is WSL 1; WSL 2 uses 9p (aname=drvfs),
 * or virtiofs on newer builds. On WSL a path whose mount has one of these types is a Windows disk.
 */
export const WSL_WINDOWS_FS_TYPES: readonly string[] = ['drvfs', '9p', 'virtiofs']

/** The default mount root of the Windows drives: a path under it is refused whatever its mount's type says. */
export const WSL_WINDOWS_MOUNTS = /^\/mnt\/[a-z](\/|$)/

/** Everything one supervisor is made of. A platform supplies each piece; the lifecycle code above them is shared. */
export interface SupervisorParts {
  host: (session: string) => PtyHost
  secrets: SecretStore
  notifier: Notifier
  loginStart: LoginStart
  keepAwake: KeepAwake
  platform: PlatformFacts
}
