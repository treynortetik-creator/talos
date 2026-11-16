// Main's state in one line, for a reader with no terminal and no bridge (the Windows tray reads it as root through
// `talos-wsl.sh status`): `$TALOS_APP_HOME/run/main-state`, rewritten atomically whenever the supervisor publishes Main's
// status. Derived from the same MainStatus the supervisor writes to its status file, so the two never disagree.
//   main=running            the input box is up
//   main=starting           spawned, restarting, or cleaning up after an exit
//   main=stopped            stopped (by the owner, a crash loop, a start that failed)
//   main=signin             Claude Code is not signed in, or its token was refused: the tray offers "Sign in"
//   main=waiting:<kind>     a screen the supervisor does not answer on its own (theme, security_notes, trust, mcp_consent, dev_channels, api_key,
//                           bypass, unknown); for `unknown` a second line holds the first 200 characters of the screen
import { join } from 'node:path'
import type { MainStatus } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'

export const MAIN_STATE_FILE = join('run', 'main-state')

export type MainWaitingKind =
  | 'theme'
  | 'security_notes'
  | 'trust'
  | 'mcp_consent'
  | 'dev_channels'
  | 'api_key'
  | 'bypass'
  | 'unknown'

/** What the supervisor knows besides its status: sign-in trouble it saw, and the screen behind an unknown wait. */
export interface MainStateExtras {
  /** Claude Code said it is not signed in, or a token was refused (a 401 at start). */
  signin?: boolean
  /** A first-start screen the supervisor saw and did not answer, by kind. */
  waiting?: MainWaitingKind
  /** The rows of the screen behind a `waiting:unknown`. */
  screen?: readonly string[]
}

/** The file's text: one line, and a second for `waiting:unknown`. */
export function mainStateText(s: MainStatus, x: MainStateExtras = {}): string {
  const line = mainStateLine(s, x)
  if (line !== 'main=waiting:unknown') return `${line}\n`
  const excerpt = screenExcerpt(x.screen ?? [])
  return excerpt ? `${line}\n${excerpt}\n` : `${line}\n`
}

function mainStateLine(s: MainStatus, x: MainStateExtras): string {
  if (x.signin) return 'main=signin'
  const n = s.needsYou
  if (n?.kind === 'dialog') {
    if (n.dialog === 'login') return 'main=signin'
    if (n.dialog === 'trust' || n.dialog === 'mcp_consent' || n.dialog === 'dev_channels')
      return `main=waiting:${n.dialog}`
    return `main=waiting:${x.waiting ?? 'unknown'}`
  }
  if (n?.kind === 'confirm_cold_start' || n?.kind === 'restart_not_confirmed') return 'main=waiting:dev_channels'
  if (x.waiting) return `main=waiting:${x.waiting}`
  if (n?.kind === 'start_stalled') return 'main=waiting:unknown'
  switch (s.phase) {
    case 'running':
      return 'main=running'
    case 'starting':
    case 'cleaning_up':
    case 'waiting_to_restart':
      return 'main=starting'
    default:
      return 'main=stopped'
  }
}

/**
 * At most 200 characters of the screen, for a reader to show: control and invisible characters dropped, runs of blanks and
 * box drawing folded to one space, and anything token-shaped (an Anthropic key, a JWT, a long run of base64 or hex) replaced
 * by `[redacted]`. The screen is Claude Code's, and a pasted token or a URL with a code in it must never reach a file the tray
 * shows.
 */
export function screenExcerpt(rows: readonly string[]): string {
  const text = rows
    .join(' ')
    .replace(ANSI, '')
    .replace(INVISIBLE, ' ')
    .replace(BOX_DRAWING, ' ')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, '[redacted]')
    .replace(/[?&](code|state|token|access_token|code_challenge)=[^\s&]+/gi, (m) => `${m.split('=')[0]}=[redacted]`)
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return [...text].slice(0, 200).join('')
}

// written as escapes, never as the characters themselves (U+2028 inside a regex literal would end the line)
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is dropped
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence starts with ESC
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const BOX_DRAWING = /[\u2500-\u259f\u2800-\u28ff]+/g

/** Writes the state file (0600: the tray reads it as root), atomically, so a reader never sees half a line. */
export function writeMainState(talosHome: string, text: string): void {
  writeFileAtomic(join(talosHome, MAIN_STATE_FILE), text, 0o600)
}

/**
 * What Claude Code showed the owner at a first start without them (its security notes), for the tray's Setup and the owner's
 * first look: `run/first-start-notes`, a heading line and the screen's lines, control characters dropped, token-shaped text
 * redacted, at most 40 lines of 200 characters. Written once, when the supervisor answers the screen; never read back here.
 */
export const FIRST_START_NOTES_FILE = join('run', 'first-start-notes')

export function firstStartNotesText(text: readonly string[], at: Date): string {
  const lines = text.slice(0, 40).map((r) => screenExcerpt([r]))
  return `Claude Code showed its security notes on first start (${at.toISOString()}); the supervisor pressed Enter:\n${lines.join('\n')}\n`
}

export function writeFirstStartNotes(talosHome: string, text: readonly string[], at = new Date()): void {
  writeFileAtomic(join(talosHome, FIRST_START_NOTES_FILE), firstStartNotesText(text, at), 0o600)
}
