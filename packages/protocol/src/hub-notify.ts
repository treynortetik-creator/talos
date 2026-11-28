// hook → hub: a Claude Code `Notification` hook (kit/hooks/notification-relay.py) says a session is waiting on the owner in a way that has no card:
// `ask` (an elicitation dialog). (Claude Code's idle prompt is NOT one: it fires after every answered turn. FOLLOWUPS.) The line carries the KIND and the proof of who asks, never the notification's
// own text: the bridge writes the sentence itself (apps/bridge/src/permission/needs-you-words.ts), so nothing a session sends is ever shown as text.
// Proof is the same as `perm`: a thread session names its thread, pid and nonce; the main session names none.
import { z } from 'zod'
import { ThreadId } from './ids.ts'

export const NEEDS_YOU_KINDS = ['ask'] as const
export type NeedsYouKindT = (typeof NEEDS_YOU_KINDS)[number]

export const HubNotify = z.looseObject({
  t: z.literal('notify'),
  id: z.string().min(1).max(64),
  kind: z.enum(NEEDS_YOU_KINDS),
  thread_id: ThreadId.optional(),
  pid: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(64).optional(),
  cwd: z.string().max(1000).optional(),
  session_id: z.string().max(100).optional(),
})
export type HubNotifyT = z.infer<typeof HubNotify>
