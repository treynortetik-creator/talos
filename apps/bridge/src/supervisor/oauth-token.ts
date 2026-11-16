// Claude Code's sign-in for an install with no terminal (the Windows tray): the tray signs the owner in on Windows and writes the
// long-lived token to `$TALOS_APP_HOME/claude-oauth-token` in the distro (temp file + rename, 0600, one line). The supervisor
// passes it to Main and the thread sessions as CLAUDE_CODE_OAUTH_TOKEN, and restarts Main when it changes while Main shows
// signed out. The token is never logged, audited, shown or written anywhere else; only why a file was refused is said.
// The file lives in the Talos home, which every worker is already fenced from (worker-spec.ts deny rules).
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { clean, inputBox, liveDialog } from './screen.ts'

export const OAUTH_TOKEN_FILE = 'claude-oauth-token'
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'
/** The launch-only variable that names the token file for the launch script; never exported into the agent. */
export const OAUTH_TOKEN_FILE_ENV = 'TALOS_APP_OAUTH_TOKEN_FILE'
const MAX_BYTES = 4096

export type TokenRead = { token: string; stamp: string } | { none: true } | { refused: string; stamp: string }

/**
 * Reads the token: a plain file (never through a link) of this user's, readable by nobody else, at most 4 KB, one line of
 * token characters. `stamp` names the file's version (inode, size, change time) so a change can be told without the token.
 */
export function readOAuthToken(talosHome: string, uid = process.getuid?.() ?? 0): TokenRead {
  const path = join(talosHome, OAUTH_TOKEN_FILE)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { none: true } : { refused: `cannot be opened (${code})`, stamp: `err:${code}` }
  }
  try {
    const st = fstatSync(fd)
    const stamp = `${st.ino}:${st.size}:${st.ctimeMs}`
    if (!st.isFile()) return { refused: 'not a plain file', stamp }
    if (st.uid !== uid) return { refused: 'not this user’s', stamp }
    if ((st.mode & 0o077) !== 0) return { refused: 'readable by others (it must be 0600)', stamp }
    if (st.size > MAX_BYTES) return { refused: 'larger than 4 KB', stamp }
    const buf = Buffer.alloc(MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, MAX_BYTES + 1, 0)
    const text = buf
      .subarray(0, n)
      .toString('utf8')
      .replace(/\r?\n$/, '')
    if (!/^[A-Za-z0-9._~+/=-]{20,}$/.test(text)) return { refused: 'not one line of a token', stamp }
    return { token: text, stamp }
  } finally {
    closeSync(fd)
  }
}

/**
 * `env` with the token's FILE named for the launch to read (OAUTH_TOKEN_FILE_ENV), never the token itself: the tmux launch
 * file reads it into CLAUDE_CODE_OAUTH_TOKEN as the pane starts (tmux-host.ts), so the token is written nowhere else. Only
 * when the file was read as a valid token now; any token or file name that came from elsewhere (a login profile) is dropped.
 */
export function withOAuthToken(
  env: Record<string, string>,
  read: TokenRead,
  talosHome: string,
): Record<string, string> {
  const out = { ...env }
  delete out[OAUTH_TOKEN_ENV]
  delete out[OAUTH_TOKEN_FILE_ENV]
  if ('token' in read) out[OAUTH_TOKEN_FILE_ENV] = join(talosHome, OAUTH_TOKEN_FILE)
  return out
}

/** The stamp of what is there now: a change of it is a new token (or one removed). */
export const tokenStamp = (r: TokenRead): string => ('none' in r ? 'none' : r.stamp)

/** Which token it is (a SHA-256 of it, kept in memory only), or null when there is no valid one to start Main with. */
export const tokenIdentity = (r: TokenRead): string | null =>
  'token' in r ? createHash('sha256').update(r.token).digest('hex') : null

/**
 * The token was refused: the last answer on screen is Claude Code's `● Please run /login · API Error: 401 …` (seen with a
 * refused CLAUDE_CODE_OAUTH_TOKEN on 2.1.322, fixture token-refused-401.txt). Only the LAST `●` row counts, so a later answer
 * clears it.
 */
export function tokenRefused(rows: readonly string[]): boolean {
  const answers = rows.map(clean).filter((r) => r.startsWith('● '))
  const last = answers[answers.length - 1]
  // the whole row Claude Code draws, never a bare "API Error: 401" a model's own answer could start with
  return last !== undefined && /^● Please run \/login · API Error: 401\b/.test(last)
}

/**
 * Claude Code says it is not signed in: its input box is up, and the row just above the box's top rule ends with
 * `Not logged in · Run /login` (2.1.322, fixture not-logged-in.txt: onboarding done, no credentials; it then also starts the
 * project's MCP servers). Only that row counts, never the same words anywhere else on screen.
 */
export function notLoggedIn(rows: readonly string[]): boolean {
  // no dialog drawn over the box, and the box is the one at the bottom (only its footer below it), never a quoted one
  if (liveDialog([...rows]).kind !== 'none') return false
  const box = inputBox([...rows])
  if (!box) return false
  if (rows.slice(box[1] + 1).filter((r) => r.trim() !== '').length > 3) return false
  // the status row as Claude Code draws it: right-aligned (a run of spaces first), the words last
  const above = rows[box[0] - 2]
  return above !== undefined && /^ {20,}(\S.* · )?Not logged in · Run \/login\s*$/.test(above)
}

/**
 * A new token from the tray while Main shows it is signed out (or stopped by a start that failed): Main is started again with
 * it. Which token it is goes by its own bytes (tokenIdentity), so a file rewritten with the same token, or a chmod, is not a
 * new one, and a missing or unreadable file starts nothing. Each token is tried once (a token Claude Code refuses again is no
 * loop); one that arrived while Main was not signed out is still tried if Main signs out later. Only while nobody is attached
 * to Main's pane (an owner at it is left alone; the restart waits for them to leave), never after the owner's own stop, and
 * the restart is quiet: the owner is not told Main stopped.
 */
export class TokenRestart {
  private tried: string | null
  private restarting = false
  constructor(
    private readonly d: {
      /** The token's identity now (tokenIdentity), or null. */
      identity: () => string | null
      eligible: () => boolean
      clients: () => Promise<number[] | null>
      phase: () => string
      stopped: () => boolean
      stop: () => Promise<void>
      start: () => Promise<void>
      audit: (e: string, f?: Record<string, string>) => void
    },
  ) {
    // the token Main is running with now counts as tried: only a different one restarts it
    this.tried = d.identity()
  }

  async tick(): Promise<void> {
    if (this.restarting) {
      // stopped: started again only when the owner has not stopped it meanwhile; either way this restart is over
      if (this.d.phase() !== 'stopped') return
      this.restarting = false
      if (!this.d.stopped()) await this.d.start()
      return
    }
    const id = this.d.identity()
    if (id === null || id === this.tried || !this.d.eligible()) return
    const clients = await this.d.clients()
    if (clients === null || clients.length > 0) return
    this.tried = id
    this.restarting = true
    this.d.audit('oauth_token_changed', { action: 'restart' })
    if (this.d.phase() !== 'stopped') await this.d.stop()
  }
}
