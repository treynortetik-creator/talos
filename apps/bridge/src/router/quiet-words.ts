// What the owner reads when a thread's session has read his message and then gone quiet (router/quiet-watch.ts), in ONE place. Final
// wording (Pantheon, 2026-11-26). The "Open terminal" button's label is the app's own (apps/web .../messageActionWords.ts): the
// message only names the action.
export const QUIET = {
  /** `<agent>` is the thread's name, as the app shows it. */
  text: (agent: string) =>
    `${agent} has been quiet for 5 minutes and isn't doing anything. Open its terminal to see what's going on.`,
  /**
   * The "stopped before it answered" notice (router.ts reportUnanswered) for a message the owner was ALREADY told was quiet: he has heard
   * that it was not answering, so this says only what changed.
   */
  stoppedAfter: (agent: string) =>
    `${agent} has stopped and still hasn't answered. Send your message again to carry on.`,
} as const
