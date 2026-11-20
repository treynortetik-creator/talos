// Option C: an opt-in dedicated Claude Code session per thread (docs/OPTION-C.md). WP-OC0 owns this file: the thread
// switch, the global `dedicated` settings, the supervisor's `workers.json`, the wake file, the local hub socket lines
// and the constants every side has to agree on. Nothing here starts a process; the bridge and the desktop supervisor
// read it. No thread has its own session until the owner turns that thread's switch on. The master switch (`dedicated.enabled`)
// is on for a config that never wrote one (the owner, 2026-11-19: "they can't even go look at it"), and is written the first time
// a thread is turned on (`writeSwitchOnFirstUse`): until then routing, and the Mac app, read it as off, and no thread is on its
// own session (`clearUnswitchedSessions`), so nothing starts that the owner did not turn on.
import { z } from 'zod'
import { WorkerDialog } from './dialog-files.ts'
import { IsoTs, ThreadId } from './ids.ts'
import { SpecHash } from './spec-hash.ts'
import { clipUnits } from './untrusted.ts'
import { PendingWakes } from './wake-me.ts'
import { WORKERS_UNREADABLE_KEY } from './workers-unreadable.ts'

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
  // twice by canonical equivalence (NFC), as the Mac's Set compares names: `café` written precomposed and with a combining
  // accent is one name named twice, and the list fails closed there. Only the check normalizes: names stay as written
  .refine((l) => new Set(l.map((n) => n.normalize('NFC'))).size === l.length, { message: 'a server is named twice' })
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
  /** Mac-only (`THREAD_SESSION_OPT_ROWS`): the thread's session may run `errors list` and `errors show`. */
  ops_read: z.boolean().optional(),
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
  /** A value this build cannot read is absent (off), never on. */
  ops_read: z.boolean().optional().catch(undefined),
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
  restart_on_update: z.boolean().default(true),
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
  /**
   * After an update, restart each running thread session whose launch spec changed (spec-hash.ts), once per spec, resuming its
   * conversation and never cutting a turn. A junk value is on (the default), never a silent off.
   */
  restart_on_update: z.boolean().default(true).catch(true),
})
export type DedicatedConfigT = z.infer<typeof DedicatedConfig>

/** The settings in force for routing: a config without `dedicated` is the all-defaults one, off (see threadSessionsAllowed). */
export function dedicatedSettings(config: { dedicated?: unknown }): DedicatedConfigT {
  const parsed = DedicatedConfig.safeParse(config.dedicated ?? {})
  return parsed.success ? parsed.data : DedicatedConfig.parse({})
}

/**
 * The master switch as the owner sees it, in Settings and on each thread: a config that never wrote one (no `dedicated` at all, every
 * new install) shows it on, so each thread offers its own switch (off). An explicit value is what it says. Whether a thread is
 * routed to its own session is still `threadSessionMode`, which needs the switch WRITTEN on: the Mac app reads a missing one as off.
 */
export function threadSessionsAllowed(config: { dedicated?: unknown }): boolean {
  if (config.dedicated === undefined) return true
  return dedicatedSettings(config).enabled
}

/**
 * A config that never wrote the switch has no thread on its own session: the Mac app reads a missing switch as off, so such a
 * thread never ran, and the owner is shown it off. Read that way everywhere (the bridge on load, reload and every write; the
 * fake Mac), so no later change can start one he never turned on: not an agent card that sends every thread whole, not the
 * switch turned off and on. Turning things off only, so it never needs asking. Unchanged config: the same object.
 */
export function clearUnswitchedSessions<C extends ConfigLike>(config: C): C {
  if (config.dedicated !== undefined || !config.threads.some((t) => t.session === 'dedicated')) return config
  return {
    ...config,
    threads: config.threads.map((t) => (t.session === 'dedicated' ? { ...t, session: 'shared' as const } : t)),
  }
}

/**
 * The patch-time rule that makes the shown switch real (the bridge's `config.patch` and `update`, the fake Mac). `before` is on
 * disk (cleared by clearUnswitchedSessions: no thread on its own session), `after` about to be written, `patch` the change as
 * sent (absent for a tool's `update`). Only when `before` never wrote the switch, and `after` turns a thread on or writes
 * `dedicated`: the switch is written on, unless the patch itself names `dedicated.enabled` (an explicit off stays off). A patch
 * that writes only a limit (`max_live`) would otherwise leave the schema's `enabled: false` behind and hide every thread's switch.
 * Anything else comes back unchanged (the same object).
 */
export function writeSwitchOnFirstUse<C extends ConfigLike>(
  before: ConfigLike,
  after: C,
  patch?: { dedicated?: unknown },
): C {
  if (before.dedicated !== undefined) return after
  const turnedOn = after.threads.some((t) => t.session === 'dedicated' && canBeDedicated(after, t.id))
  if (!turnedOn && after.dedicated === undefined) return after
  const sent = patch?.dedicated
  if (typeof sent === 'object' && sent !== null && 'enabled' in sent && after.dedicated !== undefined) return after
  return { ...after, dedicated: { ...DedicatedConfig.parse(after.dedicated ?? {}), enabled: true } }
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
 * `Thread.session`, `Thread.session_opts`, `Thread.parent_id` and `AgentConfig.dedicated` are tolerant when READ: a value this build doesn't
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
    // read tolerantly (a value this build can't read is no parent), so a write must refuse it or the thread lands top-level
    if (t.parent_id !== undefined && !ThreadId.safeParse(t.parent_id).success)
      return `thread "${String(t.id)}": the parent is not a thread id`
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
  const root = (r: string) => r.replace(/\/+$/, '')
  const under = (r: string) => norm === root(r) || norm.startsWith(`${root(r)}/`)
  // only the refused folders ignore case: a Mac's disk is case-insensitive, so `.CLAUDE` is `.claude` there (refusing the other
  // spelling on a case-sensitive disk too costs nothing). "Inside home" and "not home itself" are exact, as the disk spells them.
  const low = norm.toLowerCase()
  const underFold = (r: string) => low === root(r).toLowerCase() || low.startsWith(`${root(r).toLowerCase()}/`)
  if (!under(roots.home) || norm === root(roots.home)) return 'the folder must be inside your home folder'
  if (underFold(`${root(roots.home)}/.claude`) || (roots.claudeDir && underFold(roots.claudeDir)))
    return "the folder can't be inside ~/.claude"
  if (underFold(roots.talosHome)) return "the folder can't be inside the Talos data folder"
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

const clipUnits300 = (s: string): string => clipUnits(s, 300)

const SessionUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

/** The folder, model, effort and MCP list a worker was actually started with (the Mac records it at launch). */
export const WorkerLaunched = z.object({
  cwd: AbsolutePath,
  model: WorkerModel.default('inherit'),
  effort: WorkerEffort.optional().catch(undefined),
  mcp_allow: McpAllowRead,
  /**
   * The launch spec's hash (spec-hash.ts) when this session was launched; missing on an entry an older supervisor wrote, which
   * is restarted once on update. A value that is not a hash reads as missing.
   */
  spec_hash: SpecHash.optional().catch(undefined),
  /** The spec hash an update restart was last tried for, written BEFORE the try: never tried twice for the same spec. */
  update_tried_hash: SpecHash.optional().catch(undefined),
  /**
   * The digest of the instructions the start handed a session outside the agent folder (the system prompt, its delimiter token
   * replaced), so the update check can tell an instruction edit alone from any other change. Absent in the agent folder (that
   * folder's files are loaded by the session itself and never hashed) and from an older supervisor. A value that is not a hash
   * reads as missing.
   */
  instructions_hash: SpecHash.optional().catch(undefined),
})
export type WorkerLaunchedT = z.infer<typeof WorkerLaunched>

/**
 * Why a session is parked or on its way out (`stopped_why`), as the supervisor recorded it at the park or stop: the idle limit,
 * the live cap (another thread needed the slot), the owner (a tap, a park), a crash, an interruption (the Mac or the app went
 * away mid-turn), a restart, or the usage governor. A value this build does not know reads as `unknown` for that entry only.
 */
export const WORKER_STOPPED_WHY = ['idle', 'cap', 'owner', 'crash', 'interrupted', 'restart', 'governor'] as const
export const WorkerStoppedWhy = z.enum([...WORKER_STOPPED_WHY, 'unknown'])
export type WorkerStoppedWhyT = z.infer<typeof WorkerStoppedWhy>
/** `needs_you.kind`, in UTF-16 units: what the session waits on the owner for, in the supervisor's words (a dialog's name). */
export const WORKER_NEEDS_YOU_KIND_MAX = 80
/**
 * The `needs_you.kind` values of screens the owner must never be told to "answer" (the Mac's `DialogMatcher.Screen.answerless`):
 * the computer-use permission dialog (Enter on its first row opens System Settings) and Claude Code's usage-limit screen (one of its
 * options spends usage credits; the Mac sends it no key at all). Same words as the Mac writes.
 */
export const NEEDS_YOU_COMPUTER_USE = 'computer-use permissions'
export const NEEDS_YOU_USAGE_LIMIT = 'usage limit'
/**
 * The `needs_you.kind` names a supervisor writes for the prompts it knows (the Mac's SessionSwitcher.promptName; the Linux
 * supervisor uses the same words). Only these go to the app: any other kind is a screen's own title, which can name a file,
 * so `workers.status` says "a prompt" for it and the raw title stays on the Mac for Main's status tool.
 */
export const WORKER_NEEDS_YOU_KINDS = [
  'trust this folder',
  'approve a project MCP server',
  'bypass permissions',
  'sign in',
  NEEDS_YOU_COMPUTER_USE,
  NEEDS_YOU_USAGE_LIMIT,
  'development channels',
  'an unknown question',
  'conversation not found',
] as const
export const NEEDS_YOU_OTHER_PROMPT = 'a prompt'
/** Where a step is done on a Mac: its sentences are the Mac's, byte for byte. */
export const NEEDS_YOU_MAC_PLACE = 'at the Mac'
const NEEDS_YOU_STEPS: Record<string, (place: string) => string> = {
  // computer use is Claude Code's on a Mac only (no Linux detector raises it), but the kind is shared: elsewhere its pane is
  // closed the same way, and there is no System Settings to open
  [NEEDS_YOU_COMPUTER_USE]: (place) =>
    place === NEEDS_YOU_MAC_PLACE
      ? 'press Esc in its pane at the Mac to close it (Esc only: Enter opens System Settings)'
      : `press Esc in its pane ${place} to close it (Esc only)`,
  [NEEDS_YOU_USAGE_LIMIT]: (place) =>
    `press Esc in its pane ${place}, then /model <another model> (Talos presses nothing there: one option spends usage credits)`,
}
/**
 * What the owner does for a `needs_you.kind`, for the kinds that must never read as "answer it"; undefined for any other kind, one
 * this build does not know included (the caller then says what it always said). `place`: where, in the platform's words ("at the
 * Mac", the default and the Mac's sentences unchanged; a Linux computer's "on <its name>", or "there" in a sentence that names it).
 */
export function needsYouStep(kind: unknown, place: string = NEEDS_YOU_MAC_PLACE): string | undefined {
  return typeof kind === 'string' && Object.hasOwn(NEEDS_YOU_STEPS, kind)
    ? (NEEDS_YOU_STEPS[kind] as (place: string) => string)(place)
    : undefined
}
/**
 * The session waits on the owner (a dialog or a prompt on its pane), since when. The supervisor raises it where it posts
 * "waiting on ..." and clears it when the prompt goes. `kind` is clipped, never refused; anything else that does not fit reads as none.
 */
export const WorkerNeedsYou = z.object({
  kind: z
    .string()
    .min(1)
    .transform((s) => clipUnits(s, WORKER_NEEDS_YOU_KIND_MAX)),
  since: IsoTs,
  /**
   * The usage-limit screen's reset as an absolute time, worked out by the supervisor that read the screen: the next such
   * moment after it read it, in the zone the screen names, else the supervisor's own. Absent when it cannot be parsed.
   */
  resets_at: IsoTs.optional().catch(undefined),
})
export type WorkerNeedsYouT = z.infer<typeof WorkerNeedsYou>

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
      // clipped to 300 UTF-16 units, never refused: the Mac clips at 300 Characters, which can be more units (audit O3)
      detail: z.string().transform(clipUnits300).optional(),
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
  /** The session id a message was last typed into, or the id last retired. The Mac writes and reads it (whether `session_id` ever had a turn); the bridge only tolerates it. */
  turn_session: z.string().max(64).optional().catch(undefined),
  // The three below are optional and added late (status that tells the truth): an older reader strips them, and a value this
  // build cannot read is none for this entry only, never an unreadable file. Null reads as none too.
  /** What the session waits on the owner for right now, and since when. */
  needs_you: WorkerNeedsYou.nullish().catch(undefined),
  /** Why it is parked or stopping; cleared when it starts. */
  stopped_why: WorkerStoppedWhy.catch('unknown').nullish(),
  /** When the turn now running began (a message typed into it); cleared when the turn ends. `last_turn_at` is when the last one ended. */
  turn_started_at: IsoTs.nullish().catch(undefined),
})
export type WorkerEntryT = z.infer<typeof WorkerEntry>

export const WorkersFile = z.object({
  v: z.literal(1),
  supervisor: z.object({
    pid: z.number().int().nonnegative(),
    heartbeat_at: IsoTs,
    /** This supervisor can host workers (OC3 and later). The app shows the switch only when it is true. */
    workers_supported: z.boolean().default(false).catch(false),
    /** This Mac app checks a sub-thread's folder is inside its parent's before every start; until it says so, no thread gets a parent. */
    subthreads_supported: z.boolean().default(false).catch(false),
    /** This Mac app also starts a dedicated sub-thread in an existing folder outside its parent's; without it that is refused. */
    subthreads_own_folder: z.boolean().default(false).catch(false),
    /** This supervisor also starts a dedicated sub-thread with no folder, or its parent's own, in the parent's folder; without it that is refused. */
    subthreads_shared_folder: z.boolean().default(false).catch(false),
    /** This supervisor also starts a dedicated sub-thread with a folder of its own under a parent with none (judged against the agent folder, the parent's rules carried over); without it that is refused. */
    subthreads_folderless_parent: z.boolean().default(false).catch(false),
    /**
     * This supervisor's reader takes `workers/<id>/control` (WORKER_FILES.control) before `wake`. The bridge writes an owner's tap
     * there only when this is true; absent (an older supervisor) or false, it writes the tap into `wake` as it always did, so no
     * tap is ever left in a file nobody reads.
     */
    reads_control: z.boolean().default(false).catch(false),
    /** The pane pid of main's session (diagnostics). */
    main_pane_pid: z.number().int().nonnegative().default(0),
    /** Main's own dialog on its pane right now (the development-channels warning), published here because Main has no thread entry. A value that does not fit reads as none. */
    main_dialog: WorkerDialog.optional().catch(undefined),
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

/** workers.json as the hub reads it: every entry it could read, and the threads whose own session it must not count on. */
export type WorkersReadT = WorkersFileT & { unavailable: string[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads `workers.json` for the hub entry by entry (protocol audit O3; the contract is workers-unreadable.ts). An entry of
 * `threads` this build cannot read, and a thread set aside under `unreadable_threads`, is listed in `unavailable`: that
 * thread's session is neither "off" nor started on a guess, and every other thread reads as written. The whole file is
 * `null` (the supervisor reads as down) only where WORKERS_FILE_REFUSED_WHEN says, or when `supervisor` cannot be read.
 * A writer reads with parseWorkersFile instead, which stays all-or-nothing so a save never drops an entry it could not read.
 */
export function readWorkersFile(text: string): WorkersReadT | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw) || raw.v !== 1 || !isPlainObject(raw.threads)) return null
  const aside = raw[WORKERS_UNREADABLE_KEY]
  if (aside !== undefined && !isPlainObject(aside)) return null
  const head = WorkersFile.safeParse({ ...raw, threads: {} })
  if (!head.success) return null
  const threads: Record<string, WorkerEntryT> = {}
  const unavailable = new Set<string>()
  for (const [id, e] of Object.entries(raw.threads)) {
    if (!ThreadId.safeParse(id).success) continue // not a thread: nothing can route to it
    const r = WorkerEntry.safeParse(e)
    if (r.success) threads[id] = r.data
    else unavailable.add(id)
  }
  for (const id of Object.keys(aside ?? {})) if (ThreadId.safeParse(id).success) unavailable.add(id) // `K#` is not an id
  return { ...head.data, threads, unavailable: [...unavailable] }
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
    /**
     * Who asked for a control: the owner's button or the main session's `thread_session` tool. For the log only; nothing acts
     * on it. Optional and added late: a supervisor that predates it ignores the key (zod strips unknown keys; the Mac's
     * Decodable reads named keys only), and a value this build does not know reads as none, never a dropped wake.
     */
    by: z.enum(['owner', 'main']).optional().catch(undefined),
    /**
     * Ignored. An early build of the reader-side checks numbered wakes; nothing writes or reads it now (wake-decision.ts says why).
     * Still tolerated so a file written then parses: a value that is not a positive safe integer reads as none, never a failed wake.
     */
    counter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
  })
  .refine((w) => w.action !== 'pointer' || w.message_ids.length > 0, {
    path: ['message_ids'],
    message: 'a pointer wake names at least one message',
  })
export type WakeFileT = z.infer<typeof WakeFile>

/**
 * Files under `$TALOS_APP_HOME/workers/<thread>/`: `wake` and `control` (hub writes, supervisor consumes and deletes), `nonce` (the
 * supervisor writes it before each start, 0600, and passes the same value in the worker's env as
 * TALOS_APP_WORKER_NONCE; the hub refuses a `hello` without it), `ready` (hub writes it on a good `hello`; the
 * supervisor's start is done when it appears), `mcp.json` and `WORKER.md` (supervisor / main).
 */
export const WORKER_FILES = {
  wake: 'wake',
  // a control the owner tapped (park, resume, restart, fresh; the same WakeFile shape), apart from `wake` so a message pointer
  // written after it can never replace it (BSUP-5). The reader takes it before `wake`, in the same tick.
  control: 'control',
  nonce: 'nonce',
  ready: 'ready',
  // Needs-you prompts (dialog-files.ts): the card's state for the Mac, the signed answer to press and the Mac's result
  dialogCard: 'dialog-card.json',
  dialogAnswer: 'dialog-answer.json',
  // Main's own answer (the development-channels card): apart from a worker's, which can sit on the same default thread
  mainDialogAnswer: 'main-dialog-answer.json',
  dialogResult: 'dialog-result.json',
  // the Mac's own record of the signed taps it has acted on, so a copy of one is refused after a relaunch too
  dialogProofsUsed: 'dialog-proofs-used.json',
  mainDialogProofsUsed: 'main-dialog-proofs-used.json',
  // the bridge's record of the capped wakes it wrote (writeWake), for its up-front check when the reader keeps no state. 0600
  wakeWritten: 'wake-written.json',
  // the reader's own record (wake-decision.ts WakeState): the capped wakes it carried out. 0600
  wakeState: 'wake-state.json',
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
 * its Chronos, and the settings cards `config_propose` draws): it asks the hub, and the hub answers as the thread the connection proved, never one the request names.
 */
export const HUB_RPC_TOOLS = [
  'schedules_list',
  'schedule_propose',
  'schedule_run_start',
  'schedule_run_done',
  'config_propose',
  'wake_me',
] as const
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
/**
 * hook → hub: the kit's action rules (kit/hooks/action-rules.py, audit item 28). An "ask first" rule's approval is the owner's
 * signed tap on a card that shows the exact call, never anything a session writes. Proof of WHO is asking is the same as `perm`
 * (a thread session's nonce and pane pid; none for main). One request per connection, no `hello`.
 *   `ask_rule`  `approve`: raise (or wait on) the "Allow once" card for this call and wait for the tap.
 *   `rule_take` the PreToolUse check: take the one-use approval for exactly this call, if the owner gave one, or go ahead for a
 *               send kind the owner always allows. The kind is never in the line: the bridge decides it from the shipped rules.
 */
const HubRuleCall = {
  id: z.string().min(1).max(64),
  thread_id: ThreadId.optional(),
  pid: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(64).optional(),
  rule: z.string().min(1).max(80),
  tool_name: z.string().min(1).max(4096),
  tool_input: z.unknown().optional(),
  cwd: z.string().max(1000).optional(),
}
export const HubAskRule = z.looseObject({
  t: z.literal('ask_rule'),
  ...HubRuleCall,
  why: z.string().max(300).optional(),
  /** How long this request waits for the tap; the card itself stays open after it gives up. */
  wait_ms: z.number().int().min(0).max(3_600_000).optional(),
})
export type HubAskRuleT = z.infer<typeof HubAskRule>
export const HubRuleTake = z.looseObject({ t: z.literal('rule_take'), ...HubRuleCall })
export type HubRuleTakeT = z.infer<typeof HubRuleTake>
/**
 * hook → hub: a rule file of the kit's action rules could not be read, so the hook is asking (denying, unattended) about every call
 * until it is fixed. The bridge posts ONE plain notice to the owner's thread per file and content hash; it writes the words itself
 * from these fields, so nothing a session sends is ever shown as text. Proof of who asks is the same as `perm`.
 */
export const HubRuleNotice = z.looseObject({
  t: z.literal('rule_notice'),
  id: z.string().min(1).max(64),
  thread_id: ThreadId.optional(),
  pid: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(64).optional(),
  file: z.enum(['shipped', 'user']),
  line: z.number().int().min(1).max(1_000_000).optional(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  unattended: z.boolean().optional(),
})
export type HubRuleNoticeT = z.infer<typeof HubRuleNotice>
export const HubWorkerLine = z.discriminatedUnion('t', [
  HubHello,
  HubOut,
  HubMod,
  HubRpc,
  HubPerm,
  HubAskRule,
  HubRuleTake,
  HubRuleNotice,
])
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

/** What a session waits on the owner for, as `workers.status` carries it: a known prompt name or "a prompt", since when. */
export const StatusNeedsYou = z.object({
  kind: z.string().min(1).max(WORKER_NEEDS_YOU_KIND_MAX),
  since: IsoTs,
  step: z.string().min(1).max(300).optional().catch(undefined),
  resets_at: IsoTs.optional().catch(undefined),
})
export type StatusNeedsYouT = z.infer<typeof StatusNeedsYou>

export const WorkerStatusItem = z.object({
  thread_id: ThreadId,
  state: WorkerStatusState,
  model: WorkerModel.optional().catch(undefined),
  cwd: AbsolutePath.optional().catch(undefined),
  last_turn_at: IsoTs.optional().catch(undefined),
  parked_at: IsoTs.optional().catch(undefined),
  error: WorkerStatusFailure.optional(),
  // Added for the app's status line (what the session is doing, in words). Each is optional and reads as none when it does not
  // fit, so an older bridge (none sent) and a newer one (a value this build cannot read) never cost the frame. An older page
  // strips them.
  /** When the failure was recorded. Its detail stays on the Mac (it can name paths). */
  error_at: IsoTs.optional().catch(undefined),
  /** What the session waits on the owner for: `kind` one of WORKER_NEEDS_YOU_KINDS, else "a prompt"; `step` what to do at the Mac when "answer it" is wrong. */
  needs_you: StatusNeedsYou.optional().catch(undefined),
  stopped_why: WorkerStoppedWhy.optional().catch(undefined),
  started_at: IsoTs.optional().catch(undefined),
  turn_started_at: IsoTs.optional().catch(undefined),
  /** Crash restarts in the hour before `at`. */
  restarts_1h: z.number().int().min(0).max(10).optional().catch(undefined),
  /** The session's own pending `wake_me` timers, soonest first (at most WAKE_STATUS_MAX), and how many there are in all. */
  wakes: PendingWakes.optional().catch(undefined),
  wakes_total: z.number().int().min(0).max(10_000).optional().catch(undefined),
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
  /**
   * Main's own session sits on a prompt at the Mac (main-restart-check.json `needs_you`, while that file is fresh). Optional:
   * an older bridge sends none, and one this build cannot read is none.
   */
  main_needs_you: StatusNeedsYou.optional().catch(undefined),
  /** Main's own pending `wake_me` timers (and those of a thread that has gone back to main), like `threads[].wakes`. */
  main_wakes: PendingWakes.optional().catch(undefined),
  main_wakes_total: z.number().int().min(0).max(10_000).optional().catch(undefined),
})
export type WorkersStatusT = z.infer<typeof WorkersStatus>

/** How many thread sessions' states the relay keeps for `ready` and the bridge sends (the config allows 40 threads). */
export const MAX_THREAD_SESSION_STATES = 40

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
