// What the owner reads when a session is waiting on him in a way that has no card (the Notification hook, kit/hooks/notification-relay.py), in ONE
// place. Fixed words: the notification's own text is never forwarded. The "Open terminal" button's label is the app's own; the message only names
// the action. `agent` is the thread's name, as the app shows it.
export const NEEDS_YOU_NOTICE = {
  /** `elicitation_dialog` in a thread's session: a server asked the owner something at the terminal. */
  ask: (agent: string) => `${agent} asked you something at its terminal. Open it to answer.`,
  /** The same in the main session (the default thread's name would not say it is the main agent). */
  askMain: 'The main agent asked you something at its terminal. Open it to answer.',
} as const
