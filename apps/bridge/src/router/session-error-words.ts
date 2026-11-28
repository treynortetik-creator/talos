// Everything the owner reads about a thread session that stopped on an API error or a refusal (router/session-error-*.ts), in ONE
// place. The words are PROVISIONAL (the owner may change them): change them here and nowhere else. Every line is built from the
// fixed phrases below; nothing from the transcript's own text is ever put in one.
import { say } from '../owner-words.ts'

/** What went wrong, in the bridge's own kinds (session-error-watch.ts `classify`). `auth` has no card: it gets a plain line. */
export type ErrorKind = 'refusal' | 'too_big' | 'servers' | 'rate' | 'auth' | 'other'
/** Why a refusal happened, from the fixed list of categories Claude Code names (anything else is `other`). */
export type RefusalReason = 'biology' | 'cybersecurity' | 'other'
/** For the `other` kind: a fixed word for what failed. */
export type OtherWhat = 'billing' | 'model not found' | 'reply too long' | 'unknown'

/** The two buttons. */
export const BUTTONS = { retry: 'Retry', clear: 'Clear session' } as const
/** The one button a card without a message to send again has next to Clear session. */
export const DISMISS_BUTTON = 'Dismiss'

/** The card's title: `<thread name> stopped: <what>`. */
export const TITLE_WHAT: Record<Exclude<ErrorKind, 'auth'>, string> = {
  refusal: 'safety filter',
  too_big: 'too big',
  servers: 'servers',
  rate: 'rate limit',
  other: 'request failed',
}
export const title = (name: string, kind: Exclude<ErrorKind, 'auth'>): string => `${name} stopped: ${TITLE_WHAT[kind]}`

/** The card's one-line summary. */
export const SUMMARY = 'The last turn ended on an error.'

/** The card body, by kind. */
export const BODY = {
  refusal: (why: RefusalReason) =>
    `Claude's safety filter stopped the last message (reason: ${why}). Asking again will usually stop the same way. Clearing starts a fresh conversation; the old one is kept.`,
  too_big:
    'The conversation or a file in it is too big for Claude to take. Clearing starts a fresh conversation; the old one is kept.',
  servers: "Claude's servers had a problem. Usually temporary.",
  rate: 'Claude wants a short pause. Try again in a minute.',
  other: (what: OtherWhat) => `The last request failed (${what}). Retry once; if it fails again, clear the session.`,
} as const

/** Signed out: no card, one plain line (the supervisor's own sign-in path does the rest). */
export const AUTH_LINE = () =>
  say({
    mac: 'Claude is signed out for this thread. Sign in to Claude on your Mac, then send your message again.',
    linux: 'Claude is signed out for this thread. Sign in to Claude on your computer, then send your message again.',
    windows: 'Claude is signed out for this thread. Sign in to Claude on your PC, then send your message again.',
  })

/** Shown on a card whose first button sends the message again. */
export const RETRY_WARNING =
  'Sending it again repeats the whole request, including anything the agent had already done.'

/** What the card says after a tap. */
export const RESULT = {
  cleared: 'Started a fresh conversation. The old one is kept. Your last message was not sent again.',
  retried: 'Sent your last message again.',
  failed: (reason: string) => `Talos could not do that: ${reason}.`,
  dismissed: 'Left as it is.',
  notFromHere: 'Open the card in the app to answer it.',
  /** The thread's session changed since the card was made: the card is old. */
  stale: 'This thread has a different session now, so nothing was done.',
  /** The thread went on after the failure this card is about. */
  movedOn: 'This has moved on; nothing was done.',
  gone: "Talos no longer holds that message, so it can't be sent again. Send it again yourself.",
  already: 'It was already sent again.',
  /** The original was already taken by the main session (its time to wait passed): nothing is sent again. */
  mainAnswered: 'The main session already answered it.',
  /** Retry when the thread's own session cannot take a message now (stopping, failed, a start the usage limits block, no longer its own). */
  notRunning: "the thread's session isn't running right now",
  /** The router gave the message to the main session after all. */
  sentToMain: 'Sent to the main session instead.',
  busy: 'This thread is working on something, so nothing was done.',
} as const

/** Line put before the message when it is sent again (main-resend.ts `redelivered`). */
export const RETRY_REDELIVERED_PREFIX =
  "(Talos sent this again because the last turn stopped on an error. If you already did part of it, don't do it twice.)"

/** The plain line posted when a card cannot be shown: never silent. */
export const plainLine = (name: string, kind: Exclude<ErrorKind, 'auth'>, body: string): string =>
  `${title(name, kind)}. ${body}`
