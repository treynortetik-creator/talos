// The types of the thread-session manager (workers.ts): what it needs of a worker's tmux host, a dedicated thread, a start's
// plan, what the supervisor hands it, and its runtime per thread. Here so the manager's file is its behaviour alone.
import type {
  DialogKeyKind,
  JwkP256T,
  PtyDialogKey,
  PtyExit,
  PtyLaunch,
  PtySendResult,
  WorkerEntryT,
  WorkerFailureT,
} from '@talos-app/protocol'
import type { Proc } from './bg-work.ts'
import type { LoginEnvCache } from './login-env.ts'
import type { OwedState, PointerPane } from './owed-pointer.ts'
import type { TurnWait } from './worker-cap.ts'
import type { OfferState } from './worker-dialogs.ts'
import type { BusyWatch, IdleClock } from './worker-idle.ts'
import type { LaunchDebounce } from './worker-launch.ts'
import type { NoticeRuntime, PostOutcome, Where } from './worker-notices.ts'
import type { CeilingAxis } from './worker-policy.ts'

/** What the manager needs of a worker's tmux host (TmuxPtyHost has all of it). */
export interface WorkerHost extends PointerPane {
  /** The pane's visible rows without colours (null when the capture failed). */
  visibleRows(): Promise<string[] | null>
  /** One key of a dialog answer, by tmux key name. */
  sendDialogKey(key: PtyDialogKey, kind?: DialogKeyKind): Promise<PtySendResult>
  /** Why the host's key guard refused the last key (tmux-host.ts), for the audit. */
  lastKeyRefusal?(): { why: string; row?: string } | null
  /** Status-row parts not yet known, allowed or refused, by shape, each once per supervisor run (key-guard.ts). */
  unknownShapes?(): Array<{ event: string; shape: string }>
  start(launch: PtyLaunch): Promise<number>
  probe(): Promise<{ kind: 'running'; pid: number } | { kind: 'dead' } | { kind: 'gone' } | { kind: 'unknown' }>
  attachIfRunning(session: string): Promise<number | null>
  signal(sig: NodeJS.Signals): boolean
  close(): Promise<void>
  detach(): void
  onExit(cb: (exit: PtyExit) => void): void
  /** The pid this host started or adopted after checking it (null when none): the only pids that count as ours. */
  childPid(): number | null
  /** When the pane last drew anything (wall ms), or null when tmux did not say: output makes a worker busy. */
  lastOutputAt(): Promise<number | null>
}

/** A dedicated thread as config.json has it. */
export type UnreadOpt = 'session_opts' | 'cwd' | 'model' | 'effort'

export type WorkerThread = {
  id: string
  cwd: string
  model: string
  effort: string | null
  parentCwd: string | null
  /** The thread's name in config.json, for its notices (its id when it has none). */
  name?: string | null
  /** Minutes of no activity before the session is parked (session_opts.idle_park_min; DEFAULT_IDLE_PARK_MIN when none). */
  idleParkMin?: number
  /** session_opts.mcp_allow: absent = no list (the session gets what Claude Code gives it); a list, even empty = strict. */
  mcpAllow?: string[]
  /**
   * Session options that are there but cannot be read: 'session_opts' (not an object at all), or the launch fields whose value
   * cannot be read (a hand-edited typo, a newer build's value). Each such field is its default, never a reason to restart.
   */
  optsUnread?: UnreadOpt[]
  /**
   * A sub-thread (a parent_id, P3d5): what its start needs beyond its effective options (worker-subthreads.ts). Its folder is its
   * own (inside its parent's, or an existing one outside), its model, effort and MCP list the effective ones; `parentCwd` is the
   * live parent's folder it is judged against. `shares`: it runs in its parent's folder (`cwd` is that folder, `parentCwd` null,
   * `ownCwd` false): nothing is made, fenced or parked for it, and it is exempt from `folder_claimed` against its family only.
   */
  sub?: {
    parentId: string
    ownCwd: boolean
    shares?: boolean
    refusal: string | null
    unreadable: Record<string, string>
  }
}

/** The launch of one start, built and checked by worker-spec.ts (buildWorkerSpec, validateSpec); or why it may not start. */
export type WorkerPlan =
  | {
      launch: PtyLaunch
      settingsJSON: string
      cwd: string
      /** Servers on the thread's MCP list it starts without: not found anywhere, or never allowed. Told once per launch. */
      mcpLeftOut?: { missing: string[]; refused: string[] }
      /** The folder's own settings files, which the session does not load (--setting-sources=user): told once per launch. */
      settingsIgnored?: string
      /** This launch's spec hash (launch-spec.ts), kept as WorkerLaunched.spec_hash for restart-on-update. */
      specHash?: string
      /** The digest of the instructions handed to a session outside the agent folder (WorkerLaunched.instructions_hash). */
      instructionsHash?: string
      /** A dry plan's only: this spec's hash with a recorded instructions digest in place of its own (the update check's report). */
      specWith?: (instructionsHash: string) => string | undefined
    }
  | {
      refused: {
        code: WorkerFailureT
        detail: string
        axis?: CeilingAxis
        /** Main's own --settings (its path, or that it was inline) could not be read: the thread is told how to fix it. */
        mainSettingsUnreadable?: string
        /** Main runs in a mode a thread session cannot be held to (its name): the thread is told why its session does not start. */
        mainRestricted?: string
        /** The session's permission hook cannot run (why): the thread is told its prompts would never reach the phone. */
        hookMissing?: string
      }
    }

export type WorkerDeps = {
  home: string
  /** Main is running and signed in: a thread failed at the sign-in screen starts again on its next message (stateAfterSignin). */
  mainSignedIn?(): boolean
  /** The sign-in link of the supervisor's own sign-in (signin.ts), for the thread line, while one is waiting on the owner. */
  signInLink?: (() => string | null) | undefined
  hostFor(threadId: string): WorkerHost
  /** The dedicated threads; null when config.json cannot be read (the last good list is kept). */
  threads(): WorkerThread[] | null
  /** dedicated.max_live; null when config.json cannot be read (the last good one is kept). None: DEFAULT_MAX_LIVE. */
  maxLive?(): number | null
  plan(o: {
    thread: WorkerThread
    sessionId: string
    resume: boolean
    nonce: string
    baseEnv: Record<string, string>
    /** The update check's plan: the same launch and spec hash, nothing written (workers-wiring.ts). */
    dry?: boolean
  }): WorkerPlan
  loginEnv: Pick<LoginEnvCache, 'current' | 'refreshIfDue'>
  /** Has Claude Code saved this session's transcript (it had a turn)? In the worker's own config folder. */
  sessionSaved(cwd: string, sessionId: string, env: Record<string, string>): boolean
  newSessionId(): string
  /**
   * Asked before a start takes a slot: a reason it is going to be refused whatever happens (Main's own --settings cannot be
   * read), so a doomed start never parks another session to make room. None: every start goes on to the plan.
   */
  preflight?(
    threadId: string,
    baseEnv: Record<string, string>,
  ): {
    code: WorkerFailureT
    detail: string
    mainSettingsUnreadable?: string
    mainRestricted?: string
    hookMissing?: string
  } | null
  /**
   * Why a running sub-thread's parent folder no longer holds it beyond the fence itself: a parent folder no session may use (the
   * home folder itself, ~/.claude, the Talos home), as a start would refuse. None: only the fence is asked.
   */
  parentFolderProblem?(parentCwd: string): string | null
  /**
   * Why Main now runs in a mode no thread session can be held to (restricted, safe, bare, personal config locked, or an
   * environment that cannot be known), or null: asked each tick, so a session already running is parked after its turn.
   */
  mainNarrowed?(): string | null
  /** The agent folder (Main's own), where several sessions may work at once (OPTION-C 7.2); none: no folder is exempt. */
  agentDir?(): string | null
  /** A thread folder resolved as the planner resolves it, or null when it cannot be (none: realpath; tests pass their own). */
  realFolder?(cwd: string): string | null
  /** Monotonic seconds. */
  now(): number
  wallMs(): number
  audit(event: string, fields?: Record<string, string>): void
  mainPanePid(): number
  supervisorPid: number
  /** config.json dedicated.restart_on_update (on by default); null when config.json cannot be read (update-restart.ts). */
  restartOnUpdate?(): boolean | null
  /** The usage governor from a live bridge's fresh status.json; null when there is none, it is stale, or it does not say. */
  updateGovernor?(): string | null
  /** The owner's default thread (config.json default_thread, else the phone's fallback), for update-restart.ts's one line. */
  defaultThread?(): string | null
  /** The release this supervisor runs (its own commit, and the kit's), whose change starts update-restart.ts's check. */
  releaseId?(): string | null
  /** One system row into a thread (system-post.ts); none: the notices are recorded and not sent. */
  post?(thread: string, text: string): Promise<PostOutcome>
  /** Where the owner answers a worker's pane: its tmux attach command and this computer's name. */
  where?(threadId: string): Where
  /** A paired, not revoked device's key from devices.json (a tap's proof); none: no answer ever proves itself. */
  pinnedKey?(deviceId: string): JwkP256T | undefined
  /** The pauses between the looks of a dialog answer (tests make them instant). */
  sleep?(ms: number): Promise<void>
  /** The process table for the background-work look, and one process's argv (bg-work.ts reads /proc when none is given). */
  procTable?(): Proc[] | null
  procArgv?(pid: number): string[] | null
}

/** One thread session as the manager keeps it (worker-slots.ts reads and moves it too). */
export type WorkerRuntime = {
  id: string
  entry: WorkerEntryT
  host: WorkerHost | null
  /** Monotonic time of the start (the ready timer), of the park (its grace), of the owner's stop. */
  startedAt: number | null
  parkAt: number | null
  killed: boolean
  /** What to do once parked: a restart (fresh: a new session id) goes through park. */
  afterPark: { fresh: boolean } | null
  /** Where the next state goes when the session ends: parked (a park) or off (a stop). */
  endAs: 'parked' | 'off' | null
  baseEnv: Record<string, string> | null
  /** The owed pointer: typed once the session is live, kept across a restart of the supervisor in workers.json. */
  owed: OwedState
  /** Why the pointer waits, as last told (the notice says it once per change). */
  heldFor?: 'draft' | 'no_box' | 'copy_mode' | 'refused' | 'unseen' | 'enter_uncertain' | null
  /** What the pane told the owner (worker-notices.ts). */
  notes: NoticeRuntime
  /** The dialog offered for a card, and the answers taken for it (worker-dialogs.ts). */
  offer: OfferState
  /** The idle clock (worker-idle.ts): the last real activity and the screen body last seen. */
  idle: IdleClock
  /** What busy last read of the pane's output time. */
  busyWatch: BusyWatch
  /** The idle park is held by background work (bg-work.ts): said once per hold. */
  bgHeld?: boolean
  /** The running turn (turn_started_at) has been seen busy: only then does quiet end it (worker-status.ts turnLook). */
  turnSeenBusy?: boolean
  /** When (wall ms) the Enter that began the running turn went in: output in that same second is the line's own echo. */
  turnTypedAtMs?: number
  /** The rows of this tick's look at the pane (null when it could not be read). */
  rows: string[] | null
  /**
   * A start waiting for a slot (worker-cap.ts): since when (monotonic s), how, the worker parked to make room for it, and whether it
   * is held only to type an owed pointer (dropped with the pointer) or for a start someone asked for (the owner, a restart).
   */
  held: { since: number; fresh: boolean; victim: string | null; forPointer: boolean } | null
  /** A park waiting for the current turn to end (`stopping` until the pane is quiet): why, and the owner's stop limit. */
  turnWait: TurnWait | null
  /** A change to what the running session was started with, waiting out its settle time (worker-launch.ts). */
  launchChange: LaunchDebounce
}
