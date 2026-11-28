// What a worker's pane says to the owner (P3d3, part 4b; the Mac's WorkerNotices.swift, with the wording of WorkerNotice in
// SessionSwitcher.swift and SupervisorNotice.workerPromptLine): a dialog or a prompt nobody named on the pane, a pointer held
// back by the owner's draft, by a pane with no input box or by a left-over line, and a start stopped at a question (needs_mac).
// Each is ONE line into the worker's own thread per episode, through `post` (a signed system row, never `talos-app post`).
// The record (workers/<id>/notice.json, 0600) is written BEFORE the post, so a crash in between cannot send a line twice; a
// clear failure is tried again (three tries, notice_retry_s apart), a timeout never (it may have been sent).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadId, WORKER_TIMING, type WorkerEntryT, type WorkerStateT } from '@talos-app/protocol'
import { ensureDir, writeFileAtomic } from '../fsutil.ts'
import { WINDOWS_OPEN_SESSION, WINDOWS_SIGN_IN } from '../owner-words.ts'
import { workerDir } from '../worker/files.ts'
import { plainPath } from '../worker/project-settings.ts'
import { busyLine } from './bg-work.ts'
import { detectPrompt, isIdle, isToolPrompt, type Prompt } from './dialog-reader.ts'
import { DialogAbsence, PromptWatch } from './prompt-watch.ts'
import { liveDialog, type Screen } from './screen.ts'
import { resetsAt, USAGE_LIMIT_KIND, UsageLimitWatch, usageLimitThreadLine } from './usage-limit.ts'

export type PostOutcome = 'sent' | 'failed' | 'unknown'

/** How long a notice's post may take before it counts as `unknown` (the relay's own timeout is 15 s). */
export const NOTICE_POST_TIMEOUT_MS = 20_000

/**
 * A post's outcome: sent; `unknown` when it timed out (here, or the request's own abort), since it may have landed; `failed`
 * for any other error (no relay, no key, a refusal): nothing went.
 */
export function postOutcome(send: () => Promise<unknown>, timeoutMs = NOTICE_POST_TIMEOUT_MS): Promise<PostOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<PostOutcome>((r) => {
    timer = setTimeout(() => r('unknown'), timeoutMs)
  })
  const sent = send().then(
    (): PostOutcome => 'sent',
    (e): PostOutcome => {
      const name = (e as Error)?.name
      return name === 'TimeoutError' || name === 'AbortError' ? 'unknown' : 'failed'
    },
  )
  return Promise.race([sent, late]).finally(() => clearTimeout(timer))
}

// ---- the wording ----------------------------------------------------------------------------------------------------------

/** The `needs you` kinds of the holds (not dialogs): the Mac's WorkerNotice.draftKind, noBoxKind and leftoverKind. */
export const HOLD_KIND = {
  draft: 'unsent text',
  noBox: 'no input box',
  leftover: 'left-over line',
  enterUncertain: 'enter may have answered',
} as const
export const NEEDS_MAC_KIND = 'needs_mac'
/** The record kind of the line for a park that cut background work (the Mac's `BackgroundWork.cutKind`). */
export const BG_CUT_KIND = 'background cut'
/** The record kind of the line for a start over the limit (the Mac's `BackgroundWork.busyKind`). */
export const BUSY_KIND = 'computer busy'

/** A thread name as a line may show it: no control characters, trimmed, at most 40 characters; null when nothing is left. */
export function cleanTitle(s: string | null | undefined): string | null {
  if (s == null) return null
  const kept = s.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/^\s+|\s+$/gu, '')
  if (kept === '') return null
  const cp = [...kept]
  return cp.length > 40 ? `${cp.slice(0, 39).join('')}…` : kept
}

/** The supervisor's own time zone, for a reset the screen gives without one. */
const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The prompt in the owner's words. The CLI's own text is never copied into a notice (it is screen text). */
/** The needs_mac details a start fails with on the sign-in screen, or on a prompt it could not name. */
const SIGNIN_DETAILS = new Set(['sign in', 'prompt'])

/**
 * A thread whose start met the sign-in screen before Main was signed in was failed as needs_mac, and a failed worker answers no
 * message, so the thread said "stopped at a question" until someone restarted it by hand (Titan's day-one find on Windows). Once
 * Main is signed in, a message to that thread moves it to off (`toOff`), and the message starts it. Nothing else that failed is
 * touched. Returns the state the wake goes on with.
 */
export function stateAfterSignin(
  entry: WorkerEntryT,
  mainSignedIn: (() => boolean) | undefined,
  toOff: () => boolean,
): WorkerStateT {
  const e = entry.error
  if (entry.state !== 'failed' || e?.code !== 'needs_mac' || !SIGNIN_DETAILS.has(e.detail ?? '')) return entry.state
  return mainSignedIn?.() === true && toOff() ? 'off' : entry.state
}

export function promptName(kind: Screen['kind']): string {
  switch (kind) {
    case 'trust':
      return 'trust this folder'
    case 'mcp_consent':
      return 'approve a project MCP server'
    case 'bypass_disclaimer':
      return 'bypass permissions'
    case 'login_expired':
      return 'sign in'
    case 'dev_channels':
      return 'development channels'
    case 'unknown_selection':
      return 'an unknown question'
    case 'usage_limit':
      return USAGE_LIMIT_KIND
    case 'resume_missing':
      return 'conversation not found' // the Mac's word (DialogMatcher Screen.resumeMissing.label)
    default:
      return 'none'
  }
}

/** `a 'Bash command' prompt, "Do you want to proceed?"`: the question is screen text the detector cleaned to one short line. */
export function promptWhat(p: Prompt): string {
  // the title only (a fixed table): the question is screen text an agent or a repository can write, and a system row in the
  // thread is read as Talos speaking
  let what = p.title ? `a '${p.title}' prompt` : 'a prompt'
  const s = p.autoBlockSeconds
  if (s !== null)
    what += ` (Claude Code blocks it automatically in ${s < 60 ? 'under a minute' : `about ${Math.floor((s + 30) / 60)} min`})`
  return what
}

/** Where the owner goes: the command that attaches to the thread's session, the one that restarts it, and this computer's name. */
/**
 * Where the owner answers a worker's pane: its attach command, the restart command and the machine's name; `windows` on the
 * Windows PC, whose owner has no terminal (the tray's Open a thread's session..., WINDOWS_OPEN_SESSION; the tray for the rest).
 */
export type Where = { attach: string; restart: string; machine: string; windows?: boolean }

/** Names from the owner's config, already cleaned and capped, in quotes so they read as data, never as Talos speaking. */
const quoted = (names: string[]) =>
  names.map((n) => (/^and \d+ more$/.test(n) ? n : `"${n.replaceAll('"', "'")}"`)).join(', ')

export const lines = {
  dialog: (kind: Screen['kind'], w: Where) =>
    // the questions that have a card (MCP server, bypass disclaimer, development channel): no terminal, no command. This line is what
    // the owner gets when no card could be made for it, and it says so (the screen could not be read whole, or no bridge made one)
    kind === 'mcp_consent' || kind === 'bypass_disclaimer' || kind === 'dev_channels'
      ? `This thread's session is waiting on a '${promptName(kind)}' prompt. Talos could not put it on a card, so nothing was pressed and it still waits for your answer.`
      : w.windows
        ? `This thread's session is waiting on a '${promptName(kind)}' prompt. ${WINDOWS_OPEN_SESSION}`
        : `This thread's session is waiting on a '${promptName(kind)}' prompt; attach on ${w.machine} to answer: ${w.attach}`,
  /**
   * Signed out: "Sign in to Claude again". The supervisor runs the sign-in itself (signin.ts), so this names no terminal, no ssh and no
   * command. Nothing here starts a login (the code box on the phone is not built yet, signin.ts `startLogins`), so the line says where to
   * sign in and promises nothing that is not sent.
   */
  login: (w: Where, link?: string | null) =>
    w.windows
      ? `Sign in to Claude again: Claude Code is signed out for this thread's session. ${WINDOWS_SIGN_IN}, then restart this thread's session from your phone.`
      : link
        ? `Sign in to Claude again: Claude Code is signed out for this thread's session. Talos started the sign-in on ${w.machine}; its link is ${link}. Taking the code from your phone is not built yet, so it cannot be finished from here.`
        : `Sign in to Claude again: Claude Code is signed out for this thread's session. Sign in to Claude on ${w.machine}, the computer that runs Talos; this thread's session starts again on your next message after that.`,
  prompt: (p: Prompt, w: Where) =>
    w.windows
      ? `This thread's session is waiting on ${promptWhat(p)}. ${WINDOWS_OPEN_SESSION}`
      : `This thread's session is waiting on ${promptWhat(p)}; attach on ${w.machine} to answer: ${w.attach}`,
  noBox: (w: Where) =>
    w.windows
      ? `This thread's session isn't showing its input box yet. ${WINDOWS_OPEN_SESSION}`
      : `This thread's session isn't showing its input box yet. Attach on ${w.machine} to see what it's waiting on: ${w.attach}`,
  leftover: (w: Where) =>
    w.windows
      ? `This thread's session has text in its input box that may include an old line from Talos, so Talos left it alone. ${WINDOWS_OPEN_SESSION}`
      : `This thread's session has text in its input box that may include an old line from Talos, so Talos left it alone. Attach on ${w.machine} to clear it: ${w.attach}`,
  turnCut: (why: string, w: Where) =>
    w.windows
      ? `This thread's session was still in a turn when it had to ${why === 'restart' || why === 'fresh' || why === 'config' ? 'restart' : 'stop'}, and the turn ran past its time limit, so Talos cut it. ${WINDOWS_OPEN_SESSION}`
      : `This thread's session was still in a turn when it had to ${why === 'restart' || why === 'fresh' || why === 'config' ? 'restart' : 'stop'}, and the turn ran past its time limit, so Talos cut it. Attach on ${w.machine} to see where it stopped: ${w.attach}`,
  /** The key guard refused the pointer: the session shows something other than its empty input box (key-guard.ts). */
  /** The pointer was typed and never showed in the input box: it went somewhere else, and is not typed again (owed-pointer.ts). */
  /** The pointer's Enter may have answered a prompt that opened just then (enter-check.ts): said at once, once per pointer. */
  enterUncertain: (w: Where) =>
    w.windows
      ? `Talos pressed Enter as a prompt appeared in this thread's session; check what it approved. ${WINDOWS_OPEN_SESSION}`
      : `Talos pressed Enter as a prompt appeared in this thread's session; check what it approved. Attach on ${w.machine} to see it: ${w.attach}`,
  /** The Mac's LaunchChange.folderLine: a new folder in the thread's settings started a new conversation there. */
  folder: () => "Started a new conversation in this thread's new folder.",
  /** Starts are refused while Main runs in restricted mode (its code-running tools are off, and a worker cannot be held to it). */
  mainRestricted: (id: string, mode: string) =>
    `Main runs in ${mode}, which this thread's session can't be held to, so it doesn't start; fix that and restart Main, then run \`talos-app supervise restart-thread ${id}\`.`,
  /** Starts are refused while the session's permission hook cannot run: its prompts would stay at the terminal, unseen. */
  hookMissing: (why: string, id: string, w: Where) =>
    w.windows
      ? `This thread's session doesn't start: ${why}, and without it the session's approval prompts would never reach your phone. On the PC, run Talos Setup again, then restart this thread's session from your phone.`
      : `This thread's session doesn't start: ${why}, and without it the session's approval prompts would wait at the terminal on ${w.machine} and never reach your phone. Reinstall Talos on ${w.machine} (or fix the hook), then run \`talos-app supervise restart-thread ${id}\`.`,
  /** Starts are refused while Main's own --settings cannot be read (a session's limits could not be matched to Main's). */
  mainSettings: (what: string, id: string) =>
    `${what === 'the settings given inline' ? "Main's --settings given inline" : `Main's --settings file ${what}`} can't be read, so this thread's session can't start with limits that match Main's; fix or remove it, then run \`talos-app supervise restart-thread ${id}\`.`,
  /** The Mac's LaunchChange.missingServersLine / refusedServersLine. */
  missingServers: (names: string[]) =>
    `These MCP servers on this thread's list were not found, so the session started without them: ${quoted(names)}.`,
  /** The thread folder's own settings, which a thread session does not load (--setting-sources=user). */
  settingsIgnored: (why: string) =>
    `This thread's session started without its folder's own Claude Code settings, skills, commands and subagents (outside the agent folder it loads only your user settings and the folder's instruction files), and one of them would not be allowed anyway: ${why}.`,
  refusedServers: (names: string[]) =>
    `These servers can't be on a thread session's list (a claude.ai connector, the browser or screen tools, a messaging plugin) or Talos can't set them up, so the session started without them: ${quoted(names)}.`,
  needsMac: (what: string, w: Where) =>
    w.windows
      ? `This thread's session stopped at a question only the PC can answer ('${what}'): nobody answered it in ${Math.round(WORKER_TIMING.start_dialog_s / 60)} minutes. ${WINDOWS_OPEN_SESSION}`
      : `This thread's session stopped at a question only ${w.machine} can answer ('${what}'): nobody answered it in ${Math.round(WORKER_TIMING.start_dialog_s / 60)} minutes. To answer it, run \`${w.restart}\` on ${w.machine}, then \`${w.attach}\`.`,
}

// ---- the records ----------------------------------------------------------------------------------------------------------

/** kind -> when it was sent (wall seconds) and whether that dialog (or hold) is still open. The Mac's NoticeRecord. */
export type NoticeRecords = Record<string, { at: number; open: boolean }>
export const NOTICE_FILE = 'notice.json'

const isThread = (id: string) => ThreadId.safeParse(id).success
const noticePath = (home: string, id: string) => join(workerDir(home, id), NOTICE_FILE)

/** The thread's records; a file that is missing or does not fit reads as none. */
export function readNotices(home: string, id: string): NoticeRecords {
  if (!isThread(id)) return {}
  try {
    const o = JSON.parse(readFileSync(noticePath(home, id), 'utf8')) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: NoticeRecords = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as { at?: unknown; open?: unknown }
      if (r && typeof r.at === 'number' && Number.isFinite(r.at) && typeof r.open === 'boolean')
        out[k] = { at: r.at, open: r.open }
    }
    return out
  } catch {
    return {}
  }
}

export function writeNotices(home: string, id: string, m: NoticeRecords): void {
  if (!isThread(id)) return
  ensureDir(workerDir(home, id))
  writeFileAtomic(noticePath(home, id), JSON.stringify(m), 0o600)
}

/** Every record closed: the dialog (or hold) on the pane is over. */
export function closeNoticeRecords(home: string, id: string): void {
  const m = readNotices(home, id)
  if (!Object.values(m).some((r) => r.open)) return
  for (const r of Object.values(m)) r.open = false
  writeNotices(home, id, m)
}

/** One kind's record removed: the hold it announced is over, so the next one is announced again. */
export function forgetNoticeRecord(home: string, id: string, kind: string): void {
  const m = readNotices(home, id)
  if (!(kind in m)) return
  delete m[kind]
  writeNotices(home, id, m)
}

/** Already announced: still open from before a restart, or one of this kind went out lately (a clock set back holds nothing). */
export function noticeSuppressed(m: NoticeRecords, kind: string, nowS: number): boolean {
  const rec = m[kind]
  if (!rec) return false
  if (rec.open) return true
  // a prompt nobody named comes again and again (each tool asks); the stillness before it counts already guards a flap
  // the usage-limit screen: one line an hour at most, across appearances and restarts (the Mac's UsageLimitWatch.window)
  const window = kind.startsWith('prompt: ')
    ? WORKER_TIMING.prompt_debounce_s
    : kind === USAGE_LIMIT_KIND
      ? UsageLimitWatch.WINDOW_S
      : WORKER_TIMING.notice_debounce_s
  return rec.at <= nowS + 60 && nowS - rec.at < window
}

// ---- the per-worker state -------------------------------------------------------------------------------------------------

/** One kind of notice: sent, in flight, its clear failures, when it may be tried again; `episode` counts the episodes. */
export type NoticeSlot = { sent: boolean; inFlight: boolean; attempts: number; retryAt: number; episode: number }
const newSlot = (): NoticeSlot => ({ sent: false, inFlight: false, attempts: 0, retryAt: 0, episode: 0 })
/** In place: a post in flight holds the same object and sees the episode move on. */
function resetSlot(s: NoticeSlot): void {
  s.sent = false
  s.inFlight = false
  s.attempts = 0
  s.retryAt = 0
  s.episode++
}

export type NoticeRuntime = {
  /** The dialog or prompt the pane shows now, in the owner's words. Memory only: a dialog is a screen, not a state. */
  needsYou: string | null
  /** When (monotonic) the current dialog was first seen: a start waits on it at most start_dialog_s. */
  dialogSince: number | null
  /** When (wall clock, ISO) `needsYou` was raised: `needs_you.since` in workers.json (worker-status.ts). */
  needsYouAt: string | null
  /** The usage-limit screen's reset, as a moment (ISO), when it could be read: `needs_you.resets_at`. */
  needsYouResetsAt: string | null
  dlg: NoticeSlot
  held: NoticeSlot
  noBox: { since: number | null; notice: NoticeSlot }
  enterHold: { since: number | null; notice: NoticeSlot }
  mcpMissing: NoticeSlot
  mcpRefused: NoticeSlot
  folder: NoticeSlot
  settingsIgnored: NoticeSlot
  lockNote: NoticeSlot
  draftSince: number | null
  /** The records were checked against the screen since this supervisor took the worker over. */
  recordsChecked: boolean
  screenText: string | null
  screenSince: number
  promptWatch: PromptWatch
  /** The prompt on screen (by its signature) and when (monotonic) it first showed: the clock of the tool-prompt hold cap. */
  heldPrompt: { hash: string; since: number; logged: boolean; missing: number | null } | null
  /** The prompt the needs-you flag was raised for (its hash): a different one showing under the held flag is a new ask. */
  flaggedPrompt: string | null
  absence: DialogAbsence
  /** The needs_mac line: posted once the worker failed, tried again by `retry` while a clear failure leaves it unsent. */
  failed: NoticeSlot
  failedLine: { kind: string; text: string } | null
  /** The line for a park that cut background work: its own slot, so it never replaces a turn-cut or needs_mac line. */
  bgCut: NoticeSlot
  bgCutLine: string | null
  /** The line for a start over the limit: its own slot, kept for `retry` until it went (or three clear failures). */
  busy: NoticeSlot
  busyLine: string | null
}

/**
 * How long an attached client's typing may hold back the line for a TOOL prompt (Bash, a file create or edit), counted from when
 * that prompt first showed. A question or picker is the owner's own and is held for as long as the typing goes on; a tool prompt
 * is what the phone must hear about, so past this it is told whoever is at the keys (Delphi, 2026-11-11: a sub-agent's prompt sat
 * in the pane and nothing reached the thread).
 */
export const TOOL_PROMPT_HOLD_MAX_S = 60

export const newNoticeRuntime = (): NoticeRuntime => ({
  heldPrompt: null,
  flaggedPrompt: null,
  needsYou: null,
  dialogSince: null,
  needsYouAt: null,
  needsYouResetsAt: null,
  dlg: newSlot(),
  held: newSlot(),
  noBox: { since: null, notice: newSlot() },
  enterHold: { since: null, notice: newSlot() },
  mcpMissing: newSlot(),
  mcpRefused: newSlot(),
  folder: newSlot(),
  settingsIgnored: newSlot(),
  lockNote: newSlot(),
  draftSince: null,
  recordsChecked: false,
  screenText: null,
  screenSince: 0,
  promptWatch: new PromptWatch(),
  absence: new DialogAbsence(),
  failed: newSlot(),
  failedLine: null,
  bgCut: newSlot(),
  bgCutLine: null,
  busy: newSlot(),
  busyLine: null,
})

export type NoticeDeps = {
  home: string
  /** One system row into the thread: 'unknown' when it timed out (it may have been sent). */
  post(thread: string, text: string): Promise<PostOutcome>
  threadName(id: string): string
  where(id: string): Where
  /** Monotonic seconds, and wall seconds (the records). */
  now(): number
  wallS(): number
  audit(event: string, fields?: Record<string, string>): void
  /** The line for a dialog offered as a card waits for that card (part 4b-ii); none waits without it. */
  lineWaits?(id: string): boolean
  /** The sign-in link of the supervisor's own sign-in (signin.ts), when one is running and has shown it. */
  signInLink?: (() => string | null) | undefined
  /** The owner's "continue at the usage limit" switch now (config.json); the usage-limit line says Claude Code goes on by itself when on. */
  autoContinue?: (() => boolean) | undefined
}

export class WorkerNotices {
  private readonly inFlight = new Set<Promise<void>>()
  constructor(private readonly d: NoticeDeps) {}

  private wallIso(): string {
    return new Date(this.d.wallS() * 1000).toISOString()
  }

  /** Every post sent so far has been answered (tests). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  /** Whether the pane's whole screen has held still for dialog_settle_s (fed once per look). */
  still(r: NoticeRuntime, rows: string[]): boolean {
    const text = rows.join('\n')
    const t = this.d.now()
    if (r.screenText !== text) {
      r.screenText = text
      r.screenSince = t
    }
    return t - r.screenSince >= WORKER_TIMING.dialog_settle_s
  }

  /**
   * One look at the pane (the Mac's noteScreens): `seen` is the known dialog on a screen that has held still, else none; a prompt
   * nobody named is announced once it has held still (PromptWatch); `typing` says whether an attached client typed lately (the
   * owner's own picker holds a prompt's wait).
   */
  async look(
    id: string,
    r: NoticeRuntime,
    rows: string[],
    seen: Screen,
    settled: boolean,
    typing: () => Promise<boolean>,
  ): Promise<void> {
    const t = this.d.now()
    const settle = WORKER_TIMING.dialog_settle_s
    const before = r.promptWatch.current
    const found = seen.kind !== 'none' ? null : detectPrompt(rows)
    // the cap's clock outlives a look or two that did not read the prompt (a redraw): it starts over once it has been gone 2 s
    if (found === null) {
      const h = r.heldPrompt
      if (h && h.missing === null) h.missing = t
      else if (h && h.missing !== null && t - h.missing >= 2) r.heldPrompt = null
    } else if (r.heldPrompt?.hash !== found.hash)
      r.heldPrompt = { hash: found.hash, since: t, logged: false, missing: null }
    else r.heldPrompt.missing = null
    const capped = found !== null && isToolPrompt(found) && t - (r.heldPrompt?.since ?? t) >= TOOL_PROMPT_HOLD_MAX_S
    const hold = found !== null && before === null && !capped && (await typing())
    if (hold && found && r.heldPrompt && !r.heldPrompt.logged) {
      // each hold once in the log, so it can say a prompt was seen and why it was not told yet
      r.heldPrompt.logged = true
      this.d.audit('worker_prompt_held', { thread: id, prompt: found.title ?? 'prompt', why: 'client_typing' })
    }
    const change = r.promptWatch.observe(found, t, { settle, hold, idle: isIdle(rows) })
    // Another prompt in place of the one announced: its own notice. So is one that shows while the flag of the last is still
    // held (a sub-agent's next ask a few seconds after the owner answered the first: the flag outlives its prompt by
    // dialog_settle_s, and the slot it left as sent would swallow this one's line). The Mac's WorkerNotices, 78dadd8d.
    // (the same prompt back after a moment's other screen is a flicker, not a new ask: its one line stands)
    if (
      change.kind === 'appeared' &&
      (before !== null || (r.needsYou !== null && r.flaggedPrompt !== change.prompt.hash))
    ) {
      resetSlot(r.dlg)
      closeNoticeRecords(this.d.home, id)
    }
    // A flag is held through repaints: it clears when the settled screen has none, or when no dialog shape has been on the pane
    // for dialog_settle_s running.
    const live = liveDialog(rows)
    const gone = r.absence.gone(!(found === null && live.kind === 'none'), t, settle)
    // back to back: the held dialog's place taken by another whole dialog, the screen never still. A new dialog, its own notice
    if (seen.kind === 'none' && live.kind !== 'none' && r.needsYou !== null && r.needsYou !== promptName(live.kind))
      return this.noteScreen(id, r, live, false)
    const shown = r.promptWatch.current
    if (seen.kind !== 'none' || !shown) return this.noteScreen(id, r, seen, (settled && found === null) || gone)
    this.notePrompt(id, r, shown)
  }

  private noteScreen(id: string, r: NoticeRuntime, scr: Screen, settled: boolean): void {
    if (scr.kind === 'none') {
      if (!settled && r.needsYou !== null) return // held: only a settled screen without it says it is gone
      const had = r.needsYou !== null
      if (had) {
        r.needsYou = null
        r.needsYouAt = null
        r.needsYouResetsAt = null
        r.flaggedPrompt = null
        r.dialogSince = null
        resetSlot(r.dlg)
      }
      // a restart of the supervisor forgets which dialog was open, but notice.json still says so: the first settled look closes it
      if (had || (settled && !r.recordsChecked)) {
        r.recordsChecked = true
        closeNoticeRecords(this.d.home, id)
      }
      return
    }
    r.recordsChecked = true
    const prompt = promptName(scr.kind)
    if (r.needsYou !== prompt) {
      r.needsYou = prompt
      r.needsYouAt = this.wallIso()
      r.needsYouResetsAt =
        scr.kind === 'usage_limit' ? resetsAt(scr.info.parts, this.d.wallS() * 1000, localZone()) : null
      r.flaggedPrompt = null // a known dialog, not an unnamed prompt
      r.dialogSince = this.d.now() // a replaced dialog starts its own wait
      resetSlot(r.dlg)
      this.d.audit('worker_needs_you', { thread: id, prompt })
    }
    if (this.d.lineWaits?.(id)) return // offered for a card: the line is the fallback, after the card wait
    const where = this.d.where(id)
    // the usage-limit screen is never "answered": its own line, with the model, the reset and the way on (usage-limit.ts)
    const text =
      scr.kind === 'login_expired'
        ? lines.login(where, this.d.signInLink?.() ?? null)
        : scr.kind === 'usage_limit'
          ? usageLimitThreadLine(scr.info, where.attach, where.windows, this.d.autoContinue?.() === true)
          : lines.dialog(scr.kind, where)
    this.send(id, r.dlg, prompt, text)
  }

  private notePrompt(id: string, r: NoticeRuntime, p: Prompt): void {
    r.recordsChecked = true
    r.flaggedPrompt = p.hash
    const name = p.title ?? 'prompt'
    if (r.needsYou !== name) {
      r.needsYou = name
      r.needsYouAt = this.wallIso()
      r.needsYouResetsAt = null
      if (r.dialogSince === null) r.dialogSince = this.d.now()
      resetSlot(r.dlg)
      this.d.audit('worker_needs_you', { thread: id, prompt: name })
    }
    this.send(id, r.dlg, `prompt: ${p.hash}`, lines.prompt(p, this.d.where(id)))
  }

  /**
   * A pointer held back is not silent. By a draft (or a line of ours that may be mixed with the owner's text, past its deadline:
   * `leftover`): one line after draft_notice_after_s. By no input box on the pane: one line after ready_s. A dialog or prompt
   * that is flagged has its own notice, so it is not also counted as a missing box.
   */
  heldPointer(
    id: string,
    r: NoticeRuntime,
    hold: 'draft' | 'no_box' | 'copy_mode' | 'refused' | 'unseen' | 'enter_uncertain' | null,
    leftover: boolean,
  ): void {
    const h = hold === 'no_box' && r.needsYou !== null ? null : hold
    this.draftHold(id, r, h === 'draft', leftover)
    this.noBoxHold(id, r, h === 'no_box')
    // scrolled back, refused by the key guard, typed and never seen in the box, and a draft: no line of their own any more. The
    // hub says why a message waits (`pointer_hold` in workers.json) and, when Main takes it, says so itself.
    // the Enter that may have answered a prompt: at once (the owner should look now), once per pointer
    this.timedHold(id, r.enterHold, HOLD_KIND.enterUncertain, lines.enterUncertain, h === 'enter_uncertain', 0)
  }

  /** A hold said once after draft_notice_after_s, and forgotten (its record too) when it ends. */
  private timedHold(
    id: string,
    slot: { since: number | null; notice: NoticeSlot },
    kind: string,
    line: (w: Where) => string,
    held: boolean,
    waitS: number = WORKER_TIMING.draft_notice_after_s,
  ): void {
    if (!held) {
      if (slot.since !== null) {
        slot.since = null
        resetSlot(slot.notice)
        forgetNoticeRecord(this.d.home, id, kind)
      }
      return
    }
    const t = this.d.now()
    if (slot.since === null) slot.since = t
    if (t - slot.since < waitS) return
    this.send(id, slot.notice, kind, line(this.d.where(id)))
  }

  /**
   * The pointer was dropped at its claim deadline while a hold kept it back (the message has gone to Main). Only a missing input box
   * still says its line here; the draft, scrolled-back, refused and typed-but-not-seen holds have none (the hub says why Main
   * answered), and the hold is over.
   */
  heldAtDrop(
    id: string,
    r: NoticeRuntime,
    hold: 'draft' | 'no_box' | 'copy_mode' | 'refused' | 'unseen' | 'enter_uncertain',
  ): void {
    const where = this.d.where(id)
    // already said, at once, when it was held: no second line at the drop
    if (hold === 'enter_uncertain') {
      this.heldPointer(id, r, null, false)
      return
    }
    if (hold === 'no_box' && r.needsYou === null) this.send(id, r.noBox.notice, HOLD_KIND.noBox, lines.noBox(where))
    this.heldPointer(id, r, null, false)
  }

  private draftHold(id: string, r: NoticeRuntime, held: boolean, leftover: boolean): void {
    if (!held) {
      if (r.draftSince !== null) {
        r.draftSince = null
        resetSlot(r.held)
        closeNoticeRecords(this.d.home, id)
      }
      return
    }
    const t = this.d.now()
    if (r.draftSince === null) r.draftSince = t
    if (t - r.draftSince < WORKER_TIMING.draft_notice_after_s) return
    const where = this.d.where(id)
    if (leftover) this.send(id, r.held, HOLD_KIND.leftover, lines.leftover(where))
  }

  private noBoxHold(id: string, r: NoticeRuntime, held: boolean): void {
    if (!held) {
      if (r.noBox.since !== null) {
        r.noBox.since = null
        resetSlot(r.noBox.notice)
        forgetNoticeRecord(this.d.home, id, HOLD_KIND.noBox)
      }
      return
    }
    const t = this.d.now()
    if (r.noBox.since === null) r.noBox.since = t
    if (t - r.noBox.since < WORKER_TIMING.ready_s) return
    this.send(id, r.noBox.notice, HOLD_KIND.noBox, lines.noBox(this.d.where(id)))
  }

  /** A start stopped at a question nobody answered: its line, kept for `retry` until it went (or three clear failures). */
  needsMac(id: string, r: NoticeRuntime, what: string): void {
    resetSlot(r.failed)
    r.failedLine = { kind: NEEDS_MAC_KIND, text: lines.needsMac(what, this.d.where(id)) }
    this.retry(id, r)
  }

  /** A turn cut at its limit: its line, through the same slot as needs_mac (kept for `retry` until it went). */
  turnCut(id: string, r: NoticeRuntime, why: string): void {
    resetSlot(r.failed)
    r.failedLine = { kind: `turn_cut: ${why}`, text: lines.turnCut(why, this.d.where(id)) }
    this.retry(id, r)
  }

  /** A park cut background work: its line (bg-work.ts cutLine), kept for `retry` until it went. A new cut is a new line. */
  backgroundCut(id: string, r: NoticeRuntime, text: string): void {
    resetSlot(r.bgCut)
    forgetNoticeRecord(this.d.home, id, BG_CUT_KIND)
    r.bgCutLine = text
    this.retry(id, r)
  }

  /**
   * The servers a launch left out, one line each (missing, refused), once per launch. The names are the owner's own list's,
   * cleaned like a title and at most twelve of them, so a line can never carry a definition's value or run on.
   */
  mcpLeftOut(id: string, r: NoticeRuntime, missing: string[], refused: string[]): void {
    const clean = (ns: string[]) => {
      const out = ns.map((n) => cleanTitle(n)).filter((n): n is string => n !== null)
      return out.length > 12 ? [...out.slice(0, 12), `and ${out.length - 12} more`] : out
    }
    const m = clean(missing)
    const f = clean(refused)
    resetSlot(r.mcpMissing)
    resetSlot(r.mcpRefused)
    if (m.length > 0) this.send(id, r.mcpMissing, `mcp missing: ${[...m].sort().join(',')}`, lines.missingServers(m))
    if (f.length > 0) this.send(id, r.mcpRefused, `mcp refused: ${[...f].sort().join(',')}`, lines.refusedServers(f))
  }

  /** A start over the limit: one line, at most one in the notice window however often the thread is woken (the Mac's tellComputerBusy). */
  computerBusy(id: string, r: NoticeRuntime): void {
    resetSlot(r.busy)
    r.busyLine = busyLine
    this.retry(id, r)
  }

  /** The extra lock stayed on because config.json could not be read: one line, once per launch. */
  lockNote(id: string, r: NoticeRuntime, text: string): void {
    resetSlot(r.lockNote)
    this.send(id, r.lockNote, 'lock note', text)
  }

  /** The folder's own settings files say what a thread session may not carry (they are not loaded): once per launch. */
  settingsIgnored(id: string, r: NoticeRuntime, why: string): void {
    resetSlot(r.settingsIgnored)
    const plain = plainPath(why)
    this.send(id, r.settingsIgnored, `settings ignored: ${plain.slice(0, 200)}`, lines.settingsIgnored(plain))
  }

  /** After a fresh start for a new folder in the thread's settings: one line, once per folder (the Mac's noteLaunch). */
  folderChanged(id: string, r: NoticeRuntime, folder: string): void {
    resetSlot(r.folder)
    this.send(id, r.folder, `folder: ${folder}`, lines.folder())
  }

  /** A start refused because Main's own --settings cannot be read: one line per episode, naming the file and the fix. */
  mainSettingsUnreadable(id: string, r: NoticeRuntime, what: string): void {
    // through the failed-start slot, so a post that failed is tried again each tick; set once per episode (a start that runs
    // clears it), so a refused start after another never posts a second line
    const kind = `main settings unreadable: ${what}`
    if (r.failedLine?.kind !== kind) {
      resetSlot(r.failed)
      r.failedLine = { kind, text: lines.mainSettings(what, id) }
    }
    this.retry(id, r)
  }

  /** A start refused for a reason the thread is told about (Main's own --settings unreadable, or Main restricted). */
  startRefused(
    id: string,
    r: NoticeRuntime,
    why: { mainSettingsUnreadable?: string; mainRestricted?: string; hookMissing?: string },
  ): void {
    if (why.mainSettingsUnreadable !== undefined) this.mainSettingsUnreadable(id, r, why.mainSettingsUnreadable)
    if (why.mainRestricted) this.mainRestricted(id, r, why.mainRestricted)
    if (why.hookMissing) {
      // one line per reason, through the failed-start slot (retried while a clear failure leaves it unsent)
      const kind = `hook missing: ${why.hookMissing}`
      if (r.failedLine?.kind !== kind) {
        resetSlot(r.failed)
        r.failedLine = { kind, text: lines.hookMissing(why.hookMissing, id, this.d.where(id)) }
      }
      this.retry(id, r)
    }
  }

  /** A start refused because Main runs in restricted mode: one line per episode, through the failed-start slot (retried). */
  mainRestricted(id: string, r: NoticeRuntime, mode: string): void {
    const kind = `main narrowed: ${mode}`
    if (r.failedLine?.kind !== kind) {
      resetSlot(r.failed)
      r.failedLine = { kind, text: lines.mainRestricted(id, mode) }
    }
    this.retry(id, r)
  }

  /** Each tick: a line that failed clearly is tried again once notice_retry_s has passed. */
  retry(id: string, r: NoticeRuntime): void {
    if (r.failedLine) this.send(id, r.failed, r.failedLine.kind, r.failedLine.text)
    if (r.bgCutLine) this.send(id, r.bgCut, BG_CUT_KIND, r.bgCutLine)
    if (r.busyLine) this.send(id, r.busy, BUSY_KIND, r.busyLine)
  }

  /** The pane is gone: what it showed is over (the clocks and the notices start again with the next one). */
  release(id: string, r: NoticeRuntime): void {
    r.needsYou = null
    r.needsYouAt = null
    r.needsYouResetsAt = null
    r.flaggedPrompt = null
    r.dialogSince = null
    resetSlot(r.dlg)
    r.promptWatch = new PromptWatch()
    r.heldPrompt = null
    resetSlot(r.held)
    r.draftSince = null
    r.noBox.since = null
    resetSlot(r.noBox.notice)
    r.absence.reset()
    r.screenText = null
    r.screenSince = 0
    closeNoticeRecords(this.d.home, id)
  }

  /** A new start has no dialog open; a needs_mac line still unsent is for a start that is over. */
  newStart(id: string, r: NoticeRuntime): void {
    this.release(id, r)
    resetSlot(r.failed)
    r.failedLine = null
  }

  /** One line, once per episode (`slot`); a repeat of the same kind inside its debounce window is not sent. */
  private send(id: string, slot: NoticeSlot, kind: string, text: string): void {
    if (slot.sent || slot.inFlight || this.d.now() < slot.retryAt) return
    const m = readNotices(this.d.home, id)
    if (noticeSuppressed(m, kind, this.d.wallS())) {
      slot.sent = true
      return
    }
    slot.inFlight = true
    // written before the post: a crash or a restart in the middle cannot make a second one
    m[kind] = { at: this.d.wallS(), open: true }
    writeNotices(this.d.home, id, m)
    const episode = slot.episode
    const p: Promise<void> = this.d
      .post(id, text)
      .catch((): PostOutcome => 'failed')
      .then((outcome) => {
        // a clear failure sent nothing: the debounce slot is given back, so the next one of this kind is not held back
        if (outcome === 'failed') forgetNoticeRecord(this.d.home, id, kind)
        this.d.audit('worker_notice', { thread: id, kind, outcome })
        if (slot.episode !== episode) return // answered or replaced meanwhile: nothing to track
        slot.inFlight = false
        if (outcome !== 'failed') {
          slot.sent = true // a timeout may have been sent: never retried, so it cannot go twice
          return
        }
        slot.attempts++
        if (slot.attempts >= 3) {
          slot.sent = true
          this.d.audit('worker_notice_failed', { thread: id, kind })
        } else slot.retryAt = this.d.now() + WORKER_TIMING.notice_retry_s
      })
      .finally(() => this.inFlight.delete(p))
    this.inFlight.add(p)
  }
}
