// Option C: an opt-in dedicated Claude Code session per thread (docs/OPTION-C.md). WP-OC0 owns this file: the thread
// switch, the global `dedicated` settings, the supervisor's `workers.json`, the wake file, the local hub socket lines
// and the constants every side has to agree on. Nothing here starts a process; the bridge and the desktop supervisor
// read it. Everything defaults to off: a config without these fields behaves exactly as before.
import { z } from 'zod'
import { WorkerDialog } from './dialog-files.ts'
import { IsoTs, ThreadId } from './ids.ts'

// ---- the per-thread switch (OPTION-C 9.1) -----------------------------------------------------------------------

/** `shared` = the main session answers (option B, the default). `dedicated` = the thread's own worker session. */
export const ThreadSessionMode = z.enum(['shared', 'dedicated'])
export type ThreadSessionModeT = z.infer<typeof ThreadSessionMode>

/** A `--model` value for a worker: `inherit` (same as main) or an alias / model id. Same grammar as ModelValue. */
export const WorkerModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/)
/** An effort level (`low` … `max`). Set in the worker's settings file, never with `/effort` (OPTION-C 6.4). */
export const WorkerEffort = z.string().regex(/^[a-z]{1,16}$/)
/** An absolute path with no control characters. The Mac re-checks it on disk (checkWorkerCwd + realpath). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const NO_CONTROL_ABS = /^\/[^\u0000-\u001f\u007f]*$/
export const AbsolutePath = z.string().max(512).regex(NO_CONTROL_ABS)

export const DEFAULT_IDLE_PARK_MIN = 30

/** Most servers a thread's allow list may name, and the longest name (a `claude.ai <Name>` connector is the long kind). */
export const MCP_ALLOW_MAX = 32
export const MCP_NAME_MAX = 80
/**
 * A server name as Claude Code knows it (`github`, `plugin:x:y`, `claude.ai Gmail`): printable, no spaces at the ends, no
 * commas, and none of the characters that change how text reads or where a line ends (C0 and C1 controls, line and
 * paragraph separators, zero-width marks, bidi marks and overrides).
 */
const MCP_BAD = '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff,'
const MCP_NAME = new RegExp(`^[^\\s${MCP_BAD}](?:[^${MCP_BAD}]*[^\\s${MCP_BAD}])?$`)
/**
 * The MCP servers a thread's own session may use, besides `talos-app` (which it always has). No list at all means today's
 * behaviour: the session gets whatever Claude Code gives it. A list, even an empty one, means ONLY those. Unique names.
 */
export const McpAllowList = z
  .array(z.string().max(MCP_NAME_MAX).regex(MCP_NAME))
  .max(MCP_ALLOW_MAX)
  .refine((l) => new Set(l).size === l.length, { message: 'a server is named twice' })
export type McpAllowListT = z.infer<typeof McpAllowList>
/**
 * As read: a list this build cannot read is the EMPTY list (talos-app only), never "no list". Reading junk as "allow
 * everything" would open a fence a hand edit or a newer build meant to close.
 */
const McpAllowRead = McpAllowList.optional().catch([])

/** What the Mac accepts in a write (`sessionFieldsIssue`). */
export const ThreadSessionOptsStrict = z.object({
  /** Absolute; absent = the agent folder. */
  cwd: AbsolutePath.optional(),
  model: WorkerModel.default('inherit'),
  effort: WorkerEffort.optional(),
  idle_park_min: z.number().int().min(5).max(720).default(DEFAULT_IDLE_PARK_MIN),
  mcp_allow: McpAllowList.optional(),
})

/**
 * What every side reads. Per field: a value this build can't read falls back on its own, so a newer range on one field
 * never costs the others (the folder, the master switch) or fails `config.sync` and `ready`.
 */
export const ThreadSessionOpts = z.object({
  cwd: AbsolutePath.optional().catch(undefined),
  model: WorkerModel.default('inherit').catch('inherit'),
  effort: WorkerEffort.optional().catch(undefined),
  idle_park_min: z.number().int().min(5).max(720).default(DEFAULT_IDLE_PARK_MIN).catch(DEFAULT_IDLE_PARK_MIN),
  mcp_allow: McpAllowRead,
})
export type ThreadSessionOptsT = z.infer<typeof ThreadSessionOpts>

// ---- the global switch -------------------------------------------------------------------------------------------

const GOVERNOR_DEFAULTS = { five_hour: 80, weekly: 85, park_all: 95, off: false }
export const DEFAULT_MAX_LIVE = 3

/** What the Mac accepts in a write (`sessionFieldsIssue`). */
export const DedicatedConfigStrict = z.object({
  enabled: z.boolean().default(false),
  max_live: z.number().int().min(1).max(6).default(DEFAULT_MAX_LIVE),
  governor: z
    .object({
      five_hour: z.number().min(1).max(100).default(GOVERNOR_DEFAULTS.five_hour),
      weekly: z.number().min(1).max(100).default(GOVERNOR_DEFAULTS.weekly),
      park_all: z.number().min(1).max(100).default(GOVERNOR_DEFAULTS.park_all),
      off: z.boolean().default(GOVERNOR_DEFAULTS.off),
    })
    .default(GOVERNOR_DEFAULTS),
})

const percent = (fallback: number) => z.number().min(1).max(100).default(fallback).catch(fallback)

/** The limits as read: each falls back on its own (see DedicatedConfig). */
export const DedicatedGovernor = z.object({
  /** No new starts or resumes at or above this 5-hour usage percent. */
  five_hour: percent(GOVERNOR_DEFAULTS.five_hour),
  /** No new starts or resumes at or above this weekly usage percent. */
  weekly: percent(GOVERNOR_DEFAULTS.weekly),
  /** Park every worker after its current turn at or above this percent on either window. */
  park_all: percent(GOVERNOR_DEFAULTS.park_all),
  /** The owner turned the governor off. */
  off: z.boolean().default(GOVERNOR_DEFAULTS.off).catch(GOVERNOR_DEFAULTS.off),
})

/**
 * As read. Per field, so one value this build can't read (a newer Mac allowing `max_live` 8) never loses the master
 * switch: an app that read that as off would hide the way back to shared. A junk `enabled` is off, never on.
 */
export const DedicatedConfig = z.object({
  /** Master switch. Off: every thread is shared, whatever its own setting says. */
  enabled: z.boolean().default(false).catch(false),
  /** Workers in `live`/`busy`/`starting` at once (C8.2 cap). */
  max_live: z.number().int().min(1).max(6).default(DEFAULT_MAX_LIVE).catch(DEFAULT_MAX_LIVE),
  governor: DedicatedGovernor.default(GOVERNOR_DEFAULTS).catch(GOVERNOR_DEFAULTS),
})
export type DedicatedConfigT = z.infer<typeof DedicatedConfig>

/** The settings in force: a config without `dedicated` is the all-defaults (off) one. */
export function dedicatedSettings(config: { dedicated?: unknown }): DedicatedConfigT {
  const parsed = DedicatedConfig.safeParse(config.dedicated ?? {})
  return parsed.success ? parsed.data : DedicatedConfig.parse({})
}

/** Main's front doors: never dedicated (OPTION-C 9.2), on top of the default thread and any `system` thread. */
export const NEVER_DEDICATED_THREADS = ['general', 'inbox'] as const

type ThreadLike = {
  id: string
  kind: string
  archived?: boolean
  session?: ThreadSessionModeT | undefined
  session_opts?: Partial<ThreadSessionOptsT> | undefined
}
type ConfigLike = { threads: readonly ThreadLike[]; default_thread: string; dedicated?: unknown }

/** May this thread ever have its own session? (The switch is offered only when it may.) */
export function canBeDedicated(config: ConfigLike, threadId: string): boolean {
  const t = config.threads.find((x) => x.id === threadId)
  if (!t || t.kind === 'system' || t.archived) return false
  if (threadId === config.default_thread) return false
  return !(NEVER_DEDICATED_THREADS as readonly string[]).includes(threadId)
}

/**
 * Who answers this thread right now, by config alone: `dedicated` only when the master switch is on, the thread asked
 * for it and it is allowed to. Anything else (unknown thread included) is `shared`. Whether the worker is reachable is
 * the hub's question (OPTION-C 3.2), not this one.
 */
export function threadSessionMode(config: ConfigLike, threadId: string): ThreadSessionModeT {
  if (!dedicatedSettings(config).enabled) return 'shared'
  const t = config.threads.find((x) => x.id === threadId)
  if (t?.session !== 'dedicated') return 'shared'
  return canBeDedicated(config, threadId) ? 'dedicated' : 'shared'
}

/**
 * Patch-time rule, on the exact config the bridge is about to write (`after`) against the one on disk (`before`). Only
 * threads this change touches are judged: a thread newly set to `dedicated`, or one that stays dedicated but became
 * ineligible because of this change (made the default thread, turned into a system thread). A config that already
 * breaks the rule never blocks unrelated edits, and a change that only turns things off (`dedicated.enabled: false`, a
 * thread back to `shared`) can never be refused. Archiving is not refused either: `clearArchivedSessions` turns an
 * archived thread back to shared before this runs.
 */
export function dedicatedPatchIssue(before: ConfigLike, after: ConfigLike): string | null {
  for (const t of after.threads) {
    if (t.session !== 'dedicated' || canBeDedicated(after, t.id)) continue
    const was = before.threads.find((x) => x.id === t.id)
    const touched = was?.session !== 'dedicated' || canBeDedicated(before, t.id)
    if (touched)
      return `thread "${t.id}" can't have its own session: the default thread, general, inbox and archived threads are always shared`
  }
  return null
}

/** Archived threads are always shared: drop `session` from them (their `session_opts` stay for a restore). */
export function clearArchivedSessions<C extends { threads: readonly ThreadLike[] }>(config: C): C {
  if (!config.threads.some((t) => t.archived && t.session !== undefined)) return config
  return {
    ...config,
    threads: config.threads.map((t) => {
      if (!t.archived || t.session === undefined) return t
      const { session: _s, ...rest } = t
      return rest
    }),
  }
}

/**
 * `Thread.session`, `Thread.session_opts` and `AgentConfig.dedicated` are tolerant when READ: a value this build doesn't
 * know falls back on its own, field by field, so a newer config can't make `config.sync` or `ready` unparseable, or a hand edit stop
 * the bridge from loading. The Mac must still refuse junk it would WRITE, so `config.patch` runs this strict check on the
 * merged object first. Returns a reason, or null.
 */
export function sessionFieldsIssue(merged: { threads?: unknown; dedicated?: unknown }): string | null {
  if (merged.dedicated !== undefined && !DedicatedConfigStrict.safeParse(merged.dedicated).success)
    return 'those thread session settings are not valid'
  if (!Array.isArray(merged.threads)) return null
  for (const t of merged.threads as Array<Record<string, unknown>>) {
    if (typeof t !== 'object' || t === null) continue
    if (t.session !== undefined && !ThreadSessionMode.safeParse(t.session).success)
      return `thread "${String(t.id)}": not a session mode`
    if (t.session_opts !== undefined && !ThreadSessionOptsStrict.safeParse(t.session_opts).success)
      return `thread "${String(t.id)}": those session settings are not valid`
  }
  return null
}

/**
 * The lexical half of the Mac's `cwd` check (OPTION-C 9.2): absolute, no `.`/`..` segments, under the user's home and
 * not inside `~/.claude` or `$TALOS_APP_HOME`. The bridge runs it on the raw value AND on its realpath (a symlink into
 * `~/.claude` must fail), and also checks that the folder exists. `claudeDir` is where `~/.claude` really is, when it is
 * a symlink itself (stow, chezmoi): that folder is off limits too. Returns a reason, or null when fine.
 */
export function checkWorkerCwd(
  cwd: string,
  roots: { home: string; talosHome: string; claudeDir?: string | null },
): string | null {
  if (!AbsolutePath.safeParse(cwd).success) return 'the folder must be an absolute path'
  const parts = cwd.split('/').slice(1)
  if (parts.some((p) => p === '.' || p === '..')) return 'the folder path must not contain . or .. segments'
  const norm = `/${parts.filter(Boolean).join('/')}`
  const under = (root: string) => {
    const r = root.replace(/\/+$/, '')
    return norm === r || norm.startsWith(`${r}/`)
  }
  if (!under(roots.home) || norm === roots.home.replace(/\/+$/, '')) return 'the folder must be inside your home folder'
  if (under(`${roots.home.replace(/\/+$/, '')}/.claude`) || (roots.claudeDir && under(roots.claudeDir)))
    return "the folder can't be inside ~/.claude"
  if (under(roots.talosHome)) return "the folder can't be inside the Talos data folder"
  return null
}

// ---- names and constants both sides use ----------------------------------------------------------------------------

/** The worker's tmux session on the supervisor's private socket (`tmux -L talos`). Thread ids are tmux-safe. */
export const workerTmuxName = (threadId: string) => `t-${threadId}`
/** The worker's `--name` (shown in `claude agents`, the target of cross-session `SendMessage` from main). */
export const workerSessionName = (threadId: string) => `talos-${threadId}`

/** The one line the supervisor types into a worker. Fixed text: message content never reaches the keyboard. */
export const WORKER_POINTER_TEXT = 'Talos: new message in this thread. Call read_inbound.'

export const SUPERVISOR_HEARTBEAT_MS = 5_000
/** A heartbeat older than this means the supervisor is gone: every dedicated thread falls back to main at once. */
export const SUPERVISOR_STALE_MS = 15_000
/** No `read_inbound` claim this long after the wake → the hub claims the message for main. */
export const CLAIM_DEADLINE_MS = 90_000
/** The same deadline when the wake had to resume a parked worker. */
export const CLAIM_DEADLINE_COLD_MS = 120_000
/** All workers busy at the cap: hold a new start this long, then fall back to main with `worker_cap`. */
export const CAP_HOLD_MS = 120_000
/** Typing guard: no pointer while an attached tmux client typed within this window. */
export const POINTER_CLIENT_QUIET_MS = 10_000
/** Crash backoff for a live worker, same as main (OPTION-C 2.5). Five crashes in 15 min = `failed: crash_loop`. */
export const WORKER_BACKOFF_S = [2, 5, 15, 30, 60] as const
export const WORKER_CRASH_LOOP = { count: 5, window_s: 15 * 60 } as const

// WORKER_BRIDGE_TOOLS and WORKER_THREAD_LOCKED_TOOLS follow the agent tool table in apps/bridge/src/tools/table.ts.

/** Words a worker's command line must never contain (OPTION-C 4.3). The supervisor's WorkerSpec test checks the same. */
export const WORKER_FORBIDDEN_ARGS = ['--channels', '--dangerously-load-development-channels', '-p', '--print', '--bg']
/** Environment a worker never inherits. Plus every `TELEGRAM_*` (kept as a defence for Macs that still have a Telegram token in their environment) and `IMESSAGE_*` key. */
export const WORKER_STRIPPED_ENV = ['TALOS_APP_BRIDGE', 'MCP_PROTOCOL_NEGOTIATION', 'TELEGRAM_BOT_TOKEN']
export const WORKER_STRIPPED_ENV_PREFIXES = ['TELEGRAM_', 'IMESSAGE_']
/** Set in a worker's environment: the bridge's worker mode and the hooks' role gate key off these. */
export const WORKER_ENV = {
  thread: 'TALOS_APP_WORKER_THREAD',
  role: 'TALOS_SESSION_ROLE',
  roleValue: 'worker',
} as const

// ---- workers.json (supervisor writes, hub reads; OPTION-C 2.2) --------------------------------------------------------

export const WorkerState = z.enum(['off', 'starting', 'live', 'busy', 'parking', 'parked', 'failed', 'stopping'])
export type WorkerStateT = z.infer<typeof WorkerState>
/** States in which the worker holds a slot under `max_live`. */
export const WORKER_LIVE_STATES: readonly WorkerStateT[] = ['starting', 'live', 'busy']

export const WorkerFailure = z.enum([
  'needs_mac', // a dialog at start (workspace trust, login); the owner has to answer it at the Mac
  'resume_missing', // `No session found with ID`; [Start fresh] moves the id to previous_ids
  'crash_loop',
  'start_failed',
  'folder_claimed', // another session works in that folder and no worktree was possible
  'mode_escalation_denied', // the spec would be wider than the main session (see WorkerCeilingAxis); it was not launched
])
/** Which axis of the privilege ceiling a `mode_escalation_denied` failure was over. */
export const WorkerCeilingAxis = z.enum(['permission_mode', 'mcp', 'deny_rules'])
export type WorkerFailureT = z.infer<typeof WorkerFailure>

const SessionUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

/** The folder, model, effort and MCP list a worker was actually started with (the Mac records it at launch). */
export const WorkerLaunched = z.object({
  cwd: AbsolutePath,
  model: WorkerModel.default('inherit'),
  effort: WorkerEffort.optional().catch(undefined),
  mcp_allow: McpAllowRead,
})
export type WorkerLaunchedT = z.infer<typeof WorkerLaunched>

export const WorkerEntry = z.object({
  state: WorkerState,
  session_id: SessionUuid.nullable().default(null),
  previous_ids: z.array(SessionUuid).max(5).default([]),
  tmux: z.string().regex(/^t-[a-z][a-z0-9_]{0,31}$/),
  pane_pid: z.number().int().nonnegative().default(0),
  cwd: AbsolutePath,
  model: WorkerModel.default('inherit'),
  started_at: IsoTs.nullable().default(null),
  last_turn_at: IsoTs.nullable().default(null),
  parked_at: IsoTs.nullable().default(null),
  restarts: z.array(IsoTs).max(10).default([]),
  error: z
    .object({
      // A code this build does not know (a newer Mac) is `unknown` for THIS entry: it must never make the whole file unreadable,
      // which would take every thread's session down with it.
      code: z.enum([...WorkerFailure.options, 'unknown']).catch('unknown'),
      detail: z.string().max(300).optional(),
      at: IsoTs,
      /** With `mode_escalation_denied`. An axis this build does not know is dropped, never the file. */
      axis: WorkerCeilingAxis.optional().catch(undefined),
    })
    .nullable()
    .default(null),
  /** The worker's last real activity, saved by the Mac so a relaunched app carries the idle clock on. The bridge only tolerates it. A value that is not a time reads as none. */
  last_active_at: IsoTs.optional().catch(undefined),
  /** A known dialog on the pane right now (dialog-files.ts); a value that does not fit reads as none. */
  dialog: WorkerDialog.optional().catch(undefined),
  /** What the running session was started with. The Mac writes it; the bridge only tolerates it. A value that does not fit reads as none. */
  launched: WorkerLaunched.optional().catch(undefined),
})
export type WorkerEntryT = z.infer<typeof WorkerEntry>

export const WorkersFile = z.object({
  v: z.literal(1),
  supervisor: z.object({
    pid: z.number().int().nonnegative(),
    heartbeat_at: IsoTs,
    /** This supervisor can host workers (OC3 and later). The app shows the switch only when it is true. */
    workers_supported: z.boolean().default(false),
    /** The pane pid of main's session (diagnostics). */
    main_pane_pid: z.number().int().nonnegative().default(0),
  }),
  threads: z.record(ThreadId, WorkerEntry).default({}),
})
export type WorkersFileT = z.infer<typeof WorkersFile>

/**
 * Parses `workers.json` text. A torn, unreadable or wrong-version file is `null` and the hub treats the supervisor as
 * down (every dedicated thread falls back to main); it never guesses at a partial file.
 */
export function parseWorkersFile(text: string): WorkersFileT | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const res = WorkersFile.safeParse(raw)
  return res.success ? res.data : null
}

/** Is the supervisor alive by its heartbeat? A future timestamp (clock skew) older than the window counts as fresh. */
export function supervisorFresh(file: WorkersFileT | null, now: number): boolean {
  if (!file) return false
  const at = Date.parse(file.supervisor.heartbeat_at)
  return Number.isFinite(at) && now - at < SUPERVISOR_STALE_MS
}

// ---- the wake file (hub writes `workers/<thread>/wake`, supervisor consumes) ------------------------------------------

/**
 * Message ids only: the supervisor never sees content. `action` says what the supervisor should do: type the pointer
 * (starting or resuming the worker first when it is not live), or run a control. A pointer wake carries at least one id.
 */
export const WakeFile = z
  .object({
    v: z.literal(1),
    thread_id: ThreadId,
    message_ids: z
      .array(z.string().regex(/^[a-z]{1,3}_[0-9A-HJKMNP-TV-Z]{26}$/))
      .max(50)
      .default([]),
    at: IsoTs,
    /** Why the worker is woken: an owner message, a card action for a card it raised, or a control. */
    reason: z.enum(['message', 'card_action', 'control', 'governor']).default('message'),
    action: z.enum(['pointer', 'park', 'restart', 'fresh', 'resume']).default('pointer'),
  })
  .refine((w) => w.action !== 'pointer' || w.message_ids.length > 0, {
    path: ['message_ids'],
    message: 'a pointer wake names at least one message',
  })
export type WakeFileT = z.infer<typeof WakeFile>

/**
 * Files under `$TALOS_APP_HOME/workers/<thread>/`: `wake` (hub writes, supervisor consumes and deletes), `nonce` (the
 * supervisor writes it before each start, 0600, and passes the same value in the worker's env as
 * TALOS_APP_WORKER_NONCE; the hub refuses a `hello` without it), `ready` (hub writes it on a good `hello`; the
 * supervisor's start is done when it appears), `mcp.json` and `WORKER.md` (supervisor / main).
 */
export const WORKER_FILES = {
  wake: 'wake',
  nonce: 'nonce',
  ready: 'ready',
  // Needs-you prompts (dialog-files.ts): the card's state for the Mac, the signed answer to press and the Mac's result
  dialogCard: 'dialog-card.json',
  dialogAnswer: 'dialog-answer.json',
  dialogResult: 'dialog-result.json',
} as const
export const WORKER_NONCE_ENV = 'TALOS_APP_WORKER_NONCE'

export const WorkerReady = z.object({
  v: z.literal(1),
  thread_id: ThreadId,
  pid: z.number().int().positive(),
  session_id: z.string().max(64).optional(),
  at: IsoTs,
})
export type WorkerReadyT = z.infer<typeof WorkerReady>

// ---- the hub socket (`$TALOS_APP_HOME/hub.sock`, JSON lines; OPTION-C 5.1) ------------------------------------------

/** The worker's bridge runs the Schedules tools over the hub (`rpc`) and can be handed a `schedule_run`. */
export const HUB_FEATURE_SCHEDULES = 'schedules/1'

export const HUB_MAX_LINE_BYTES = 300 * 1024

/** worker → hub. The hub accepts `hello` only from a pid in the recorded pane's process group. */
export const HubHello = z.strictObject({
  t: z.literal('hello'),
  thread_id: ThreadId,
  session_id: z.string().min(1).max(64).optional(),
  pid: z.number().int().positive(),
  nonce: z.string().min(16).max(64),
  /** What this worker's bridge can do beyond the first hub (HUB_FEATURE_*). Absent from an older worker; unknown names are ignored. */
  features: z.array(z.string().max(40)).max(20).optional(),
})
/** worker → hub: a reply/attach/card/status frame the worker built. The hub re-validates thread, size and schema. */
export const HubOut = z.strictObject({
  t: z.literal('out'),
  frame: z.looseObject({ type: z.string(), id: z.string() }),
})
/**
 * worker → hub (P1, WP-OC5): what the Talos mod in a worker reports, forwarded per scope. Loose on purpose: the hub
 * re-parses each part with the session schemas, so a newer mod's extra fields never break an older hub.
 */
export const HubMod = z.strictObject({
  t: z.literal('mod'),
  state: z.looseObject({}).optional(),
  inventory: z.looseObject({}).optional(),
  results: z.array(z.looseObject({})).max(20).optional(),
})
/**
 * The tools a thread session cannot run in its own process because they need main's live bridge (the Schedules service and
 * its Chronos): it asks the hub, and the hub answers as the thread the connection proved, never one the request names.
 */
export const HUB_RPC_TOOLS = ['schedules_list', 'schedule_propose', 'schedule_run_start', 'schedule_run_done'] as const
export const HUB_RPC_MAX_TEXT = 100_000
/** worker → hub: run one of HUB_RPC_TOOLS. `tool` is a plain string so a newer worker's tool is refused as one answer, not dropped. */
export const HubRpc = z.strictObject({
  t: z.literal('rpc'),
  id: z.string().min(1).max(64),
  tool: z.string().min(1).max(40),
  args: z.looseObject({}),
})
/**
 * hook → hub: the kit's PermissionRequest hook (kit/hooks/permission-relay.py) asks for a permission card on the phone and
 * waits for the owner's answer. One request per connection; the connection needs no `hello`. WHO is asking is proven here,
 * never named: with `thread_id` the hub requires that thread's supervisor nonce and a `pid` inside the recorded pane's
 * process group (the same proof as `hello`), and the card goes to that thread; without it the request is the main session's
 * and the card goes to the default thread. Loose on purpose: a newer hook's extra fields never break an older hub.
 */
export const HubPerm = z.looseObject({
  t: z.literal('perm'),
  id: z.string().min(1).max(64),
  thread_id: ThreadId.optional(),
  pid: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(64).optional(),
  tool_name: z.string().min(1).max(4096),
  tool_input: z.unknown().optional(),
  /** Claude Code's session id and working folder; only the folder is shown (on a main-session card, to say who asked). */
  session_id: z.string().max(100).optional(),
  cwd: z.string().max(1000).optional(),
})
export type HubPermT = z.infer<typeof HubPerm>
export const HubWorkerLine = z.discriminatedUnion('t', [HubHello, HubOut, HubMod, HubRpc, HubPerm])
export type HubWorkerLineT = z.infer<typeof HubWorkerLine>

/** hub → worker. */
export const HubWelcome = z.strictObject({ t: z.literal('welcome'), thread_id: ThreadId })
export const HubAck = z.strictObject({
  t: z.literal('ack'),
  frame_id: z.string().max(64),
  state: z.enum(['sent', 'queued', 'refused']),
  code: z.string().max(40).optional(),
  message: z.string().max(300).optional(),
})
export const HubRefused = z.strictObject({
  t: z.literal('refused'),
  code: z.string().max(40),
  message: z.string().max(300),
})
/** hub → worker (P1, WP-OC5): session controls routed to this worker's mod. Each control is re-checked by the mod. */
export const HubControls = z.strictObject({
  t: z.literal('controls'),
  controls: z.array(z.looseObject({})).max(20).default([]),
})
/** hub → worker: the answer to one `rpc`. `ok:false` is the tool's own refusal or failure, in words for the agent. */
export const HubRpcResult = z.strictObject({
  t: z.literal('rpc_result'),
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  text: z.string().max(HUB_RPC_MAX_TEXT),
})
/**
 * hub → hook: the answer to one `perm`. `allow` and `deny` are the owner's own signed answer to the card; `none` is
 * "no decision" (the relay is off, the request was refused, the owner never answered, the card was closed). A hook acts on
 * the exact words `allow` and `deny` only, so any other value, or a newer hub's new one, reads as `none`.
 */
export const HubPermResult = z.looseObject({
  t: z.literal('perm_result'),
  id: z.string().min(1).max(64),
  decision: z.string().max(20),
  reason: z.string().max(300).optional(),
})
export const HubHubLine = z.discriminatedUnion('t', [
  HubWelcome,
  HubAck,
  HubRefused,
  HubControls,
  HubRpcResult,
  HubPermResult,
])
export type HubHubLineT = z.infer<typeof HubHubLine>

// ---- what the app sees (bridge → relay → app) -------------------------------------------------------------------------

// Forward compatibility: the app drops any frame that fails to parse, and a cached PWA outlives every bridge. So nothing
// in the status may fail on a value a newer Mac adds: an unknown state, failure or governor reading becomes `unknown`, a
// field this build can't read is dropped, and `ready.workers_status` as a whole falls back to absent (frames.ts).
export const GovernorState = z.enum(['ok', 'paused', 'park_all', 'off', 'unknown']).catch('unknown')
export const WorkerStatusState = z.enum([...WorkerState.options, 'unknown']).catch('unknown')
export type WorkerStatusStateT = z.infer<typeof WorkerStatusState>
export const WorkerStatusFailure = z.enum([...WorkerFailure.options, 'unknown']).catch('unknown')

export const WorkerStatusItem = z.object({
  thread_id: ThreadId,
  state: WorkerStatusState,
  model: WorkerModel.optional().catch(undefined),
  cwd: AbsolutePath.optional().catch(undefined),
  last_turn_at: IsoTs.optional().catch(undefined),
  parked_at: IsoTs.optional().catch(undefined),
  error: WorkerStatusFailure.optional(),
})
export type WorkerStatusItemT = z.infer<typeof WorkerStatusItem>

/** The thread-session picture for the app (`workers.status`, and `ready.workers_status`). */
export const WorkersStatus = z.object({
  /** The bridge routes dedicated threads AND a supervisor that can host workers is running. The switch needs both. */
  supported: z.boolean(),
  supervisor_online: z.boolean(),
  threads: z.array(WorkerStatusItem).max(40),
  governor: z.object({ state: GovernorState, resets_at: IsoTs.optional().catch(undefined) }),
  at: IsoTs,
})
export type WorkersStatusT = z.infer<typeof WorkersStatus>

/**
 * A thread session's own `session.state`, as `ready.thread_session_states` carries it (docs/OPTION-C.md 9.3). The state
 * is loose here so an app parses it with `SessionState` itself and a newer field never makes `ready` fail.
 *
 * Rule: a `session.state` with `scope` set (a worker's) goes out only once the relay lists `thread-sessions/1`; an
 * older app's strict SessionState refuses a scoped one. Main's state never carries `scope`.
 */
export const ThreadSessionStateItem = z.object({
  thread_id: ThreadId,
  state: z.looseObject({ session_id: z.string().min(1).max(64) }),
})

/** Bridge feature: it routes dedicated threads (hub, read_inbound, deadlines). The app hides the switch without it. */
export const THREAD_SESSIONS_FEATURE = 'thread-sessions/1'
