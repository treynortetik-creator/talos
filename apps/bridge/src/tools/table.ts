// The one table of agent tools: a record per tool, in the order the bridge lists them. Every list the bridge uses (what a
// headless job or a worker gets, the worker thread lock, which group registers a tool) and every tool's instruction text is
// read from these records. To add a tool: write its record in a file here (define.ts says what a record holds) and add it
// to the array below; nothing else names it. tools/index.ts refuses to start on a record that does not fit
// (toolTableProblems), so the owner finds it in bridge.log.
import { APP_TOOL_RECORDS } from './apps.ts'
import { retryAttachmentTool } from './attachments.ts'
import { card, cardResult } from './card.ts'
import { configPropose, settingsRead } from './config.ts'
import { type AgentToolGroup, READ_THREAD_TOOLS, type ToolRecord } from './define.ts'
import { handoffTool } from './handoff.ts'
import { memoryNoteReadTool } from './memory-note-read.ts'
import { inboxRaw, inboxTriage, setStatus } from './misc.ts'
import { talosModHello, talosModSync } from './mod.ts'
import { publishPage } from './pages.ts'
import { peerSendTool } from './peer.ts'
import { permissionMode } from './permission-mode.ts'
import { readInboundTool } from './read-inbound.ts'
import { restartMain } from './restart-main.ts'
import { schedulePropose, scheduleRerun, scheduleRunDone, scheduleRunStart, schedulesList } from './schedules.ts'
import { SCREEN_TOOL_RECORDS } from './screen.ts'
import { attach, reply } from './send.ts'
import { threadSession } from './sessions.ts'
import { setThreadInstructions } from './thread-instructions.ts'
import { archiveThread, createThread, listThreads, readThread } from './threads.ts'
import { wakeMe } from './wake-me.ts'

/** In the order agents are shown the tools: this order is the order of every list below, and of tools/list. */
export const TOOL_RECORDS: readonly ToolRecord[] = [
  reply,
  attach,
  card,
  cardResult,
  setStatus,
  listThreads,
  createThread,
  archiveThread,
  readThread,
  inboxTriage,
  inboxRaw,
  talosModHello,
  talosModSync,
  schedulesList,
  schedulePropose,
  scheduleRunStart,
  scheduleRunDone,
  scheduleRerun,
  wakeMe,
  configPropose,
  settingsRead,
  setThreadInstructions,
  retryAttachmentTool,
  publishPage,
  ...APP_TOOL_RECORDS,
  readInboundTool,
  memoryNoteReadTool,
  handoffTool,
  peerSendTool,
  threadSession,
  restartMain,
  permissionMode,
  ...SCREEN_TOOL_RECORDS,
]

/** The records by name, in table order. */
export const AGENT_TOOLS: Readonly<Record<string, ToolRecord>> = Object.fromEntries(
  TOOL_RECORDS.map((t) => [t.name, t]),
)
export const AGENT_TOOL_NAMES: readonly string[] = TOOL_RECORDS.map((t) => t.name)

const where = (test: (t: ToolRecord) => boolean): readonly string[] => TOOL_RECORDS.filter(test).map((t) => t.name)
const inGroup = (g: AgentToolGroup) => where((t) => t.group === g)

/** The 12 tools of spec 4.4. */
export const BRIDGE_TOOLS = inGroup('core')
/** The Schedules tools (docs/SCHEDULES.md S6.1), and `wake_me`, which writes its one-shot job through the same scheduler. */
export const SCHEDULE_BRIDGE_TOOLS = inGroup('schedule')
/** The one tool by which the agent may PROPOSE a settings change (main session, live only); the owner's card applies it. */
export const CONFIG_BRIDGE_TOOLS = inGroup('config')
/** The tool that brings back an owner attachment whose download failed for a reason other than a failed check. */
export const ATTACHMENT_BRIDGE_TOOLS = inGroup('attachment')
/** The app-view tools (docs/MCP-APPS-SPEC.md M5.3): registered only when the owner turned apps on. */
export const APP_BRIDGE_TOOLS = inGroup('apps')
/** `talos_mod_hello` / `talos_mod_sync`: mod-only, denied to the model by the mod's guard. */
export const MOD_BRIDGE_TOOLS = inGroup('mod')
/** Org pages (docs/ORG-PAGES-SPEC.md): publish only; sharing is the owner's. */
export const PAGE_BRIDGE_TOOLS = inGroup('pages')
/** The screen tools: Talos.app's screen helper on the Mac (main and thread sessions, never headless). */
export const SCREEN_BRIDGE_TOOLS = inGroup('screen')
/** Tools a scheduled headless job may call. */
export const HEADLESS_BRIDGE_TOOLS = where((t) => t.headless)
/** Tools a worker-mode `talos-app` server lists. */
export const WORKER_BRIDGE_TOOLS = where((t) => t.worker)
/** Of those, the tools that take a thread id and must be given the worker's own. */
export const WORKER_THREAD_LOCKED_TOOLS = where((t) => t.locked)

/** What does not fit in the records, for anything the types cannot see. */
export function tableProblems(records: readonly ToolRecord[] = TOOL_RECORDS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const readers = new Set<string>(READ_THREAD_TOOLS)
  for (const t of records) {
    if (seen.has(t.name)) out.push(`agent tool "${t.name}" is in the table twice`)
    seen.add(t.name)
    if (t.told.length > 0 && typeof t.instructions !== 'string')
      out.push(`agent tool "${t.name}" is told to ${t.told.join(' and ')} but has no instruction text`)
    if (t.told.includes('worker') && !t.worker)
      out.push(`agent tool "${t.name}" is told to workers but workers do not get it`)
    if ('thread' in t && t.thread === 'read' && !readers.has(t.name))
      out.push(
        `agent tool "${t.name}" is labelled as reading a thread but is not in READ_THREAD_TOOLS (tools/define.ts)`,
      )
  }
  for (const n of READ_THREAD_TOOLS)
    if (!seen.has(n)) out.push(`READ_THREAD_TOOLS names "${n}", which is not in the table`)
  return out
}
