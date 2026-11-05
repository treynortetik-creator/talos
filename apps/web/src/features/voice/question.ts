// What the app signs when the voice model hands a task to the agent (spec 6.3 step 2). Pure, so it is easy to test.

export type Utterance = { who: 'owner' | 'agent'; text: string; at: number }

export const QUESTION_MAX_CHARS = 4000
export const TAIL_TURNS = 20
export const TAIL_TURN_CHARS = 1000
export const FALLBACK_WINDOW_MS = 60_000

/**
 * `utterances` is everything said so far, oldest first, with any unfinished turn included as the last item.
 * The question is what the owner said since the previous delegation, else in the last 60 s. Empty means: nothing to ask.
 */
export function buildAsk(args: { utterances: readonly Utterance[]; lastDelegationAt: number | null; now: number }): {
  question: string
  transcriptTail: Array<{ who: 'owner' | 'agent'; text: string }>
} {
  const owner = args.utterances.filter((u) => u.who === 'owner' && u.text.trim())
  let picked = args.lastDelegationAt === null ? [] : owner.filter((u) => u.at > (args.lastDelegationAt as number))
  if (picked.length === 0) picked = owner.filter((u) => args.now - u.at <= FALLBACK_WINDOW_MS)
  const joined = picked
    .map((u) => u.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
  const question = joined.length > QUESTION_MAX_CHARS ? joined.slice(joined.length - QUESTION_MAX_CHARS) : joined
  const transcriptTail = args.utterances
    .filter((u) => u.text.trim())
    .slice(-TAIL_TURNS)
    .map((u) => ({ who: u.who, text: u.text.trim().slice(0, TAIL_TURN_CHARS) }))
  return { question, transcriptTail }
}
