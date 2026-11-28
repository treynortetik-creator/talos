// Every word the read-only terminal view shows, in one place (docs/CHANGELOG.md, "Watch your agent's terminal"). The card is fixed
// app UI: nothing an agent writes can make, fill in or point at it, and one tap opens one view.
import type { TermCloseWhy } from '@talos-app/protocol'

export const TERM_WORDS = {
  cardTitle: "Watch your agent's terminal",
  // This piece has no indicator on the Mac, so it claims none (the Mac app's "remote viewer open" window is a later piece).
  cardLine: 'Read-only. Nothing you do here types into it.',
  pickerLabel: 'Which terminal',
  main: 'Main',
  watch: 'Watch',
  watchAgain: 'Watch again',
  opening: 'Opening…',
  close: 'Close',
  footer: "You're watching. Nothing you do here types into the terminal.",
  terminalLabel: 'Terminal output, read-only',
  catchingUp: 'Catching up',
  watching: 'Watching',
  needsUpdate: 'Update Talos on your Mac to watch its terminal.',
  relayNeedsUpdate: 'This relay needs an update before it can show the terminal.',
  macAway: "Your Mac isn't connected. You can watch its terminal when it is.",
  unpinned: 'Waiting for your Mac to confirm this device.',
  loadFailed: "The terminal couldn't load. Try again.",
} as const

/** `<name>'s terminal`: the header. */
export const terminalTitle = (name: string): string => `${name}'s terminal`

/** The time left, as the header says it. */
export function timeLeft(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'closing'
  if (secondsLeft < 60) return 'under 1 min'
  return `${Math.ceil(secondsLeft / 60)} min`
}

const ENDED: Record<string, string> = {
  idle: 'The terminal closed after 10 minutes with nobody looking at it.',
  max: 'The terminal closed after an hour, the longest one stays open.',
  pane_gone: "The agent's terminal ended.",
  no_pane: 'That agent has no terminal running right now.',
  resized: 'The terminal was resized on your Mac, so it closed.',
  socket_closed: 'The connection dropped, so the terminal closed.',
  mac_offline: 'Your Mac went away, so the terminal closed.',
  restart: "Your Mac's Talos restarted, so the terminal closed.",
  revoked: 'This device was removed, so the terminal closed.',
  keyframe: 'The terminal kept needing a fresh picture, so it closed.',
  too_many: 'Four terminals are already open. Close one first.',
  unsupported: TERM_WORDS.needsUpdate,
  refused: "Your Mac didn't accept that. Check this device's clock and try again.",
}

/** Why a view ended, in words. `closed` (the owner's own Close) has none: the card just comes back. */
export function endedWords(why: TermCloseWhy | string): string | null {
  if (why === 'closed') return null
  return ENDED[why] ?? 'The terminal closed.'
}
