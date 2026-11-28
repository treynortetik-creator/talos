// tmux control mode (docs/PROTOCOL.md, "The terminal stream"): one `tmux -L <socket> -f <conf> -C attach -f ignore-size -t =<session>`
// client per watched session. tmux tells it about the pane's output as `%output %<pane> <data>` lines, where bytes below 0x20 and
// the backslash come as `\ooo` octal and everything else (UTF-8 included) as the raw byte, so every read here is on BYTES: a
// string would mangle a code point split across two reads. Commands we write to its stdin are answered in order, each wrapped
// in `%begin <time> <n> <flags>` ... `%end|%error <time> <n> <flags>`; tmux never puts a notification inside such a block. The
// client is NOT attached read-only (`-r` makes every plain `send-keys` on the session fail, which broke the agent's own keys while
// someone watched), so read-only rests on this file: its stdin has ONE writer, writeControl, which throws before writing anything but
// the read commands in `controlCommands` (capture-pane and display-message, with exact formats).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { isPaneId } from '../supervisor/tmux-commands.ts'

/** The pane's output bytes of one `%output` line, with the octal escapes undone. A malformed escape stays as it is. */
export function unescapeOutput(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  let o = 0
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number
    if (c === 0x5c && i + 3 < data.length) {
      const a = data[i + 1] as number
      const b = data[i + 2] as number
      const d = data[i + 3] as number
      if (a >= 0x30 && a <= 0x33 && b >= 0x30 && b <= 0x37 && d >= 0x30 && d <= 0x37) {
        out[o++] = ((a - 0x30) << 6) | ((b - 0x30) << 3) | (d - 0x30)
        i += 3
        continue
      }
    }
    out[o++] = c
  }
  return out.subarray(0, o)
}

export type ControlEvent =
  | { kind: 'output'; pane: string; data: Uint8Array }
  /** The answer to one command we wrote: its lines (raw bytes, no newline), and whether tmux ran it. */
  | { kind: 'reply'; ok: boolean; lines: Uint8Array[] }
  | { kind: 'layout' }
  | { kind: 'exit' }
  /** A line that is not a notification or a reply: in control mode tmux prints its refusal of the attach this way, on stdout. */
  | { kind: 'stray' }

const enc = new TextEncoder()
const startsWith = (b: Uint8Array, s: string): boolean => {
  const p = enc.encode(s)
  if (b.length < p.length) return false
  for (let i = 0; i < p.length; i++) if (b[i] !== p[i]) return false
  return true
}
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

/** Turns the client's stdout, in whatever chunks it arrives, into events. */
export class ControlParser {
  /** The start of a line that has not ended yet, as the chunks it arrived in: joined once, when its newline comes, never per chunk. */
  private parts: Uint8Array[] = []
  /**
   * The `%begin` tuple of the reply being read: its lines are the answer, and only the matching `%end`/`%error` closes it. A line of
   * pane text inside the answer can look like a guard; it closes nothing unless its whole tuple (the server-wide command number and
   * the time) equals the begin's. Even a forged match gains nothing: the pane's text is the agent's own, which it could print into
   * the stream anyway, and the answer is only ever a picture (nothing here is executed or typed).
   */
  private block: { tuple: string; ours: boolean; lines: Uint8Array[] } | null = null

  push(chunk: Uint8Array): ControlEvent[] {
    const events: ControlEvent[] = []
    let from = 0
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, from)) {
      const head = chunk.subarray(from, i)
      if (this.parts.length === 0) this.line(head, events)
      else {
        const all = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0) + head.length)
        let o = 0
        for (const p of this.parts) {
          all.set(p, o)
          o += p.length
        }
        all.set(head, o)
        this.parts = []
        this.line(all, events)
      }
      from = i + 1
    }
    if (from < chunk.length) this.parts.push(chunk.slice(from))
    return events
  }

  private line(line: Uint8Array, out: ControlEvent[]): void {
    if (this.block) {
      if (startsWith(line, '%end ') || startsWith(line, '%error ')) {
        const tuple = text(line).split(' ').slice(1).join(' ')
        if (tuple === this.block.tuple) {
          // the reply to the attach itself (flags 0) is not an answer to anything we wrote
          if (this.block.ours)
            out.push({
              kind: 'reply',
              ok: line[2] === 0x6e /* the n of %end; %error has an r there */,
              lines: this.block.lines,
            })
          this.block = null
          return
        }
      }
      this.block.lines.push(line.slice())
      return
    }
    if (startsWith(line, '%begin ')) {
      const tuple = text(line).split(' ').slice(1).join(' ')
      this.block = { tuple, ours: tuple.endsWith(' 1'), lines: [] }
    } else if (startsWith(line, '%output ')) {
      let sp = 8
      while (sp < line.length && line[sp] !== 0x20) sp++
      const pane = text(line.subarray(8, sp))
      if (isPaneId(pane)) out.push({ kind: 'output', pane, data: unescapeOutput(line.subarray(sp + 1)) })
    } else if (startsWith(line, '%layout-change ')) out.push({ kind: 'layout' })
    else if (startsWith(line, '%exit')) out.push({ kind: 'exit' })
    else if (!startsWith(line, '%') && line.length > 0) out.push({ kind: 'stray' })
  }
}

/** A live, read-only look at one session's pane. */
export interface PaneSource {
  readonly paneId: string
  /** The pane's size when the source opened, then whenever tmux said it changed (`onResize`). */
  size(): { cols: number; rows: number }
  /** How many output bytes this source has delivered so far: the stream's absolute offset. */
  offset(): number
  onOutput(cb: (data: Uint8Array) => void): void
  onResize(cb: (size: { cols: number; rows: number }) => void): void
  /** The pane ended or the control client went away (`pane_gone`), or the source failed (`error`). Said once. */
  onEnd(cb: (why: 'pane_gone' | 'error') => void): void
  /**
   * The screen and its history as the bytes that redraw them, exact for the stream offset `at`: output delivered after `at` is
   * what happened after this picture. Null when tmux did not answer.
   */
  snapshot(): Promise<{ at: number; bytes: Uint8Array } | null>
  /** Ends the control client (idempotent). */
  close(): void
}

export type OpenSource = (session: string) => Promise<PaneSource | { error: 'no_pane' | 'unavailable' }>

export type TmuxSourceOptions = {
  tmux: string
  configPath: string
  socket: string
  /** The environment tmux runs with (TMUX, TMUX_PANE and TMUX_TMPDIR removed, like the supervisor's own). */
  env?: Record<string, string | undefined>
  /** Test seam: extra attach flags, for a flag tmux refuses (an old tmux). Production passes none. */
  extraArgs?: string[]
  /** How many lines of history a keyframe carries above the screen. */
  historyLines?: number
}

const HISTORY_LINES = 1000

const PANE = '%[0-9]{1,9}'
const SESSION = '[A-Za-z][A-Za-z0-9_-]{0,39}'
const SIZE_FMT = '#{pane_width} #{pane_height}'
const CURSOR_FMT =
  '#{cursor_x} #{cursor_y} #{alternate_on} #{cursor_flag} #{scroll_region_upper} #{scroll_region_lower}'
const FIRST_FMT = '#{pane_id} #{pane_width} #{pane_height}'

/** The only commands the view ever writes to the control client, built here and nowhere else. */
export const controlCommands = {
  /** The session's pane and its size. */
  first: (session: string) => `display-message -p -t =${session}: '${FIRST_FMT}'`,
  size: (pane: string) => `display-message -p -t ${pane} '${SIZE_FMT}'`,
  cursor: (pane: string) => `display-message -p -t ${pane} '${CURSOR_FMT}'`,
  /** The screen and its history, colour kept, wrapped lines joined. */
  capture: (pane: string, lines: number) => `capture-pane -p -e -J -S -${lines} -t ${pane}`,
}

const esc = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ALLOWED = [
  new RegExp(`^display-message -p -t =${SESSION}: '${esc(FIRST_FMT)}'$`),
  new RegExp(`^display-message -p -t ${PANE} '${esc(SIZE_FMT)}'$`),
  new RegExp(`^display-message -p -t ${PANE} '${esc(CURSOR_FMT)}'$`),
  new RegExp(`^capture-pane -p -e -J -S -[0-9]{1,5} -t ${PANE}$`),
]

/**
 * Queues the waiter for one command's reply and writes the command, in that order, but only AFTER the allowlist has passed it: a refused
 * command throws before a waiter is queued, so no reply is ever handed to the wrong asker.
 */
export function askOn<T>(
  waiters: Array<(r: T) => void>,
  stdin: { write(data: string): unknown },
  cmd: string,
  ended: () => boolean,
  gone?: T,
): Promise<T | null> {
  if (!isAllowedControlCommand(cmd)) throw new Error('refused: not a command the terminal view may send')
  return new Promise((res) => {
    if (ended()) return res(gone ?? null)
    waiters.push(res as (r: T) => void)
    try {
      writeControl(stdin, cmd)
    } catch {
      waiters.pop()
      res(null)
    }
  })
}

/** Is `cmd` exactly one of the view's read commands? No newline, no `;` chain, no other command or format can pass. */
export const isAllowedControlCommand = (cmd: string): boolean => ALLOWED.some((re) => re.test(cmd))

/**
 * THE single writer to the control client's stdin. The client is not read-only (see attachArgs), so read-only is this function: it
 * throws BEFORE writing anything that is not on the allowlist (capture-pane and display-message with the exact formats above), so no
 * key, paste, buffer, resize or chained command can reach tmux through the view.
 */
export function writeControl(stdin: { write(data: string): unknown }, cmd: string): void {
  if (!isAllowedControlCommand(cmd)) throw new Error('refused: not a command the terminal view may send')
  stdin.write(`${cmd}\n`)
}

/**
 * The control client's argv: our own socket and config, control mode, the session named exactly (`=`), and `-f ignore-size`, so the pane is
 * asked not to size the window for it. That flag does NOT keep the size by itself: a lone client that sends `refresh-client -C WxH` resizes
 * the window anyway (probed on tmux 3.8), so the size is protected by the allowlist below, which refuses refresh-client. NOT `-r`: a read-only client makes every plain `send-keys` on the session fail ("client is read-only"), which
 * silently broke the agent's own automatic keys while someone watched. Read-only rests on writeControl below instead. An old tmux that
 * refuses `-f` fails the view (see `unavailable`); there is no fallback to an attach that could resize.
 */
export const attachArgs = (
  o: Pick<TmuxSourceOptions, 'configPath' | 'socket' | 'extraArgs'>,
  session: string,
): string[] => [
  '-L',
  o.socket,
  '-f',
  o.configPath,
  '-C',
  'attach',
  '-f',
  'ignore-size',
  ...(o.extraArgs ?? []),
  '-t',
  `=${session}`,
]

const cleanEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].includes(k)) out[k] = v
  return out
}

const ints = (line: Uint8Array | undefined, n: number): number[] | null => {
  const parts = text(line ?? new Uint8Array(0))
    .trim()
    .split(' ')
  if (parts.length < n) return null
  const nums = parts.slice(-n).map(Number)
  return nums.every((x) => Number.isInteger(x) && x >= 0) ? nums : null
}

/** The `tmux -C attach -f ignore-size` client behind a PaneSource. Resolves to an error when the session has no pane to show. */
export function tmuxSourceOpener(o: TmuxSourceOptions): OpenSource {
  return (session) =>
    new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(o.tmux, attachArgs(o, session), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: cleanEnv(o.env ?? process.env),
        })
      } catch {
        return resolve({ error: 'unavailable' })
      }
      const parser = new ControlParser()
      type Answer = { ok: boolean; lines: Uint8Array[]; at: number }
      const waiters: Array<(r: Answer) => void> = []
      const outCbs: Array<(d: Uint8Array) => void> = []
      const resizeCbs: Array<(s: { cols: number; rows: number }) => void> = []
      const endCbs: Array<(w: 'pane_gone' | 'error') => void> = []
      let paneId = ''
      let cols = 0
      let rows = 0
      let outBytes = 0
      let ended = false
      let opened = false
      let checking = false

      const ask = (cmd: string): Promise<Answer | null> => askOn(waiters, child.stdin, cmd, () => ended)
      // refused by tmux before the attach: see the stray line and the stderr words below
      let refusesFlag = false
      const finish = (why: 'pane_gone' | 'error') => {
        if (ended) return
        ended = true
        for (const w of waiters.splice(0)) w({ ok: false, lines: [], at: outBytes })
        if (!opened) resolve({ error: refusesFlag ? 'unavailable' : 'no_pane' })
        for (const cb of endCbs) cb(why)
      }
      const source: PaneSource = {
        get paneId() {
          return paneId
        },
        size: () => ({ cols, rows }),
        offset: () => outBytes,
        onOutput: (cb) => void outCbs.push(cb),
        onResize: (cb) => void resizeCbs.push(cb),
        onEnd: (cb) => void endCbs.push(cb),
        async snapshot() {
          // capture-pane (colour kept, wrapped lines joined, the history above the screen) and then the cursor and the screen
          // mode: two commands, so two replies, written back to back. Output that lands between the two replies would leave
          // the cursor a little ahead of the picture, so then it is asked again (three tries; the last one is taken as it is).
          for (let attempt = 0; attempt < 3; attempt++) {
            const [cap, cur] = await Promise.all([
              ask(controlCommands.capture(paneId, o.historyLines ?? HISTORY_LINES)),
              ask(controlCommands.cursor(paneId)),
            ])
            if (!cap?.ok || !cur?.ok) return null
            const meta = ints(cur.lines[0], 6)
            if (!meta) return null
            // `cap.at` was read as the reply arrived, and no output lands inside a reply: the picture is exact for it
            if (cap.at === cur.at || attempt === 2)
              return {
                at: cap.at,
                bytes: keyframeBytes(cap.lines, meta[0] as number, meta[1] as number, {
                  alt: meta[2] === 1,
                  cursorHidden: meta[3] === 0,
                  // the whole screen is no region: only a region the app set is put back
                  region:
                    rows > 0 && (meta[4] !== 0 || meta[5] !== rows - 1) ? [meta[4] as number, meta[5] as number] : null,
                }),
              }
          }
          return null
        },
        close() {
          if (ended) return
          ended = true
          for (const w of waiters.splice(0)) w({ ok: false, lines: [], at: outBytes })
          try {
            child.stdin.end()
          } catch {
            // already closed
          }
          // a control client leaves when its stdin ends; the signal is for one that does not
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          }, 1000).unref()
        },
      }
      const checkSize = async () => {
        if (checking || ended) return
        checking = true
        const r = await ask(controlCommands.size(paneId))
        checking = false
        const v = r?.ok ? ints(r.lines[0], 2) : null
        if (v && (v[0] !== cols || v[1] !== rows)) {
          cols = v[0] as number
          rows = v[1] as number
          for (const cb of resizeCbs) cb({ cols, rows })
        }
      }
      child.stdout.on('data', (chunk: Buffer) => {
        for (const ev of parser.push(chunk)) {
          if (ev.kind === 'output') {
            if (ev.pane !== paneId || ended) continue
            outBytes += ev.data.length
            for (const cb of outCbs) cb(ev.data)
          } else if (ev.kind === 'reply') {
            waiters.shift()?.({ ok: ev.ok, lines: ev.lines, at: outBytes })
          } else if (ev.kind === 'layout') void checkSize()
          else if (ev.kind === 'stray') {
            // control mode prints tmux's refusal of the attach (an old tmux that does not know a flag) on STDOUT, then %exit
            if (!opened) refusesFlag = true
          } else finish('pane_gone')
        }
      })
      // tmux's own words are not for the owner, but one thing in them decides the answer: a tmux that refuses `-f` (an old one) cannot
      // give a client that asks not to size the window, and there is no fallback to an attach that could resize the pane
      child.stderr.on('data', (d: Buffer) => {
        if (/usage:|unknown flag|unknown option/i.test(d.toString())) refusesFlag = true
      })
      child.on('error', () => {
        if (!opened) resolve({ error: 'unavailable' })
        finish('error')
      })
      child.on('close', () => finish(opened ? 'pane_gone' : 'error'))
      child.stdin.on('error', () => {})
      // the first reply names the pane and its size; a session with nothing to show ends the client before it comes
      void ask(controlCommands.first(session)).then((r) => {
        const first = text(r?.lines[0] ?? new Uint8Array(0))
          .trim()
          .split(' ')
        const dims = first.length === 3 ? [Number(first[1]), Number(first[2])] : []
        if (!r?.ok || !isPaneId(first[0] ?? '') || !dims.every((n) => Number.isInteger(n) && (n as number) > 0)) {
          source.close()
          return resolve({ error: 'no_pane' })
        }
        paneId = first[0] as string
        cols = dims[0] as number
        rows = dims[1] as number
        opened = true
        resolve(source)
      })
    })
}

export type KeyModes = {
  /** The pane is in its alternate screen. */
  alt: boolean
  /** The pane's cursor is hidden (`#{cursor_flag}` 0). */
  cursorHidden: boolean
  /** The pane's scroll region (0-based top and bottom rows) when it is not the whole screen. */
  region: [number, number] | null
}

/**
 * The longest piece of `row` that is at most `max` bytes and ends whole: not inside an escape sequence (CSI, OSC, or a two-byte one)
 * and not inside a UTF-8 character. `capture-pane -e` prints only SGR and OSC 8 (hyperlinks), both handled here. A row cut to fit may
 * leave the NEXT row's colour stale (the cut dropped the sequence that would have ended or changed it): it can happen only in a keyframe
 * that had to be cut, and the next full line of live output sets its own colours.
 */
export function cutRow(row: Uint8Array, max: number): Uint8Array {
  if (row.length <= max) return row
  let safe = 0
  let i = 0
  while (i < row.length) {
    const c = row[i] as number
    let end = i + 1
    if (c === 0x1b) {
      const n = row[i + 1]
      if (n === 0x5b) {
        end = i + 2 // CSI: parameters, then a final byte 0x40-0x7e
        while (end < row.length && !((row[end] as number) >= 0x40 && (row[end] as number) <= 0x7e)) end++
        end++
      } else if (n === 0x5d) {
        end = i + 2 // OSC: until BEL or ST (ESC \)
        while (end < row.length && row[end] !== 0x07 && !(row[end] === 0x1b && row[end + 1] === 0x5c)) end++
        end += row[end] === 0x07 ? 1 : 2
      } else end = i + 2
    } else if (c >= 0xf0) end = i + 4
    else if (c >= 0xe0) end = i + 3
    else if (c >= 0xc0) end = i + 2
    if (end > row.length || end > max) break
    safe = end
    i = end
  }
  return row.subarray(0, safe)
}

/**
 * The bytes that redraw a pane on a fresh terminal of the same size: a full reset (modes, scroll region, colours), the screen and
 * scrollback cleared, the pane's own modes put back (alternate screen, hidden cursor, scroll region), the history and screen rows
 * joined by CR LF, then the cursor placed. The screen is always the LAST rows of what was captured, so the cursor's row counts from
 * the screen and not from the history. Colour comes from `capture-pane -e`, which carries a colour across a line break, so nothing
 * resets it between rows. Never more than `maxBytes`: the oldest history goes first, then the longest rows are cut whole.
 *
 * Why the live stream that follows may still start in the middle of something: `at` is a byte offset the pane's pty reached, and a
 * read can end inside an escape sequence the app was sending, whose first half the picture (a grid, not bytes) cannot carry. tmux does
 * not say where its parser stands, so there is no safe point to start from; the worst case is a few stray characters until the app's
 * next full line, which a read-only view accepts.
 */
export function keyframeBytes(
  rows: Uint8Array[],
  cx: number,
  cy: number,
  modes: KeyModes,
  maxBytes = 128 * 1024,
): Uint8Array {
  const head = enc.encode(
    `\x1bc${modes.alt ? '\x1b[?1049h' : ''}${modes.cursorHidden ? '\x1b[?25l' : ''}\x1b[H\x1b[2J\x1b[3J`,
  )
  // The scroll region goes AFTER the rows, not before: set first, every row would be squeezed through it (the rows outside it left
  // blank), and setting it homes the cursor, so the cursor is placed after it.
  const tail = enc.encode(
    `\x1b[0m${modes.region ? `\x1b[${modes.region[0] + 1};${modes.region[1] + 1}r` : ''}\x1b[${cy + 1};${cx + 1}H`,
  )
  const sep = enc.encode('\r\n')
  const overhead = head.length + tail.length
  const total = (list: Uint8Array[]) =>
    overhead + list.reduce((n, r) => n + r.length, 0) + Math.max(0, list.length - 1) * sep.length
  let list = rows
  // too much history for one frame: the oldest lines go, never the screen's own rows (the last ones)
  let from = 0
  while (total(list.slice(from)) > maxBytes && from < list.length - 1) from++
  list = list.slice(from)
  if (total(list) > maxBytes) {
    // even the last rows alone are too big (one long joined line): the longest are cut, by the same budget, until it fits
    const avail = maxBytes - overhead - Math.max(0, list.length - 1) * sep.length
    let lo = 0
    let hi = Math.max(...list.map((r) => r.length))
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const sum = list.reduce((n, r) => n + Math.min(r.length, mid), 0)
      if (sum <= avail) lo = mid
      else hi = mid - 1
    }
    list = list.map((r) => cutRow(r, lo))
  }
  const out = new Uint8Array(total(list))
  let o = 0
  out.set(head, o)
  o += head.length
  list.forEach((r, i) => {
    out.set(r, o)
    o += r.length
    if (i < list.length - 1) {
      out.set(sep, o)
      o += sep.length
    }
  })
  out.set(tail, o)
  return out
}
