// Every sentence the screen-reader announcer says (lib/announce.ts), in one place. test/lib/announce.test.ts pins each one, so a
// rewording is a deliberate edit. Short and plain: what happened, and what the owner can do about it.
export const ANNOUNCE = {
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  sent: 'Sent',
  savedOffline: "Saved. It sends when you're back online.",
  savedUnapproved: 'Saved. It sends once this device is approved.',
  revisionSent: 'Revision sent',
  messageSentAgain: 'Message sent again',
  markedDone: 'Marked done. Undo is available',
  snoozed: 'Snoozed. Undo is available',
} as const

/**
 * What a send says, from the send's own result: `sentWords` when it went, else that it waits (offline, or this device not yet
 * approved). One rule for the message box and the Stopped strip's Undo, so neither claims a send that only joined the outbox.
 */
export const sendResultWords = (state: 'sent' | 'queued' | 'held_unpinned' | string, sentWords: string) =>
  state === 'sent' ? sentWords : state === 'held_unpinned' ? ANNOUNCE.savedUnapproved : ANNOUNCE.savedOffline

/** A card was answered: the label of the button the owner pressed. */
export const answered = (label: string) => `Answered: ${label}`
/** A stop went through; `undo` is whether the strip offers Undo. */
export const stopped = (agent: string, undo: boolean) =>
  undo ? `Stopped ${agent}. Undo is available` : `Stopped ${agent}`
/** A card on a thread other than the open one needs the owner. */
export const needsYou = (thread: string) => `${thread} needs you`
/** Several threads need the owner at once. */
export const threadsNeedYou = (count: number) => `${count} threads need you`

/** The sources a message is announced under: a newer message from the same source replaces one still waiting. */
export const SOURCE = {
  copy: 'copy',
  sent: 'sent',
  stop: 'stop',
  undo: 'undo',
  inboxUndo: 'inbox-undo',
  needsYou: 'needs-you',
  card: (id: string) => `card:${id}`,
} as const
