// The services every part of the bridge shares. Built once in bridge.ts; tests build it with fakes.
import { type Frame, type MessageT, newId, newUlid } from '@talos-app/protocol'
import type { AppService } from './apps/service.ts'
import type { CardExpiry } from './card-expiry.ts'
import type { CardLedger } from './cards-ledger.ts'
import type { Clock } from './clock.ts'
import type { BridgeEnv, BridgePaths } from './config.ts'
import type { ConfigFile } from './config-file.ts'
import type { ConfigProposals } from './config-propose/service.ts'
import type { DeviceStore } from './devices.ts'
import type { DialogCards } from './dialog-card.ts'
import { receiptFrame, replyFrame } from './frames-out.ts'
import type { HistoryStore } from './history-store.ts'
import type { Logger } from './log.ts'
import { holdOwnerNotice, newResendMemory, resendToMain } from './main-resend.ts'
import type { MediaStore } from './media.ts'
import type { ModLink } from './mod/link.ts'
import { type Notification, systemNotification, type ThreadRef } from './notify.ts'
import { say } from './owner-words.ts'
import type { PermissionRelay } from './permission/relay.ts'
import type { RelayHttp } from './relay-http.ts'
import type { ScheduleService } from './schedules/service.ts'
import type { SessionControls } from './session/controls.ts'
import type { Transport } from './transport.ts'
import type {
  BugContextSeam,
  FilesServiceSeam,
  FolderServiceSeam,
  HealthService,
  MemoryService,
  SearchService,
  SpeakServiceSeam,
} from './v2-seams.ts'

/** kv key holding the ids the agent was told about and has not touched (D39). */
const UNANSWERED_KEY = 'unanswered_v1'
/** A pending id older than this is not reported: the owner has long since moved on or asked again. */
export const UNANSWERED_MAX_AGE_MS = 14 * 24 * 3600_000
const UNANSWERED_MAX_ENTRIES = 500

type Pending = { thread: string; at: number; run: string; pid: number }

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // it exists, we just may not signal it
  }
}

/**
 * Owner messages the agent was told about and has not touched yet; a tool call with that thread marks them `seen`.
 *
 * With `persist` (the live main bridge) the pending ids are also kept in the store, stamped with this process' run id, so
 * a session that dies with a message in flight is noticed by the next one (D39: the app showed Delivered forever and the
 * relay and `hasSeen` both treat the message as handled). The in-memory list is what `unread` and `take` read; the store
 * copy is only read by `takeUnansweredFromEarlierRuns`.
 */
export class SeenTracker {
  private pending = new Map<string, string[]>()
  /** Per process. A reconnect keeps it; a restart does not, which is how an earlier session's entries are told apart. */
  readonly run = newUlid()
  constructor(private persist?: { store: Pick<HistoryStore, 'kvGet' | 'kvSet'>; clock: Clock }) {}

  /** Ids the thread router took for a dedicated worker session: it tracks those claims itself, so they are not persisted here. */
  private routerOwned = new Set<string>()
  /**
   * Per thread: when this session was first told about a message there, with no tool call from it since (ms). Messages the router
   * gave to a thread's own worker are left out (another process reads those) until the router falls back to this session.
   */
  private unseenSince = new Map<string, number>()
  /**
   * Per thread: the owner messages told to this session since its last tool call (what `oldestUnseenAt` is the start of). A tool call
   * or `take` empties it, so a message Main already took in is never in it (`pending` is not that: it outlives a tool call).
   */
  private unseenList = new Map<string, string[]>()
  /** Called when `oldestUnseenAt` may have changed (the live bridge rewrites status.json). */
  onChange?: () => void

  add(thread: string, messageId: string, opts: { persist?: boolean } = {}) {
    const l = this.pending.get(thread) ?? []
    l.push(messageId)
    this.pending.set(thread, l)
    const routed = this.routerOwned.delete(messageId)
    if (!routed) {
      this.markUnseen(thread)
      this.noteUnseen(thread, messageId)
    }
    if (opts.persist === false || routed) return
    this.track(thread, messageId)
  }

  /** The router gave this session a message a thread's own worker did not claim in time: it is this session's to read now. */
  heldForMain(thread: string, messageId: string) {
    this.markUnseen(thread)
    this.noteUnseen(thread, messageId)
    this.track(thread, messageId)
  }

  /** Any tool call from this session: it is reading and working, so nothing it was told about counts as unseen any more. */
  toolCalled() {
    if (this.unseenSince.size === 0) return
    this.unseenSince.clear()
    this.unseenList.clear()
    this.onChange?.()
  }

  private noteUnseen(thread: string, messageId: string) {
    const l = this.unseenList.get(thread) ?? []
    l.push(messageId)
    this.unseenList.set(thread, l)
  }

  private markUnseen(thread: string) {
    if (this.unseenSince.has(thread)) return
    this.unseenSince.set(thread, this.persist?.clock.now() ?? Date.now())
    this.onChange?.()
  }

  /**
   * status.json's `unseen_oldest_at`: the oldest time this session was told about an owner message with no tool call since, or
   * null when there is none. A supervisor reads it to tell a session that stopped reading (packages/protocol supervisor.ts).
   */
  oldestUnseenAt(): string | null {
    let oldest: number | undefined
    for (const at of this.unseenSince.values()) if (oldest === undefined || at < oldest) oldest = at
    return oldest === undefined ? null : new Date(oldest).toISOString()
  }

  private stopAt: number | null = null
  /** A stop the mod carried out for the owner (a session control `stop` answered ok): kept so a missed-turn resend is never made for a turn they stopped. */
  noteStop(at: number) {
    this.stopAt = this.stopAt === null ? at : Math.max(this.stopAt, at)
    this.onChange?.()
  }
  /** After a restart: the last stop the bridge kept (epoch ms as text). */
  restoreStop(raw: string | null | undefined) {
    const n = Number(raw)
    if (raw && Number.isFinite(n)) this.stopAt = n
  }
  /** When the owner last pressed Stop (ISO), null for none since this bridge started (status.json's `last_stop_at`). */
  lastStopAt(): string | null {
    return this.stopAt === null ? null : new Date(this.stopAt).toISOString()
  }

  private resend = newResendMemory()
  /** Every notice on its way to Main (the owner's own are kept for `resendToMain`). */
  hold(n: Notification) {
    holdOwnerNotice(this.resend, n)
  }
  /** The Mac's stall watchdog asked (request file) for the unread owner message to be delivered once more (main-resend.ts). */
  resendToMain(ctx: { paths: BridgePaths; log: Logger; clock: Clock }, deliver: (n: Notification) => Promise<void>) {
    return resendToMain(this.resend, this, ctx, deliver)
  }

  /** The owner messages told to this session since its last tool call: the ones a stall is about, never an earlier, taken-in one. */
  unseenIds(): string[] {
    return [...this.unseenList.values()].flat()
  }

  /** The router handed this message to a thread's own worker session (another process): its claim is the router's to report. */
  routerOwns(messageId: string) {
    if (!messageId) return
    if (this.routerOwned.size > 1000) this.routerOwned.clear() // ids whose owner message never reached add() (a card_action)
    this.routerOwned.add(messageId)
    if (!this.persist) return
    const all = this.read()
    if (delete all[messageId]) this.write(all)
  }

  /** Keep the id in the store only (not the in-memory unread list): the router fell back to this session for it. */
  track(thread: string, messageId: string) {
    if (!this.persist) return
    const all = this.read()
    all[messageId] = { thread, at: this.persist.clock.now(), run: this.run, pid: process.pid }
    const ids = Object.keys(all)
    // oldest first out; an unbounded list would be a slow leak for a session that never answers
    if (ids.length > UNANSWERED_MAX_ENTRIES)
      for (const id of ids
        .sort((x, y) => (all[x]?.at ?? 0) - (all[y]?.at ?? 0))
        .slice(0, ids.length - UNANSWERED_MAX_ENTRIES))
        delete all[id]
    this.write(all)
  }

  /** The agent touched the thread (any tool): the owner gets a `seen` receipt. This is NOT an answer; see `answered`. */
  take(thread: string): string[] {
    const l = this.pending.get(thread) ?? []
    this.pending.delete(thread)
    this.unseenList.delete(thread)
    if (this.unseenSince.delete(thread)) this.onChange?.()
    return l
  }
  /**
   * The agent posted to the thread (a reply, a file, a card): whatever the owner sent before that has been answered, so the
   * stored copy goes. A read or a status line is not an answer: a session that marks "working" and dies mid-task is the
   * main case this exists for.
   */
  answered(thread: string) {
    if (!this.persist) return
    const all = this.read()
    let changed = false
    for (const [id, e] of Object.entries(all))
      if (e.thread === thread && e.run === this.run) changed = delete all[id] || changed
    if (changed) this.write(all)
  }
  count(thread: string): number {
    return this.pending.get(thread)?.length ?? 0
  }

  /**
   * Entries an EARLIER process left behind, grouped by thread, newest-first not guaranteed. Removes them from the store
   * (at most once), together with anything over 14 days old. Entries of this run, and of another process that is still alive
   * (a thread's own worker session, a superseded bridge), stay.
   */
  takeUnansweredFromEarlierRuns(isAlive: (pid: number) => boolean = pidAlive): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (!this.persist) return out
    const now = this.persist.clock.now()
    const all = this.read()
    let changed = false
    for (const [id, e] of Object.entries(all)) {
      if (e.run === this.run) continue
      if (now - e.at > UNANSWERED_MAX_AGE_MS) {
        delete all[id]
        changed = true
        continue
      }
      if (e.pid !== process.pid && isAlive(e.pid)) continue
      out.set(e.thread, [...(out.get(e.thread) ?? []), id])
      delete all[id]
      changed = true
    }
    if (changed) this.write(all)
    return out
  }

  private read(): Record<string, Pending> {
    try {
      const v = JSON.parse(this.persist?.store.kvGet(UNANSWERED_KEY) ?? '{}') as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
      const out: Record<string, Pending> = {}
      for (const [id, e] of Object.entries(v as Record<string, Partial<Pending>>))
        if (
          typeof e?.thread === 'string' &&
          typeof e.at === 'number' &&
          typeof e.run === 'string' &&
          typeof e.pid === 'number'
        )
          out[id] = { thread: e.thread, at: e.at, run: e.run, pid: e.pid }
      return out
    } catch {
      return {}
    }
  }
  private write(all: Record<string, Pending>) {
    this.persist?.store.kvSet(UNANSWERED_KEY, JSON.stringify(all))
  }
}

export type BridgeContext = {
  mode: 'live' | 'headless'
  /** Another bridge owns the key (4409) and this one has not rejoined: no tool prompts or live-only tools until it does. */
  superseded?: boolean
  /**
   * Set at the very start of Bridge.stop(), before anything is awaited: nothing more is handed to the agent or a thread's
   * session, no frame is taken up or acked, and every pending undo-point hold is given up (stopping.ts).
   */
  closing?: boolean
  env: BridgeEnv
  paths: BridgePaths
  log: Logger
  clock: Clock
  config: ConfigFile
  devices: DeviceStore
  store: HistoryStore
  ledger: CardLedger
  /** Live bridge only: arms the expiry timers. Headless processes leave it unset; the live bridge syncs from the ledger. */
  expiry?: CardExpiry
  /** Claude Code permission prompts as cards (docs/CLAUDE-CODE.md C3). Always present; it does nothing unless enabled. */
  permission: PermissionRelay
  media: MediaStore
  http: RelayHttp
  transport: Transport
  seen: SeenTracker
  /** The Talos mod's link (C2.3): `talos_mod_*` tools, session state and inventory, the C3.4 event feed. */
  mod: ModLink
  /** Plan usage from main and every thread session, newest per kind (router/usage-pool.ts). Live bridge only. */
  usage?: import('./router/usage-pool.ts').UsagePool
  /** App controls for the live Claude session (C4): policy check, queue for the mod, recorded result. */
  session: SessionControls
  /** Schedules (docs/SCHEDULES.md): present in live and headless mode; loops and writes only ever run when live and gated. */
  schedules?: ScheduleService
  /** O1: settings the agent may PROPOSE (a card the owner approves, applied by the bridge). Live main session only. */
  configProposals?: ConfigProposals
  /** Needs-you prompts: a card for a known dialog in a thread session (docs/OPTION-C.md). Live main session only. */
  dialogs?: DialogCards
  /** An open AskUserQuestion mirrored as cards and answered through its hook (permission/question.ts): the live main bridge only. */
  questions?: import('./permission/question.ts').QuestionAsks
  /** Screen helper consent: one card per app per Mac (screen-consent.ts). Live main session only. */
  screenConsent?: import('./screen-consent.ts').ScreenConsent
  /** Consent cards for a permission-mode change the owner has not said yes to (permission-mode.ts). Live main session only. */
  permissionModeConsent?: import('./permission-mode.ts').PermissionModeConsent
  /** The kit's "ask first" rules as cards (action-rule-asks.ts): live main bridge only. */
  actionRuleAsks?: import('./action-rule-asks.ts').ActionRuleAsks
  /** v2 features (docs/V2-FEATURES.md V8): set by WP-V2, WP-V5 and WP-V1; absent = the read answers a fixed error. */
  search?: SearchService
  memory?: MemoryService
  health?: HealthService
  /** Read aloud on request (the play button): set by a live bridge; absent = the read answers a fixed error. */
  speak?: SpeakServiceSeam
  /** Whether the Mac app's run channel is connected (`run-pane/1`; pane-run.ts): live main bridge only. */
  paneRun?: import('./pane-run.ts').PaneChannel
  /** The folder picker's lister (live main bridge only); absent = `fs.list` answers a fixed error. */
  folders?: FolderServiceSeam
  /** The Files pane's fenced list and read of a thread's folder (live main bridge only); absent = `files.*` answers a fixed error. */
  files?: FilesServiceSeam
  /** The thread's AGENTS.md in its settings (src/files/agents-md.ts; live main bridge only); absent = `agents_md.*` answers a fixed error. */
  agentsMd?: import('./files/agents-md.ts').AgentsMdService
  /** Uploads into a thread's folder (src/files/put.ts; live main bridge only); absent = `files.put` answers a fixed error. */
  filesPut?: import('./files/put.ts').FilesPutService
  /** The files sent in Talos, from history (src/files/sent.ts); absent = `files.sent` answers a fixed error. */
  filesSent?: import('./files/sent.ts').FilesSentService
  /** Which folders Memory's Notes show, picked in Settings (src/memory/roots.ts): a live main bridge. */
  memoryRoots?: import('./memory/roots.ts').MemoryRoots
  /** The bug reporter's read of versions, filed errors and the cleaned log tail (live main bridge only); absent = `bug.context` answers a fixed error. */
  bugContext?: BugContextSeam
  /** The remote terminal's read-only view of the agent's pane (src/term): the live main bridge with tmux. Absent elsewhere. */
  term?: import('./term/service.ts').TermService
  /** MCP apps (docs/APPS.md): present on a live bridge; it answers app requests with a fixed refusal while the feature is off. */
  apps?: AppService
  /** Problem reports (docs/ERRORS.md): the live main bridge files them; absent elsewhere. */
  problems?: import('./problems/service.ts').ProblemService
  /** Tells Main what the bridge learned itself, once per key and across a restart (src/main-wake): the live main bridge only. */
  mainWake?: import('./main-wake/service.ts').MainWake
  /** Linked agents (src/peer): `peer_send` and the inbound ledger. The live main bridge only. */
  peers?: import('./peer/service.ts').PeerService
  /** Option C worker mode (docs/OPTION-C.md): this process is the named thread's own session. */
  worker?: {
    thread: string /** The connection to main's hub: the Schedules tools ask main through it. */
    hub?: import('./hub/client.ts').HubClient
  }
  /** Live bridge only: reaches thread leads for the `handoff` tool (router.ts). */
  leads?: { unreachable(thread: string): string | undefined; deliver(): Promise<void> }
  /** Undo points (undo/service.ts): the live main bridge only. Absent elsewhere, and no point is taken. */
  undo?: import('./undo/route-point.ts').UndoSeam
  /** The undo card (undo/card.ts): the live main bridge only. */
  undoCards?: import('./undo/card.ts').UndoCards
  /** The "waiting on you" notice for the gaps with no card (the Notification hook; permission/needs-you-notice.ts). */
  needsYou?: import('./permission/needs-you-notice.ts').NeedsYouNotices
  /** "Add plugin to agent": the card and the install on the owner's tap (plugins/agent-plugins.ts): the live main bridge only. */
  agentPlugins?: import('./plugins/agent-plugins.ts').AgentPlugins
  /** The offer to send a turn an update cut off again (router/update-resend.ts): the live main bridge only. */
  updateResend?: import('./router/update-resend.ts').UpdateResendCards
  /** The card for a thread session that stopped on an API error or a refusal (router/session-error-cards.ts): the live main bridge only. */
  sessionErrors?: import('./router/session-error-cards.ts').SessionErrorCards
  /** Linked agents (peer/address-ask.ts): the ask that holds waiting messages when an agent's address changes. Live main bridge only. */
  peerAddressAsk?: import('./peer/address-ask.ts').PeerAddressAsk
  /** A message's undo point on its receipt and history rows (undo/marks.ts): the live main bridge only. */
  undoMarks?: import('./undo/marks.ts').UndoMarks
  /** Pushes a channel notification into the Claude session. A no-op in headless mode. */
  emit: (n: Notification) => Promise<void>
}

export function threadRef(ctx: BridgeContext, id: string): ThreadRef {
  const t = ctx.config.thread(id)
  return { id, name: t?.name ?? id }
}

/**
 * Where proactive messages go when no thread is named. A headless `claude -p` job that Chronos started (CHRONOS_JOB set)
 * posts to that job's result thread instead (docs/SCHEDULES.md S3.6).
 */
export function defaultThreadRef(ctx: BridgeContext): ThreadRef {
  return threadRef(ctx, ctx.schedules?.headlessJobThread() ?? ctx.config.config.default_thread)
}

/** Sends `receipt{seen}` for owner messages in `thread` the agent had not touched yet. */
export function touchThread(ctx: BridgeContext, thread: string) {
  for (const id of ctx.seen.take(thread)) {
    ctx.transport.sendEphemeral(receiptFrame(ctx.clock.now(), id, 'seen'))
  }
}

/**
 * A notice from the bridge itself (device pinned/revoked): a `system` row in the app and, when
 * wanted, a `system` notification to the agent.
 */
export async function postSystemNotice(
  ctx: BridgeContext,
  text: string,
  opts: {
    toAgent?: boolean
    thread?: ThreadRef
    id?: string
    handoff?: MessageT['handoff']
    /** Buttons the row offers (the quiet-agent notice's Open terminal): client-side only, no authority (protocol MessageAction). */
    actions?: MessageT['actions']
    /** The agent changed a setting that decides which alerts reach the owner: pushed through quiet hours (frames.ts). */
    settingsChanged?: boolean
    /** A send made without a card because its kind is always allowed: pushed through quiet hours (always-allow.ts). */
    sentAlwaysAllowed?: boolean
    /** Posted to the thread without a phone notification (always-allow passes, owner 2026-11-15). */
    silent?: boolean
  } = {},
) {
  const now = ctx.clock.now()
  const thread = opts.thread ?? defaultThreadRef(ctx)
  const message: MessageT = {
    id: opts.id ?? newId('m'),
    thread_id: thread.id,
    author: 'system',
    kind: 'text',
    text,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date(now).toISOString(),
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
    ...(opts.actions ? { actions: opts.actions } : {}),
  }
  ctx.store.addMessage(message)
  try {
    await ctx.transport.sendDurable(
      replyFrame(now, message, {
        ...(opts.silent ? { silent: true } : {}),
        ...(opts.settingsChanged ? { settings_changed: true } : {}),
        ...(opts.sentAlwaysAllowed ? { sent_always_allowed: true } : {}),
      }) as Frame,
    )
  } catch (e) {
    ctx.log.warn('system notice not sent', { error: (e as Error).message })
  }
  if (opts.toAgent) {
    await ctx.emit(systemNotification({ thread, text, ts: message.created_at, id: message.id }))
  }
}

/**
 * D39, once per process: tell the owner (a line in the thread) and the agent (a system notification) about owner messages an
 * EARLIER session was handed and never touched. Called from `ready`, which fires on every reconnect, so the once-per-process
 * guard lives in the caller and this only ever looks at entries stamped by a different run. The message is not sent again:
 * the agent decides. "May not have been answered", because a superseded bridge can look the same.
 */
export async function reportUnansweredFromEarlierRuns(ctx: BridgeContext): Promise<void> {
  if (ctx.mode !== 'live' || ctx.worker) return
  const byThread = ctx.seen.takeUnansweredFromEarlierRuns()
  if (byThread.size === 0) return
  const total = [...byThread.values()].reduce((n, ids) => n + ids.length, 0)
  const many = total > 1
  // One line however many threads: in that thread when it is only one, else in the default thread.
  const thread = byThread.size === 1 ? ([...byThread.keys()][0] as string) : defaultThreadRef(ctx).id
  const where = byThread.size > 1 ? ` in ${byThread.size} threads` : ''
  const text = `${many ? `${total} messages` : 'A message'}${where} you sent may not have been answered: the session on ${say({ mac: 'your Mac', linux: 'your computer' })} stopped while ${many ? 'they were' : 'it was'} being handled. Send ${many ? 'them' : 'it'} again if ${many ? 'they still matter' : 'it still matters'}.`
  try {
    await postSystemNotice(ctx, text, { toAgent: true, thread: threadRef(ctx, thread) })
  } catch (e) {
    ctx.log.warn('unanswered notice not posted', { error: (e as Error).message })
  }
}
