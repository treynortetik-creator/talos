import type { BridgeContext } from '../context.ts'
import { touchThread } from '../context.ts'

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
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

export const threadProps = {
  thread_id: {
    type: 'string',
    description: 'Thread id from list_threads, passed back unchanged from the notification.',
  },
  chat_id: { type: 'string', description: 'Alias for thread_id.' },
}
