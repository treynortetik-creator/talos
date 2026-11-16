// "Always allow" (owner ruling 2026-11-14: "If it's sending anything external, you should be able to allow it and also have an
// option to always allow it ... just like it's in Claude Code"). A card of a send kind offers Always allow / Allow / Deny; an
// always-allowed kind is sent without a card, with a silent line in the thread (passes within 10 minutes fold into one). The list lives in config.json
// (`always_allow`): the owner's signed tap on a card, his signed change in Settings, or the agent when he asks in his own words
// (config_propose, blocked by "Lock Talos settings") are the only writers. Scope is per card kind; `destination` is reserved
// for a narrower scope later and is always null now.
import { z } from 'zod'
import { IsoTs } from './ids.ts'

/** The card kinds that send something outside: the ones a card offers "Always allow" for. */
export const SEND_KINDS = ['email', 'message', 'deploy', 'publish', 'purchase', 'push'] as const
export type SendKind = (typeof SEND_KINDS)[number]
export const isSendKind = (k: string): k is SendKind => (SEND_KINDS as readonly string[]).includes(k)

export const AlwaysAllowEntry = z.strictObject({
  kind: z.enum(SEND_KINDS),
  /** Reserved: a narrower scope (one recipient, one site) later. Always null now. */
  destination: z.null().default(null),
  /** When the owner's tap added it; absent when it came through config_propose. */
  added_at: IsoTs.optional(),
})
export type AlwaysAllowEntryT = z.infer<typeof AlwaysAllowEntry>

/** One entry per kind; an unreadable list reads as empty (nothing is allowed by accident). */
export const AlwaysAllowList = z
  .array(AlwaysAllowEntry)
  .max(SEND_KINDS.length)
  .refine((l) => new Set(l.map((e) => e.kind)).size === l.length, 'one entry per kind')

/** The bridge says it reads `always_allow` and takes `always` on a card answer: the app offers the button only then. */
export const ALWAYS_ALLOW_FEATURE = 'always-allow/1'

/**
 * Is `kind` always allowed in this list? Read when the agent's card call comes in, never cached. A git push used to be a
 * "deploy", so an older grant for deploy still covers push (never the other way: a push grant is only pushes).
 */
export const alwaysAllowed = (list: readonly AlwaysAllowEntryT[] | undefined, kind: string): boolean =>
  !!list?.some((e) => e.destination === null && (e.kind === kind || (kind === 'push' && e.kind === 'deploy')))
