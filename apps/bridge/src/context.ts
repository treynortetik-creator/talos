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
import { receiptFrame, replyFrame } from './frames-out.ts'
import type { HistoryStore } from './history-store.ts'
import type { Logger } from './log.ts'
import type { MediaStore } from './media.ts'
import type { ModLink } from './mod/link.ts'
import { type Notification, systemNotification, type ThreadRef } from './notify.ts'
import type { PermissionRelay } from './permission/relay.ts'
import type { RelayHttp } from './relay-http.ts'
import type { ScheduleService } from './schedules/service.ts'
import type { SessionControls } from './session/controls.ts'
import type { Transport } from './transport.ts'
import type { HealthService, MemoryService, SearchService, SpeakServiceSeam } from './v2-seams.ts'

/** kv key holding the ids the agent was told about and has not touched (D39). */
const UNANSWERED_KEY = 'unanswered_v1'
/** A pending id older than this is not reported: the owner has long since moved on or asked again. */
export const UNANSWERED_MAX_AGE_MS = 24 * 3600_000
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

  add(thread: string, messageId: string, opts: { persist?: boolean } = {}) {
    const l = this.pending.get(thread) ?? []
    l.push(messageId)
    this.pending.set(thread, l)
    if (opts.persist === false || this.routerOwned.delete(messageId)) return
    this.track(thread, messageId)
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
   * (at most once), together with anything over 24 h old. Entries of this run, and of another process that is still alive
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
  /** App controls for the live Claude session (C4): policy check, queue for the mod, recorded result. */
  session: SessionControls
  /** Schedules (docs/SCHEDULES.md): present in live and headless mode; loops and writes only ever run when live and gated. */
  schedules?: ScheduleService
  /** O1: settings the agent may PROPOSE (a card the owner approves, applied by the bridge). Live main session only. */
  configProposals?: ConfigProposals
  /** v2 features (docs/V2-FEATURES.md V8): set by WP-V2, WP-V5 and WP-V1; absent = the read answers a fixed error. */
  search?: SearchService
  memory?: MemoryService
  health?: HealthService
  /** Read aloud on request (the play button): set by a live bridge; absent = the read answers a fixed error. */
  speak?: SpeakServiceSeam
  /** MCP apps (docs/APPS.md): present on a live bridge; it answers app requests with a fixed refusal while the feature is off. */
  apps?: AppService
  /** Problem reports (docs/ERRORS.md): the live main bridge files them; absent elsewhere. */
  problems?: import('./problems/service.ts').ProblemService
  /** Option C worker mode (docs/OPTION-C.md): this process is the named thread's own session. */
  worker?: { thread: string }
  /** Live bridge only: reaches thread leads for the `handoff` tool (router.ts). */
  leads?: { unreachable(thread: string): string | undefined; deliver(): Promise<void> }
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
  opts: { toAgent?: boolean; thread?: ThreadRef; id?: string; handoff?: MessageT['handoff'] } = {},
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
  }
  ctx.store.addMessage(message)
  try {
    await ctx.transport.sendDurable(replyFrame(now, message) as Frame)
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
  for (const [thread, ids] of ctx.seen.takeUnansweredFromEarlierRuns()) {
    const many = ids.length > 1
    const text = `${many ? `${ids.length} messages` : 'A message'} you sent may not have been answered: the session on your Mac stopped while ${many ? 'they were' : 'it was'} being handled. Send ${many ? 'them' : 'it'} again if ${many ? 'they still matter' : 'it still matters'}.`
    try {
      await postSystemNotice(ctx, text, { toAgent: true, thread: threadRef(ctx, thread) })
    } catch (e) {
      ctx.log.warn('unanswered notice not posted', { error: (e as Error).message })
    }
  }
}
