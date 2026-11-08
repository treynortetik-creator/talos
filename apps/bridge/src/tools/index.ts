import { threadSessionMode } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { fail, type Tool, type ToolResult } from './common.ts'
import { AGENT_TOOL_GROUPS, type AgentToolGroup } from './define.ts'
import { workerStoreOf } from './read-inbound.ts'
import { AGENT_TOOLS, HEADLESS_BRIDGE_TOOLS, TOOL_RECORDS, tableProblems, WORKER_THREAD_LOCKED_TOOLS } from './table.ts'

/** What does not fit in the table of agent tools (table.ts), for anything the types cannot see. Empty when all is well. server.ts calls it once its logger exists and refuses to start on any line, so the owner finds it in bridge.log (an error thrown at import came before the logger and never reached it). */
export const toolTableProblems = tableProblems

const toolsOf = (keep: (name: string) => boolean): Tool[] => TOOL_RECORDS.filter((t) => keep(t.name))
const inGroups =
  (...groups: AgentToolGroup[]) =>
  (n: string) =>
    groups.includes(AGENT_TOOLS[n]?.group as AgentToolGroup)

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
export const WORKER_TOOLS: Tool[] = toolsOf((n) => AGENT_TOOLS[n]?.worker === true)

const WORKER_WITHOUT_SCHEDULER: Tool[] = toolsOf(
  (n) => AGENT_TOOLS[n]?.worker === true && !NEEDS_SCHEDULER.includes(AGENT_TOOLS[n].group),
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
