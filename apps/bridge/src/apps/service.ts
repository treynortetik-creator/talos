// The live side of MCP apps: `app.request` handling, the pending-request lifecycle, results coming back from the hooks,
// card outcomes, views and their revocation (MCP-APPS-SPEC M4, M5.2 to M5.6). One instance per live bridge.
// Nothing here logs arguments, message text or results (M4.8).
import { type FSWatcher, readFileSync, statSync, watch } from 'node:fs'
import {
  type AppErrorCodeT,
  type AppPendingRequestT,
  type AppViewT,
  appMessageProblem,
  type CardT,
  type Frame,
  isAppRequestFresh,
  jcs,
  jcsBytes,
  type McpCallToolResultT,
  Message,
  type MessageT,
  newId,
  sanitizeExternal,
  sha256Hex,
  trustOn,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import { iso } from '../clock.ts'
import { type BridgeContext, postSystemNotice, threadRef, touchThread } from '../context.ts'
import { appResponseFrame, appUpdateFrame, cardUpdateFrame, replyFrame } from '../frames-out.ts'
import { appCardActionLine, appMessageNotification, appToolCallNotification } from '../notify.ts'
import { type CaptureT, deleteCapture, pruneCaptures, readCapture } from './captures.ts'
import { type AppCardPayloadT, cardPayloadOf, prettyArgs, sendAppCard } from './cards.ts'
import {
  type AppCatalogT,
  approvedResourceOf,
  type CatalogResourceT,
  type CatalogServerT,
  findServer,
  readCatalog,
  toolRunsWithoutTap,
  writeCatalog,
} from './catalog.ts'
import {
  DirectAuthError,
  type DirectConnector,
  DirectManifestChanged,
  DirectNotRunnable,
  DirectPool,
  DirectTimeoutError,
  DirectTooLargeError,
  DirectUnavailableError,
  realDirectConnector,
} from './direct.ts'
import type { ServerSecrets } from './keychain.ts'
import { type AppPaths, appPaths } from './paths.ts'
import {
  AUTHORISED_UNCLAIMED_MS,
  CARD_GRACE_MS,
  CLAIM_TO_POST_MS,
  type ClaimedRequestT,
  ensureAppDirs,
  listClaimed,
  listPending,
  readPending,
  removePending,
  TOMBSTONE_MS,
  writePending,
} from './pending.ts'
import { type DecideCtx, type Decision, decideCall, Limits, takeMessage } from './policy.ts'
import { readPinnedHtml } from './scan.ts'
import { appsSwitch } from './switch.ts'
import {
  AppStore,
  packResult,
  uploadAppPage,
  VIEW_CALL_WINDOW_MS,
  type ViewRow,
  viewMessage,
  writeAppMediaIndex,
} from './views.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
type AppRequest = Of<'app.request'>

export class AppToolError extends Error {}

export type AppServiceDeps = {
  secrets: ServerSecrets
  connector?: DirectConnector
  isEnabled?: () => boolean
  /** How often the sweeper runs (ms). Default 5000. */
  tickMs?: number
  /** Turns fs.watch off (tests that drive `tick()` by hand). */
  watch?: boolean
}

const AGENT_FALLBACK = 'your agent'

/** What the app-state line says about a tool's rule: a read-only tool runs, every write draws a card (trust mode or not). */
function tapWords(s: Parameters<typeof toolRunsWithoutTap>[0], t: Parameters<typeof toolRunsWithoutTap>[1]) {
  return toolRunsWithoutTap(s, t) ? 'no tap' : 'card'
}

export class AppService {
  readonly paths: AppPaths
  readonly store: AppStore
  readonly limits: Limits
  readonly pool: DirectPool
  private catCache: { mtime: number; cat: AppCatalogT | undefined } | undefined
  private timer: unknown = null
  private watchers: FSWatcher[] = []
  private stopped = false
  private ticking = false
  private pokeQueued = false
  private offHandled = false
  private lastPrune = 0
  private delivering = new Set<string>()
  private envCache: { at: number; on: boolean } | undefined

  constructor(
    private readonly ctx: BridgeContext,
    private readonly deps: AppServiceDeps,
  ) {
    this.paths = appPaths(ctx.paths.home)
    this.store = new AppStore(ctx.store)
    this.limits = new Limits(() => ctx.clock.now())
    this.pool = new DirectPool({
      connector: deps.connector ?? realDirectConnector,
      secrets: deps.secrets,
      clock: ctx.clock,
      log: ctx.log,
    })
  }

  /** Cards whose tool this process is running right now (a bridge-run card between the tap and its result). */
  private readonly running = new Set<string>()
  isRunning(cardId: string): boolean {
    return this.running.has(cardId)
  }
  private track(cardId: string, work: Promise<void>): Promise<void> {
    this.running.add(cardId)
    return work.finally(() => this.running.delete(cardId))
  }
  /** True when the owner's own kill or revise closed the card: nothing more may be said about it. */
  private closedByOwner(cardId: string): boolean {
    const a = this.ctx.ledger.get(cardId)?.resolution?.action
    return a !== undefined && a !== 'primary'
  }

  // ---- switch ----------------------------------------------------------------------------------------------------

  /** TALOS_APP_APPS: bridge.env first, then the process environment (see switch.ts); re-read every 2 s so "off" takes effect without a restart. */
  enabled(): boolean {
    if (this.deps.isEnabled) return this.deps.isEnabled()
    const now = this.ctx.clock.now()
    if (this.envCache && now - this.envCache.at < 2000) return this.envCache.on
    const on = appsSwitch(this.ctx.env.home, process.env, this.ctx.env.apps)
    this.envCache = { at: now, on }
    return on
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  start(): void {
    ensureAppDirs(this.paths)
    this.arm()
    if (this.deps.watch === false) return
    for (const dir of [this.paths.claimed, this.paths.captures, this.paths.dir]) {
      try {
        this.watchers.push(watch(dir, { persistent: false }, () => this.poke()))
      } catch {
        // the periodic tick still runs
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ctx.clock.clearTimeout(this.timer)
    for (const w of this.watchers) w.close()
    this.watchers = []
    await this.pool.closeAll()
  }

  private arm(): void {
    if (this.stopped) return
    this.ctx.clock.clearTimeout(this.timer)
    this.timer = this.ctx.clock.setTimeout(() => {
      this.tick().catch((e) => this.ctx.log.warn('apps tick failed', { error: (e as Error).message }))
    }, this.deps.tickMs ?? 5000)
  }

  private poke(): void {
    if (this.pokeQueued || this.stopped) return
    this.pokeQueued = true
    queueMicrotask(() => {
      this.pokeQueued = false
      this.tick().catch((e) => this.ctx.log.warn('apps tick failed', { error: (e as Error).message }))
    })
  }

  /** One sweep: results from the hooks, timeouts, tombstones, catalog changes, the off switch, pruning. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      const now = this.ctx.clock.now()
      if (!this.enabled()) {
        if (!this.offHandled) {
          this.offHandled = true
          await this.handleOff()
        }
        return
      }
      this.offHandled = false
      await this.syncCatalog()
      await this.deliverClaimed(now)
      await this.sweepPending(now)
      if (now - this.lastPrune > 5 * 60_000 || now < this.lastPrune) {
        this.lastPrune = now
        pruneCaptures(this.paths, now, this.keepCaptureIds())
        this.store.prune(now)
      }
    } finally {
      this.ticking = false
      this.arm()
    }
  }

  private keepCaptureIds(): Set<string> {
    const keep = new Set<string>()
    for (const c of listClaimed(this.paths)) if (c.linked) keep.add((c.req as ClaimedRequestT).tool_use_id)
    return keep
  }

  // ---- catalog ---------------------------------------------------------------------------------------------------

  catalog(): AppCatalogT | undefined {
    let mtime = 0
    try {
      mtime = statSync(this.paths.catalog).mtimeMs
    } catch {
      // no catalog yet
    }
    if (this.catCache && this.catCache.mtime === mtime) return this.catCache.cat
    const r = readCatalog(this.paths)
    if (!r.ok) this.ctx.log.warn('app catalog unreadable', { reason: r.reason })
    const cat = r.ok ? r.catalog : undefined
    this.catCache = { mtime, cat }
    return cat
  }

  /** A catalog that changed under live views: revoke every view whose approval no longer holds. */
  private async syncCatalog(): Promise<void> {
    const cat = this.catalog()
    for (const v of this.store.activeViews()) {
      const server = cat ? findServer(cat, v.server, v.source) : undefined
      const res = server?.resources.find((r) => r.uri === v.resource_uri)
      if (res?.state !== 'approved' || res.approval_key !== v.approval_key)
        await this.revokeView(v, 'This app was changed or removed. Run talos-app apps scan on the Mac.')
    }
  }

  private async handleOff(): Promise<void> {
    for (const v of this.store.activeViews()) await this.revokeView(v, 'Apps are turned off on this Mac.')
    for (const r of listPending(this.paths, this.ctx.clock.now()).requests) {
      if (r.state !== 'expired') await this.tombstone(r, 'view_closed', 'Apps are turned off on this Mac.')
    }
  }

  // ---- responses and updates ---------------------------------------------------------------------------------------

  private respond(
    viewId: string,
    requestId: string,
    state: 'pending_card' | 'done' | 'failed',
    extra: {
      card_id?: string
      result?: McpCallToolResultT
      result_media?: AppViewT['tool_result_media']
      code?: AppErrorCodeT
      message?: string
    } = {},
  ): void {
    const f = appResponseFrame(this.ctx.clock.now(), {
      view_id: viewId,
      request_id: requestId,
      state,
      ...(extra.card_id ? { card_id: extra.card_id } : {}),
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.result_media ? { result_media: extra.result_media } : {}),
      ...(state === 'failed'
        ? { error: { code: extra.code ?? 'tool_failed', message: extra.message ?? 'The request failed.' } }
        : {}),
    })
    this.ctx.transport.sendEphemeral(f)
  }

  private failed(viewId: string, requestId: string, code: AppErrorCodeT, message: string): void {
    this.respond(viewId, requestId, 'failed', { code, message })
  }

  private sendUpdate(v: ViewRow, state: 'superseded' | 'closed' | 'revoked', reason: string): void {
    // queued in the outbox first; waiting for the relay's ack here would hold up the tool or request that caused it
    this.ctx.transport
      .sendDurable(appUpdateFrame(this.ctx.clock.now(), { view_id: v.view_id, thread_id: v.thread_id, state, reason }))
      .catch((e) => this.ctx.log.warn('app.update not sent', { error: (e as Error).message }))
  }

  /** Revokes one view: state, the frame, and every request still open on it. */
  async revokeView(v: ViewRow, reason: string, state: 'revoked' | 'closed' = 'revoked'): Promise<void> {
    if (!this.store.setViewState(v.view_id, state)) return
    this.limits.forgetView(v.view_id)
    this.sendUpdate(v, state, reason)
    for (const r of this.store.openRequests(v.view_id)) {
      this.store.updateRequest(r.request_id, { state: 'expired', resolved_at: iso(this.ctx.clock.now()) })
      const p = readPending(this.paths, r.request_id)
      if (p && p.state !== 'expired') await this.tombstone(p, 'view_closed', 'That view is closed.')
      else this.failed(v.view_id, r.request_id, 'view_closed', 'That view is closed.')
    }
  }

  async revokeServer(server: string, source: string, reason: string): Promise<void> {
    for (const v of this.store.activeViews({ server, source })) await this.revokeView(v, reason)
  }

  /**
   * A pending request the app will not hear back on: the file stays as a 10-minute `expired` tombstone so a late call is
   * denied. It never touches the card. An approved card's agent has been told to act, so it may still run the tool and
   * report with `card_result`; the card stays `resolved` for that, and its "no result yet" line is the honest state.
   */
  private async tombstone(r: AppPendingRequestT, code: AppErrorCodeT, message: string): Promise<void> {
    const now = this.ctx.clock.now()
    writePending(this.paths, { ...r, state: 'expired', expires_at: iso(now + TOMBSTONE_MS) })
    this.store.updateRequest(r.request_id, { state: 'expired', resolved_at: iso(now) })
    this.failed(r.view_id, r.request_id, code, message)
  }

  // ---- app.request (M4.3) ------------------------------------------------------------------------------------------

  /** Called by the inbound pipeline after the owner signature on the RAW JSON verified. */
  async onAppRequest(f: AppRequest): Promise<void> {
    const { ctx } = this
    const now = ctx.clock.now()
    if (!this.enabled()) {
      this.failed(f.view_id, f.request_id, 'view_closed', 'Apps are turned off on this Mac.')
      if (!this.offHandled) {
        this.offHandled = true
        await this.handleOff()
      }
      return
    }
    if (!isAppRequestFresh(f.ts, now)) {
      ctx.log.security('app request stale', { view_id: f.view_id })
      return this.failed(f.view_id, f.request_id, 'sig_invalid', "This device's clock looks off.")
    }
    const seenKey = `req:${f.request_id}`
    if (ctx.store.hasSeen(seenKey)) {
      ctx.log.security('app request replayed', { view_id: f.view_id })
      return this.failed(f.view_id, f.request_id, 'sig_invalid', 'That request was already used.')
    }
    ctx.store.markSeen(seenKey, now, 'ok')
    if (f.method === 'ui/message') return this.onMessage(f)
    return this.onCall(f)
  }

  private decideCtx(): DecideCtx {
    return {
      now: this.ctx.clock.now(),
      catalog: this.catalog(),
      store: this.store,
      limits: this.limits,
      pendingCount: (v) => this.store.openRequests(v).length,
      labelCheck: (s, t) => this.pool.labelCheck(s, t),
      hasLabelConnection: (s, r) => (s.direct?.type === 'http' || s.direct?.type === 'sse') && r.owner.direct,
      trust: trustOn(this.ctx.config.config),
    }
  }

  private logRequest(
    f: AppRequest,
    decision: 'authorised' | 'card' | 'denied',
    code: AppErrorCodeT | undefined,
    server?: string,
    tool?: string,
  ): void {
    const args = f.method === 'tools/call' ? f.arguments : {}
    this.ctx.log.info('app.request', {
      view_id: f.view_id,
      server,
      tool: tool ?? (f.method === 'tools/call' ? f.tool_name : undefined),
      method: f.method,
      decision,
      code,
      args_sha256: sha256Hex(jcs(args)),
      bytes: f.method === 'tools/call' ? jcsBytes(args) : f.text.length,
      gesture: f.user_gesture,
    })
    if (decision === 'denied') this.ctx.log.security('app request denied', { view_id: f.view_id, code })
  }

  private async onCall(f: Extract<AppRequest, { method: 'tools/call' }>): Promise<void> {
    const { ctx } = this
    let d: Decision
    try {
      d = await decideCall(this.decideCtx(), {
        viewId: f.view_id,
        threadId: f.thread_id,
        toolName: f.tool_name,
        gesture: f.user_gesture,
        argsBytes: jcsBytes(f.arguments) ?? Number.MAX_SAFE_INTEGER,
      })
    } catch (e) {
      ctx.log.error('app policy failed', { error: (e as Error).message })
      d = { kind: 'fail', code: 'tool_failed', message: 'Talos could not check this request.' }
    }
    if (d.kind === 'fail') {
      this.logRequest(f, 'denied', d.code)
      this.failed(f.view_id, f.request_id, d.code, d.message)
      const v = this.store.getView(f.view_id)
      if (v && d.revoke) {
        if (d.reapproval) await this.markNeedsReapproval(v, d.reapproval)
        else await this.revokeServer(v.server, v.source, 'This app changed since it was approved.')
      }
      if (v && d.closeView) {
        await this.revokeView(v, 'Too many requests from this app.', 'closed')
        await postSystemNotice(ctx, `${this.labelOf(v)} was closed: it sent too many requests.`, {
          thread: threadRef(ctx, v.thread_id),
        })
      }
      return
    }
    const { server, tool, resource, view } = d
    // the label check awaited a server: the switch, the view or the approval may have moved since
    if (!d.card && !this.stillRunnable(view)) {
      this.logRequest(f, 'denied', 'view_closed', server.server, tool.name)
      return this.failed(view.view_id, f.request_id, 'view_closed', 'That view is closed.')
    }
    this.store.addRequest({
      request_id: f.request_id,
      view_id: view.view_id,
      method: 'tools/call',
      created_at: iso(ctx.clock.now()),
      state: d.card ? 'awaiting_card' : 'authorised',
    })
    this.logRequest(f, d.card ? 'card' : 'authorised', undefined, server.server, tool.name)
    const nowMs = ctx.clock.now()
    if (d.path === 'agent') {
      if (!d.card) {
        writePending(this.paths, {
          request_id: f.request_id,
          view_id: view.view_id,
          server: server.server,
          server_source: server.source,
          tool: tool.name,
          arguments: f.arguments,
          state: 'authorised',
          created_at: iso(nowMs),
          expires_at: iso(nowMs + AUTHORISED_UNCLAIMED_MS),
        })
        await this.notifyAgentOfCall(view, resource, f.request_id, tool.name, f.arguments, 'read_only')
        return
      }
      return this.raiseCard(f, d, 'agent')
    }
    // direct path
    if (!d.card) {
      void this.runDirect({
        view,
        server,
        tool: tool.name,
        args: f.arguments,
        requestId: f.request_id,
        cardId: undefined,
      })
      return
    }
    return this.raiseCard(f, d, 'bridge')
  }

  /** Same conditions runBridgeCard checks at the tap: apps on, view active, resource still approved under the same key. */
  private stillRunnable(view: ViewRow): boolean {
    if (!this.enabled()) return false
    if (this.store.getView(view.view_id)?.state !== 'active') return false
    const cat = this.catalog()
    const server = cat ? findServer(cat, view.server, view.source) : undefined
    const res = server?.resources.find((r) => r.uri === view.resource_uri)
    return !!res && res.state === 'approved' && res.approval_key === view.approval_key
  }

  private labelOf(v: ViewRow): string {
    const r =
      this.catalog() &&
      findServer(this.catalog() as AppCatalogT, v.server, v.source)?.resources.find((x) => x.uri === v.resource_uri)
    return r?.owner.label ?? v.server
  }

  private async raiseCard(
    f: Extract<AppRequest, { method: 'tools/call' }>,
    d: Extract<Decision, { kind: 'run' }>,
    executor: 'agent' | 'bridge',
  ): Promise<void> {
    const { ctx } = this
    const { server, tool, resource, view } = d
    const agent = ctx.config.config.agent.name || AGENT_FALLBACK
    const label = resource.owner.label
    const warning = d.couldntCheck
      ? `Asked for by an app, not by you or ${agent}. Talos couldn't check this tool's current labels.`
      : `Asked for by an app, not by you or ${agent}.`
    let card: CardT
    try {
      card = await sendAppCard(ctx, {
        threadId: view.thread_id,
        title: `${label} wants to run ${tool.name}`,
        destination: [
          { label: 'Server', value: server.server },
          { label: 'Tool', value: tool.name },
        ],
        body: prettyArgs(f.arguments),
        warning,
        primaryLabel: `Run ${tool.name}`,
        killLabel: 'Kill app request',
        risk: tool.destructive === false && tool.open_world === false ? 'low' : 'high',
        payload: {
          kind: 'app_request',
          executor,
          view_id: view.view_id,
          request_id: f.request_id,
          server: server.server,
          tool: tool.name,
          arguments: f.arguments,
        },
      })
    } catch (e) {
      ctx.log.warn('app card not sent', { error: (e as Error).message })
      this.store.updateRequest(f.request_id, { state: 'failed', resolved_at: iso(ctx.clock.now()) })
      return this.failed(view.view_id, f.request_id, 'tool_failed', 'Talos could not raise the approval card.')
    }
    this.store.updateRequest(f.request_id, { card_id: card.id })
    // the view may have been revoked or closed while the card was being sent: then nothing is left waiting on it
    if (this.store.getView(view.view_id)?.state !== 'active') {
      this.store.updateRequest(f.request_id, { state: 'expired', resolved_at: iso(ctx.clock.now()) })
      return this.failed(view.view_id, f.request_id, 'view_closed', 'That view is closed.')
    }
    if (executor === 'agent') {
      writePending(this.paths, {
        request_id: f.request_id,
        view_id: view.view_id,
        server: server.server,
        server_source: server.source,
        tool: tool.name,
        arguments: f.arguments,
        state: 'awaiting_card',
        card_id: card.id,
        created_at: iso(ctx.clock.now()),
        expires_at: iso(Date.parse(card.expires_at) + CARD_GRACE_MS),
      })
    }
    this.respond(view.view_id, f.request_id, 'pending_card', { card_id: card.id })
  }

  private async notifyAgentOfCall(
    view: ViewRow,
    resource: CatalogResourceT,
    requestId: string,
    tool: string,
    args: Record<string, unknown>,
    basis: 'read_only' | 'card',
  ): Promise<void> {
    const { ctx } = this
    await ctx.emit(
      appToolCallNotification({
        thread: threadRef(ctx, view.thread_id),
        ts: iso(ctx.clock.now()),
        id: requestId,
        view: { viewId: view.view_id, requestId, server: view.server, tool, label: resource.owner.label },
        basis,
        arguments: args,
      }),
    )
  }

  // ---- ui/message --------------------------------------------------------------------------------------------------

  private async onMessage(f: Extract<AppRequest, { method: 'ui/message' }>): Promise<void> {
    const { ctx } = this
    const view = this.store.getView(f.view_id)
    const cat = this.catalog()
    const server = view && cat ? findServer(cat, view.server, view.source) : undefined
    const res = server?.resources.find((r) => r.uri === view?.resource_uri)
    const deny = (code: AppErrorCodeT, message: string) => {
      this.logRequest(f, 'denied', code, view?.server)
      this.failed(f.view_id, f.request_id, code, message)
    }
    if (!view || view.thread_id !== f.thread_id) return deny('view_unknown', 'That view is not known here.')
    if (view.state !== 'active' || ctx.clock.now() >= Date.parse(view.calls_until))
      return deny('view_closed', 'That view is closed.')
    if (!server || !res || res.state !== 'approved' || res.approval_key !== view.approval_key) {
      deny('approval_changed', 'This app changed since it was approved.')
      return this.revokeServer(view.server, view.source, 'This app changed since it was approved.')
    }
    // A tap inside the view cannot be told from the view focusing itself, so the owner's Send on Talos's own chip decides.
    if (f.owner_confirmed !== true) return deny('needs_confirm', 'Tap Send on the card.')
    if (!takeMessage(this.limits, view.view_id).ok) {
      const close = this.limits.noteHit(view.view_id)
      deny('rate_limited', 'Too many messages. Slow down.')
      if (close) {
        await this.revokeView(view, 'Too many requests from this app.', 'closed')
        await postSystemNotice(ctx, `${this.labelOf(view)} was closed: it sent too many requests.`, {
          thread: threadRef(ctx, view.thread_id),
        })
      }
      return
    }
    this.store.addRequest({
      request_id: f.request_id,
      view_id: view.view_id,
      method: 'ui/message',
      created_at: iso(ctx.clock.now()),
      state: 'done',
    })
    this.logRequest(f, 'authorised', undefined, view.server)
    const now = ctx.clock.now()
    const echo: MessageT = Message.parse({
      id: newId('m'),
      thread_id: view.thread_id,
      author: 'app',
      kind: 'text',
      text: f.text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: iso(now),
      app_view_id: view.view_id,
    })
    const bad = appMessageProblem(echo)
    if (bad) return deny('tool_failed', 'Talos could not record the message.')
    ctx.store.addMessage(echo)
    try {
      await ctx.transport.sendDurable(replyFrame(now, echo, { silent: true }))
    } catch (e) {
      ctx.log.warn('app echo not sent', { error: (e as Error).message })
    }
    await ctx.emit(
      appMessageNotification({
        thread: threadRef(ctx, view.thread_id),
        ts: iso(now),
        id: f.request_id,
        view: { viewId: view.view_id, requestId: f.request_id, server: view.server, label: res.owner.label },
        text: f.text,
      }),
    )
    this.respond(view.view_id, f.request_id, 'done')
  }

  // ---- direct path -----------------------------------------------------------------------------------------------

  private async runDirect(a: {
    view: ViewRow
    server: CatalogServerT
    tool: string
    args: Record<string, unknown>
    requestId: string
    cardId: string | undefined
  }): Promise<{ ok: boolean; text: string }> {
    const { ctx } = this
    const { view, server } = a
    this.store.updateRequest(a.requestId, { state: 'running' })
    const finish = async (
      r: { ok: true; result: McpCallToolResultT } | { ok: false; code: AppErrorCodeT; message: string },
    ) => {
      const live = this.store.getView(view.view_id)?.state === 'active'
      this.store.updateRequest(a.requestId, { state: r.ok ? 'done' : 'failed', resolved_at: iso(ctx.clock.now()) })
      if (!live) return // a closed view discards the result (M4.4)
      if (!r.ok) return this.failed(view.view_id, a.requestId, r.code, r.message)
      const packed = await packResult(ctx, r.result).catch(() => ({ error: 'tool_failed' as const }))
      if ('error' in packed)
        return this.failed(view.view_id, a.requestId, packed.error, 'The result could not be sent to the view.')
      if ('media' in packed) return this.respond(view.view_id, a.requestId, 'done', { result_media: packed.media })
      this.respond(view.view_id, a.requestId, 'done', { result: packed.result })
    }
    try {
      // the pool awaits a second list and maybe a connection: the same conditions run again right before the server call
      const result = await this.pool.callTool(server, a.tool, a.args, () => this.stillRunnable(view))
      await finish({ ok: true, result })
      return { ok: true, text: `Ran ${a.tool}` }
    } catch (e) {
      if (e instanceof DirectManifestChanged) {
        await this.markNeedsReapproval(
          view,
          `\`${e.tool ?? a.tool}\` is labelled differently than when you approved it`,
        )
        await finish({ ok: false, code: 'approval_changed', message: 'This app changed how it labels its tools.' })
        return { ok: false, text: 'approval_changed' }
      }
      if (e instanceof DirectNotRunnable) {
        await finish({ ok: false, code: 'view_closed', message: 'That view is closed.' })
        return { ok: false, text: 'view_closed' }
      }
      if (e instanceof DirectAuthError) {
        await this.noticeOnce(
          view,
          `auth:${view.server}`,
          24 * 3600_000,
          `${this.labelOf(view)}: app-only buttons need sign-in. Run talos-app apps login <server> on the Mac.`,
        )
        await finish({ ok: false, code: 'direct_auth', message: 'Sign-in needed.' })
        return { ok: false, text: 'direct_auth' }
      }
      if (e instanceof DirectUnavailableError) {
        const n = this.pool.noteFailure(server)
        if (n >= 3)
          await this.noticeOnce(
            view,
            `unavailable:${view.server}`,
            10 * 60_000,
            `${this.labelOf(view)}: the server is not answering.`,
          )
        await finish({ ok: false, code: 'direct_unavailable', message: 'The server is not reachable.' })
        return { ok: false, text: 'direct_unavailable' }
      }
      if (e instanceof DirectTimeoutError) {
        await finish({ ok: false, code: 'timeout', message: 'The tool took too long.' })
        return { ok: false, text: 'timeout' }
      }
      if (e instanceof DirectTooLargeError) {
        await finish({ ok: false, code: 'too_large', message: 'The result is too large.' })
        return { ok: false, text: 'too_large' }
      }
      await finish({ ok: false, code: 'tool_failed', message: 'The tool call failed.' })
      return { ok: false, text: 'tool_failed' }
    }
  }

  private async noticeOnce(view: ViewRow, key: string, everyMs: number, text: string): Promise<void> {
    const k = `app_notice:${key}`
    const last = Number(this.ctx.store.kvGet(k) ?? 0)
    const now = this.ctx.clock.now()
    if (last && now - last < everyMs && now >= last) return
    this.ctx.store.kvSet(k, String(now))
    await postSystemNotice(this.ctx, text, { thread: threadRef(this.ctx, view.thread_id) })
  }

  /** The call-time label check (or a direct connect) found the labels changed: refuse, revoke, ask for a rescan. */
  private async markNeedsReapproval(view: ViewRow, diff: string): Promise<void> {
    const cat = readCatalog(this.paths)
    if (cat.ok && cat.catalog) {
      const c = structuredClone(cat.catalog)
      const server = findServer(c, view.server, view.source)
      if (server) {
        for (const r of server.resources) {
          r.state = 'needs_reapproval'
          r.reapproval_diff = diff.slice(0, 2000)
        }
        try {
          writeCatalog(this.paths, c)
          this.catCache = undefined
        } catch (e) {
          this.ctx.log.warn('catalog not updated', { error: (e as Error).message })
        }
      }
    }
    const label = this.labelOf(view)
    await this.revokeServer(view.server, view.source, 'This app changed how it labels its tools.')
    await postSystemNotice(
      this.ctx,
      `${label} changed how it labels its tools. Run talos-app apps scan on the Mac to re-approve.`,
      { thread: threadRef(this.ctx, view.thread_id) },
    )
  }

  // ---- cards ---------------------------------------------------------------------------------------------------------

  /**
   * An `app_action` card was resolved (the inbound pipeline calls this after the ledger accepted it). Returns whether the
   * agent should hear about it; a bridge-executed card never reaches the agent. Long work runs in the background.
   */
  onCardResolved(
    row: LedgerRow,
    action: string,
    approvedPayload: unknown,
    payloadPath: string | undefined,
  ): { notifyAgent: boolean; extra?: string } {
    const p = cardPayloadOf({ payload: approvedPayload })
    if (!p) return { notifyAgent: row.actor !== 'bridge' }
    if (p.kind === 'app_show') {
      void this.track(row.id, this.finishShowCard(row, action, p)).catch((e) =>
        this.ctx.log.warn('app show card failed', { error: (e as Error).message }),
      )
      return { notifyAgent: false }
    }
    const requestId = p.request_id
    const view = this.store.getView(p.view_id)
    if (action !== 'primary') {
      this.store.updateRequest(requestId, { state: 'killed', resolved_at: iso(this.ctx.clock.now()) })
      removePending(this.paths, requestId)
      if (view) this.failed(view.view_id, requestId, 'owner_killed', 'You stopped this request.')
      return { notifyAgent: p.executor === 'agent' }
    }
    if (!this.enabled()) {
      // Apps were switched off before this tap was processed (the 5 s sweep may not have run): nothing may run, and the
      // card says why, in the true words.
      const pend = readPending(this.paths, requestId)
      if (pend && pend.state !== 'expired') void this.tombstone(pend, 'view_closed', 'Apps are turned off on this Mac.')
      else {
        this.store.updateRequest(requestId, { state: 'expired', resolved_at: iso(this.ctx.clock.now()) })
        if (view) this.failed(view.view_id, requestId, 'view_closed', 'Apps are turned off on this Mac.')
      }
      this.endUnrun(row, 'Nothing ran: Apps are turned off on this Mac.')
      return { notifyAgent: false }
    }
    if (p.executor === 'agent') {
      const pend = readPending(this.paths, requestId)
      if (pend?.state !== 'awaiting_card') {
        // the card outlived its pending file (a tombstone, or a timeout): nothing may run, and nobody will report on it
        this.endUnrun(row, 'Nothing ran: this request was no longer waiting when you approved it.')
        return { notifyAgent: false }
      }
      const now = this.ctx.clock.now()
      writePending(this.paths, { ...pend, state: 'authorised', expires_at: iso(now + AUTHORISED_UNCLAIMED_MS) })
      this.store.updateRequest(requestId, { state: 'authorised' })
      return {
        notifyAgent: true,
        extra: appCardActionLine({ tool: p.tool, server: p.server, payloadPath: payloadPath ?? '(approved binding)' }),
      }
    }
    void this.track(row.id, this.runBridgeCard(row, p)).catch((e) =>
      this.ctx.log.warn('app bridge card failed', { error: (e as Error).message }),
    )
    return { notifyAgent: false }
  }

  /** Ends an approved card that will never run, as failed, after the inbound pipeline's `resolved` frame (the app keeps the last one). */
  private endUnrun(row: LedgerRow, text: string): void {
    const { ctx } = this
    void (async () => {
      await new Promise((r) => setTimeout(r, 0))
      if (!ctx.ledger.finish(row.id, false)) return
      await ctx.transport.sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: 'failed',
          result: { ok: false, text, at: iso(ctx.clock.now()), ran: false },
        }),
      )
    })().catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  private async runBridgeCard(row: LedgerRow, p: Extract<AppCardPayloadT, { kind: 'app_request' }>): Promise<void> {
    const { ctx } = this
    await new Promise((r) => setTimeout(r, 0)) // the inbound pipeline sends `resolved` first; `done` follows it
    const view = this.store.getView(p.view_id)
    const cat = this.catalog()
    const server = cat ? findServer(cat, p.server, view?.source ?? '') : undefined
    let outcome: { ok: boolean; text: string; ran?: boolean }
    const res = server?.resources.find((r) => r.uri === view?.resource_uri)
    // uncertain state never runs anything: apps off, a closed or revoked view, or an approval that moved all refuse the tap
    if (
      !this.enabled() ||
      !view ||
      view.state !== 'active' ||
      !server ||
      !res ||
      res.state !== 'approved' ||
      res.approval_key !== view.approval_key
    ) {
      const off = !this.enabled()
      outcome = {
        ok: false,
        text: off ? 'Apps are turned off on this Mac.' : 'This app changed before the request could run.',
        ran: false, // the checks refused it before any call was made
      }
      if (view)
        off
          ? this.failed(view.view_id, p.request_id, 'view_closed', 'Apps are turned off on this Mac.')
          : this.failed(view.view_id, p.request_id, 'approval_changed', 'This app changed since it was approved.')
    } else {
      outcome = await this.runDirect({
        view,
        server,
        tool: p.tool,
        args: p.arguments,
        requestId: p.request_id,
        cardId: row.id,
      })
    }
    const ok = outcome.ok
    if (!ctx.ledger.finish(row.id, ok) && this.closedByOwner(row.id)) return // the owner closed it; anything else, the real result reaches the card
    ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: {
            ok,
            text: ok ? `Ran ${p.tool}` : `${p.tool} did not run (${outcome.text})`.slice(0, 500),
            at: iso(ctx.clock.now()),
            ...(outcome.ran === false ? { ran: false } : {}),
          },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  /** A card expired: the app hears `card_expired`; the pending file becomes a tombstone. True when the agent is not to be told. */
  async onCardExpired(row: LedgerRow): Promise<'quiet' | 'tell_agent'> {
    const p = cardPayloadOf({ payload: row.binding.payload })
    if (!p) return 'tell_agent'
    if (p.kind === 'app_show') {
      deleteCapture(this.paths, p.capture_id)
      return 'quiet'
    }
    const pend = readPending(this.paths, p.request_id)
    if (pend && pend.state !== 'expired') await this.tombstone(pend, 'card_expired', 'The approval expired.')
    else {
      this.store.updateRequest(p.request_id, { state: 'expired', resolved_at: iso(this.ctx.clock.now()) })
      this.failed(p.view_id, p.request_id, 'card_expired', 'The approval expired.')
    }
    return p.executor === 'bridge' ? 'quiet' : 'tell_agent'
  }

  /**
   * The owner approved but the agent was never (or maybe not) told. Nothing may run: the pending request becomes a tombstone,
   * so the gate refuses the tool, and the app hears it failed.
   */
  async onDecisionNotDelivered(row: LedgerRow): Promise<void> {
    const p = cardPayloadOf({ payload: row.binding.payload })
    if (p?.kind !== 'app_request') return
    const pend = readPending(this.paths, p.request_id)
    if (pend && pend.state !== 'expired')
      await this.tombstone(pend, 'view_closed', 'The agent did not get the approval, so nothing ran.')
  }

  // ---- results from the hooks ------------------------------------------------------------------------------------------

  private async deliverClaimed(now: number): Promise<void> {
    for (const c of listClaimed(this.paths)) {
      const req = c.req
      const id = req.request_id
      if (this.delivering.has(id)) continue
      if (!c.linked) {
        if (now - c.mtimeMs > CLAIM_TO_POST_MS) await this.dropClaim(req, 'timeout', 'The tool took too long.')
        continue
      }
      const linked = req as ClaimedRequestT
      const cap = readCapture(this.paths, linked.tool_use_id, now)
      if (cap) {
        this.delivering.add(id)
        try {
          await this.finishAgentRequest(linked, cap)
        } finally {
          this.delivering.delete(id)
        }
        continue
      }
      if (now - Date.parse(linked.claimed_at) > CLAIM_TO_POST_MS)
        await this.dropClaim(linked, 'timeout', 'The tool took too long.')
    }
  }

  private async dropClaim(r: AppPendingRequestT, code: AppErrorCodeT, message: string): Promise<void> {
    removePending(this.paths, r.request_id)
    this.store.updateRequest(r.request_id, { state: 'timeout', resolved_at: iso(this.ctx.clock.now()) })
    if (this.store.getView(r.view_id)?.state === 'active') this.failed(r.view_id, r.request_id, code, message)
  }

  private async finishAgentRequest(req: ClaimedRequestT, cap: CaptureT): Promise<void> {
    const { ctx } = this
    const view = this.store.getView(req.view_id)
    removePending(this.paths, req.request_id)
    deleteCapture(this.paths, cap.capture_id)
    this.store.updateRequest(req.request_id, {
      state: cap.ok && cap.result ? 'done' : 'failed',
      tool_use_id: req.tool_use_id,
      resolved_at: iso(ctx.clock.now()),
    })
    if (view?.state !== 'active') return // a closed view discards the result
    if (cap.too_large || !cap.result)
      return this.failed(
        view.view_id,
        req.request_id,
        cap.too_large ? 'too_large' : 'tool_failed',
        cap.too_large ? 'The result is too large.' : 'The tool call failed.',
      )
    const packed = await packResult(ctx, cap.result).catch(() => ({ error: 'tool_failed' as const }))
    if ('error' in packed)
      return this.failed(view.view_id, req.request_id, packed.error, 'The result could not be sent to the view.')
    if ('media' in packed)
      return this.respond(view.view_id, req.request_id, cap.ok ? 'done' : 'failed', {
        result_media: packed.media,
        ...(cap.ok ? {} : { code: 'tool_failed', message: 'The tool call failed.' }),
      })
    if (!cap.ok) return this.failed(view.view_id, req.request_id, 'tool_failed', 'The tool call failed.')
    this.respond(view.view_id, req.request_id, 'done', { result: packed.result })
  }

  private async sweepPending(now: number): Promise<void> {
    for (const r of listPending(this.paths, now).requests) {
      const deadline = Date.parse(r.expires_at)
      if (r.state === 'expired') {
        if (now > deadline) removePending(this.paths, r.request_id)
      } else if (now > deadline) {
        if (r.state === 'authorised') await this.tombstone(r, 'timeout', 'The agent did not run this in time.')
        else await this.tombstone(r, 'card_expired', 'The approval expired.')
      }
    }
  }

  // ---- tools (app_show, app_result, list_apps) ---------------------------------------------------------------------

  private requireOn(): void {
    if (!this.enabled()) throw new AppToolError('Apps are turned off on this Mac.')
  }

  async show(a: { threadId: string; captureId: string; caption?: string | undefined }): Promise<string> {
    this.requireOn()
    const { ctx } = this
    const now = ctx.clock.now()
    const cap = readCapture(this.paths, a.captureId, now)
    if (!cap)
      throw new AppToolError('No such capture (they last 15 minutes). Call the tool again and use the new capture id.')
    if (!cap.ok) throw new AppToolError('That tool call failed, so there is nothing to show.')
    if (cap.too_large || !cap.result) throw new AppToolError('result too large for an app view')
    const cat = this.catalog()
    const server = cat ? findServer(cat, cap.server, cap.source) : undefined
    const tool = server?.tools.find((t) => t.name === cap.tool)
    const resource = server && tool ? approvedResourceOf(server, tool) : undefined
    if (!cat || !server || !tool || !resource)
      throw new AppToolError("That tool's app is not approved. The owner approves apps with talos-app apps scan.")
    const live = this.liveVersion()
    if (live && cat.claude_code_version && live !== cat.claude_code_version)
      throw new AppToolError(
        `The apps were scanned with Claude Code ${cat.claude_code_version} and this session runs ${live}. Run talos-app apps scan on the Mac.`,
      )
    if (!readPinnedHtml(this.paths, resource.html_sha256))
      throw new AppToolError('The approved app file is missing. Run talos-app apps scan on the Mac.')
    if ((jcsBytes(cap.tool_input) ?? Number.MAX_SAFE_INTEGER) > 16 * 1024)
      throw new AppToolError('The tool input is too large for an app view.')
    if (resource.owner.show === 'ask') {
      const agent = ctx.config.config.agent.name || AGENT_FALLBACK
      await sendAppCard(ctx, {
        threadId: a.threadId,
        title: `Show ${resource.owner.label} result in this thread?`,
        destination: [
          { label: 'Server', value: server.server },
          { label: 'Tool', value: tool.name },
        ],
        body: "It'll be stored on your relay for 7 days.",
        warning: `Asked for by ${agent}, for an app.`,
        primaryLabel: 'Show',
        killLabel: "Don't show",
        risk: 'low',
        payload: {
          kind: 'app_show',
          executor: 'bridge',
          thread_id: a.threadId,
          capture_id: a.captureId,
          ...(a.caption ? { caption: a.caption } : {}),
        },
      })
      return "waiting for the owner's tap"
    }
    return this.mintView(a.threadId, cap, server, tool.name, resource, a.caption)
  }

  private async finishShowCard(
    row: LedgerRow,
    action: string,
    p: Extract<AppCardPayloadT, { kind: 'app_show' }>,
  ): Promise<void> {
    const { ctx } = this
    await new Promise((r) => setTimeout(r, 0)) // the inbound pipeline sends `resolved` first; `done` follows it
    let ok = false
    let text = 'Not shown'
    let ran: boolean | undefined
    if (action === 'primary' && !this.enabled()) {
      text = 'Nothing ran: Apps are turned off on this Mac.'
      ran = false
    } else if (action === 'primary') {
      try {
        const cap = readCapture(this.paths, p.capture_id, ctx.clock.now())
        const cat = this.catalog()
        const server = cat && cap ? findServer(cat, cap.server, cap.source) : undefined
        const tool = server?.tools.find((t) => t.name === cap?.tool)
        const resource = server && tool ? approvedResourceOf(server, tool) : undefined
        if (!cap?.ok || !cap.result || !server || !tool || !resource) text = 'The result expired or the app changed.'
        else {
          await this.mintView(p.thread_id, cap, server, tool.name, resource, p.caption)
          ok = true
          text = 'Shown'
        }
      } catch (e) {
        text = e instanceof AppToolError ? e.message.slice(0, 200) : 'Could not show it.'
      }
    } else if (action !== 'primary') deleteCapture(this.paths, p.capture_id)
    // A kill or revise was already closed `done` by the inbound pipeline: say nothing more, or the card would read "failed".
    // Closed by anything else (a sweep mid-run), a real result still reaches the card, as it always did.
    if (!ctx.ledger.finish(row.id, ok) && this.closedByOwner(row.id)) return
    ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: { ok, text, at: iso(ctx.clock.now()), ...(ran === false ? { ran } : {}) },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  private liveVersion(): string | undefined {
    try {
      const v = readFileSync(this.paths.liveVersion, 'utf8').trim()
      return v || undefined
    } catch {
      return undefined
    }
  }

  private async mintView(
    threadId: string,
    cap: CaptureT,
    server: CatalogServerT,
    toolName: string,
    resource: CatalogResourceT,
    caption: string | undefined,
  ): Promise<string> {
    const { ctx } = this
    const html = readPinnedHtml(this.paths, resource.html_sha256)
    if (!html) throw new AppToolError('The approved app file is missing. Run talos-app apps scan on the Mac.')
    const now = ctx.clock.now()
    const packed = await packResult(ctx, cap.result as McpCallToolResultT)
    if ('error' in packed)
      throw new AppToolError(
        packed.error === 'too_large'
          ? 'result too large for an app view'
          : 'The result could not be packed for the view.',
      )
    const page = await uploadAppPage(ctx, {
      html,
      csp: resource.csp,
      approvalKey: resource.approval_key,
      name: 'app.html',
    })
    writeAppMediaIndex(ctx, page, `${this.paths.resources}/${resource.html_sha256}.html`)
    const viewId = this.store.newViewId()
    const shown = iso(now)
    const until = iso(now + VIEW_CALL_WINDOW_MS)
    const view: AppViewT = {
      view_id: viewId,
      thread_id: threadId,
      label: resource.owner.label,
      server: sanitizeExternal(server.server, 120) || 'server',
      tool: toolName,
      resource_uri: resource.uri,
      approval_key: resource.approval_key,
      page: page.ref,
      csp: resource.csp,
      ...(resource.prefers_border !== undefined ? { prefers_border: resource.prefers_border } : {}),
      tool_input: cap.tool_input,
      ...('result' in packed ? { tool_result: packed.result } : { tool_result_media: packed.media }),
      calls_until: until,
      shown_at: shown,
    }
    // older active views of this resource in this thread are replaced
    for (const old of this.store.activeViews({
      thread_id: threadId,
      server: server.server,
      source: server.source,
      resource_uri: resource.uri,
    })) {
      if (this.store.setViewState(old.view_id, 'superseded'))
        this.sendUpdate(old, 'superseded', 'Replaced by a newer result.')
    }
    this.store.addView({
      view_id: viewId,
      thread_id: threadId,
      server: server.server,
      source: server.source,
      tool: toolName,
      resource_uri: resource.uri,
      approval_key: resource.approval_key,
      shown_at: shown,
      calls_until: until,
      state: 'active',
    })
    const msg = viewMessage(ctx, view)
    if (caption) {
      msg.text = caption.slice(0, 280)
      msg.format = 'markdown'
    }
    const checked = Message.safeParse(msg)
    const problem = checked.success ? appMessageProblem(checked.data) : 'view does not fit the message schema'
    if (problem || !checked.success) {
      this.store.setViewState(viewId, 'closed')
      throw new AppToolError(`The view could not be built (${problem}).`)
    }
    ctx.store.addMessage(checked.data)
    touchThread(ctx, threadId)
    await ctx.transport.sendDurable(replyFrame(now, checked.data))
    deleteCapture(this.paths, cap.capture_id)
    return `shown (view ${viewId})`
  }

  /** `app_result` with ok:false: the agent declines a request it was told about. */
  async decline(requestId: string, text: string | undefined): Promise<string> {
    this.requireOn()
    const p = readPending(this.paths, requestId)
    if (!p) throw new AppToolError('No such app request is waiting.')
    removePending(this.paths, requestId)
    this.store.updateRequest(requestId, { state: 'declined', resolved_at: iso(this.ctx.clock.now()) })
    this.failed(p.view_id, requestId, 'agent_declined', (text ?? 'The agent could not run this.').slice(0, 200))
    return 'declined'
  }

  listApps(): string {
    this.requireOn()
    const cat = this.catalog()
    if (!cat || cat.servers.length === 0)
      return 'No apps are approved. The owner approves them with talos-app apps scan on the Mac.'
    const lines: string[] = []
    const live = this.liveVersion()
    if (live && cat.claude_code_version && live !== cat.claude_code_version)
      lines.push(
        `Warning: scanned with Claude Code ${cat.claude_code_version}, this session runs ${live}. Run talos-app apps scan.`,
      )
    for (const s of cat.servers) {
      for (const r of s.resources) {
        const bound = s.tools.filter((t) => t.resource_uri === r.uri).map((t) => t.name)
        if (r.state !== 'approved') {
          lines.push(`${r.owner.label} (${s.server}): ${r.state}${r.reason ? ` - ${r.reason}` : ''}`)
          continue
        }
        const hasConn = (s.direct?.type === 'http' || s.direct?.type === 'sse') && r.owner.direct
        const parts = s.tools.map((t) => {
          const appOnly = t.visibility.length === 1 && t.visibility[0] === 'app'
          if (!t.visibility.includes('app')) return `${t.name}: not for apps`
          if (appOnly) {
            if (!hasConn)
              return `${t.name}: not supported (${s.direct?.type === 'stdio' ? 'local server' : 'this server type'})`
            return `${t.name}: direct (${s.direct?.auth === 'oauth' ? 'needs sign-in' : 'ready'}), ${tapWords(s, t)}`
          }
          const rule = tapWords(s, t)
          const note =
            !toolRunsWithoutTap(s, t) &&
            t.read_only === false &&
            t.destructive === false &&
            t.visibility.includes('app') &&
            /poll|refresh|stats/i.test(t.name)
              ? " (polls but isn't marked read-only)"
              : ''
          return `${t.name}: ${rule}${note}`
        })
        lines.push(
          `${r.owner.label} (${s.server}) shown by ${bound.join(', ') || 'no tool'}; tools an app may call: ${parts.join('; ')}${!hasConn && s.tools.some((t) => toolRunsWithoutTap(s, t)) ? '; labels not re-checked' : ''}`,
        )
      }
    }
    return lines.join('\n')
  }
}
