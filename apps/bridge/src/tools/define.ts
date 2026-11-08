// What one agent tool is, in one record: what the MCP server lists (name, description, schema), the code that runs it, what
// the agent is told about it, and every list it belongs to. A tool file exports one of these per tool; table.ts is the
// ordered list of them, and every list the bridge uses (what a headless job may call, what a worker gets, which tools are
// locked to a worker's thread, which group registers it) is derived from the records, never written down a second time.
import type { Tool } from './common.ts'

/** How an agent tool group is registered. `core` is the 12 tools of spec 4.4; the others were added later. */
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
 * nothing else checks, so only the tools in READ_THREAD_TOOLS may carry it (toolTableProblems and a test refuse any other).
 */
export type WorkerAccess =
  | { worker: false; locked: false }
  | { worker: true; locked: false; thread: 'none' | 'read' }
  | { worker: true; locked: true; thread: 'post' | 'read' }

/** The tools that only read a thread's history. A worker's copy is still locked to its own thread. */
export const READ_THREAD_TOOLS = ['read_thread'] as const

export const NOT_FOR_WORKERS = { worker: false, locked: false } as const
export const OWN_THREAD = { worker: true, locked: true, thread: 'post' } as const
export const WORKER_NO_THREAD = { worker: true, locked: false, thread: 'none' } as const
/** Reads a thread's history, so it is locked to the worker's own thread: a lead never sees another lane. */
export const WORKER_READS_OWN_THREAD = { worker: true, locked: true, thread: 'read' } as const

export type ToolMembership = {
  group: AgentToolGroup
  /** A scheduled headless job (`claude -p`) may call it. Leave it false unless it is safe unattended. */
  headless: boolean
} & WorkerAccess

/** Which session's instruction text carries a tool's words: the main session's, or a thread's own (worker) session's. */
export type Audience = 'main' | 'worker'

/**
 * The whole definition of one tool. `instructions` is what the agent is told about it, or null when it has none; `told` is
 * which sessions are told it (empty for null, and for the apps tool, whose words are APP_INSTRUCTIONS, added only when apps
 * are on). instructions.ts places the words of the tools it names where its text puts them; a tool it does not name is told
 * after them, in table order, so a new tool's words reach the agent without touching that file. A record missing any field
 * fails typecheck.
 */
export type ToolRecord = Tool & ToolMembership & { instructions: string | null; told: readonly Audience[] }
