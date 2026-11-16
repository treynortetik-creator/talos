import type { BridgeContext } from '../context.ts'
import { touchThread } from '../context.ts'

export type TextContent = { type: 'text'; text: string }
/** An image for the model (MCP `image` content): base64 data and its type. Only the screen tools send one. */
export type ImageContent = { type: 'image'; data: string; mimeType: string; text?: never }
export type ToolResult = { content: Array<TextContent | ImageContent>; isError?: boolean }
export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}
export type Tool = {
  name: string
  description: string
  inputSchema: JsonSchema
  /** Needs the relay socket (a live session). Headless processes answer these with an error. */
  liveOnly?: boolean
  handler: (ctx: BridgeContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export class ToolError extends Error {}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function needStr(args: Record<string, unknown>, key: string, max?: number): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') throw new ToolError(`${key} is required`)
  if (max !== undefined && v.length > max) throw new ToolError(`${key} is over ${max} characters`)
  return v
}

/** `reply`, `attach` and `card` accept `chat_id` as an alias for `thread_id` (agents used to other chat tools pass it). */
export function threadArg(ctx: BridgeContext, args: Record<string, unknown>): string {
  const id = str(args.thread_id) ?? str(args.chat_id)
  if (!id) throw new ToolError('thread_id is required')
  if (!ctx.config.thread(id)) {
    throw new ToolError(`Unknown thread "${id}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
  }
  touchThread(ctx, id)
  return id
}

/**
 * The thread for a tool that POSTS (`reply`, `attach`, `app_show`). An archived thread is refused: the app leaves it out of
 * the thread list and out of every badge, so a row stored there would say "sent" and never be seen. The error names the
 * default thread, where the agent can post it instead. Reading an archived thread stays allowed (`threadArg`).
 */
export function postThreadArg(ctx: BridgeContext, args: Record<string, unknown>): string {
  const asked = str(args.thread_id) ?? str(args.chat_id)
  const t = asked ? ctx.config.thread(asked) : undefined
  if (t?.archived) {
    const fallback = ctx.config.config.default_thread
    throw new ToolError(
      `Thread "${t.id}" is archived, so the owner would not see this there. Nothing was posted. ` +
        (fallback !== t.id && !ctx.config.thread(fallback)?.archived
          ? `Post it to "${fallback}" instead and say it is about "${t.name}".`
          : 'Ask the owner to unarchive it.'),
    )
  }
  return threadArg(ctx, args)
}

export const threadProps = {
  thread_id: {
    type: 'string',
    description: 'Thread id from list_threads, passed back unchanged from the notification.',
  },
  chat_id: { type: 'string', description: 'Alias for thread_id.' },
}
