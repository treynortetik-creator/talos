// The tmux PtyHost of the supervisor contract (@talos-app/protocol, section 1): the TypeScript port of the Mac's
// TmuxPtyHost.swift. The agent lives in tmux on our own socket and config; quitting or crashing the supervisor leaves the pane
// running, and a new host adopts it with attachIfRunning. tmux runs `/usr/bin/env -i /bin/sh <launch file>` (the contract's
// launch rule, see writeLaunch), and the execs leave the pane pid the agent's, its own process group and session leader.

import { randomBytes } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DialogKeyKind,
  PTY_EXIT_ROWS,
  PTY_POLL_MS,
  PTY_UNKNOWN_LIMIT,
  type PtyDialogKey,
  type PtyExit,
  type PtyHost,
  type PtyLaunch,
  type PtySendResult,
} from '@talos-app/protocol'
import { type KeyIntent, type KeyRefusal, keyRefusal, type ShapeNote, takeUnknownShapes } from './key-guard.ts'
import { OAUTH_TOKEN_FILE_ENV } from './oauth-token.ts'
import { groupAlive, type ProcIdentity, type RunResult, runTool, signalOwnGroup, systemIdentity } from './proc.ts'
import {
  IN_MODE_MARKER,
  isEmptyPaneRow,
  isPaneId,
  isValidSessionName,
  type PaneState,
  parseCapture,
  parseClientActivity,
  parsePaneState,
  SENT_MARKER,
  saysGone,
  saysServerWentAway,
  TMUX_PANE_OPTION,
  TmuxCommands,
  versionIsSupported,
} from './tmux-commands.ts'

export type PtyHostErrorCode = 'invalid_name' | 'already_running' | 'start_failed' | 'exited_immediately'

export class PtyHostError extends Error {
  constructor(
    readonly code: PtyHostErrorCode,
    message: string,
    /** For `exited_immediately`: what the agent left on screen (a resume error, an unknown flag), "Pane is dead" removed. */
    readonly rows: string[] = [],
  ) {
    super(message)
  }
}

export type TmuxHostOptions = {
  tmux: string
  configPath: string
  session: string
  socket?: string
  /** Default: the shared proc-identity helper. */
  identity?: ProcIdentity
  /** The environment tmux itself runs with before the first start (TMUX, TMUX_PANE, TMUX_TMPDIR are removed). */
  baseEnv?: Record<string, string | undefined>
  /** A private folder (0700, ours) for the launch files; under the Talos home. */
  launchDir: string
  pollMs?: number
  run?: typeof runTool
  /**
   * Test seam: what decides whether a key may go to the pane (default: key-guard.ts keysAllowed, on what Claude Code draws, for
   * what the sender means to press). The plumbing tests drive a plain shell, which draws no input box, and pass their own; the
   * supervisor never sets it.
   */
  keyGuard?: (escaped: readonly string[] | null, intent?: KeyIntent) => boolean
}

type PaneRead = { kind: 'state'; state: PaneState } | { kind: 'gone' } | { kind: 'unknown' }

const clean = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && k !== 'TMUX' && k !== 'TMUX_PANE' && k !== 'TMUX_TMPDIR') out[k] = v
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * What a send through sendUnlessInMode did, from what tmux answered: sent only when our own marker came back; the in-mode
 * marker is nothing sent. A call that answered with neither, or timed out, may have sent the keys: unknown (the screen decides,
 * and a line is never typed twice on top of itself). A call that failed sent nothing.
 */
export function markedSend(r: Pick<RunResult, 'ok' | 'out' | 'timedOut'>): PtySendResult {
  if (r.ok && r.out.includes(IN_MODE_MARKER)) return 'failed'
  if (r.ok && r.out.includes(SENT_MARKER)) return 'sent'
  return r.ok || r.timedOut ? 'unknown' : 'failed'
}

export class TmuxPtyHost implements PtyHost {
  readonly kind = 'tmux' as const
  private readonly base: TmuxCommands
  private readonly run: typeof runTool
  private readonly pollMs: number
  private tmuxEnv: Record<string, string>
  private paneId: string | undefined
  private pid: number | null = null
  private started: string | null = null
  private reported = true
  private exitCb: ((exit: PtyExit) => void) | undefined
  private lastRows: string[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private unknownReads = 0
  /** Bumped by every start, restart, adoption and detach: a poll begun before one never reports after it. */
  private generation = 0
  /** What the last pane lookup found: `unknown` keeps a missing pane id from reading as "gone". */
  private paneLookup: 'found' | 'none' | 'unknown' = 'none'
  /** Names the last launch could not pass to a shell (exported bash functions, read-only shell variables); for the log. */
  droppedEnv: string[] = []

  private readonly identity: ProcIdentity

  constructor(private readonly opts: TmuxHostOptions) {
    this.identity = opts.identity ?? systemIdentity
    this.base = new TmuxCommands(opts.tmux, opts.configPath, opts.session, opts.socket)
    this.run = opts.run ?? runTool
    this.pollMs = opts.pollMs ?? PTY_POLL_MS
    this.tmuxEnv = clean(opts.baseEnv ?? process.env)
  }

  /** Commands aimed at our own pane (`%N`) once it exists. */
  private get cmd(): TmuxCommands {
    return this.base.withPane(this.paneId)
  }

  private tmux(argv: string[], env?: Record<string, string>): Promise<RunResult> {
    return this.run(argv, env ?? this.tmuxEnv, 10_000)
  }

  /** tmux >= 3.2 at `tmux`? */
  static async usable(tmux: string, run: typeof runTool = runTool): Promise<boolean> {
    const r = await run([tmux, '-V'], clean(process.env), 5_000)
    return r.ok && versionIsSupported(r.out)
  }

  private requireName(session: string): void {
    if (!isValidSessionName(this.base.session) || session !== this.base.session)
      throw new PtyHostError('invalid_name', `invalid tmux session name ${session}`)
  }

  async sessionExists(): Promise<boolean> {
    return isValidSessionName(this.base.session) && (await this.tmux(this.base.hasSession())).ok
  }

  private async setPane(id: string): Promise<void> {
    this.paneId = id
    await this.tmux(this.base.setOption(TMUX_PANE_OPTION, id))
  }

  /**
   * Finds our pane: the session option, else a session with exactly one pane adopts it. `unknown` when tmux did not answer
   * (a timeout, a failure that is not "gone"): that is never "no pane", which would respawn or double a live agent.
   */
  private async loadPane(): Promise<'found' | 'none' | 'unknown'> {
    this.paneLookup = await this.findPane()
    return this.paneLookup
  }

  private async findPane(): Promise<'found' | 'none' | 'unknown'> {
    if (this.paneId) return 'found'
    const opt = await this.tmux(this.base.showOption(TMUX_PANE_OPTION))
    if (opt.timedOut) return 'unknown'
    const v = opt.out.trim()
    if (opt.ok && isPaneId(v)) {
      this.paneId = v
      return 'found'
    }
    const list = await this.tmux(this.base.listPanes())
    if (!list.ok) return saysGone(list.status, list.err, list.timedOut) ? 'none' : 'unknown'
    const panes = list.out.split('\n').filter(isPaneId)
    if (panes.length !== 1) return 'none'
    await this.setPane(panes[0] as string)
    return 'found'
  }

  private async readPane(): Promise<PaneRead> {
    if (!this.paneId) return this.paneLookup === 'unknown' ? { kind: 'unknown' } : { kind: 'gone' }
    const r = await this.tmux(this.cmd.paneState())
    if (r.ok) {
      const st = parsePaneState(r.out)
      if (st) return { kind: 'state', state: st }
      return isEmptyPaneRow(r.out) ? { kind: 'gone' } : { kind: 'unknown' }
    }
    if (saysGone(r.status, r.err, r.timedOut) || (r.status !== 0 && !r.timedOut && r.err.includes("can't find pane")))
      return { kind: 'gone' }
    return { kind: 'unknown' }
  }

  private async paneState(): Promise<PaneState | null> {
    const r = await this.readPane()
    return r.kind === 'state' ? r.state : null
  }

  /**
   * A pane read that is an answer, for decisions that kill or create: a timed-out read is asked again (bounded), and one that
   * still says nothing refuses. Treating it as "no pane" would respawn a live agent or start a second one beside it.
   */
  private async definitePane(): Promise<{ kind: 'state'; state: PaneState } | { kind: 'gone' }> {
    for (let i = 0; i < 3; i++) {
      await this.loadPane()
      const r = await this.readPane()
      if (r.kind !== 'unknown') return r
    }
    throw new PtyHostError('start_failed', 'tmux did not say whether the session is running; nothing was started')
  }

  /** Forget the running child before replacing it: a poll still looking at the old one must not report the new one's exit. */
  private forgetChild(): void {
    this.generation++
    this.pid = null
    this.started = null
    this.reported = true
  }

  /**
   * The launch file (the contract's rule for Main and workers alike): no environment value ever reaches an argv, tmux's or any
   * other, and the tmux server's environment never reaches the agent. tmux runs `/usr/bin/env -i /bin/sh <file>`, so the
   * pane starts from an EMPTY environment; the file (0600, created new in our own 0700 folder) removes itself, sets each
   * variable with `export` (a shell builtin, in no process's argv), and `exec`s the agent's argv. Values and arguments are
   * single-quoted. Returns tmux's argv and the file, which the caller removes when the start fails.
   */
  private writeLaunch(launch: PtyLaunch): { argv: string[]; file: string } {
    const [program] = launch.argv
    if (program === undefined || program === '') throw new PtyHostError('start_failed', 'nothing to run')
    // `exec -x` is an option to exec in some shells, and `exec --` is not portable: a program name never starts with `-`
    if (program.startsWith('-')) throw new PtyHostError('start_failed', 'a program name cannot start with -')
    if (launch.argv.some((a) => a.includes('\0')))
      throw new PtyHostError('start_failed', 'an argument holds a NUL byte')
    const { env, dropped } = shellEnv(clean(launch.env))
    this.droppedEnv = dropped
    // the token's file, read by the launch itself as the pane starts: the token is never written into this file (oauth-token.ts)
    const tokenFile = env[OAUTH_TOKEN_FILE_ENV]
    delete env[OAUTH_TOKEN_FILE_ENV]
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    if (Object.values(env).some((v) => v.includes('\0')))
      throw new PtyHostError('start_failed', 'a variable holds a NUL byte')
    // with `env -i` the pane has only this: the terminal type tmux used to give it (tmux.conf default-terminal) comes too
    if (!env.TERM) env.TERM = 'xterm-256color'
    const dir = this.launchDir()
    // one start per session at a time: a file this session's pane never got to read (it died first) goes now; the exact
    // name, so `t-a` never removes `t-a-b`'s
    const mine = new RegExp(`^launch-${this.base.session}-[0-9a-f]{16}\\.sh$`)
    for (const f of readdirSync(dir)) if (mine.test(f)) rmSync(join(dir, f), { force: true })
    const file = join(dir, `launch-${this.base.session}-${randomBytes(8).toString('hex')}.sh`)
    const body = [
      ...Object.keys(env)
        .sort()
        .map((k) => `export ${k}=${shq(env[k] as string)}`),
      // a plain file (never a link) of the token, read now; its trailing newline goes with the command substitution
      ...(tokenFile
        ? [
            `if [ -f ${shq(tokenFile)} ] && [ ! -L ${shq(tokenFile)} ]; then CLAUDE_CODE_OAUTH_TOKEN="$(cat -- ${shq(tokenFile)})"; export CLAUDE_CODE_OAUTH_TOKEN; fi`,
          ]
        : []),
      // after the exports: they are builtins, and `rm` is then found on the launch's own PATH (not the shell's default)
      'rm -f "$0"',
      `exec ${launch.argv.map(shq).join(' ')}`,
      '',
    ].join('\n')
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, body)
    } finally {
      closeSync(fd)
    }
    return { argv: ['/usr/bin/env', '-i', '/bin/sh', file], file }
  }

  /** Our launch folder: made 0700 when missing, refused when it is a link, someone else's or open to others. */
  private launchDir(): string {
    const dir = this.opts.launchDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      throw new PtyHostError('start_failed', `the launch folder ${dir} is not private to this user`)
    return dir
  }

  async start(launch: PtyLaunch): Promise<number> {
    this.requireName(launch.session) // before anything is created: an untargetable session would be unsupervised
    if (await this.sessionExists()) {
      await this.loadPane()
      const p = await this.definitePane()
      if (p.kind === 'state' && !p.state.dead)
        throw new PtyHostError('already_running', `session ${launch.session} already runs`)
      return this.respawn(launch)
    }
    this.forgetChild()
    // the server, if this starts it, runs with only the plain basics: no token or setting of one launch in tmux's own process
    const serverEnv = serverBasics(clean(launch.env))
    const { argv, file } = this.writeLaunch(launch)
    this.paneId = undefined
    this.paneLookup = 'none'
    return this.launched(file, async () => {
      const create = this.base.newSession(argv, launch.cwd)
      let r = await this.tmux(create, serverEnv)
      // a server that was shutting down (its last session had just been killed) created nothing: ask again, bounded
      for (let i = 0; i < 3 && saysServerWentAway(r.status, r.err, r.timedOut); i++)
        r = await this.tmux(create, serverEnv)
      if (!r.ok) throw new PtyHostError('start_failed', r.err.trim() || 'tmux new-session failed')
      this.tmuxEnv = serverEnv
      const id = r.out.trim()
      if (!isPaneId(id)) {
        await this.tmux(this.base.killSession()) // never leave a session nobody supervises
        throw new PtyHostError('start_failed', 'tmux printed no pane id')
      }
      await this.setPane(id)
      return this.adopt()
    })
  }

  /** Runs a start; when it fails, the launch file goes too (the pane may never have read it). */
  private async launched(file: string, f: () => Promise<number>): Promise<number> {
    try {
      return await f()
    } catch (e) {
      rmSync(file, { force: true })
      throw e
    }
  }

  async restart(launch: PtyLaunch): Promise<number> {
    this.requireName(launch.session)
    if (!(await this.sessionExists())) return this.start(launch)
    return this.respawn(launch)
  }

  private async respawn(launch: PtyLaunch): Promise<number> {
    const p = await this.definitePane()
    this.forgetChild()
    const { argv, file } = this.writeLaunch(launch)
    return this.launched(file, async () => {
      if (p.kind === 'gone') {
        // our pane is gone but the session lives on (someone else's pane in it): a new window, never their pane
        const r = await this.tmux(this.base.newWindow(argv, launch.cwd))
        const id = r.out.trim()
        if (!r.ok || !isPaneId(id)) throw new PtyHostError('start_failed', r.err.trim() || 'tmux new-window failed')
        await this.setPane(id)
        return this.adopt()
      }
      // a fresh screen and history: a dialog from the previous run must never be read as this run's
      await this.tmux(this.cmd.clearHistory())
      const r = await this.tmux(this.cmd.respawnPane(argv, launch.cwd))
      if (!r.ok) throw new PtyHostError('start_failed', r.err.trim() || 'tmux respawn-pane failed')
      return this.adopt()
    })
  }

  private async adopt(): Promise<number> {
    const s = await this.paneState()
    const pid = s?.pid ?? null
    const started = pid === null ? null : this.identity.processStartTime(pid)
    if (pid === null || started === null) {
      // it died before its pid could be read (an unknown flag, a resume of a conversation that is gone)
      const r = await this.tmux(this.cmd.captureRecent(PTY_EXIT_ROWS))
      throw new PtyHostError('exited_immediately', 'the agent exited at once', r.ok ? deadPaneRows(r.out) : [])
    }
    this.generation++
    this.pid = pid
    this.started = started
    this.reported = false
    this.unknownReads = 0
    this.watch()
    return pid
  }

  async attachIfRunning(session: string): Promise<number | null> {
    this.requireName(session)
    if (!(await this.sessionExists())) return null
    await this.loadPane()
    const s = await this.paneState()
    this.forgetChild()
    if (!s || s.dead || s.pid === null) return null // a dead pane waits (remain-on-exit); the next start respawns it
    const started = this.identity.processStartTime(s.pid)
    if (started === null) return null
    this.generation++
    this.pid = s.pid
    this.started = started
    this.reported = false
    this.unknownReads = 0
    this.watch()
    return s.pid
  }

  private watch(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), this.pollMs)
  }

  /** One poll; never two at once (a slow tmux must not stack them). Exposed for tests. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    const pid = this.pid
    const gen = this.generation
    if (pid === null || this.reported) return
    // every await below may span a restart or a detach: a result for another generation is dropped
    const rows = (await this.visibleRows()) ?? []
    if (gen !== this.generation) return
    if (rows.length > 0) this.lastRows = rows
    const read = await this.readPane()
    if (gen !== this.generation) return
    if (read.kind === 'unknown') {
      this.unknownReads++
      // tmux was slow or refused this one query: not evidence the agent is gone. A failure that never ends must not hide a
      // dead agent forever, though: has-session, then (after PTY_UNKNOWN_LIMIT unknown reads in a row) the process group.
      if (await this.confirmedLost(pid))
        this.report(gen, { pid, code: null, signal: null, hostLost: true, lastRows: this.lastRows })
      return
    }
    this.unknownReads = 0
    if (read.kind === 'gone') {
      // session or server gone under us (killed by hand): the agent is gone, the next start is cold
      this.report(gen, { pid, code: null, signal: null, hostLost: true, lastRows: this.lastRows })
      return
    }
    const s = read.state
    if (!s.dead && s.pid !== pid) return // respawned meanwhile; start/restart adopt the new pid
    if (s.dead) {
      const r = await this.tmux(this.cmd.captureRecent(PTY_EXIT_ROWS))
      this.report(gen, {
        pid,
        code: s.exitSignal === null ? s.exitStatus : null,
        signal: s.exitSignal,
        hostLost: false,
        lastRows: r.ok ? deadPaneRows(r.out) : rows,
      })
    }
  }

  private async confirmedLost(pid: number): Promise<boolean> {
    const session = await this.tmux(this.base.hasSession())
    if (saysGone(session.status, session.err, session.timedOut)) return true
    return this.unknownReads >= PTY_UNKNOWN_LIMIT && !groupAlive(pid)
  }

  private report(gen: number, exit: PtyExit): void {
    if (gen !== this.generation || this.reported || this.pid !== exit.pid) return
    this.reported = true
    try {
      this.exitCb?.(exit)
    } catch {
      // the caller's handler failing must not become an unhandled rejection of the poll timer
    }
  }

  private sent(r: RunResult): PtySendResult {
    if (r.timedOut) return 'unknown'
    return r.ok ? 'sent' : 'failed'
  }

  /**
   * Every key Talos sends goes through here first, with what it means to press (key-guard.ts keysAllowed): the live screen must
   * be exactly that, and nothing goes to Claude Code's usage-limit menu, to a pane that cannot be read, or with no intent. The
   * owner presses keys at the pane itself (tmux attach), never through these.
   */
  private async keysRefused(intent?: KeyIntent): Promise<boolean> {
    const escaped = await this.visibleRowsEscaped()
    if (this.opts.keyGuard) {
      const ok = this.opts.keyGuard(escaped, intent)
      this.refusal = ok ? null : { why: 'test_guard' }
      return !ok
    }
    this.refusal = keyRefusal(escaped, intent)
    return this.refusal !== null
  }

  /** Why the last key was refused (for the audit: the code, and the row under the box that was not a status row), or null. */
  lastKeyRefusal(): KeyRefusal | null {
    return this.refusal
  }
  /** The shapes of status-row parts not yet known that a key was allowed under, not yet said (key-guard.ts). */
  unknownShapes(): ShapeNote[] {
    return takeUnknownShapes()
  }
  private refusal: KeyRefusal | null = null

  async send(keys: Uint8Array): Promise<PtySendResult> {
    // keys go to our own pane only, never to "the active pane"; leaving copy mode and sending are one tmux invocation
    if (keys.length === 0 || !this.paneId) return 'failed'
    if (await this.keysRefused()) return 'refused' // raw keys state no intent: refused by the real guard
    return this.sent(await this.tmux(this.cmd.sendBytesLeavingMode(keys)))
  }

  async sendDialogKey(key: PtyDialogKey, kind?: DialogKeyKind): Promise<PtySendResult> {
    if (!this.paneId || (key !== 'Up' && key !== 'Down' && key !== 'Enter')) return 'failed'
    if (await this.keysRefused(kind ? { type: 'dialog', kind } : undefined)) return 'refused'
    return this.sent(await this.tmux(this.cmd.sendDialogKey(key)))
  }

  /** Literal text with no Enter (the pointer is typed, then looked at, then submitted). A line break is refused. */
  async sendText(text: string): Promise<PtySendResult> {
    // only plain text: it goes inside a tmux command string (the pointer line is all it is used for)
    if (!this.paneId || !/^[A-Za-z0-9 .,:_-]{1,512}$/.test(text)) return 'failed'
    return this.unlessInMode(`-l -- "${text}"`, { type: 'box', holds: 'empty' })
  }

  /** Keys sent only outside copy mode, the check and the send one tmux call: in a mode it is 'failed' (nothing was sent). */
  private async unlessInMode(keys: string, intent: KeyIntent): Promise<PtySendResult> {
    if (await this.keysRefused(intent)) return 'refused'
    const r = await this.tmux(this.cmd.sendUnlessInMode(keys))
    // only our own marker is a send; the in-mode marker is none. A call that answered with neither (or timed out) may have
    // sent the keys: unknown, and the screen decides (a line is never typed twice on top of itself)
    return markedSend(r)
  }

  /** Enter alone. `unknown` (a timeout) is treated as sent: an Enter is never pressed twice for one line. */
  async sendEnterKey(): Promise<PtySendResult> {
    if (!this.paneId) return 'failed'
    return this.unlessInMode('Enter', { type: 'box', holds: 'ours' })
  }

  /** `n` Backspaces, 1 to 512 (our own line, removed when nobody read it). */
  async sendBackspaces(n: number): Promise<PtySendResult> {
    if (!this.paneId || !Number.isInteger(n) || n < 1 || n > 512) return 'failed'
    return this.unlessInMode(`-N ${n} BSpace`, { type: 'box', holds: 'ours' })
  }

  /** Whether the pane is in copy mode (the owner scrolled back); null when it cannot be read. Nothing is typed while it is. */
  async inCopyMode(): Promise<boolean | null> {
    if (!this.paneId) return null
    const r = await this.tmux(this.cmd.paneInMode())
    if (!r.ok) return null
    const v = r.out.trim()
    return v === '0' ? false : v === '1' ? true : null
  }

  /** The visible rows with their colours (`capture-pane -e`), or null when the read failed. */
  async visibleRowsEscaped(): Promise<string[] | null> {
    if (!this.paneId) return null
    const r = await this.tmux(this.cmd.captureEscaped())
    return r.ok ? parseCapture(r.out) : null
  }

  async sendLine(text: string): Promise<PtySendResult> {
    // a line break inside the text would submit early, before the Enter this sends on purpose
    if (!this.paneId || /[\r\n]/.test(text)) return 'failed'
    // an arbitrary line states no intent the guard knows: refused by the real guard (no production caller)
    if (await this.keysRefused()) return 'refused'
    const typed = this.sent(await this.tmux(this.cmd.sendLiteral(text)))
    if (typed !== 'sent') return typed
    // looked at again before the Enter: a menu may have come up between the two calls (Fable R1-4)
    if (await this.keysRefused()) return 'refused'
    return this.sent(await this.tmux(this.cmd.sendEnter()))
  }

  async visibleRows(opts: { scrollback?: number } = {}): Promise<string[] | null> {
    if (!this.paneId) return null
    const n = opts.scrollback ?? 0
    const r = await this.tmux(n > 0 ? this.cmd.captureRecent(n) : this.cmd.capturePane())
    return r.ok ? parseCapture(r.out) : null
  }

  async lastOutputAt(): Promise<number | null> {
    const a = (await this.paneState())?.activity
    return a == null ? null : a * 1000
  }

  async clientActivities(): Promise<number[] | null> {
    const r = await this.tmux(this.base.listClientsActivity())
    if (!r.ok) return null
    return parseClientActivity(r.out)?.map((t) => t * 1000) ?? null
  }

  /**
   * What is in this session's pane right now, adopting nothing: `running` (its pid), `dead` (remain-on-exit kept it), `gone`
   * (no session, or no pane) or `unknown` (tmux did not answer). Only `gone` and `dead` are facts a caller may act on: a
   * supervisor adopting thread sessions marks parked only what is not there, never what it could not see (P3d2).
   */
  async probe(): Promise<{ kind: 'running'; pid: number } | { kind: 'dead' } | { kind: 'gone' } | { kind: 'unknown' }> {
    if (!isValidSessionName(this.base.session))
      throw new PtyHostError('invalid_name', `invalid tmux session name ${this.base.session}`)
    const has = await this.tmux(this.base.hasSession())
    if (!has.ok) return saysGone(has.status, has.err, has.timedOut) ? { kind: 'gone' } : { kind: 'unknown' }
    if ((await this.loadPane()) === 'unknown') return { kind: 'unknown' }
    const r = await this.readPane()
    if (r.kind === 'gone') return { kind: 'gone' }
    if (r.kind === 'unknown') return { kind: 'unknown' }
    if (r.state.dead) return { kind: 'dead' }
    return r.state.pid === null ? { kind: 'unknown' } : { kind: 'running', pid: r.state.pid }
  }

  /**
   * One signal to the started agent's group, without waiting: false when nothing was started here or the pid is no longer
   * that process (signalOwnGroup's identity check). For a park that waits on its own clock; terminate() waits inside.
   */
  signal(sig: NodeJS.Signals): boolean {
    const pid = this.pid
    const started = this.started
    return pid !== null && started !== null && signalOwnGroup(this.identity, pid, started, sig)
  }

  /**
   * SIGTERM to the agent's whole group, `graceMs`, then SIGKILL, then the session is closed. Also after the agent itself has
   * exited: its children (MCP servers) are still in its group, and the cleanup before a restart must end them.
   */
  async terminate(graceMs: number): Promise<void> {
    const pid = this.pid
    const started = this.started
    if (pid !== null && started !== null && signalOwnGroup(this.identity, pid, started, 'SIGTERM')) {
      const until = Date.now() + graceMs
      while (groupAlive(pid) && Date.now() < until) await sleep(100)
      if (groupAlive(pid)) signalOwnGroup(this.identity, pid, started, 'SIGKILL')
    }
    await this.close()
  }

  async close(): Promise<void> {
    this.reported = true
    await this.tmux(this.base.killSession())
  }

  detach(): void {
    this.generation++ // a poll already running reports nothing after this
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  childPid(): number | null {
    return this.pid
  }

  onExit(cb: (exit: PtyExit) => void): void {
    this.exitCb = cb
  }

  async setMarker(name: 'launch' | 'session' | 'pane', value: string): Promise<void> {
    await this.tmux(this.base.setOption(`talos_${name}`, value))
  }

  async marker(name: 'launch' | 'session' | 'pane'): Promise<string | null> {
    const r = await this.tmux(this.base.showOption(`talos_${name}`))
    if (!r.ok) return null
    const v = r.out.trim()
    return v === '' ? null : v
  }
}

/**
 * The variables a POSIX shell can `export`. A real login environment also holds names it cannot: exported bash functions
 * (`BASH_FUNC_which%%`, Fedora's which2.sh, Lmod) and, where /bin/sh is bash, read-only ones (`SHELLOPTS`, `UID`, ...),
 * whose export ends the script. Those are left out, never fatal.
 */
/** bash's read-only variables (an export of one ends the script); BASH_ENV and the other BASH_ settings pass. */
const SHELL_RESERVED = new Set(['SHELLOPTS', 'BASHOPTS', 'BASH_VERSINFO', 'UID', 'EUID', 'PPID'])
function shellEnv(env: Record<string, string>): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || SHELL_RESERVED.has(k)) dropped.push(k)
    else out[k] = v
  return { env: out, dropped: dropped.sort() }
}

/** One shell word: single-quoted, a `'` as `'\\''`. */
const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

/** What the tmux server itself runs with: the plain basics, never a token or a setting that belongs to one launch. */
const SERVER_BASICS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'XDG_RUNTIME_DIR']
function serverBasics(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (SERVER_BASICS.includes(k) || k.startsWith('LC_')) out[k] = v
  return out
}

/** A dead pane's screen and history, without the "Pane is dead" line tmux adds. */
function deadPaneRows(capture: string): string[] {
  return parseCapture(capture).filter((r) => !r.startsWith('Pane is dead'))
}
