// The plain explanation on a permission card. A second, independent model reads only the command and Claude's own
// description of it and writes one or two plain sentences plus one risk tag (docs/CLAUDE-CODE.md "Plain explanation").
// It rides beside the card, never in it: it is not part of the binding, so it cannot change the payload hash or what the
// owner approves, and `permissionCardAllowsPrimary` never looks at it. An older reader ignores the field.
import { z } from 'zod'

/** Least to most severe: the position in this list is the rank, so "the more severe of two tags" is the later one. */
export const EXPLAIN_TAGS = ['Reads files', 'Changes files', 'Sends over the internet', 'Installs', 'Deletes'] as const
export type ExplainTag = (typeof EXPLAIN_TAGS)[number]
export const ExplainTagSchema = z.enum(EXPLAIN_TAGS)

/** The longest sentence a card carries (the model's own is capped lower; the bridge may add one short clause). */
export const EXPLAIN_SENTENCE_MAX = 700
/** A pending explanation older than this (from the card's creation) is shown as failed: the update was lost or never sent. */
export const EXPLAIN_GIVE_UP_MS = 15_000
export const EXPLAIN_FAILED_TEXT = "Couldn't explain this one"
export const EXPLAIN_MISMATCH_SUFFIX = "Doesn't match"

export const PermissionExplain = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('ready'),
    tag: ExplainTagSchema,
    mismatch: z.boolean(),
    sentence: z.string().min(1).max(EXPLAIN_SENTENCE_MAX),
  }),
  z.object({ status: z.literal('failed') }),
])
export type PermissionExplainT = z.infer<typeof PermissionExplain>

export function moreSevereTag(a: ExplainTag, b: ExplainTag): ExplainTag {
  return EXPLAIN_TAGS.indexOf(b) > EXPLAIN_TAGS.indexOf(a) ? b : a
}

/** The chip text: the tag, or "<Tag> · Doesn't match". */
export function explainChip(e: { tag: ExplainTag; mismatch: boolean }): string {
  return e.mismatch ? `${e.tag} · ${EXPLAIN_MISMATCH_SUFFIX}` : e.tag
}

export type ExplainShown =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'failed' }
  | { kind: 'ready'; explain: Extract<PermissionExplainT, { status: 'ready' }> }

/** What a card should show now: nothing (no explainer), waiting, failed (or waiting for too long), or the explanation. */
export function explainShown(explain: PermissionExplainT | undefined, createdAt: string, now: number): ExplainShown {
  if (!explain) return { kind: 'none' }
  if (explain.status === 'ready') return { kind: 'ready', explain }
  if (explain.status === 'failed') return { kind: 'failed' }
  return now - Date.parse(createdAt) >= EXPLAIN_GIVE_UP_MS ? { kind: 'failed' } : { kind: 'waiting' }
}
