// Meta of `notifications/claude/channel` (spec 4.3). Keys match /^[A-Za-z0-9_]+$/ (a hyphen is silently dropped by
// Claude Code) and every value is a string. WP5 builds it, FakeClaude and the contract tests assert it, WP8 checks it.
import { z } from 'zod'

export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel' as const

export const CHANNEL_KINDS = [
  'text',
  'voice_note',
  'file',
  'card_action',
  'hook_event',
  'hook_digest',
  'voice_delegation',
  'voice_ended',
  'backlog',
  'system',
  // Schedules (docs/SCHEDULES.md S6.3)
  'schedule_run',
  'schedule_held',
  // Claude Code integration (docs/CLAUDE-CODE.md C4.6): the owner asked for a new session from the Sessions view
  'spawn_request',
  // v2 features (docs/V2-FEATURES.md V4.3): a row from share-to-Talos
  'share',
  // Option C hand-off between the main session and a thread lead (docs/OPTION-C.md "Hand-offs")
  'handoff',
] as const
/** `agent` is another Talos session (main or a thread lead): never the owner's word, and it approves nothing. */
export const CHANNEL_TRUSTS = ['owner', 'owner_voice', 'external', 'system', 'agent'] as const
export const ChannelKind = z.enum(CHANNEL_KINDS)
export const ChannelTrust = z.enum(CHANNEL_TRUSTS)

const META_KEY = /^[A-Za-z0-9_]+$/

/** Always present. Other keys (spec 4.3 table) are optional strings. */
export const ChannelMeta = z
  .object({
    chat_id: z.string(),
    thread_id: z.string(),
    thread_name: z.string(),
    message_id: z.string(),
    ts: z.string(),
    kind: ChannelKind,
    trust: ChannelTrust,
    user: z.string().optional(),
    written_at: z.string().optional(), // a re-signed owner message: when the words were first written
    run: z.enum(['tap']).optional(), // the Mac accepted this as the owner's tap on Run (run.ts); the only thing the agent trusts as one
    audio_path: z.string().optional(),
    transcript_engine: z.string().optional(),
    duration_s: z.string().optional(),
    file_path: z.string().optional(),
    file_mime: z.string().optional(),
    file_name: z.string().optional(),
    card_id: z.string().optional(),
    card_action: z.enum(['primary', 'kill', 'revise', 'expired']).optional(),
    card_edited: z.enum(['true', 'false']).optional(),
    payload_path: z.string().optional(),
    event_id: z.string().optional(),
    source: z.string().optional(),
    event_kind: z.string().optional(),
    priority: z.string().optional(),
    voice_session_id: z.string().optional(),
    voice_delegation_id: z.string().optional(),
    batch_count: z.string().optional(),
    // schedule_run / schedule_held (docs/SCHEDULES.md S2.2, S6.3)
    schedule_id: z.string().optional(),
    run_id: z.string().optional(),
    ds: z.string().optional(),
    fire_at: z.string().optional(),
    window_ends: z.string().optional(),
    // spawn_request (docs/CLAUDE-CODE.md C4.6)
    spawn_id: z.string().optional(),
    spawn_kind: z.string().optional(),
    // v2 features (docs/V2-FEATURES.md V1.3)
    driving: z.enum(['true']).optional(), // the owner is listening, not reading
    memory_path: z.string().optional(), // absolute, re-checked
    memory_root: z.string().optional(),
    memory_changed: z.enum(['true']).optional(),
    share_id: z.string().optional(),
    share_url: z.string().optional(),
    share_source: z.enum(['shortcut', 'page']).optional(),
    shared_file: z.string().optional(), // the shared-inbox file the bridge filed a token share into
    // Option C (docs/OPTION-C.md 3.3): a dedicated thread's message main answers because its own session didn't
    routed: z.enum(['fallback']).optional(),
    reason: z.string().optional(),
    // handoff: who sent it and what it asks
    handoff_type: z.enum(['TASK', 'RESULT', 'BLOCK']).optional(),
    handoff_from: z.enum(['main', 'lead']).optional(),
  })
  .catchall(z.string()) // file_path_2 ... file_path_10
  .superRefine((meta, ctx) => {
    for (const k of Object.keys(meta)) {
      if (!META_KEY.test(k))
        ctx.addIssue({ code: 'custom', path: [k], message: 'meta keys must match /^[A-Za-z0-9_]+$/' })
    }
    if (meta.thread_id !== meta.chat_id)
      ctx.addIssue({ code: 'custom', path: ['chat_id'], message: 'chat_id must equal thread_id' })
  })
export type ChannelMetaT = z.infer<typeof ChannelMeta>

/** How an agent tool group is registered. `core` is the 12 tools of spec 4.4; the others were added later (see each list below). */
export const AGENT_TOOL_GROUPS = [
  'core',
  'mod',
  'schedule',
  'config',
  'attachment',
  'apps',
  'worker',
  'handoff',
] as const
export type AgentToolGroup = (typeof AGENT_TOOL_GROUPS)[number]

/**
 * What a worker (a thread's own session, docs/OPTION-C.md) may do with a tool. A tool that posts into the thread it is
 * given (`thread: 'post'`) must be locked to the worker's own thread: the type allows no other row, so a new such tool
 * cannot be given to workers unlocked. `read` takes a thread id only to read it; `none` takes none. `read` is a label
 * nothing else checks, so only the tools in READ_THREAD_TOOLS may carry it (the type below refuses any other, and a test
 * fails at runtime).
 */
export type WorkerAccess =
  | { worker: false; locked: false }
  | { worker: true; locked: false; thread: 'none' | 'read' }
  | { worker: true; locked: true; thread: 'post' | 'read' }

/** The tools that only read a thread's history. A worker's copy is still locked to its own thread (WORKER_THREAD_LOCKED_TOOLS). */
export const READ_THREAD_TOOLS = ['read_thread'] as const

export type AgentToolRow = {
  group: AgentToolGroup
  /** A scheduled headless job (`claude -p`) may call it. Leave it false unless it is safe unattended. */
  headless: boolean
} & WorkerAccess

const NOT_FOR_WORKERS = { worker: false, locked: false } as const
const OWN_THREAD = { worker: true, locked: true, thread: 'post' } as const
const WORKER_NO_THREAD = { worker: true, locked: false, thread: 'none' } as const
/** Reads a thread's history, so it is locked to the worker's own thread: a lead never sees another lane. */
const WORKER_READS_OWN_THREAD = { worker: true, locked: true, thread: 'read' } as const

/**
 * The one table of agent tools: a row per tool, in the order the bridge lists them. The bridge builds its tool lists,
 * what headless jobs and workers get, the worker thread lock and the instruction text from it, and refuses to start when
 * a tool and a row do not match (apps/bridge/src/tools/index.ts). To add a tool, add its row here and its implementation
 * there; the lists below follow.
 */
export const AGENT_TOOLS = {
  reply: {
    group: 'core',
    headless: true,
    ...OWN_THREAD,
  },
  attach: {
    group: 'core',
    headless: true,
    ...OWN_THREAD,
  },
  card: {
    group: 'core',
    headless: true,
    ...OWN_THREAD,
  },
  card_result: {
    group: 'core',
    headless: false,
    ...WORKER_NO_THREAD,
  },
  set_status: {
    group: 'core',
    headless: true,
    ...OWN_THREAD,
  },
  voice_progress: {
    group: 'core',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  list_threads: {
    group: 'core',
    headless: true,
    ...WORKER_NO_THREAD,
  },
  create_thread: {
    group: 'core',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  archive_thread: {
    group: 'core',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  read_thread: {
    group: 'core',
    headless: true,
    ...WORKER_READS_OWN_THREAD,
  },
  inbox_triage: {
    group: 'core',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  inbox_raw: {
    group: 'core',
    headless: true,
    ...NOT_FOR_WORKERS,
  },
  talos_mod_hello: {
    group: 'mod',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  talos_mod_sync: {
    group: 'mod',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  schedules_list: {
    group: 'schedule',
    headless: true,
    ...NOT_FOR_WORKERS,
  },
  schedule_propose: {
    group: 'schedule',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  schedule_run_start: {
    group: 'schedule',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  schedule_run_done: {
    group: 'schedule',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  config_propose: {
    group: 'config',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  retry_attachment: {
    group: 'attachment',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  app_show: {
    group: 'apps',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  app_result: {
    group: 'apps',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  list_apps: {
    group: 'apps',
    headless: false,
    ...NOT_FOR_WORKERS,
  },
  read_inbound: {
    group: 'worker',
    headless: false,
    ...WORKER_NO_THREAD,
  },
  handoff: {
    group: 'handoff',
    headless: false,
    ...OWN_THREAD,
  },
} as const satisfies Record<string, AgentToolRow>

export type AgentToolName = keyof typeof AGENT_TOOLS
// Compile-time: a row labelled `thread: 'read'` that is not in READ_THREAD_TOOLS makes this `never`, and the line fails.
type Readers = { [K in AgentToolName]: (typeof AGENT_TOOLS)[K] extends { thread: 'read' } ? K : never }[AgentToolName]
const ONLY_LISTED_TOOLS_READ: Readers extends (typeof READ_THREAD_TOOLS)[number] ? true : never = true
void ONLY_LISTED_TOOLS_READ
type NamesWhere<F> = { [K in AgentToolName]: (typeof AGENT_TOOLS)[K] extends F ? K : never }[AgentToolName]

export const AGENT_TOOL_NAMES = Object.keys(AGENT_TOOLS) as AgentToolName[]
const where = <F>(test: (row: AgentToolRow) => boolean) =>
  AGENT_TOOL_NAMES.filter((n) => test(AGENT_TOOLS[n])) as unknown as readonly NamesWhere<F>[]
const inGroup = <G extends AgentToolGroup>(g: G) => where<{ group: G }>((r) => r.group === g)

/** The 12 tools of spec 4.4. */
export const BRIDGE_TOOLS = inGroup('core')

/**
 * The four Schedules tools (docs/SCHEDULES.md S6.1). Kept apart from BRIDGE_TOOLS, which is pinned at 12 by
 * packages/protocol/test/channel-meta.test.ts.
 */
export const SCHEDULE_BRIDGE_TOOLS = inGroup('schedule')

/**
 * O1: the one tool by which the agent may PROPOSE a settings change (main session, live only). The agent never writes: the
 * owner approves a `kind:'config'` card and the bridge applies it. Kept apart from BRIDGE_TOOLS like the Schedules tools.
 */
export const CONFIG_BRIDGE_TOOLS = inGroup('config')

/**
 * The one tool that brings back an owner attachment whose download failed for a reason other than a failed check (relay
 * unreachable, disk full). It fetches only what the owner's signed message named, against the same signed size and hash.
 */
export const ATTACHMENT_BRIDGE_TOOLS = inGroup('attachment')

/** The app-view tools (docs/MCP-APPS-SPEC.md M5.3): registered only when the owner turned apps on. */
export const APP_BRIDGE_TOOLS = inGroup('apps')

/**
 * Claude Code integration tools (docs/CLAUDE-CODE.md C2.3, C4.6). `session_report` (WP-C7, agent-facing) has no tool yet,
 * so it has no row; `talos_mod_hello` / `talos_mod_sync` (WP-C2, mod-only: deferred, "Internal to the Talos mod. Never
 * call.", denied to the model by the mod's guard) do.
 */
export const SESSION_BRIDGE_TOOLS = ['session_report'] as const
export const MOD_BRIDGE_TOOLS = inGroup('mod')

/** Tools a scheduled headless job may call. */
export const HEADLESS_BRIDGE_TOOLS = where<{ headless: true }>((r) => r.headless)

/**
 * Bridge tools a worker-mode `talos-app` server lists. No thread lifecycle, inbox, schedules or voice: main owns those.
 * The ones that post into a thread only accept the worker's own (WORKER_THREAD_LOCKED_TOOLS).
 */
export const WORKER_BRIDGE_TOOLS = where<{ worker: true }>((r) => r.worker)
/** Of those, the tools that take a thread id and must be given the worker's own. */
export const WORKER_THREAD_LOCKED_TOOLS = where<{ locked: true }>((r) => r.locked)
