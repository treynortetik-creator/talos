// Reading what the phone received. Kept apart from the driver so the one rule that decides "did my message get an answer"
// can be tested on its own.
export type Raw = Record<string, unknown>

/**
 * The rows by `author` in `thread` that arrived after the relay acknowledged the frame `id`. A row from before the ack
 * (a reply to an earlier message that was still on its way, a notice) is never an answer to this message; with no ack
 * there is nothing to count from, so nothing counts. This is "the next thing the agent said in this thread", which is
 * what an owner sees; `reply_to` on a row, when the agent set it, names the message it answers.
 */
export function rowsAfterAck(frames: Raw[], id: string, thread: string, author: 'agent' | 'system'): Raw[] {
  const ack = frames.findIndex((f) => f.type === 'ack' && f.ref === id)
  if (ack < 0) return []
  return frames
    .slice(ack + 1)
    .filter((f) => f.type === 'reply' || f.type === 'message.stored')
    .map((f) => f.message as Raw | undefined)
    .filter((m): m is Raw => m?.thread_id === thread && m.author === author)
}
