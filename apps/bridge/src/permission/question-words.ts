// The words of the open-question cards (permission/question.ts), in ONE place. NO_ANSWER_YET is what the AGENT is told for a question nobody
// answered in time: exactly these words (Pantheon's decision). The others are what the owner's card says.
/** The agent's answer to a question nobody answered within the time. Claude Code frames every answer as "The user answered: ...", so the
 *  words open by saying the owner did not answer and that this is Talos (Pantheon 11-26); then it can go on and ask again later. */
export const NO_ANSWER_YET =
  '(No answer from the owner. This is Talos, not the owner.) No answer yet; carry on with other work and ask again later.'
/** The button that takes the owner's own words (AskUserQuestion always offers one). */
export const OTHER_LABEL = 'Other…'
/** What a card says once its answer was handed to the agent. */
export const SENT_TEXT = 'Sent to Claude Code'
