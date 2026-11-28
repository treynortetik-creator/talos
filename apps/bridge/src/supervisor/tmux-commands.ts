// argv builders and output parsers for tmux: the TypeScript port of the Mac's TmuxCommands.swift (apps/desktop/Sources/
// TalosDesktopCore), which documents every rule here with what was OBSERVED on tmux 3.8. Nothing here launches a process.
// Every command names our own socket (`-L`) and config (`-f`), so the owner's tmux servers and ~/.tmux.conf are never used.
// Pane commands target the supervised pane by its stable id (`%N`), never "the session's active pane"; session commands use
// `=name` (tmux otherwise prefix-matches names).
import { constants } from 'node:os'
import {
  MAIN_TMUX_SESSION,
  PTY_COLS,
  PTY_ROWS,
  type PtyDialogKey,
  TMUX_MIN_VERSION,
  TMUX_SOCKET,
} from '@talos-app/protocol'

export const TMUX_PANE_OPTION = 'talos_pane'

/** ASCII letters, digits, `_` and `-`, starting with a letter, at most 40: a name tmux can always target exactly. */
export const isValidSessionName = (s: string): boolean => /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(s)

export const isPaneId = (s: string): boolean => /^%[0-9]+$/.test(s)

/**
 * tmux ends a command at an argv element that ends in `;` and starts the next one after it. One backslash before that last
 * `;` is removed by tmux and the element arrives as typed. Every element a user can influence goes through this.
 */
export const literalArg = (element: string): string => (element.endsWith(';') ? `${element.slice(0, -1)}\\;` : element)

/** tmux expands `-c` as a format; `##` is a literal `#`. */
export const literalPath = (path: string): string => path.replaceAll('#', '##')

/** `tmux 3.8`, `tmux 3.3a`, `tmux next-3.6` → [3, 8]. Null when unreadable. */
export function parseVersion(out: string): [number, number] | null {
  const tok = out.trim().split(/\s+/)[1]
  if (!tok) return null
  const m = /(\d+)\.(\d+)?/.exec(tok)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0)]
}

export function versionIsSupported(out: string): boolean {
  const v = parseVersion(out)
  if (!v) return false
  const [maj, min] = TMUX_MIN_VERSION.split('.').map(Number) as [number, number]
  return v[0] > maj || (v[0] === maj && v[1] >= min)
}

const hex = (bytes: Uint8Array): string[] => [...bytes].map((b) => b.toString(16).padStart(2, '0'))

/** Printed by sendUnlessInMode when the pane is in a mode: nothing was sent. */
export const IN_MODE_MARKER = 'talos-pane-in-mode'
/** Printed by sendUnlessInMode right after the keys went: the one output that says they were sent. */
export const SENT_MARKER = 'talos-keys-sent'

export class TmuxCommands {
  constructor(
    readonly tmux: string,
    readonly configPath: string,
    readonly session: string = MAIN_TMUX_SESSION,
    readonly socket: string = TMUX_SOCKET,
    /** The supervised pane (`%N`). Undefined only before the pane exists; then pane commands fall back to `=name:`. */
    readonly paneId?: string,
  ) {}

  withPane(id: string | undefined): TmuxCommands {
    return new TmuxCommands(this.tmux, this.configPath, this.session, this.socket, id && isPaneId(id) ? id : undefined)
  }

  get base(): string[] {
    return [this.tmux, '-L', this.socket, '-f', this.configPath]
  }
  get sessionTarget(): string {
    return `=${this.session}`
  }
  get paneTarget(): string {
    return this.paneId ?? `=${this.session}:`
  }

  version(): string[] {
    return [this.tmux, '-V']
  }
  hasSession(): string[] {
    return [...this.base, 'has-session', '-t', this.sessionTarget]
  }

  /** No `-e`: by the launch rule the environment goes in the launch file, never in an argv. */
  newSession(argv: string[], cwd: string, cols = PTY_COLS, rows = PTY_ROWS): string[] {
    return [
      ...this.base,
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-s',
      this.session,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-c',
      literalArg(literalPath(cwd)),
      '--',
      ...argv.map(literalArg),
    ]
  }

  /** A fresh window for the agent when our pane is gone but the session still holds someone else's pane. */
  newWindow(argv: string[], cwd: string): string[] {
    return [
      ...this.base,
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      `${this.sessionTarget}:`,
      '-c',
      literalArg(literalPath(cwd)),
      '--',
      ...argv.map(literalArg),
    ]
  }

  /** Respawn and clear-history in ONE invocation, so nothing the new child prints can be wiped. */
  respawnPane(argv: string[], cwd: string): string[] {
    return [
      ...this.base,
      'respawn-pane',
      '-k',
      '-t',
      this.paneTarget,
      '-c',
      literalArg(literalPath(cwd)),
      '--',
      ...argv.map(literalArg),
      ';',
      'clear-history',
      '-t',
      this.paneTarget,
    ]
  }

  static readonly paneStateFormat =
    '#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{window_activity}|#{session_created}|#{pane_id}'

  paneState(): string[] {
    return [...this.base, 'display-message', '-p', '-t', this.paneTarget, TmuxCommands.paneStateFormat]
  }
  capturePane(): string[] {
    return [...this.base, 'capture-pane', '-p', '-J', '-t', this.paneTarget]
  }
  /** Is the pane in a mode (copy mode after the owner scrolled)? Keys sent then are mode commands, not typing. */
  paneInMode(): string[] {
    return [...this.base, 'display-message', '-p', '-t', this.paneTarget, '#{pane_in_mode}']
  }
  /** The screen with its colours (`-e`): the input box's draft is told from its dim placeholder by them. */
  captureEscaped(): string[] {
    return [...this.base, 'capture-pane', '-p', '-e', '-J', '-t', this.paneTarget]
  }
  /** `n` Backspaces (our own pointer line, never typed over by anyone, cleared when nobody read it). */
  sendBackspaces(n: number): string[] {
    return [...this.base, 'send-keys', '-t', this.paneTarget, '-N', String(n), 'BSpace']
  }
  /** The screen plus `lines` of history (a dead pane's last output is scrolled into history). */
  captureRecent(lines: number): string[] {
    return [...this.base, 'capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', this.paneTarget]
  }

  /** Leaves copy mode (only when in one) and sends raw bytes as hex, in ONE invocation: nothing can re-enter the mode between. */
  sendBytesLeavingMode(bytes: Uint8Array): string[] {
    return [
      ...this.base,
      'if-shell',
      '-F',
      '-t',
      this.paneTarget,
      '#{pane_in_mode}',
      `send-keys -t ${this.paneTarget} -X cancel`,
      ';',
      'send-keys',
      '-t',
      this.paneTarget,
      '-H',
      ...hex(bytes),
    ]
  }

  /** Up, Down or Enter by key NAME (tmux sends what the pane's cursor-key mode wants), after leaving copy mode. */
  sendDialogKey(key: PtyDialogKey): string[] {
    return [
      ...this.base,
      'if-shell',
      '-F',
      '-t',
      this.paneTarget,
      '#{pane_in_mode}',
      `send-keys -t ${this.paneTarget} -X cancel`,
      ';',
      'send-keys',
      '-t',
      this.paneTarget,
      key,
    ]
  }

  /**
   * Keys sent only when the pane is not in a mode, in ONE tmux invocation (no gap between the look and the send for a scroll to
   * land in): in a mode, the marker is printed instead and nothing is sent. `keys` is a tmux command string's arguments, so
   * only plain text is accepted (the caller refuses anything else).
   */
  sendUnlessInMode(keys: string): string[] {
    return [
      ...this.base,
      'if-shell',
      '-F',
      '-t',
      this.paneTarget,
      '#{pane_in_mode}',
      `display-message -p ${IN_MODE_MARKER}`,
      // the keys, then the marker that says so (tmux runs the two in order): any other output is not a send
      `send-keys -t ${this.paneTarget} ${keys} ; display-message -p ${SENT_MARKER}`,
    ]
  }
  /** Literal text (`-l`, no key names). Enter goes separately: a program reads one chunk as a paste. */
  sendLiteral(text: string): string[] {
    return [...this.base, 'send-keys', '-t', this.paneTarget, '-l', '--', literalArg(text)]
  }
  sendEnter(): string[] {
    return [...this.base, 'send-keys', '-t', this.paneTarget, 'Enter']
  }
  clearHistory(): string[] {
    return [...this.base, 'clear-history', '-t', this.paneTarget]
  }
  listPanes(): string[] {
    return [...this.base, 'list-panes', '-s', '-t', this.sessionTarget, '-F', '#{pane_id}']
  }
  killSession(): string[] {
    return [...this.base, 'kill-session', '-t', this.sessionTarget]
  }
  /**
   * The activity time of each client at a keyboard; a control-mode client (the remote terminal view's) prints an empty
   * row, so watching the pane is never read as the owner being at the keyboard (startup keys, restarts, idle parking).
   */
  listClientsActivity(): string[] {
    return [...this.base, 'list-clients', '-t', this.sessionTarget, '-F', '#{?client_control_mode,,#{client_activity}}']
  }
  setOption(key: string, value: string): string[] {
    return [...this.base, 'set-option', '-t', `${this.sessionTarget}:`, `@${key}`, literalArg(value)]
  }
  showOption(key: string): string[] {
    return [...this.base, 'show-options', '-v', '-t', `${this.sessionTarget}:`, `@${key}`]
  }
}

export type PaneState = {
  /** Null once the pane is dead (tmux prints an empty `#{pane_pid}` for a dead pane). */
  pid: number | null
  dead: boolean
  exitStatus: number | null
  exitSignal: number | null
  /** Last output, seconds since 1970 (`#{window_activity}`). */
  activity: number | null
  sessionCreated: number | null
  paneId: string | null
}

const int = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s.trim()) ? Number(s) : null)

export function parsePaneState(out: string): PaneState | null {
  const f = (out.split('\n')[0] ?? '').split('|')
  if (f.length < 6 || (f[1] !== '0' && f[1] !== '1')) return null
  const raw = int(f[0])
  const pid = raw !== null && raw > 0 ? raw : null
  const dead = f[1] === '1'
  if (!dead && pid === null) return null
  const num = (s: string | undefined) =>
    s !== undefined && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null
  return {
    pid,
    dead,
    exitStatus: int(f[2]),
    exitSignal: parseSignal(f[3] ?? ''),
    activity: num(f[4]),
    sessionCreated: num(f[5]),
    paneId: f[6] !== undefined && isPaneId(f[6]) ? f[6] : null,
  }
}

/** Exit 0 with every field empty is how tmux 3.8 says "no such pane/session"; that row is "gone". */
export function isEmptyPaneRow(out: string): boolean {
  const line = out.split('\n')[0] ?? ''
  return line.includes('|') && /^[| ]*$/.test(line)
}

/** `#{pane_dead_signal}` is a lowercase name in tmux 3.8 (`term`, `kill`), a number in older builds. This host's numbers. */
export function parseSignal(s: string): number | null {
  const t = s.trim().toLowerCase()
  if (t === '') return null
  if (/^\d+$/.test(t)) return Number(t)
  const bare = (t.startsWith('sig') ? t.slice(3) : t).toUpperCase()
  const n = (constants.signals as Record<string, number>)[`SIG${bare}`]
  return n ?? -1
}

/** capture-pane output → rows, bottom-anchored (trailing blank rows dropped). */
export function parseCapture(out: string): string[] {
  const rows = out.split('\n').map((r) => r.replaceAll('\r', ''))
  while (rows.length > 0 && (rows[rows.length - 1] ?? '').trim() === '') rows.pop()
  return rows
}

/** One time (seconds since 1970) per attached client that can type; empty when nobody is. Null when any row cannot be read. */
export function parseClientActivity(out: string): number[] | null {
  const rows = out.split('\n').map((r) => r.trim())
  const times: number[] = []
  for (const r of rows) {
    if (r === '') continue // a control-mode client (the terminal view's): not someone at the keyboard
    if (!Number.isFinite(Number(r))) return null
    times.push(Number(r))
  }
  return times
}

/** A failed command means the session is gone only when tmux itself says so. A timeout or other failure says nothing. */
export function saysGone(status: number, stderr: string, timedOut: boolean): boolean {
  if (status === 0 || timedOut) return false
  return (
    stderr.includes("can't find session") ||
    stderr.includes('no server running') ||
    (stderr.includes('error connecting to') && stderr.includes('(No such file or directory)'))
  )
}

/** The command reached a server that was shutting down: nothing ran, so asking again is safe. Never a timeout. */
export function saysServerWentAway(status: number, stderr: string, timedOut: boolean): boolean {
  return status !== 0 && !timedOut && stderr.includes('server exited unexpectedly')
}
