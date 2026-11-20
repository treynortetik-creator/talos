// Setting thread agents up (owner ruling 2026-11-19): Main creates threads with their own session, folder, model, MCP list and
// instructions, including sub-threads; a thread's own session does the same for ITS sub-threads. One function per tool, each taking
// `scope` (the thread session that asks, proven by the hub; absent for Main). The proposal goes through config_propose's service,
// which judges who may touch what (the protocol's scopeIssue), the folder on disk, and the gate (setup-gate.ts); the instructions
// are written only into the target thread's own folder, through the owner's no-follow AGENTS.md save.
import { Buffer } from 'node:buffer'
import { AGENTS_MD_WORDING, isInheritedName, THREAD_TOPIC_MAX, ThreadId, undoText } from '@talos-app/protocol'
import { folderWithin } from '../config-propose/folder-check.ts'
import { strictlyQuiet } from '../config-propose/setup-gate.ts'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { lastOwnerThread, SETTINGS_LOCKED } from '../trust.ts'
import { ReadError } from '../v2-seams.ts'
import { fail, ok, str, type Tool, ToolError, type ToolResult } from './common.ts'

type Ctx = Parameters<Tool['handler']>[0]

/** The most an agent writes into a thread's AGENTS.md in one call (the owner's own editor takes up to AGENTS_MD_MAX_BYTES). */
export const AGENT_INSTRUCTIONS_MAX_BYTES = 32 * 1024

export const SETUP_PROPS = {
  parent_id: {
    type: 'string',
    description:
      'Make this a sub-thread of that thread (one level deep). A thread session must give ITS OWN thread id here; Main may name any thread.',
  },
  session: {
    type: 'boolean',
    description:
      "true: the thread gets its own session (its own Claude conversation; it uses the owner's Claude plan). Needs a folder (a sub-thread may share its parent's).",
  },
  folder: {
    type: 'string',
    description:
      "The folder its session works in: an absolute path to a folder that already exists, inside the owner's home and not in ~/.claude or the Talos data. A thread session's sub-thread must be inside its parent's folder. Nothing is created for you.",
  },
  color: { type: 'string' },
  model: { type: 'string', description: 'A model the app offers, or "inherit".' },
  effort: { type: 'string' },
  mcp: {
    type: 'array',
    items: { type: 'string' },
    description:
      "The MCP servers its session may use (up to 32 names; [] for none). A sub-thread gets no more than its parent's.",
  },
  idle_park_min: { type: 'number', description: 'Minutes idle before its session parks (5 to 720).' },
  instructions: {
    type: 'string',
    description: `Its AGENTS.md text (up to ${AGENT_INSTRUCTIONS_MAX_BYTES / 1024} KB), written into its own folder once the thread exists. Only when the thread has its own session and its own folder.`,
  },
} as const

/** What a proposal says to do with the thread's setup fields, only the ones the caller gave. */
function setupValue(args: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  const parent = str(args.parent_id)
  if (parent !== undefined) v.parent = parent
  if (args.session === true) v.session = 'dedicated'
  const folder = str(args.folder)
  if (folder !== undefined) v.session_opts = { cwd: folder }
  for (const [from, to] of [
    ['color', 'color'],
    ['model', 'model'],
    ['effort', 'effort'],
  ] as const) {
    const s = str(args[from])
    if (s !== undefined) v[to] = s
  }
  if (args.mcp !== undefined) {
    if (!Array.isArray(args.mcp) || args.mcp.some((x) => typeof x !== 'string'))
      throw new ToolError('mcp must be a list of server names')
    v.mcp_allow = args.mcp
  }
  if (args.idle_park_min !== undefined) {
    if (typeof args.idle_park_min !== 'number') throw new ToolError('idle_park_min must be a number of minutes')
    v.idle_park_min = args.idle_park_min
  }
  return v
}

/**
 * A `config_propose` of one change, from the tool's own say-so. The card goes to the thread the owner asked in (Main: `asked`, else the
 * one he spoke in last, else the default thread), or to the thread session's own thread (`scope`).
 */
export async function proposeThreadChange(
  ctx: Ctx,
  asked: string | undefined,
  args: Record<string, unknown>,
  changes: Array<{ path: string; value: unknown }>,
  defaultReason: string,
  scope?: string,
) {
  if (!ctx.configProposals) throw new ToolError('Settings proposals are not available in this process.')
  const reason = str(args.reason)?.trim() || defaultReason
  return ctx.configProposals.propose(
    {
      thread_id: scope ?? asked ?? lastOwnerThread(ctx) ?? ctx.config.config.default_thread,
      reason,
      changes,
    },
    { tool: true, ...(scope !== undefined ? { scope } : {}) },
  )
}

export function slugId(ctx: Ctx, name: string, given: string | undefined, slug: (n: string) => string): string {
  const taken = new Set(ctx.config.config.threads.map((t) => t.id))
  if (given !== undefined) {
    if (!ThreadId.safeParse(given).success) {
      let hint = slug(given)
      for (let n = 2; taken.has(hint) || hint === 'all'; n++)
        hint = `${slug(given).slice(0, 31 - String(n).length)}_${n}`
      throw new ToolError(
        `id ${JSON.stringify(given.slice(0, 64))} is not a thread id: a lowercase letter, then up to 31 lowercase letters, digits or underscores (^[a-z][a-z0-9_]{0,31}$; no hyphens), and not "all". Try "${hint}", or leave id out and it is made from the name.`,
      )
    }
    if (given.startsWith('talos__'))
      throw new ToolError('ids starting with "talos__" are reserved for the app; pick another')
    if (isInheritedName(given)) throw new ToolError(`id "${given}" is a name every object already has; pick another`)
    if (taken.has(given)) throw new ToolError(`thread id "${given}" is already taken`)
    return given
  }
  const base = slug(name)
  let id = base
  for (let n = 2; taken.has(id) || id === 'all'; n++) id = `${base.slice(0, 29)}_${n}`
  return id
}

/** `create_thread`, for Main (no scope) or a thread session (scope = its thread). One atomic proposal creates and configures it. */
export async function createThreadAs(
  ctx: BridgeContext,
  args: Record<string, unknown>,
  name: string,
  id: string,
  scope?: string,
): Promise<ToolResult> {
  const icon = str(args.icon)?.trim().slice(0, 16)
  const topic = str(args.topic)?.trim().slice(0, THREAD_TOPIC_MAX)
  const asked = str(args.thread_id)
  if (scope === undefined && asked !== undefined && !ctx.config.thread(asked))
    throw new ToolError(`Unknown thread "${asked}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
  const instructions = str(args.instructions)
  if (instructions !== undefined && Buffer.byteLength(instructions) > AGENT_INSTRUCTIONS_MAX_BYTES)
    throw new ToolError(`instructions are over ${AGENT_INSTRUCTIONS_MAX_BYTES / 1024} KB`)
  const r = await proposeThreadChange(
    ctx,
    asked,
    args,
    [
      {
        path: `threads.${id}`,
        value: { name, ...(icon ? { icon } : {}), ...(topic ? { topic } : {}), ...setupValue(args) },
      },
    ],
    `The agent wants a thread "${name}" for this topic.`,
    scope,
  )
  if (!r.ok) return fail(r.text)
  if (!r.text.startsWith('Saved.'))
    return ok(
      `${r.text}. Thread ${id} (${name}) is created when the owner approves the card.${
        instructions !== undefined
          ? ` Its instructions are not written yet: call set_thread_instructions for ${id} once it exists.`
          : ''
      }`,
    )
  const made = `created thread ${id} (${name}). ${undoText([{ path: `threads.${id}`, old: null, new: null }])}`
  if (instructions === undefined) return ok(made)
  const w = await setInstructionsAs(ctx, { id, text: instructions }, scope)
  return ok(`${made} Instructions: ${w.content[0]?.type === 'text' ? w.content[0].text : ''}`)
}

const lockedText = `${SETTINGS_LOCKED} The owner can unlock them in Settings, or edit the thread's instructions there.`
const outsideText =
  "Something from outside reached the agent since the owner last spoke, so the instructions are not written for you now. The owner can ask again in his own words, or edit them in the thread's settings."

/**
 * `set_thread_instructions`: AGENTS.md of a thread with its own folder, through the owner's save (no link followed, written to a new
 * file and renamed over, the old text kept as agents-md.prev). Main: any thread. A thread session: its own sub-threads only (its own
 * instructions are the owner's). With the lock on, or when anything outside reached the agent since the owner last spoke, it is
 * refused (there is no card for a file write; the owner edits it in the thread's settings).
 */
export async function setInstructionsAs(
  ctx: BridgeContext,
  args: Record<string, unknown>,
  scope?: string,
): Promise<ToolResult> {
  try {
    const id = str(args.id)
    const text = str(args.text)
    if (!id || text === undefined) throw new ToolError('id and text are required')
    const t = ctx.config.thread(id)
    if (!t) throw new ToolError(`Unknown thread "${id}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
    if (t.archived) throw new ToolError(`thread ${id} is archived`)
    if (scope !== undefined && (t.parent_id !== scope || id === scope))
      throw new ToolError(
        `This session belongs to thread "${scope}" and can write the instructions of its own sub-threads only; its own are the owner's. Nothing was written.`,
      )
    if (Buffer.byteLength(text) > AGENT_INSTRUCTIONS_MAX_BYTES)
      throw new ToolError(`instructions are over ${AGENT_INSTRUCTIONS_MAX_BYTES / 1024} KB. Nothing was written.`)
    // a thread session writes only into a folder inside its own, by the real paths and whole segments (the owner may have put a
    // sub-thread's folder elsewhere); Main is unchanged
    if (scope !== undefined) {
      const mine = ctx.config.thread(scope)?.session_opts?.cwd
      const theirs = t.session_opts?.cwd
      if (!mine || !theirs || !folderWithin(theirs, mine, true))
        throw new ToolError(
          `thread ${id}'s folder is not inside this session's own folder, so only the owner or Main can write its instructions. Nothing was written.`,
        )
    }
    const svc = ctx.agentsMd
    if (!svc) throw new ToolError('Thread instructions are not available in this process.')
    ctx.config.refresh()
    if (ctx.config.config.settings_lock === true) throw new ToolError(lockedText)
    if (!strictlyQuiet(ctx, scope)) throw new ToolError(outsideText)
    try {
      const now = await svc.read({ thread_id: id })
      if (now.too_large) throw new ToolError('its AGENTS.md is too large to replace from here. Nothing was written.')
      await svc.write({ thread_id: id, text, base_sha: now.exists ? (now.sha ?? null) : null })
      const replaced = now.exists
      const line = `Changed the instructions of ${t.name} (AGENTS.md in its own folder, ${Buffer.byteLength(text)} bytes).${
        replaced
          ? " To undo: the text before is kept as agents-md.prev in the thread's records, and the thread's settings show what changed."
          : " To undo: clear the instructions in the thread's settings."
      }`
      await postSystemNotice(ctx, line, {
        thread: threadRef(ctx, scope ?? id),
      }).catch(() => {})
      return ok(`${line}`)
    } catch (e) {
      if (e instanceof ReadError) {
        const m =
          e.message === AGENTS_MD_WORDING.shared ? `${e.message} It needs a folder of its own first.` : e.message
        throw new ToolError(`${m} Nothing was written.`)
      }
      throw e
    }
  } catch (e) {
    return fail((e as Error).message)
  }
}
