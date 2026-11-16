// Main's restart check on Linux: `$TALOS_APP_HOME/main-restart-check.json`, the answer to "would Main come back after a
// restart?" (packages/protocol/src/main-restart.ts; the Mac's MainRestartCheck.swift and SupervisorRestartCheck.swift). The
// bridge reads it (restart-main.ts readRestartCheck: `restart_main check|go`) and passes `needs_you` to the phone (status-line.ts).
// Only the supervisor holding the lock writes it: at least every MAIN_RESTART_CHECK_WRITE_MS, and at once when what it says
// changes. Bytes as the Mac writes them: compact JSON, sorted keys, ISO times with milliseconds, mode 0600, written atomically.
//
// The reasons are the protocol's list, decided from what the Linux supervisor knows (restartReasons). The phone lines are this
// computer's words: the Mac's sentences, with nothing in them a Linux machine does not have (no "Mac", no app, no menu).

import { join } from 'node:path'
import {
  MAIN_RESTART_CHECK_FILE,
  MAIN_RESTART_CHECK_MAX_BYTES,
  MAIN_RESTART_CHECK_WRITE_MS,
  MAIN_RESTART_DETAIL_MAX,
  MAIN_RESTART_REASONS,
  type MainRestartLastT,
  type MainRestartReasonT,
  type MainStatus,
} from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import type { MainStateExtras } from './main-state.ts'
import { readSmallFile } from './worker-dialogs.ts'

/** The labels `needs_you.kind` and `last.detail` use: the Mac's DialogMatcher labels, byte for byte. */
export const LABEL = {
  devWarning: 'dev-channel warning',
  trust: 'folder trust',
  mcp: 'MCP server consent',
  login: 'login expired',
  usage: 'usage limit',
  unknown: 'an unknown question',
} as const
/** A held start without a dialog (the Mac's stall labels). */
export const STALL = {
  blocked: 'takeover check',
  notStarted: 'could not start',
  nothingKnown: 'no screen Talos knows',
} as const
/** The labels a `last.detail` read back after a restart keeps (the Mac's ownLabels): anything else is dropped. */
const OWN_LABELS = new Set<string>([...Object.values(LABEL), ...Object.values(STALL), ...MAIN_RESTART_REASONS])

/**
 * What Main waits on the owner for, as the Mac labels it, or null. From the supervisor's needs-you (a dialog it never answers,
 * the startup warning held, the usage-limit menu) and from a first-start screen it did not answer (main-state's extras).
 * Main stuck, a start that stalled with no screen, the bridge not live: no label (the Mac writes none for those either).
 */
export function needsYouLabel(s: MainStatus, x: MainStateExtras | undefined): string | null {
  const n = s.needsYou
  if (n) {
    if (n.kind === 'usage_limit') return LABEL.usage
    if (n.kind === 'confirm_cold_start' || n.kind === 'restart_not_confirmed') return LABEL.devWarning
    if (n.kind === 'dialog') {
      if (n.dialog === 'trust') return LABEL.trust
      if (n.dialog === 'mcp_consent') return LABEL.mcp
      if (n.dialog === 'login') return LABEL.login
      if (n.dialog === 'dev_channels') return LABEL.devWarning
      return LABEL.unknown
    }
  }
  if (x?.signin) return LABEL.login
  if (x?.waiting === 'trust') return LABEL.trust
  if (x?.waiting === 'mcp_consent') return LABEL.mcp
  if (x?.waiting === 'dev_channels') return LABEL.devWarning
  if (x?.waiting) return LABEL.unknown
  return null
}

/** What the reasons are decided from, all read fresh for each check. */
export type CheckInputs = {
  /** supervisor.json could be read (else the only reason is `unknown`). */
  configOk: boolean
  agentDirExists: boolean
  /** The launch passes `--dangerously-load-development-channels` (so a start shows the warning the guard answers). */
  devChannels: boolean
  /** Root's launch approval holds for the launch as configured now (launch-approval.ts). */
  approved: boolean
  /** The channels the launch passes. */
  launchChannels: readonly string[]
  claudeFound: boolean
  autoConfirmRestart: boolean
  /** A client is attached to Main's pane; null when that cannot be read (counted as attached). */
  attached: boolean | null
  phase: MainStatus['phase']
  ownerStopped: boolean
  /** Seconds since an agent's request could last be held to (main-request.ts sinceLastRequest(owner:false)). */
  sinceLastRequestS: number | null
  /** Requests not the owner's acted on in the rolling hour. */
  agentRestartsLastHour: number
  /** The conversation id a start would resume, or null for a new one. */
  sessionId: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONLY_CHANNEL = 'server:talos-app'
/** The gap and the hourly count, the protocol's numbers (AGENT_REQUEST_MIN_GAP_MS, AGENT_RESTARTS_PER_HOUR). */
export const REQUEST_MIN_GAP_S = 120
export const AGENT_RESTARTS_PER_HOUR = 3

/** Why Main would not come back after a restart an agent asked for: each reason once, in the protocol's order; [] is yes. */
export function restartReasons(i: CheckInputs): MainRestartReasonT[] {
  if (!i.configOk) return ['unknown']
  const out = new Set<MainRestartReasonT>()
  if (i.devChannels) {
    if (!i.approved || i.launchChannels.length !== 1 || i.launchChannels[0] !== ONLY_CHANNEL) out.add('launch_changed')
  }
  if (!i.claudeFound) out.add('claude_path_changed')
  if (i.devChannels && !i.autoConfirmRestart) out.add('auto_confirm_off')
  if (i.attached !== false) out.add('someone_typing')
  if (i.phase === 'blocked') out.add('takeover_held')
  if (i.ownerStopped) out.add('owner_stopped')
  if (i.sinceLastRequestS !== null && i.sinceLastRequestS < REQUEST_MIN_GAP_S) out.add('too_soon')
  if (i.sessionId !== null && !UUID.test(i.sessionId)) out.add('session_id_invalid')
  if (i.agentRestartsLastHour >= AGENT_RESTARTS_PER_HOUR) out.add('restart_limit')
  if (!i.agentDirExists) out.add('unknown')
  return MAIN_RESTART_REASONS.filter((r) => out.has(r))
}

// ---- the phone lines: this computer's words ------------------------------------------------------------------------------

/** One sentence per reason, for "Main was not restarted: …". */
export function reasonSentence(r: string): string {
  switch (r as MainRestartReasonT) {
    case 'launch_changed':
      return 'the way Main starts is not the one approved on this computer, so it would wait at its startup warning.'
    case 'claude_path_changed':
      return 'the claude program cannot be found on this computer, so Main would not start.'
    case 'auto_confirm_off':
      return 'answering the startup warning automatically is off, so this machine needs you at the keyboard after a restart.'
    case 'budget_spent':
      return 'the automatic restarts are used up for now, so Main would wait at its startup warning.'
    case 'someone_typing':
      return 'someone is attached to Main’s window on this computer.'
    case 'takeover_held':
      return 'another session holds the channels Main needs.'
    case 'owner_stopped':
      return 'you stopped Main on this computer, and that stands until you start it again.'
    case 'too_soon':
      return 'Main was restarted less than 2 minutes ago.'
    case 'session_id_invalid':
      return 'the saved conversation id is not a session id, so Main would not start.'
    case 'restart_limit':
      return 'it was already restarted on request 3 times in the last hour.'
    default:
      return 'this computer could not tell whether Main would come back.'
  }
}

export const refusedLine = (reason: string): string => `Main was not restarted: ${reasonSentence(reason)}`
/** No proof and no thread: a session's request, or the phone's own button through a bridge older than the owner's proof. */
export const refusedUnprovedLine = (reason: string): string =>
  `${refusedLine(reason)} If you tapped Restart on your phone, restart Main on this computer instead.`
/** Main sits on a screen that needs someone at the keyboard: an agent's request is refused there. */
export const refusedWaitingLine = (label: string): string =>
  label === LABEL.usage
    ? usageRefusedLine
    : `Main was not restarted: it is waiting on this computer at the ${label}, and a restart would not get past that on its own.`
/** The usage-limit menu: refused for everyone, the owner too (a restart lands on the same menu). */
export const usageRefusedLine =
  'Main was not restarted: it is on Claude Code’s usage-limit menu, and a restart would land on the same menu; it clears when the limit resets.'
export const proofBadLine = 'Main was not restarted: a restart request that claimed to be yours did not verify.'
export function clockLine(why: string): string {
  if (why === 'time_before_launch')
    return 'Your phone’s restart request was signed before Talos started on this computer; it was treated as a session’s.'
  if (why === 'time_before_mark')
    return 'Your phone’s restart request was signed earlier than one this computer already accepted (check the phone’s clock); it was treated as a session’s.'
  if (why === 'form_unknown')
    return 'Your phone’s restart request uses a form this version of Talos does not know (update Talos on this computer); it was treated as a session’s.'
  return 'Your phone’s restart request was signed at a time this computer does not accept (check the phone’s clock); it was treated as a session’s.'
}
/**
 * The line when a session's request is acted on. Who is never a bare name (a forged `by_thread: "owner"` must not read as the
 * owner): "a session", with the thread id only when this computer knows a thread by it. The session's own `why` is never in
 * it: this line is the supervisor's own signed row.
 */
export function restartingLine(byThread: string | null, known: boolean, noProof: boolean): string {
  const who =
    byThread === null
      ? noProof
        ? 'a session, or by your phone through a bridge that has not restarted yet'
        : 'a session (no thread named)'
      : known
        ? `a session in thread “${byThread}”`
        : 'a session (thread not known)'
  return `Main is restarting, asked by ${who}.`
}
/** The first hold of a restart a request began: what it waits at, said at once (the owner's own tap included). */
export function stalledLine(label: string): string {
  if (label === LABEL.usage)
    return 'Main restarted on request and is on Claude Code’s usage-limit menu on this computer; it clears when the limit resets.'
  if (label === STALL.blocked)
    return 'Main restarted on request and is held: another session holds the channels Main needs.'
  if (label === STALL.notStarted) return 'Main restarted on request but could not be started; look at this computer.'
  if (label === STALL.nothingKnown)
    return 'Main restarted on request and is showing a screen Talos does not know; look at this computer.'
  return `Main restarted on request and is waiting at the ${label} on this computer; someone has to answer it at the keyboard (Talos does not).`
}

/** The three lines about requests, each at most once per REQUEST_MIN_GAP_S, one post in flight (the Mac's PhoneLines). */
export class PhoneLines {
  private readonly postedAt = new Map<string, number>()
  private inFlight = false
  /** When (monotonic s) each kind last went, for keeping across a restart. */
  posted(): Record<string, number> {
    return Object.fromEntries(this.postedAt)
  }
  /** A line of `kind` that went at `awake` (read back at a start). */
  seed(kind: string, awake: number): void {
    this.postedAt.set(kind, awake)
  }
  take(kind: 'restarting' | 'refused' | 'stalled', awake: number): boolean {
    if (this.inFlight) return false
    const t = this.postedAt.get(kind)
    if (t !== undefined && awake - t < REQUEST_MIN_GAP_S) return false
    this.postedAt.set(kind, awake)
    this.inFlight = true
    return true
  }
  finished(): void {
    this.inFlight = false
  }
}

// ---- the file ----------------------------------------------------------------------------------------------------------

export type NeedsYouNow = { kind: string; since: string; resets_at?: string }

/** The file's text: sorted keys, compact; over MAIN_RESTART_CHECK_MAX_BYTES, `last.detail` is dropped. */
export function checkFileText(o: {
  atMs: number
  reasons: readonly MainRestartReasonT[]
  last: MainRestartLastT | null
  needsYou: NeedsYouNow | null
}): string {
  const sorted = (v: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const build = (last: MainRestartLastT | null) =>
    JSON.stringify(
      sorted({
        at: new Date(o.atMs).toISOString(),
        ...(last ? { last: sorted({ ...last }) } : {}),
        ...(o.needsYou ? { needs_you: sorted({ ...o.needsYou }) } : {}),
        reasons: [...o.reasons],
        v: 1,
        will_return: o.reasons.length === 0,
      }),
    )
  const text = build(o.last)
  if (Buffer.byteLength(text) <= MAIN_RESTART_CHECK_MAX_BYTES || !o.last?.detail) return text
  const { detail: _dropped, ...rest } = o.last
  return build(rest)
}

/** `detail` as the file allows it: printable ASCII, at most MAIN_RESTART_DETAIL_MAX. */
export const plainDetail = (s: string): string => s.replace(/[^\x20-\x7e]/g, '').slice(0, MAIN_RESTART_DETAIL_MAX)

/** The `last` this supervisor wrote before it restarted, read back strictly; a detail that is not one of its own is dropped. */
export function readLastBack(home: string): MainRestartLastT | null {
  const f = readSmallFile(join(home, MAIN_RESTART_CHECK_FILE), MAIN_RESTART_CHECK_MAX_BYTES)
  if (f.kind !== 'data') return null
  try {
    const l = (JSON.parse(f.text) as { last?: unknown }).last as Record<string, unknown> | undefined
    if (!l || typeof l !== 'object') return null
    const id = l.control_id
    const at = l.at
    const outcome = l.outcome
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null
    if (outcome !== 'came_back' && outcome !== 'stalled' && outcome !== 'refused') return null
    const detail = typeof l.detail === 'string' && OWN_LABELS.has(l.detail) ? l.detail : undefined
    return { control_id: id, at, outcome, ...(detail !== undefined ? { detail } : {}) }
  } catch {
    return null
  }
}

/** The writer: the caller writes when `due` (what it writes is read only then). A failed write is audited once per run. */
export class RestartCheckFile {
  private writtenAt: number | null = null
  private dirty = true
  private failing = false
  constructor(
    private readonly d: {
      home: string
      audit: (e: string, f?: Record<string, string>) => void
    },
  ) {}
  markDirty(): void {
    this.dirty = true
  }
  /** A write is due: never written, MAIN_RESTART_CHECK_WRITE_MS since the last (by the wall clock, either way), or dirty. */
  due(atMs: number): boolean {
    return this.dirty || this.writtenAt === null || Math.abs(atMs - this.writtenAt) >= MAIN_RESTART_CHECK_WRITE_MS
  }
  write(o: Parameters<typeof checkFileText>[0]): void {
    try {
      writeFileAtomic(join(this.d.home, MAIN_RESTART_CHECK_FILE), checkFileText(o), 0o600)
      this.writtenAt = o.atMs
      this.dirty = false
      if (this.failing) this.d.audit('restart_check_written')
      this.failing = false
    } catch (e) {
      if (!this.failing) this.d.audit('restart_check_write_failed', { error: String((e as Error)?.message ?? e) })
      this.failing = true
    }
  }
}
