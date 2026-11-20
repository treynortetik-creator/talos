// Signing Claude Code in again, with nobody at a terminal (Linux and WSL; the Mac app has the same flow in ClaudeLoginSession.swift).
// The supervisor runs `claude auth login` on a pty of its own, reads the sign-in link off that pty's screen, and feeds the owner's code
// to it through ONE gate (`submitCode`). Nothing of what the CLI prints is kept beyond the screen's last rows, and the code is never
// stored, logged or put in an audit field: it is written to the pty, then Return as a write of its own.
//
// Why Return is its own write: Claude Code takes a burst of more than about 64 characters as a paste and drops an Enter inside it, and a
// real code is longer than that (Mac, 2.1.322: 89 characters in one write were never submitted; the code, then a lone Return, was
// answered in 2 to 6 seconds).
//
// A wrong code: the CLI ends the login. The flow says so (`error: 'wrong_code'`), starts a fresh login (a new link) and keeps asking, so
// the owner is offered a retry, never an empty card. A signed-in answer from `claude auth status --json` (never the screen's words)
// ends the flow and calls `onSignedIn` once, which is where the sessions that were waiting on the sign-in resume.
import type { Subprocess } from 'bun'

export const SIGNIN_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'] as const
/** Longest code the gate takes. A real code is under 200 characters. */
export const CODE_MAX = 512

export interface SignInScreen {
  url: string | null
  wantsCode: boolean
  /** The CLI said the code was not accepted. */
  rejected: boolean
}

function allowedUrl(s: string): boolean {
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false
  const host = u.hostname.toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  return SIGNIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

const REJECTED =
  /invalid (authorization )?code|oauth error|login failed|authentication failed|code (was )?(not accepted|expired)/i

/** What the login's screen shows: the first official https link, whether it waits for a pasted code, whether it refused one. */
export function parseSignInScreen(rows: readonly string[]): SignInScreen {
  let url: string | null = null
  let wantsCode = false
  let rejected = false
  for (const row of rows) {
    if (/paste code here/i.test(row)) wantsCode = true
    if (REJECTED.test(row)) rejected = true
    if (url !== null) continue
    for (const m of row.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const cand = m[0].replace(/[.,;:!?)\]}]+$/, '')
      if (allowedUrl(cand)) {
        url = cand
        break
      }
    }
  }
  return { url, wantsCode, rejected }
}

/** One line of printable characters the CLI could be asked for: no control character, no space, so no other key can ride along. */
export function validCode(code: string): boolean {
  if (code.length === 0 || code.length > CODE_MAX) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return !/[\u0000- \u007f-\u009f]/.test(code)
}

export interface LoginPty {
  /** The screen as text rows (escape sequences removed). */
  rows(): string[]
  write(text: string): boolean
  alive(): boolean
  kill(): void
  pid: number | null
}

/** Rows of text from a raw terminal stream: escapes dropped, a carriage return starts the row over. Enough to read a link and a prompt. */
export function rowsFromStream(raw: string): string[] {
  const noEsc = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the escape-sequence matcher
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the escape-sequence matcher
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the escape-sequence matcher
    .replace(/\x1b[()][A-Za-z0-9]|\x1b./g, '')
  const rows: string[] = []
  for (const line of noEsc.split('\n')) {
    const parts = line.split('\r').filter((p) => p !== '')
    rows.push(parts.length > 0 ? (parts[parts.length - 1] as string) : '')
  }
  return rows.slice(-60)
}

/** `claude auth login` on a pty this process owns (Bun's own terminal support). Wide, so a long link is one row. */
export function bunLoginPty(claude: string, env: Record<string, string>): LoginPty {
  if (!claude.startsWith('/')) throw new Error('claude is not an absolute path')
  let buf = ''
  const dec = new TextDecoder()
  const proc: Subprocess = Bun.spawn([claude, 'auth', 'login'], {
    env: { TERM: 'xterm-256color', ...env },
    cwd: env.HOME ?? '/',
    terminal: {
      cols: 600,
      rows: 40,
      data(_t, d) {
        buf = (buf + dec.decode(d, { stream: true })).slice(-65536)
      },
    },
  })
  let done = false
  void proc.exited.then(() => {
    done = true
  })
  return {
    rows: () => rowsFromStream(buf),
    write: (text) => {
      if (done) return false
      try {
        proc.terminal?.write(text)
        return true
      } catch {
        return false
      }
    },
    alive: () => !done,
    kill: () => {
      if (!done) proc.kill()
    },
    pid: proc.pid,
  }
}

/** `claude auth status --json`: `loggedIn` decides when the JSON has it; anything unreadable is unknown, never a no. */
export async function claudeAuthStatus(claude: string, env: Record<string, string>): Promise<'in' | 'out' | 'unknown'> {
  if (!claude.startsWith('/')) return 'unknown'
  try {
    const p = Bun.spawn([claude, 'auth', 'status', '--json'], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const timer = setTimeout(() => p.kill(), 15_000)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    try {
      const j = JSON.parse(out) as { loggedIn?: unknown }
      if (typeof j.loggedIn === 'boolean') return j.loggedIn ? 'in' : 'out'
    } catch {}
    return code === 0 ? 'in' : code === 127 ? 'unknown' : 'out'
  } catch {
    return 'unknown'
  }
}

export type SignInState =
  | { phase: 'idle' }
  | { phase: 'waiting'; url: string | null; wantsCode: boolean; error: 'wrong_code' | null; attempt: number }
  | { phase: 'signed_in' }
  | { phase: 'failed'; why: 'could_not_start' | 'timed_out' | 'login_ended' }

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'not_waiting' | 'not_asking' | 'bad_code' | 'write_failed' }

export interface SignInDeps {
  spawn: () => LoginPty
  status: () => Promise<'in' | 'out' | 'unknown'>
  /** Called once when Claude is signed in: the sessions that waited on it resume or restart here. */
  onSignedIn: () => void | Promise<void>
  pollMs?: number
  returnDelayMs?: number
  /** The whole sign-in gets this long. */
  limitMs?: number
}

export class SignInFlow {
  state: SignInState = { phase: 'idle' }
  private pty: LoginPty | null = null
  private run: Promise<void> | null = null
  private cancelled = false
  private attempt = 1
  private error: 'wrong_code' | null = null
  private submitted = false
  private checkedAfterEnd = false
  private lastStatusAt = 0

  constructor(private readonly d: SignInDeps) {}

  get pid(): number | null {
    return this.pty?.alive() ? this.pty.pid : null
  }

  /** false when a sign-in is already running. */
  start(): boolean {
    if (this.run !== null) return false
    this.cancelled = false
    this.attempt = 1
    this.error = null
    this.run = this.loop().finally(() => {
      this.run = null
    })
    return true
  }

  settled(): Promise<void> {
    return this.run ?? Promise.resolve()
  }

  cancel(): void {
    this.cancelled = true
    this.pty?.kill()
  }

  private begin(): boolean {
    try {
      this.pty = this.d.spawn()
    } catch {
      this.pty = null
      return false
    }
    this.submitted = false
    this.checkedAfterEnd = false
    return true
  }

  private async loop(): Promise<void> {
    const poll = this.d.pollMs ?? 250
    const deadline = Date.now() + (this.d.limitMs ?? 15 * 60_000)
    // already signed in: nothing to do but resume
    if ((await this.d.status()) === 'in') return this.finish()
    if (!this.begin()) {
      this.state = { phase: 'failed', why: 'could_not_start' }
      return
    }
    this.state = { phase: 'waiting', url: null, wantsCode: false, error: null, attempt: this.attempt }
    try {
      while (true) {
        if (this.cancelled) {
          this.state = { phase: 'idle' }
          return
        }
        if (Date.now() >= deadline) {
          this.state = { phase: 'failed', why: 'timed_out' }
          return
        }
        const pty = this.pty as LoginPty
        const screen = pty.alive() ? parseSignInScreen(pty.rows()) : { url: null, wantsCode: false, rejected: false }
        if (pty.alive()) {
          if (screen.rejected && this.submitted) this.error = 'wrong_code'
          this.state = {
            phase: 'waiting',
            url: screen.url,
            wantsCode: screen.wantsCode,
            error: this.error,
            attempt: this.attempt,
          }
        }
        const ended = !pty.alive()
        // a rejected code ends the login: a fresh one gives a fresh link, and the error stays until a new code is typed
        if (ended || (screen.rejected && this.submitted)) {
          if (!this.checkedAfterEnd) {
            this.checkedAfterEnd = true
            const s = await this.d.status()
            if (s === 'in') return this.finish()
            if (this.submitted || s === 'out') {
              if (this.cancelled) continue
              pty.kill()
              if (this.submitted) this.error = 'wrong_code'
              this.attempt += 1
              if (!this.begin()) {
                this.state = { phase: 'failed', why: 'login_ended' }
                return
              }
              this.state = { phase: 'waiting', url: null, wantsCode: false, error: this.error, attempt: this.attempt }
              continue
            }
          }
        }
        // after a code, ask Claude every couple of seconds (a login that took it may not have ended yet)
        if (this.submitted && Date.now() - this.lastStatusAt >= 2000) {
          this.lastStatusAt = Date.now()
          if ((await this.d.status()) === 'in') return this.finish()
        }
        await Bun.sleep(poll)
      }
    } finally {
      this.pty?.kill()
      this.pty = null
    }
  }

  private async finish(): Promise<void> {
    this.state = { phase: 'signed_in' }
    await this.d.onSignedIn()
  }

  /**
   * The one place a code goes in. Only while a login is waiting and has asked for a code; one line of printable characters; typed, then
   * Return as a write of its own. Returns once the code is written (the Return follows `returnDelayMs` later, if the login is still there).
   */
  async submitCode(code: string): Promise<SubmitResult> {
    const s = this.state
    const pty = this.pty
    if (s.phase !== 'waiting' || pty === null || !pty.alive()) return { ok: false, reason: 'not_waiting' }
    if (!s.wantsCode) return { ok: false, reason: 'not_asking' }
    const clean = code.trim()
    if (!validCode(clean)) return { ok: false, reason: 'bad_code' }
    if (!pty.write(clean)) return { ok: false, reason: 'write_failed' }
    this.submitted = true
    this.error = null
    this.checkedAfterEnd = false
    await Bun.sleep(this.d.returnDelayMs ?? 500)
    if (this.pty === pty && pty.alive()) pty.write('\r')
    return { ok: true }
  }
}

export interface SignInDriverDeps {
  spawn: () => LoginPty
  status: () => Promise<'in' | 'out' | 'unknown'>
  /** Main shows it is signed out (first-start sign-in screen, a refused token, or the not-logged-in hint). */
  signedOut: () => boolean
  /** The thread sessions waiting on a sign-in prompt. */
  signedOutThreads: () => string[]
  /** The owner stopped Main: nothing here starts it again. */
  ownerStopped: () => boolean
  restartMain: () => Promise<void>
  restartThread: (id: string) => Promise<void>
  audit: (event: string, fields?: Record<string, string>) => void
  /** A line to the owner (once per spell): the sign-in did not clear what was signed out. */
  tell: (what: 'still_signed_out') => void
  /**
   * Whether a login may be started at all. It is false on Linux until the owner can type the code from the phone (nothing calls
   * `submitCode` there, so a login would only wait for a code that never comes): the thread line tells them to sign in on the computer.
   */
  startLogins: boolean
  now?: () => number
  pollMs?: number
  returnDelayMs?: number
  limitMs?: number
}

/** Starts the sign-in when a session needs it, hands out its link, and resumes what waited once Claude is signed in. */
export class SignInDriver {
  private readonly flow: SignInFlow
  private failedAt = 0
  private signedInAt = 0
  /** A restart followed a sign-in and nobody has been seen signed in since: no second restart until that happens. */
  private needsClean = false
  private toldStuck = false
  /** Who needed the sign-in when it started, so they are the ones resumed. */
  private needed: { main: boolean; threads: string[] } = { main: false, threads: [] }

  constructor(private readonly d: SignInDriverDeps) {
    this.flow = new SignInFlow({
      spawn: d.spawn,
      status: d.status,
      onSignedIn: () => this.resume(),
      ...(d.pollMs !== undefined ? { pollMs: d.pollMs } : {}),
      ...(d.returnDelayMs !== undefined ? { returnDelayMs: d.returnDelayMs } : {}),
      ...(d.limitMs !== undefined ? { limitMs: d.limitMs } : {}),
    })
  }

  running(): boolean {
    return this.flow.state.phase === 'waiting'
  }

  settled(): Promise<void> {
    return this.flow.settled()
  }

  /** The link, only while a login is waiting on the owner. */
  link(): string | null {
    const s = this.flow.state
    return s.phase === 'waiting' ? s.url : null
  }

  state(): SignInState {
    return this.flow.state
  }

  submitCode(code: string): Promise<SubmitResult> {
    return this.flow.submitCode(code)
  }

  cancel(): void {
    this.flow.cancel()
  }

  /** Never throws: a failure is audited, and the next tick looks again. */
  async tick(): Promise<void> {
    try {
      await this.look()
    } catch (e) {
      this.d.audit('signin_tick_failed', { error: String((e as Error)?.message ?? e) })
    }
  }

  private async look(): Promise<void> {
    if (!this.d.startLogins) return
    const now = (this.d.now ?? Date.now)()
    const main = this.d.signedOut() && !this.d.ownerStopped()
    const threads = this.d.signedOutThreads()
    if (!main && threads.length === 0) {
      // a clean spell: the last sign-in worked, and the next one may start
      this.needsClean = false
      this.toldStuck = false
      return
    }
    const s = this.flow.state
    if (s.phase === 'failed' && this.failedAt === 0) this.failedAt = now
    // after a success, the restart it caused gets two minutes to clear what was signed out. Still signed out after that (a refused token,
    // say): not another login and not another restart, one line instead
    if (this.needsClean) {
      if (now - this.signedInAt < 120_000) return
      if (!this.toldStuck) {
        this.toldStuck = true
        this.d.audit('signin_still_signed_out', {})
        this.d.tell('still_signed_out')
      }
      return
    }
    if (this.flow.pid !== null || s.phase === 'waiting') return
    // a sign-in that failed is tried again after ten minutes, not in a tight loop
    if (s.phase === 'failed' && now - this.failedAt < 10 * 60_000) return
    this.failedAt = 0
    this.needed = { main, threads }
    if (this.flow.start()) this.d.audit('signin_started', { main: String(main), threads: String(threads.length) })
  }

  private async resume(): Promise<void> {
    this.signedInAt = (this.d.now ?? Date.now)()
    this.needsClean = true
    const n = this.needed
    this.d.audit('signin_done', { main: String(n.main), threads: String(n.threads.length) })
    if (n.main) await this.d.restartMain()
    for (const id of n.threads) await this.d.restartThread(id)
  }
}
