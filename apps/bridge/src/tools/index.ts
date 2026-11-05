import {
  AGENT_TOOL_GROUPS,
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentToolGroup,
  type AgentToolName,
  HEADLESS_BRIDGE_TOOLS,
  threadSessionMode,
  WORKER_THREAD_LOCKED_TOOLS,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { APP_TOOLS, appResult, appShow, listApps } from './apps.ts'
import { retryAttachmentTool } from './attachments.ts'
import { card, cardResult } from './card.ts'
import { fail, type Tool, type ToolResult } from './common.ts'
import { configPropose } from './config.ts'
import { handoffTool } from './handoff.ts'
import { inboxRaw, inboxTriage, setStatus, voiceProgress } from './misc.ts'
import { talosModHello, talosModSync } from './mod.ts'
import { readInboundTool, workerStoreOf } from './read-inbound.ts'
import { schedulePropose, scheduleRunDone, scheduleRunStart, schedulesList } from './schedules.ts'
import { attach, reply } from './send.ts'
import { archiveThread, createThread, listThreads, readThread } from './threads.ts'

/**
 * What each row of AGENT_TOOLS (packages/protocol/src/channel-meta.ts) runs. The type needs exactly one tool per row, so
 * a row without a tool, or a tool without a row, fails typecheck; the loop below says the same at start for anything the
 * type cannot see.
 */
const IMPLEMENTATIONS: Record<AgentToolName, Tool> = {
  reply,
  attach,
  card,
  card_result: cardResult,
  set_status: setStatus,
  voice_progress: voiceProgress,
  list_threads: listThreads,
  create_thread: createThread,
  archive_thread: archiveThread,
  read_thread: readThread,
  inbox_triage: inboxTriage,
  inbox_raw: inboxRaw,
  talos_mod_hello: talosModHello,
  talos_mod_sync: talosModSync,
  schedules_list: schedulesList,
  schedule_propose: schedulePropose,
  schedule_run_start: scheduleRunStart,
  schedule_run_done: scheduleRunDone,
  config_propose: configPropose,
  retry_attachment: retryAttachmentTool,
  app_show: appShow,
  app_result: appResult,
  list_apps: listApps,
  read_inbound: readInboundTool,
  handoff: handoffTool,
}

/**
 * What does not match between AGENT_TOOLS and the tools that run for it, for anything the types cannot see. Empty when
 * all is well. server.ts calls it once its logger exists and refuses to start on any line, so the owner finds it in
 * bridge.log (an error thrown at import came before the logger and never reached it).
 */
export function toolTableProblems(
  impls: Record<string, Tool> = IMPLEMENTATIONS,
  appTools: Tool[] = APP_TOOLS,
): string[] {
  const out: string[] = []
  for (const n of AGENT_TOOL_NAMES)
    if (impls[n]?.name !== n)
      out.push(
        `agent tool "${n}" has a row in AGENT_TOOLS (packages/protocol/src/channel-meta.ts) but tools/index.ts has no tool of that name for it`,
      )
  if (appTools.map((t) => t.name).join() !== AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].group === 'apps').join())
    out.push('the tools in apps.ts are not the `apps` rows of AGENT_TOOLS (packages/protocol/src/channel-meta.ts)')
  return out
}

const toolsOf = (keep: (name: AgentToolName) => boolean): Tool[] =>
  AGENT_TOOL_NAMES.filter(keep).map((n) => IMPLEMENTATIONS[n])
const inGroups =
  (...groups: AgentToolGroup[]) =>
  (n: AgentToolName) =>
    groups.includes(AGENT_TOOLS[n].group)

/** The Schedules tools are registered unless TALOS_APP_SCHEDULER=off; config_propose and retry_attachment stay either way. */
const NEEDS_SCHEDULER: AgentToolGroup[] = ['schedule']
/** Kept out of the main session's list: apps only when the owner turned them on (APPS below), worker only for a thread's own session. */
const NOT_MAIN: AgentToolGroup[] = ['apps', 'worker']
/** Every group but those, so a group added to AGENT_TOOL_GROUPS is registered without touching this file. */
export const mainGroups = (groups: readonly string[]): AgentToolGroup[] =>
  groups.filter((g) => !NOT_MAIN.includes(g as AgentToolGroup)) as AgentToolGroup[]
const MAIN_GROUPS = mainGroups(AGENT_TOOL_GROUPS)

/** The 12 tools of spec 4.4 plus the two mod-only tools. */
export const TOOLS: Tool[] = toolsOf(inGroups('core', 'mod'))

export const ALL_TOOLS: Tool[] = toolsOf(inGroups(...MAIN_GROUPS))

/** Option C worker mode (docs/OPTION-C.md): its own thread's tools only, plus `read_inbound`. */
export const WORKER_TOOLS: Tool[] = toolsOf((n) => AGENT_TOOLS[n].worker)

const WORKER_WITHOUT_SCHEDULER: Tool[] = toolsOf(
  (n) => AGENT_TOOLS[n].worker && !NEEDS_SCHEDULER.includes(AGENT_TOOLS[n].group),
)
const WITHOUT_SCHEDULER = toolsOf(inGroups(...MAIN_GROUPS.filter((g) => !NEEDS_SCHEDULER.includes(g))))
const APPS = toolsOf(inGroups('apps'))

export function toolsFor(env: {
  scheduler: string
  workerThread?: string | undefined
  apps?: boolean | undefined
}): Tool[] {
  if (env.workerThread) return env.scheduler === 'off' ? WORKER_WITHOUT_SCHEDULER : WORKER_TOOLS
  const base = env.scheduler === 'off' ? WITHOUT_SCHEDULER : ALL_TOOLS
  return env.apps ? [...base, ...APPS] : base
}

const LOCKED = new Set<string>(WORKER_THREAD_LOCKED_TOOLS)

/** A worker may only touch its own thread: the error names that thread and no other. */
function workerRefusal(ctx: BridgeContext, name: string, args: Record<string, unknown>): ToolResult | undefined {
  const own = ctx.worker?.thread
  if (!own) return undefined
  ctx.config.refresh()
  if (LOCKED.has(name) && threadSessionMode(ctx.config.config, own) !== 'dedicated')
    return fail(`Thread "${own}" no longer has its own session; the main session answers it now. Stop here.`)
  const asked = typeof args.thread_id === 'string' ? args.thread_id : args.chat_id
  if (LOCKED.has(name) && asked !== undefined && asked !== own)
    return fail(`This session belongs to thread "${own}" and can only post there. Valid thread ids: ${own}`)
  if (LOCKED.has(name) && asked === undefined) return fail(`thread_id is required. Valid thread ids: ${own}`)
  // cards: only what this session raised, checked before anything touches the shared ledger
  const raised = (id: unknown) =>
    typeof id !== 'string' || !ctx.ledger.get(id) || workerStoreOf(ctx).cardRaiser(id) === own
  if (name === 'card_result' && !raised(args.card_id))
    return fail(`card ${args.card_id} was not raised by this session`)
  if (name === 'card' && !raised(args.supersedes)) return fail(`card ${args.supersedes} was not raised by this session`)
  return undefined
}

/** Headless processes (scheduled `claude -p` jobs) get the rows marked `headless` in AGENT_TOOLS. */
const HEADLESS_OK = new Set<string>(HEADLESS_BRIDGE_TOOLS)

export async function callTool(ctx: BridgeContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = toolsFor(ctx.env).find((t) => t.name === name)
  if (!tool) return fail(`unknown tool ${name}`)
  if (ctx.worker) {
    const refused = workerRefusal(ctx, name, args)
    if (refused) return refused
  } else if (ctx.mode === 'headless' && (tool.liveOnly || !HEADLESS_OK.has(name))) {
    return fail(
      `${name} needs a live session (TALOS_APP_BRIDGE=1); in headless mode use reply, attach, card or list_threads`,
    )
  }
  try {
    return await tool.handler(ctx, args)
  } catch (e) {
    return fail((e as Error).message)
  }
}
