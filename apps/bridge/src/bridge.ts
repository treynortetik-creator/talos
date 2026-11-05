// Assembles the bridge: live (socket + inbound pipeline + timers) or headless (signed HTTP only).

import { randomBytes } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { homedir } from 'node:os'
import { AGENTS_FEATURE, drivingActive, newUlid } from '@talos-app/protocol'
import { ServerSecrets, securityRunner } from './apps/keychain.ts'
import { AppService } from './apps/service.ts'
import { pruneAttachmentRetries } from './attachment-retry.ts'
import { backfillCardRows, tellOwnerHistoryKeptAside } from './bridge-housekeeping.ts'
import type { BridgeOptions } from './bridge-options.ts'
import { CardExpiry } from './card-expiry.ts'
import { CardLedger } from './cards-ledger.ts'
import { sessionMarkerInherited } from './claude-env.ts'
import { type Clock, realClock } from './clock.ts'
import { assertSecureRelayUrl, type BridgePaths, paths as pathsOf } from './config.ts'
import { ConfigFile } from './config-file.ts'
import { ConfigProposals } from './config-propose/service.ts'
import {
  type BridgeContext,
  defaultThreadRef,
  postSystemNotice,
  reportUnansweredFromEarlierRuns,
  SeenTracker,
  threadRef,
} from './context.ts'
import { DeviceStore } from './devices.ts'
import { Enrollment } from './enrollment.ts'
import { configSyncFrame, sessionAgentsFrame, sessionInventoryFrame, sessionStateFrame } from './frames-out.ts'
import { ensureDir, mtimeMs } from './fsutil.ts'
import { bridgeFeatures } from './handshake.ts'
import { HealthMonitor } from './health/monitor.ts'
import { openHistoryOrKeepAside } from './history-recover.ts'
import { openHistory } from './history-store.ts'
import { HubClient } from './hub/client.ts'
import { HubServer } from './hub/server.ts'
import { Inbound } from './inbound.ts'
import { INSTRUCTIONS as INSTRUCTIONS_TEXT } from './instructions.ts'
import { commitRotation, type KeyMaterial, loadBridgeKey, loadKeyFile } from './keys.ts'
import { createLogger, type Logger } from './log.ts'
import { MediaStore } from './media.ts'
import { installMemory } from './memory/install.ts'
import { fileKeyStore, ModLink } from './mod/link.ts'
import { type Notification, systemNotification, withDrivingMeta } from './notify.ts'
import { tellAgentOfDrop } from './outbox-drop.ts'
import { PermissionRelay, type VerdictSender } from './permission/relay.ts'
import { ProblemService } from './problems/service.ts'
import { RelayClient } from './relay-client.ts'
import { RelayHttp } from './relay-http.ts'
import { RelaySilence } from './relay-silence.ts'
import { ThreadRouter } from './router/router.ts'
import { ScheduleService } from './schedules/service.ts'
import { createSearchService, type SearchServiceHandle } from './search/install.ts'
import { SessionControls } from './session/controls.ts'
import { SpeakService } from './speak/service.ts'
import { StatusWriter } from './status-file.ts'
import { callTool, toolsFor } from './tools/index.ts'
import { workerStoreOf } from './tools/read-inbound.ts'
import { HttpTransport, LiveTransport } from './transport.ts'
import { Tripwire } from './tripwire.ts'
import { noteTrustFlip } from './trust.ts'
import { pruneTtsFiles } from './tts.ts'
import { BRIDGE_CLIENT_NAME, BRIDGE_COMMIT, BRIDGE_VERSION } from './version.ts'
import { WorkerStore } from './worker/store.ts'
import { WorkerTransport } from './worker/transport.ts'

export {
  agentInstructions,
  RUN_INSTRUCTION,
  RUN_ONLY_WORDS,
  TRUST_INSTRUCTIONS,
  WORKER_INSTRUCTIONS,
} from './instructions.ts'
export type { BridgeOptions }
// scripts/size-budget.test.ts looks for this exact line; the text itself lives in instructions.ts.
export const INSTRUCTIONS = INSTRUCTIONS_TEXT

const PRUNE_EVERY_MS = 6 * 3600_000

export const POLL_MS = 10_000
export const RELAY_RESTART_NOTICE =
  'Tool prompts as cards turns on after you restart the session. Choose Restart session in the Talos menu bar, or quit and restart Claude Code in your terminal.'

export class Bridge {
  readonly ctx: BridgeContext
  readonly paths: BridgePaths
  readonly inbound: Inbound | undefined
  readonly enrollment: Enrollment
  readonly expiry: CardExpiry
  readonly client: RelayClient | undefined
  private keyRef: KeyMaterial | undefined
  private keyMtime = 0
  private keyLabels: string[] = []
  private pollTimer: unknown = null
  private lastPrune = 0
  private watchers: FSWatcher[] = []
  private readonly pollMs: number
  private stopMemory: () => void = () => {}
  private tripwire?: Tripwire
  private debounce: unknown = null
  /** Test seam: how many file-watch events each watched folder has delivered. */
  readonly watchHits: Record<string, number> = {}
  private health: HealthMonitor | undefined
  /** O6: posts to ntfy after 10 awake minutes without the relay; inert without TALOS_APP_ALERT_NTFY_URL. */
  private silence: RelaySilence | undefined
  /** D47: status.json for the menu bar. Live bridge only; a worker or headless process never has one. */
  private statusWriter: StatusWriter | undefined
  private emitFn: (n: Notification) => Promise<void> = async () => {}
  /** The relay's last `ready` listed `agents/1` (docs/SUBAGENTS.md): an older relay answers `session.agents` bad_frame. */
  private relayAgents = false
  private stopped = false
  private closed = false
  /** D39: the unanswered-message report ran for this process (`ready` repeats on every reconnect). */
  private configRecovered = false
  private unansweredChecked = false
  private relayRestartTold = false
  private healthyStartNoted = false
  private readonly onHealthyStart: (() => void) | undefined
  private historyKeptAsideTold = false
  private readonly clock: Clock
  private readonly log: Logger
  /** Option C, live bridge only: the routing table and the hub socket for thread sessions (docs/OPTION-C.md). */
  readonly router: ThreadRouter | undefined
  readonly hub: HubServer | undefined
  /** Option C, worker mode only: the connection to main's hub. */
  readonly hubClient: HubClient | undefined

  private constructor(opts: BridgeOptions, keyRef: KeyMaterial | undefined) {
    const { env } = opts
    // TALOS_APP_CHRONOS_NOW is a test hook (S1.4): a production bundle that sees it refuses to start, like the relay does
    if (env.chronosNow && env.nodeEnv !== 'test')
      throw new Error(
        'TALOS_APP_CHRONOS_NOW is a test-only setting; unset it (it makes the scheduler think it is another time)',
      )
    this.clock = opts.clock ?? realClock
    this.pollMs = opts.pollMs ?? POLL_MS
    this.paths = pathsOf(env.home)
    const p = this.paths
    for (const d of [p.home, p.media, p.approved, p.enrollPending]) ensureDir(d)
    this.log = opts.logger ?? createLogger(p.home, env.logLevel)
    this.keyRef = keyRef
    this.onHealthyStart = opts.onHealthyStart
    this.keyMtime = mtimeMs(p.bridgeKey)
    const live = !opts.headless && env.live
    const instance = opts.instance ?? `bi_${randomBytes(6).toString('hex')}`
    // Option C worker mode (docs/OPTION-C.md): never live; server.ts refuses TALOS_APP_BRIDGE=1 before we get here
    const worker = env.workerThread
    if (worker && live) throw new Error('a thread session (TALOS_APP_WORKER_THREAD) never runs as the live bridge')
    const getKey = () => {
      if (!this.keyRef) throw new Error(`no bridge key at ${p.bridgeKey}; run: talos-app init --relay-url <url>`)
      return this.keyRef
    }
    const http = new RelayHttp(env.relayUrl ?? '', getKey, opts.fetchFn)
    const config = new ConfigFile(p.configJson, { log: this.log })
    config.load()
    // only the live main bridge may move a damaged history aside; any other process leaves the file to it
    const store =
      live && !worker ? openHistoryOrKeepAside(p.historyDb, this.log, this.clock.now()).store : openHistory(p.historyDb)
    const devices = new DeviceStore(p.devicesJson)

    let transport: LiveTransport | HttpTransport | WorkerTransport
    let client: RelayClient | undefined
    let hubClient: HubClient | undefined
    if (worker) {
      hubClient = new HubClient({
        sockPath: p.hubSock,
        threadId: worker,
        nonce: env.workerNonce ?? '',
        log: this.log,
      })
      const ws = new WorkerStore(store.db)
      transport = new WorkerTransport(worker, hubClient, new HttpTransport(http), ws, this.log, () => this.clock.now())
    } else if (live) {
      // the socket's events call back into this object, which does not exist yet: they only run after start()
      const wire = {
        get connected() {
          return client?.connected ?? false
        },
        send: (f: Record<string, unknown>) => client?.send(f) ?? false,
      }
      transport = new LiveTransport(wire, store, http, this.clock, this.log, (row) => tellAgentOfDrop(this.ctx, row))
    } else {
      transport = new HttpTransport(http)
    }

    const modLink = new ModLink({
      clock: this.clock,
      log: this.log,
      // Only a live bridge owns the key file; a headless process must not rotate the running bridge's secret.
      ...(live ? { keys: fileKeyStore(p.modKey) } : {}),
      sink: {
        state: (state) => {
          if (live) transport.sendEphemeral(sessionStateFrame(this.clock.now(), state))
        },
        inventory: (inventory) => {
          if (live) transport.sendEphemeral(sessionInventoryFrame(this.clock.now(), inventory))
        },
        agents: (agents) => {
          if (live && this.relayAgents) transport.sendEphemeral(sessionAgentsFrame(this.clock.now(), agents))
        },
        result: (r) => this.ctx.session.onModResult(r),
      },
    })
    this.ctx = {
      mode: live ? 'live' : 'headless',
      env,
      paths: p,
      log: this.log,
      clock: this.clock,
      config,
      devices,
      store,
      ledger: new CardLedger(store),
      media: new MediaStore(p, http, this.log),
      http,
      transport,
      seen: new SeenTracker(live && !worker ? { store, clock: this.clock } : undefined),
      mod: modLink,
      // driving mode (docs/V2-FEATURES.md V4.1.4): owner-trust notifications say the owner is listening
      emit: (n) => this.emitFn(withDrivingMeta(n, drivingActive(config.config, this.clock.now()))),
      permission: undefined as unknown as PermissionRelay,
      session: undefined as unknown as SessionControls,
      ...(worker ? { worker: { thread: worker, ...(hubClient ? { hub: hubClient } : {}) } } : {}),
    }
    this.hubClient = hubClient
    if (live) {
      // every notification for the main session passes the routing table first; a dedicated thread's owner message
      // may go to its own session instead (docs/OPTION-C.md "Routing")
      const router = new ThreadRouter(this.ctx, (n) => this.emitFn(n), {
        store: workerStoreOf(this.ctx),
        onCardUndelivered: (id, told) => this.inbound?.cardNotDelivered(id, told),
        workerFeatures: (thread) => this.hub?.featuresOf(thread),
      })
      this.router = router
      this.ctx.leads = {
        unreachable: (thread) => router.leadUnreachable(thread),
        deliver: () => router.deliverHandoffs(),
      }
      this.ctx.emit = (n) => router.route(withDrivingMeta(n, drivingActive(config.config, this.clock.now())))
      this.hub = new HubServer(this.ctx, { store: router.store })
    }
    // search (docs/V2-FEATURES.md V3): the FTS5 probe decides whether `search/1` is advertised; only the live bridge reconciles
    this.ctx.search = createSearchService(store, { live, log: this.log, mediaDir: p.media })
    this.ctx.schedules = new ScheduleService(this.ctx, {
      connected: () => client?.connected ?? false,
      instance,
      watch: opts.scheduleWatch ?? true,
      ...(opts.chronosNow
        ? { chronosNow: opts.chronosNow }
        : env.chronosNow
          ? { chronosNow: () => env.chronosNow }
          : {}),
      ...(opts.discoveryTimeoutMs ? { discoveryTimeoutMs: opts.discoveryTimeoutMs } : {}),
      ...(opts.wrapSchedulerAdapter ? { wrapAdapter: opts.wrapSchedulerAdapter } : {}),
      ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
    })
    if (live) {
      // WP-V1: the health beat (docs/V2-FEATURES.md V2.2); advertised as health/1 once it exists
      this.health = new HealthMonitor(this.ctx, { connected: () => client?.connected ?? false })
      this.ctx.health = this.health
    }
    this.ctx.permission = new PermissionRelay(this.ctx)
    // O1: only a live main-session bridge can mint a settings card (a worker or a headless process has no relay socket to ask)
    if (live && !worker) this.ctx.configProposals = new ConfigProposals(this.ctx)
    this.ctx.session = new SessionControls(this.ctx)
    // MCP apps: only a live bridge answers app requests; the service does nothing until TALOS_APP_APPS=1
    if (live)
      this.ctx.apps = new AppService(this.ctx, { secrets: new ServerSecrets(securityRunner()), ...(opts.apps ?? {}) })
    // WP-V5: the memory browser (only a live bridge answers the app; headless processes would just hold a second index)
    if (live) this.stopMemory = installMemory(this.ctx)
    // the play button on agent messages: reads a stored message aloud with the owner's own TTS command
    if (live) this.ctx.speak = new SpeakService(this.ctx, opts.speak)
    // Problem reports: the live main bridge files them, and sees its own `error` log lines (never a worker or a headless run)
    if (live && !worker) {
      this.ctx.problems = new ProblemService({
        home: p.home,
        clock: this.clock,
        log: this.log,
        timezone: () => config.config.timezone,
        bridgeVersion: BRIDGE_VERSION,
        userHome: homedir(),
        notice: (text) =>
          postSystemNotice(this.ctx, text, {
            thread: this.ctx.config.thread('inbox') ? threadRef(this.ctx, 'inbox') : defaultThreadRef(this.ctx),
          }),
        fetchScreenshot: (ref) => this.ctx.media.download(ref),
      })
      this.log.setErrorTap?.(this.ctx.problems.tap)
      // security files changed outside the app: one line in the Inbox thread (no agent wake-up)
      this.tripwire = new Tripwire({
        home: p.home,
        now: () => this.clock.now(),
        clock: this.clock,
        alert: (text) =>
          postSystemNotice(this.ctx, text, {
            thread: this.ctx.config.thread('inbox') ? threadRef(this.ctx, 'inbox') : defaultThreadRef(this.ctx),
          }),
      })
    }
    this.enrollment = new Enrollment(this.ctx)
    this.expiry = new CardExpiry(this.ctx)
    if (live) {
      this.ctx.expiry = this.expiry
      this.inbound = new Inbound(this.ctx, this.enrollment, this.expiry, opts.inbound)
      client = new RelayClient({
        relayUrl: env.relayUrl as string,
        loadKeys: () => this.loadKeyCandidates(),
        client: { name: BRIDGE_CLIENT_NAME, version: BRIDGE_VERSION },
        // read at each hello: search/memory/health appear once their services are installed (docs/V2-FEATURES.md V1)
        features: () => bridgeFeatures(this.ctx),
        agentConfigRev: () => this.ctx.config.config.rev,
        clock: this.clock,
        log: this.log,
        ...(opts.random ? { random: opts.random } : {}),
        onKeyFallback: (i) => this.onKeyFallback(i),
        events: {
          onReady: (ready) => this.onReady(ready),
          onFrame: (raw, frame) => {
            if (frame.type === 'ack') (this.ctx.transport as LiveTransport).onAck(frame.ref, frame.seq)
            else this.inbound?.onFrame(raw, frame)
          },
          onBadFrame: (raw, message) => this.inbound?.onBadFrame(raw, message),
          onDisconnect: ({ code, authed }) => {
            this.log.info('relay socket closed', { code, authed })
            this.statusWriter?.poke()
          },
          onSuperseded: () => {
            this.goHeadless().catch((e) => this.log.error('going headless failed', { error: (e as Error).message }))
          },
        },
      })
      this.client = client
      this.silence = new RelaySilence({
        url: env.alertNtfyUrl,
        connected: () => client?.connected ?? false,
        clock: this.clock,
        log: this.log,
        ...(opts.relaySilence ?? {}),
      })
      this.statusWriter = new StatusWriter({
        path: p.status,
        clock: this.clock,
        log: this.log,
        instance,
        commit: BRIDGE_COMMIT,
        sessionMarkerInherited: sessionMarkerInherited(),
        snapshot: () => ({
          mode: 'live',
          relay: {
            connected: client?.connected ?? false,
            last_connect_at: this.ctx.store.kvGet('last_connect_at') ?? null,
            last_close_code: client?.lastCloseCode ?? null,
          },
          queue_depth: this.ctx.store.outboxCount(),
          permission_relay: this.ctx.permission.configured,
          permission_relay_declared: this.ctx.permission.declared ?? this.ctx.permission.configured,
        }),
      })
    }
  }

  static async create(opts: BridgeOptions): Promise<Bridge> {
    const p = pathsOf(opts.env.home)
    let key: KeyMaterial | undefined
    try {
      key = await loadBridgeKey(p)
    } catch (e) {
      if (!opts.headless && opts.env.live) throw e
      // headless processes can still list threads and read history without a key
    }
    return new Bridge(opts, key)
  }

  get live(): boolean {
    return this.ctx.mode === 'live'
  }

  get tools() {
    return toolsFor(this.ctx.env)
  }

  setEmit(fn: (n: Notification) => Promise<void>) {
    this.emitFn = fn
  }

  /** Wires the relay's verdicts to the MCP connection (server.ts). */
  setPermissionSender(fn: VerdictSender) {
    this.ctx.permission.setSender(fn)
  }

  /** Claude Code's version from the MCP handshake; the permission card shows Allow only from the floor version up. */
  setClientVersion(fn: () => string | undefined) {
    this.ctx.permission.setClientVersion(fn)
  }

  /** Whether server.ts declares `claude/channel/permission` (read once at start; changing it needs a restart). */
  get permissionRelayEnabled(): boolean {
    return this.ctx.permission.enabled
  }

  /** server.ts records what it declared to Claude Code, so status and the app can tell a switch that needs a restart. */
  declarePermissionRelay(declared: boolean) {
    this.ctx.permission.markDeclared(declared)
    this.statusWriter?.poke()
  }

  callTool(name: string, args: Record<string, unknown>) {
    return callTool(this.ctx, name, args)
  }

  // ---- live ------------------------------------------------------------------------------------------------------

  start() {
    if (!this.client) return
    if (!this.ctx.env.relayUrl) throw new Error('TALOS_APP_RELAY_URL is not set')
    assertSecureRelayUrl(this.ctx.env.relayUrl)
    this.prune()
    backfillCardRows(this.ctx)
    this.ctx.permission.sweepStale()
    this.inbound?.sweepInterrupted() // before the socket: a replayed tap must find its marker already settled
    this.ctx.config.markSynced({ ...this.ctx.config.config, rev: -1 }) // force the first config.sync after ready
    this.client.start()
    this.statusWriter?.start()
    this.health?.start()
    this.silence?.start()
    this.ctx.problems?.start()
    this.tripwire?.start()
    // Option C: the hub socket for thread sessions, and the deadlines of messages routed before a restart
    this.hub?.start().catch((e) => this.log.warn('hub socket not started', { error: (e as Error).message }))
    this.router?.resume()
    this.expiry.sync()
    this.ctx.apps?.start()
    this.schedulePoll()
    // the owner's y/N lands in enroll-pending/ (a non-recursive watch of home never sees it), so watch both
    for (const dir of [this.paths.home, this.paths.enrollPending]) {
      try {
        this.watchers.push(
          watch(dir, { persistent: false }, () => {
            this.watchHits[dir] = (this.watchHits[dir] ?? 0) + 1
            this.pokePoll()
          }),
        )
      } catch {
        // the 10 s poll still runs
      }
    }
  }

  private async loadKeyCandidates(): Promise<KeyMaterial[]> {
    const out: KeyMaterial[] = []
    this.keyLabels = []
    if (this.keyRef) {
      out.push(this.keyRef)
      this.keyLabels.push('current')
    }
    for (const [label, path] of [
      ['prev', this.paths.bridgeKeyPrev],
      ['next', this.paths.bridgeKeyNext],
    ] as const) {
      try {
        const k = await loadKeyFile(path)
        if (k && !out.some((x) => x.keyId === k.keyId)) {
          out.push(k)
          this.keyLabels.push(label)
        }
      } catch {
        // an unreadable candidate is skipped
      }
    }
    return out
  }

  private onKeyFallback(i: number) {
    const label = this.keyLabels[i] ?? 'unknown'
    this.log.warn('rotation_incomplete', { connected_with: label })
    if (label === 'next') {
      try {
        commitRotation(this.paths)
      } catch (e) {
        this.log.error('could not finish the key rotation', { error: (e as Error).message })
      }
    }
  }

  private onReady(ready?: { features?: string[] | undefined }) {
    const { ctx } = this
    // a `ready` that lands after supersede/stop (headless transport, closed store) has nothing to flush
    if (ctx.mode !== 'live' || this.stopped || this.closed) return
    ctx.store.kvSet('last_connect_at', new Date(this.clock.now()).toISOString())
    this.statusWriter?.poke()
    ctx.config.reloadIfChanged()
    // resend what the relay never acked first, so the fresh config.sync below is not sent twice
    ;(ctx.transport as LiveTransport).flushOutbox()
    this.syncConfig()
    this.noteTrust()
    this.expiry.sync()
    this.router?.setRelayFeatures(ready?.features ?? [])
    this.router?.resendStatus()
    this.inbound?.onReady()
    // D39: once per process. `ready` fires on every reconnect, and a plain socket drop is not a session that died.
    if (!this.unansweredChecked) {
      this.unansweredChecked = true
      void reportUnansweredFromEarlierRuns(ctx)
    }
    // once per process, like the report above: a damaged history was kept aside at start, and the owner is told at the first ready
    if (!this.historyKeptAsideTold) {
      this.historyKeptAsideTold = true
      void tellOwnerHistoryKeptAside(ctx)
    }
    this.health?.onReady()
    ctx.schedules?.onReady(ready?.features ?? [])
    ctx.configProposals?.setRelayFeatures(ready?.features ?? [])
    if (!this.configRecovered && ctx.configProposals) {
      this.configRecovered = true // once per process, like the unanswered report
      void ctx.configProposals
        .recover()
        .catch((e) => this.log.warn('config card recovery failed', { error: (e as Error).message }))
    }
    // docs/SUBAGENTS.md 5.3: agents frames only to a relay that passes them on; a fresh one gets the held snapshot now
    this.relayAgents = (ready?.features ?? []).includes(AGENTS_FEATURE)
    if (this.relayAgents) ctx.mod.resendAgents()
    this.enrollment.poll().catch((e) => this.log.warn('enrollment poll failed', { error: (e as Error).message }))
    // last, so a start that throws anywhere above is not counted as one that went well
    if (!this.healthyStartNoted) {
      this.healthyStartNoted = true // `ready` repeats on every reconnect; a start is healthy once
      try {
        this.onHealthyStart?.()
      } catch (e) {
        this.log.warn('healthy start not recorded', { error: (e as Error).message })
      }
    }
  }

  private syncConfig() {
    const { ctx } = this
    if (!ctx.config.needsSync()) return
    const cfg = ctx.config.config
    ctx.transport
      .sendDurable(configSyncFrame(this.clock.now(), cfg))
      .catch((e) => this.log.warn('config.sync not sent', { error: (e as Error).message }))
    ctx.config.markSynced(cfg)
  }

  private schedulePoll() {
    if (this.stopped) return
    this.pollTimer = this.clock.setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll())
    }, this.pollMs)
  }

  /** Retention: old history rows, the log, and TTS audio and upload copies older than the history window. Cheap, so it runs at start and every few hours. */
  private prune() {
    this.lastPrune = this.clock.now()
    try {
      this.ctx.store.pruneSeen(this.lastPrune)
      pruneAttachmentRetries(this.ctx, this.lastPrune)
      this.router?.store.prune(this.lastPrune)
      const n = this.ctx.store.pruneOld(this.lastPrune, { historyDays: this.ctx.env.historyDays })
      const files = pruneTtsFiles(
        this.paths.media,
        this.lastPrune,
        // 0 days means keep history forever, so the files behind it stay too
        this.ctx.env.historyDays > 0 ? this.ctx.env.historyDays * 24 * 3600_000 : Number.POSITIVE_INFINITY,
      )
      if (n.messages || n.cards || files) this.log.info('pruned', { ...n, tts_files: files })
    } catch (e) {
      this.log.warn('prune failed', { error: (e as Error).message })
    }
  }

  /** A trust mode flip is said out loud in the thread, whether it happened while the bridge ran or while it was down. */
  private noteTrust() {
    void noteTrustFlip(this.ctx).catch((e) => this.log.warn('trust note failed', { error: (e as Error).message }))
  }

  private pokePoll() {
    if (this.debounce) this.clock.clearTimeout(this.debounce)
    this.debounce = this.clock.setTimeout(() => void this.poll(), 200)
  }

  /** Everything shared through files: config edits, key rotation, enrollment answers, cards from headless jobs. */
  async poll() {
    if (this.stopped) return
    if (this.clock.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune()
    try {
      if (this.ctx.config.reloadIfChanged() && this.client?.connected) this.syncConfig()
      this.noteTrust()
      this.ctx.permission.reconcile()
      this.tellRelayNeedsRestart()
      // A row the relay never acked stays queued; on a link that stayed up nothing else would send it again.
      if (this.client?.connected) (this.ctx.transport as LiveTransport).flushOutbox({ idleOnly: true })
      await this.checkKeyFile()
      this.statusWriter?.poke() // permission_relay, queue depth
      await this.enrollment.poll()
      this.expiry.sync()
      this.optionCTick()
    } catch (e) {
      this.log.warn('poll failed', { error: (e as Error).message })
    }
  }

  /** Once per process: the owner switched tool-prompt cards on after the session started, so tell them where they will see it. */
  private tellRelayNeedsRestart() {
    if (this.relayRestartTold || !this.ctx.permission.needsRestart) return
    this.relayRestartTold = true
    void postSystemNotice(this.ctx, RELAY_RESTART_NOTICE).catch((e) => {
      this.relayRestartTold = false // not posted: try again at the next poll
      this.log.warn('relay restart notice not posted', { error: (e as Error).message })
    })
  }

  /** Option C (docs/OPTION-C.md): workers.status for the app and the governor. */
  optionCTick() {
    const r = this.router
    if (!r || this.ctx.mode !== 'live') return
    const now = this.clock.now()
    r.tick((status) => {
      this.ctx.transport.sendEphemeral({
        v: 1,
        type: 'workers.status',
        id: newUlid(),
        ts: new Date(now).toISOString(),
        status,
      } as never)
    })
  }

  /** Worker mode: connect to main's hub (server.ts calls this once MCP is initialized). */
  startWorker(): Promise<boolean> {
    return this.hubClient?.connect() ?? Promise.resolve(false)
  }

  /** `talos-app rotate` swapped bridge.key: reconnect with the new key (closing the old socket first, so no 4409). */
  private async checkKeyFile() {
    const m = mtimeMs(this.paths.bridgeKey)
    if (m === this.keyMtime) return
    this.keyMtime = m
    const k = await loadKeyFile(this.paths.bridgeKey).catch(() => undefined)
    if (!k || k.keyId === this.keyRef?.keyId) return
    this.keyRef = k
    this.log.info('bridge key changed; reconnecting', { key_id: k.keyId })
    await this.client?.restartNow()
  }

  /** 4409: a newer bridge took over. Never reconnect; behave like a headless process for the rest of this run. */
  private async goHeadless() {
    const { ctx } = this
    this.log.warn('superseded', {})
    // D47: one last `superseded` snapshot, then no more writes (a newer bridge owns the file now)
    this.statusWriter?.supersede()
    this.silence?.stop() // superseded on purpose: this bridge is no longer supposed to hold the relay socket
    this.stopTimers(false)
    // the newer bridge files problems now; this one must not write into the same folder
    this.ctx.problems?.stop()
    this.tripwire?.stop()
    this.log.setErrorTap?.(null)
    ctx.mode = 'headless'
    ctx.permission.closeAll()
    // a superseded bridge is no longer the hub: workers reconnect to the new live bridge
    await this.hub?.close().catch(() => {})
    this.router?.close()
    ctx.transport = new HttpTransport(ctx.http)
    delete ctx.expiry
    await ctx
      .emit(
        systemNotification({
          thread: defaultThreadRef(ctx),
          text: 'Another bridge connected with this key. This session no longer receives app messages; replies still work.',
          ts: new Date(this.clock.now()).toISOString(),
          id: 'superseded',
        }),
      )
      .catch(() => {})
  }

  private stopTimers(final = true) {
    this.stopped = true
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer)
    if (this.debounce) this.clock.clearTimeout(this.debounce)
    this.pollTimer = this.debounce = null
    this.ctx.schedules?.stop(final)
    void this.ctx.apps?.stop().catch(() => {})
    this.stopMemory()
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.expiry.cancelAll()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.statusWriter?.stop()
    this.ctx.permission.closeAll()
    this.stopTimers()
    this.health?.stop()
    this.silence?.stop()
    this.ctx.problems?.stop()
    this.tripwire?.stop()
    this.log.setErrorTap?.(null)
    this.ctx.mod.close()
    this.ctx.session.close()
    this.router?.close()
    this.hubClient?.close()
    await this.hub?.close().catch(() => {})
    ;(this.ctx.search as Partial<SearchServiceHandle> | undefined)?.stop?.()
    await this.client?.stop()
    // nothing may touch the store after it closes; a stuck write must not hang shutdown (the injected clock never fires its timeouts)
    await Promise.race([
      this.ctx.schedules?.idle().catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 3000).unref?.()),
    ])
    try {
      this.ctx.store.close()
    } catch {
      // already closed
    }
  }
}
