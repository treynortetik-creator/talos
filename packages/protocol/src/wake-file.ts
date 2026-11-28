// The wake file (hub writes `workers/<thread>/wake` and `control`, the supervisor consumes them). Moved out of thread-sessions.ts,
// which re-exports it, so that file stays under 1,000 lines. No change: the same schema.
import { z } from 'zod'
import { IsoTs, ThreadId } from './ids.ts'

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
