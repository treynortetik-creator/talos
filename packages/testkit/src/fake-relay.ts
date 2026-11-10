// FakeRelay: an in-process stand-in for the relay. A real ws server that speaks the protocol well enough for the
// bridge and the web app to be built against it, and strict enough that a client which passes against it also passes
// against a relay that follows the spec:
//   /bridge  challenge -> hello -> ready. The Ed25519 signature AND key_id are ALWAYS checked (the relay generates a
//            key pair; read `relay.bridgeKey`). Turn it off only with `bridgeAuth: 'off'`.
//   /ws      hello (app) -> ready; routes message -> bridge, reply/card.* -> apps, assigns seq, acks. Optional session
//            header and Origin checks (`appAuth`, `origin`) like the real upgrade guard.
//   HTTP     the bridge-signed routes (/bridge/post, /bridge/media/:id, ...), checked with the real signature scheme,
//            and /api/media for uploads.
// Step-up: `mintStepup(purpose)` issues a single-use token; high-risk `card.resolve` and `config.patch` touching
// `work.enabled` are refused with `stepup_required` / `stepup_invalid` without one, and the token is stripped before
// the frame goes to the bridge.
// Two-stage ack: a bridge-bound consumable frame stays in the replay buffer until the bridge acks it with stage
// 'consumed'. On every bridge `hello` the relay re-sends all unconsumed frames in `relay.seq` order (delivered or not),
// so a crash never reorders messages; `replay.request` is an optional hint that re-sends the named ids in the same order.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type AgentConfigT,
  type BridgeKeyPair,
  b64urlDecode,
  bridgeKeyId,
  type CardT,
  checkConfigPatch,
  type Frame,
  type FrameType,
  generateBridgeKey,
  type MessageT,
  newChallengeNonce,
  newUlid,
  parseFrameText,
  RECOVER_NEEDS_MAC_TEXT,
  V2_READ_RESPONSE_FOR,
  verifyChallenge,
  WS_CLOSE,
} from '@talos-app/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { cardProblem, RESOLVE_REFUSALS, RelayCards } from './fake-relay-cards.ts'
import { RelayHttp } from './fake-relay-http.ts'
import {
  BRIDGE_DURABLE,
  BRIDGE_STORED,
  BRIDGE_TO_APPS,
  type BufferEntry,
  CATCHUP_PAGE,
  CONSUMABLE,
  type FakeRelayOptions,
  OWNER_FRAMES,
  PAIRING_IN,
  PAIRING_OUT,
  type RelayDirection,
  SCHEDULE_OWNER,
  TEST_DEVICE_HEADER,
  TEST_UNPINNED_HEADER,
  V2_READ,
} from './fake-relay-shared.ts'
import { loadExampleConfig } from './fixtures.ts'
import { mkFrame, now } from './frame-utils.ts'
import { type ExpectOptions, Recorder } from './recorder.ts'

export type { FakeRelayOptions, HttpRecord, RelayDirection } from './fake-relay-shared.ts'
export { TEST_DEVICE_HEADER, TEST_UNPINNED_HEADER } from './fake-relay-shared.ts'

export class FakeRelay {
  readonly rec = new Recorder<RelayDirection>()
  /** Every HTTP request the relay answered, with its status. */
  get http() {
    return this.httpRoutes.records
  }
  get media() {
    return this.httpRoutes.media
  }
  /** Replay buffer for bridge-bound frames, by frame id, in relay.seq order. */
  readonly buffer = new Map<string, BufferEntry>()
  readonly stored: Array<Record<string, unknown>> = []
  readonly host: string
  seq = 0
  config: AgentConfigT
  /** The key pair the relay trusts for the bridge. Pass it to FakeBridge / the bridge under test. */
  bridgeKey!: BridgeKeyPair
  private server!: Server
  private appWss = new WebSocketServer({ noServer: true })
  private bridgeWss = new WebSocketServer({ noServer: true })
  private apps = new Set<WebSocket>()
  private bridge: WebSocket | null = null
  private refSockets = new Map<string, WebSocket>()
  private seenClientMsg = new Map<string, number>()
  private seenOwnerIds = new Map<string, number>()
  /** Bridge durable frame ids already stored, with the seq they got (hub.ts `bf:`): a re-sent frame is acked again, never applied twice. */
  private seenBridgeIds = new Map<string, number>()
  private sockets = new Set<WebSocket>()
  private stepups = new Map<string, string>() // token -> purpose
  /** Cards this relay carried, with the relay's own rules about them. */
  private cards: RelayCards
  private httpRoutes: RelayHttp
  /** Pairing-only app sockets: the device is not pinned yet (hub.ts `limited`). */
  private limited = new Set<WebSocket>()
  /** Per app socket: the device the session belongs to (X-Test-Device) and whether the Mac must pin it first (X-Test-Unpinned). */
  private sessions = new WeakMap<
    WebSocket,
    { device?: string; needsPin: boolean; helloDevice?: string; helloSeq: number }
  >()
  /** Devices the Mac has pinned since the relay started. */
  private pinned = new Set<string>()
  /** card.resolve frame id -> card id, so the Mac's refusal of it puts the card back to pending. */
  private resolveRefs = new Map<string, string>()
  private scheduleSeen = new Set<string>()
  private scheduleRefs = new Map<string, WebSocket>() // owner schedule frame id -> sending socket (acks, errors)
  private scheduleReqs = new Map<string, WebSocket>() // request_id -> asking socket (snapshot, detail)
  /** v2 reads (docs/V2-FEATURES.md V1.3): request_id -> asking socket and the one answer type it takes. */
  private readReqs = new Map<string, { ws: WebSocket; want: string; frameId: string }>()
  private readRefs = new Map<string, WebSocket>()
  /** MCP apps: request_id -> the socket that asked; `app.response` goes only there (MCP-APPS-SPEC M3.4). Not stored, not replayed. */
  private appReqs = new Map<string, WebSocket>()
  private bridgeFeatures: string[] = []
  /** docs/SUBAGENTS.md: the last session.agents snapshot, memory only, handed out in `ready.session_agents`. */
  private lastAgents: Record<string, unknown> | undefined
  private opts: FakeRelayOptions
  private port = 0

  constructor(opts: FakeRelayOptions = {}) {
    this.opts = opts
    this.host = opts.host ?? 'relay.example.com'
    this.config = opts.agentConfig ?? loadExampleConfig('default')
    this.cards = new RelayCards(() => (this.opts.now ?? Date.now)())
    this.httpRoutes = new RelayHttp({
      opts,
      bridgeKey: () => this.bridgeKey,
      rec: this.rec,
      alreadyStored: (frame) => this.alreadyStored(frame),
      acceptBridgePost: (frame, raw, ack) => this.forwardBridgeFrame(null, frame, raw, ack),
    })
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  async start(port = 0): Promise<this> {
    this.bridgeKey = await generateBridgeKey()
    this.server = createServer((req, res) => void this.httpRoutes.handle(req, res))
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      const wss = path === '/ws' ? this.appWss : path === '/bridge' ? this.bridgeWss : null
      if (!wss) return void socket.destroy()
      if (path === '/ws') {
        const refuse = (status: number, text: string) => {
          socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          socket.destroy()
        }
        if (this.opts.origin && req.headers.origin !== this.opts.origin) return refuse(403, 'Forbidden')
        const a = this.opts.appAuth
        if (a && req.headers[a.header.toLowerCase()] !== a.value) return refuse(401, 'Unauthorized')
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws)
        ws.on('close', () => this.sockets.delete(ws))
        if (path === '/ws' && this.holdApps) {
          this.heldOff++
          return void ws.close(1013, 'try again later') // up, but not taking owners right now
        }
        if (path === '/ws') {
          const device = req.headers[TEST_DEVICE_HEADER]
          this.sessions.set(ws, {
            ...(typeof device === 'string' ? { device } : {}),
            needsPin: req.headers[TEST_UNPINNED_HEADER] !== undefined,
            helloSeq: 0,
          })
          this.onAppSocket(ws)
        } else this.onBridgeSocket(ws)
      })
    })
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate()
    this.appWss.close()
    this.bridgeWss.close()
    const closed = new Promise<void>((r) => this.server.close(() => r()))
    this.server.closeAllConnections?.()
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 250))])
  }

  get httpUrl() {
    return `http://127.0.0.1:${this.port}`
  }
  /** Base for FakeApp / FakeBridge: they append /ws or /bridge. */
  get wsBase() {
    return `ws://127.0.0.1:${this.port}`
  }
  get bridgeConnected() {
    return this.bridge?.readyState === WebSocket.OPEN
  }
  get appCount() {
    return this.apps.size
  }

  // ---- test API ------------------------------------------------------------------------------------------------

  get frames() {
    return this.rec.frames
  }
  expectFrame<T extends FrameType>(
    type: T,
    predicate?: (f: Extract<Frame, { type: T }>) => boolean,
    opts?: ExpectOptions & { direction?: RelayDirection },
  ) {
    return this.rec.expectFrame(type, predicate, opts)
  }
  expectNoFrame<T extends FrameType>(type: T, predicate?: (f: Extract<Frame, { type: T }>) => boolean, ms?: number) {
    return this.rec.expectNoFrame(type, predicate, ms)
  }

  /** Issues a single-use step-up token for `card:<id>`, `config:work` or `device:revoke`. */
  mintStepup(purpose: string): string {
    const token = `st_${newUlid()}`
    this.stepups.set(token, purpose)
    return token
  }

  /** Sends a frame to every connected app. Fills in envelope fields. */
  sendToApps(frame: Record<string, unknown>) {
    const f = this.completeFrame(frame)
    // A card the test hands to the apps is a card this relay carried, so a later resolve of it is a known card.
    if (f.type === 'card.create') this.cards.put(f.card as CardT)
    this.rec.record('to_app', f, JSON.stringify(f))
    for (const ws of this.receivers(String(f.type))) ws.send(JSON.stringify(f))
    return f
  }

  /** The Mac pinned this device: a pairing-only socket of it gets its real `ready` at the relay's next look (hub.ts refreshPairing). */
  pinDevice(deviceId: string) {
    this.pinned.add(deviceId)
  }

  /**
   * Sends a frame to the bridge. Durable ones get a `relay.seq` and are buffered first, so they survive a bridge that
   * is offline or that crashed before consuming them.
   */
  sendToBridge(frame: Record<string, unknown>, opts: { durable?: boolean } = {}) {
    let f = this.completeFrame(frame)
    const durable = opts.durable ?? BRIDGE_DURABLE.has(String(f.type))
    if (durable) {
      if (!f.relay) f = this.stamp(f)
      this.buffer.set(String(f.id), { frame: f, delivered: false, consumed: false })
    }
    this.deliverToBridge(f)
    return f
  }

  buffered(filter: (e: BufferEntry) => boolean = () => true) {
    return [...this.buffer.values()].filter(filter)
  }

  /** Closes the bridge socket with a code (default 4409, "superseded"). */
  kickBridge(code: number = WS_CLOSE.SUPERSEDED) {
    this.bridge?.close(code)
  }
  /**
   * While true the relay still takes in what the bridge sends (it stores and echoes as usual) but nothing reaches the
   * bridge: no pong, no ack, no replay. The socket stays open, like a link that died without a close frame (sleep, a
   * network change). `blackHoled` counts what was swallowed.
   */
  blackHole = false
  blackHoled = 0
  /** While true, a new app connection is closed at once with 1013 (try again later) before any hello: the app is held off until it is set back. */
  holdApps = false
  /** How many app connections `holdApps` has turned away. */
  heldOff = 0
  /** While true, acks to apps are recorded in `frames` but never sent: the relay stored the frame, the link died first. */
  swallowAcks = false
  /** While set, an `inbox.update` from an app is answered with this error code and is neither stored nor passed on. */
  inboxError: string | null = null
  /** The real relay forgets its seen ids after 8 days: this is that, without waiting. */
  forgetSeen() {
    this.seenClientMsg.clear()
    this.seenOwnerIds.clear()
  }
  /** Closes every app socket with a code and a reason, as the real relay does for a session that ended (4401). */
  closeApps(code: number, reason = '') {
    for (const c of this.appWss.clients) c.close(code, reason)
  }
  /** Simulates every app connection dropping without a close handshake. */
  dropApps() {
    for (const c of this.appWss.clients) c.terminate()
  }
  /** Simulates a dropped connection without a close handshake. */
  dropBridge() {
    this.bridge?.terminate()
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  private completeFrame(frame: Record<string, unknown>): Record<string, unknown> {
    return { ...mkFrame(String(frame.type)), ...frame }
  }

  private deliverToBridge(f: Record<string, unknown>) {
    if (this.blackHole) {
      this.blackHoled++
      return
    }
    this.rec.record('to_bridge', f, JSON.stringify(f))
    if (this.bridgeConnected) this.bridge?.send(JSON.stringify(f))
  }

  private stamp(f: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const seq = ++this.seq
    const out = { ...f, relay: { seq, received_at: now() }, ...extra }
    this.stored.push(out)
    return out
  }

  private sendTo(ws: WebSocket, dir: RelayDirection, f: Record<string, unknown>) {
    if (this.blackHole && dir === 'to_bridge') {
      this.blackHoled++
      return
    }
    this.rec.record(dir, f, JSON.stringify(f))
    if (this.swallowAcks && dir === 'to_app' && f.type === 'ack') return // stored, but the answer never reaches the app
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f))
  }

  private error(ws: WebSocket, dir: RelayDirection, code: string, message: string, ref?: unknown) {
    this.sendTo(ws, dir, mkFrame('error', { ...(typeof ref === 'string' ? { ref } : {}), code, message }))
  }

  private ready(extra: Record<string, unknown>) {
    return mkFrame('ready', {
      session_id: `sess_${newUlid().slice(-8)}`,
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: this.seq,
      presence: this.presence(),
      ...extra,
    })
  }

  private presence() {
    return {
      bridge_online: this.bridgeConnected,
      last_seen: now(),
      queue_depth: 0,
      ...(this.bridgeConnected && this.bridgeFeatures.length ? { features: this.bridgeFeatures } : {}),
    }
  }

  private broadcastPresence() {
    this.sendToApps(mkFrame('presence', this.presence()))
  }

  // ---- bridge socket -------------------------------------------------------------------------------------------

  private onBridgeSocket(ws: WebSocket) {
    const nonce = newChallengeNonce()
    const serverTime = Math.floor(Date.now() / 1000)
    this.sendTo(
      ws,
      'to_bridge',
      mkFrame('challenge', { nonce, server_time: serverTime, relay_host: this.host, protocol: 1 }),
    )
    let authed = false
    const timer = setTimeout(() => !authed && ws.close(WS_CLOSE.HANDSHAKE_TIMEOUT), this.opts.helloTimeoutMs ?? 10_000)
    ws.on('close', () => {
      clearTimeout(timer)
      if (this.bridge === ws) {
        this.bridge = null
        this.broadcastPresence()
      }
    })
    ws.on('message', (data) => {
      void (async () => {
        const text = data.toString()
        const parsed = parseFrameText(text, { authenticated: authed, direction: 'bridge_to_relay' })
        if (!parsed.ok) {
          // the real hub closes the socket on any oversized bridge frame, authenticated or not (core/hub.ts)
          if (parsed.code === 'too_large') return void ws.close(WS_CLOSE.FRAME_TOO_LARGE)
          if (!authed) return void ws.close(WS_CLOSE.UNAUTHORIZED)
          this.error(
            ws,
            'to_bridge',
            parsed.code,
            parsed.message,
            (parsed.raw as Record<string, unknown> | undefined)?.id,
          )
          return
        }
        const raw = parsed.raw as Record<string, unknown>
        this.rec.record('from_bridge', raw, text)
        const frame = parsed.frame
        if (!authed) {
          if (frame.type !== 'hello' || frame.role !== 'bridge') return void ws.close(WS_CLOSE.UNAUTHORIZED)
          if (this.opts.bridgeAuth !== 'off') {
            const keyIdOk = frame.key_id === bridgeKeyId(b64urlDecode(this.bridgeKey.publicKeyB64))
            const sigOk = await verifyChallenge(
              this.bridgeKey.publicKeyB64,
              { nonce, relay_host: this.host, server_time: serverTime },
              frame.sig,
            )
            if (!keyIdOk || !sigOk) return void ws.close(WS_CLOSE.UNAUTHORIZED)
          }
          authed = true
          clearTimeout(timer)
          this.bridgeFeatures = frame.client.features ?? []
          if (this.bridge && this.bridge !== ws) this.bridge.close(WS_CLOSE.SUPERSEDED)
          this.bridge = ws
          this.sendTo(
            ws,
            'to_bridge',
            this.ready({ features: this.opts.relayFeatures ?? ['schedules/1', 'schedules/2', 'thread-sessions/1'] }),
          )
          this.broadcastPresence()
          // Re-send everything the bridge has not consumed, in relay.seq order (Map keeps insertion order). Receivers
          // dedupe on id at the moment they notify.
          for (const e of this.buffer.values()) {
            if (!e.consumed && (CONSUMABLE.has(String(e.frame.type)) || !e.delivered)) this.deliverToBridge(e.frame)
          }
          return
        }
        this.onBridgeFrame(ws, frame, raw)
      })()
    })
  }

  private onBridgeFrame(ws: WebSocket, frame: Frame, raw: Record<string, unknown>) {
    switch (frame.type) {
      case 'ping':
        return this.sendTo(ws, 'to_bridge', mkFrame('pong', { nonce: frame.nonce }))
      case 'ack': {
        const sched = this.scheduleRefs.get(frame.ref)
        if (sched) return this.sendTo(sched, 'to_app', raw)
        const e = this.buffer.get(frame.ref)
        if (!e) return
        if (frame.stage === 'consumed') {
          this.buffer.delete(frame.ref)
        } else {
          e.delivered = true
          if (!CONSUMABLE.has(String(e.frame.type))) this.buffer.delete(frame.ref)
        }
        return
      }
      case 'replay.request': {
        const wanted = new Set(frame.ids)
        for (const e of this.buffer.values()) {
          if (wanted.has(String(e.frame.id)) && !e.consumed) this.deliverToBridge(e.frame)
        }
        return
      }
      case 'search.results':
      case 'memory.listing':
      case 'memory.file':
      case 'memory.results':
      case 'speak.result':
      case 'fs.listing': {
        const p = this.readReqs.get(frame.request_id)
        if (!p || p.want !== frame.type) return // unknown, expired or the wrong answer type: dropped
        this.readReqs.delete(frame.request_id)
        return this.sendTo(p.ws, 'to_app', raw)
      }
      case 'health.beat':
        return
      case 'error': {
        // The Mac refused a card.resolve before acting on it: the card is pending again, or expired if it lapsed, and the
        // apps are told (hub.ts rollbackRejectedResolve).
        const resolved = frame.ref ? this.resolveRefs.get(frame.ref) : undefined
        if (resolved && RESOLVE_REFUSALS.includes(frame.code)) {
          const update = this.cards.rollbackRejected(resolved, 'resolve_rejected')
          if (update) this.fanOutStamped(mkFrame('card.update', update))
        }
        // The real relay stores it as a system message when the socket is gone; the fake just drops it.
        const sock = frame.ref
          ? (this.refSockets.get(frame.ref) ?? this.scheduleRefs.get(frame.ref) ?? this.readRefs.get(frame.ref))
          : undefined
        if (sock) this.sendTo(sock, 'to_app', raw)
        return
      }
      case 'schedules.snapshot':
      case 'heartbeat.test_result':
      case 'schedule.detail': {
        const sock = this.scheduleReqs.get(frame.request_id)
        if (!sock) return // unknown or expired request id: dropped
        this.scheduleReqs.delete(frame.request_id)
        return this.sendTo(sock, 'to_app', raw)
      }
      case 'schedule.status':
        for (const a of this.receivers('schedule.status')) this.sendTo(a, 'to_app', raw)
        return
      case 'app.response': {
        const sock = this.appReqs.get(frame.request_id)
        if (!sock) return // unknown or expired request id: dropped
        if (frame.state !== 'pending_card') this.appReqs.delete(frame.request_id)
        return this.sendTo(sock, 'to_app', raw)
      }
      default: {
        // A frame the relay already stored is acked again before anything else looks at it (hub.ts processBridgeDurable).
        if (!this.alreadyStored(frame)) {
          const bad = frame.type === 'card.create' ? cardProblem(frame.card) : null
          if (bad) return this.error(ws, 'to_bridge', 'bad_frame', `card rejected: ${bad}`, frame.id)
          const refused = this.opts.rejectBridgeFrame?.(raw)
          if (refused) return this.error(ws, 'to_bridge', refused.code, refused.message, frame.id)
        }
        this.forwardBridgeFrame(ws, frame, raw)
      }
    }
  }

  private alreadyStored(frame: Frame): boolean {
    return BRIDGE_STORED.has(frame.type) && this.seenBridgeIds.has(frame.id)
  }

  /** bridge -> relay -> apps. Durable frames are stamped, acked and echoed to every app; a re-sent one is acked again and nothing more. */
  private forwardBridgeFrame(
    ws: WebSocket | null,
    frame: Frame,
    raw: Record<string, unknown>,
    httpAck?: { seq?: number },
  ) {
    const reack = (seq: number) => {
      if (httpAck) httpAck.seq = seq
      else if (ws) this.sendTo(ws, 'to_bridge', mkFrame('ack', { ref: frame.id, seq }))
    }
    const dup = this.seenBridgeIds.get(frame.id)
    if (dup !== undefined && BRIDGE_STORED.has(frame.type)) return reack(dup)
    if (frame.type === 'session.agents') this.lastAgents = raw.agents as Record<string, unknown>
    if (frame.type === 'session.state' && this.lastAgents && this.lastAgents.session_id !== frame.state.session_id)
      this.lastAgents = undefined // a new session retires the old one's rows
    let out = raw
    if (BRIDGE_STORED.has(frame.type)) {
      out = this.stamp(raw)
      const seq = (out.relay as { seq: number }).seq
      this.seenBridgeIds.set(frame.id, seq)
      reack(seq)
      if (frame.type === 'config.sync') this.config = frame.config
    }
    if (frame.type === 'card.create') this.cards.put(frame.card)
    // The Mac's card.update is the card's new state on the relay (core/hub.ts setCardState), so a later tap meets it.
    if (frame.type === 'card.update')
      this.cards.update(frame.card_id, {
        state: frame.state,
        ...(frame.resolution ? { resolution: frame.resolution } : {}),
        ...(frame.result ? { result: frame.result } : {}),
      })
    // The Mac pinned a device (the real relay's auth module does this on device.pinned).
    if (frame.type === 'device.pinned' && frame.ok) this.pinned.add(frame.device_id)
    if (BRIDGE_TO_APPS.has(frame.type)) {
      this.rec.record('to_app', out, JSON.stringify(out))
      for (const a of this.receivers(frame.type)) a.send(JSON.stringify(out))
    }
  }

  // ---- app socket ----------------------------------------------------------------------------------------------

  /** What the app gets as `ready`: the full one, or (device not pinned yet) the handshake part only (hub.ts ready(forApp)). */
  private appReady(full: boolean) {
    return this.ready({
      ...(this.opts.appFeatures ? { features: this.opts.appFeatures } : {}),
      ...(full
        ? {
            agent_config: this.config,
            threads: this.config.threads,
            open_cards: [],
            unread: {},
            statuses: [],
            ...(this.lastAgents ? { session_agents: this.lastAgents } : {}),
          }
        : {}),
    })
  }

  private isPinned(ws: WebSocket): boolean {
    const s = this.sessions.get(ws)
    return !s?.needsPin || (s.helloDevice !== undefined && this.pinned.has(s.helloDevice))
  }

  /** The Mac pinned this socket's device since the last look: hand over the real `ready` and what it missed (hub.ts refreshPairing). */
  private refreshPairing(ws: WebSocket) {
    if (!this.limited.has(ws) || !this.isPinned(ws)) return
    this.limited.delete(ws)
    this.sendTo(ws, 'to_app', this.appReady(true))
    const since = this.sessions.get(ws)?.helloSeq ?? 0
    if (since > 0) this.sendCatchup(ws, since)
  }

  /** The app sockets that may receive a frame of this type: a pairing-only one gets handshake types and nothing of the owner's data. */
  private receivers(type: string, except?: WebSocket): WebSocket[] {
    const out: WebSocket[] = []
    for (const ws of [...this.apps]) {
      if (ws === except) continue
      this.refreshPairing(ws)
      if (this.limited.has(ws) && !PAIRING_OUT.has(type)) continue
      out.push(ws)
    }
    return out
  }

  /** A card.update the relay makes itself: stored, then sent to every app that may see it. */
  private fanOutStamped(frame: Record<string, unknown>) {
    const stamped = this.stamp(frame)
    this.rec.record('to_app', stamped, JSON.stringify(stamped))
    for (const ws of this.receivers(String(stamped.type))) ws.send(JSON.stringify(stamped))
  }

  private onAppSocket(ws: WebSocket) {
    let authed = false
    const timer = setTimeout(() => !authed && ws.close(WS_CLOSE.HANDSHAKE_TIMEOUT), this.opts.helloTimeoutMs ?? 10_000)
    ws.on('close', () => {
      clearTimeout(timer)
      this.apps.delete(ws)
      this.limited.delete(ws)
    })
    ws.on('message', (data) => {
      const text = data.toString()
      const parsed = parseFrameText(text, { authenticated: authed, direction: 'app_to_relay' })
      if (!parsed.ok) {
        if (!authed) return void ws.close(parsed.code === 'too_large' ? WS_CLOSE.FRAME_TOO_LARGE : WS_CLOSE.BAD_FRAME)
        this.error(ws, 'to_app', parsed.code, parsed.message, (parsed.raw as Record<string, unknown> | undefined)?.id)
        return
      }
      const raw = parsed.raw as Record<string, unknown>
      this.rec.record('from_app', raw, text)
      const frame = parsed.frame
      const session = this.sessions.get(ws)
      if (!authed) {
        if (frame.type !== 'hello' || frame.role !== 'app') return void ws.close(WS_CLOSE.UNAUTHORIZED)
        // A tab holding a device key the session has since replaced (hub.ts appHello).
        if (session?.device && session.device !== frame.device_id)
          return void ws.close(WS_CLOSE.UNAUTHORIZED, 'device_changed')
        authed = true
        clearTimeout(timer)
        if (session) {
          session.helloDevice = frame.device_id
          session.helloSeq = frame.last_seq
        }
        this.apps.add(ws)
        // Pairing only until the Mac pins the device: the handshake `ready`, no owner data, no frame but the handshake ones.
        const pinned = this.isPinned(ws)
        if (!pinned) this.limited.add(ws)
        this.sendTo(ws, 'to_app', this.appReady(pinned))
        if (pinned && frame.last_seq > 0) this.sendCatchup(ws, frame.last_seq)
        return
      }
      this.refreshPairing(ws)
      if (this.limited.has(ws) && !PAIRING_IN.has(frame.type))
        return this.error(ws, 'to_app', 'device_not_pinned', 'this device is not pinned by your Mac yet', frame.id)
      const signedBy = (raw as { device_id?: unknown }).device_id
      if (session?.device && typeof signedBy === 'string' && signedBy !== session.device)
        return this.error(ws, 'to_app', 'unauthorized', 'frame signed by a device other than this session', frame.id)
      this.onAppFrame(ws, frame, raw)
    })
  }

  /** Catch-up page: at most 200 frames, `to_seq` is the last included seq and `more` says whether any remain. */
  private sendCatchup(ws: WebSocket, sinceSeq: number) {
    const floor = this.opts.bufferFloor
    if (floor !== undefined && sinceSeq + 1 < floor) {
      this.sendTo(ws, 'to_app', mkFrame('catchup.reset', { min_seq: floor }))
      sinceSeq = floor - 1
    }
    const all = this.stored.filter((s) => ((s.relay as { seq: number }).seq ?? 0) > sinceSeq)
    const page = all.slice(0, CATCHUP_PAGE)
    if (page.length === 0) return
    const last = ((page[page.length - 1] as Record<string, unknown>).relay as { seq: number }).seq
    this.sendTo(
      ws,
      'to_app',
      mkFrame('catchup.batch', { from_seq: sinceSeq + 1, to_seq: last, frames: page, more: all.length > page.length }),
    )
  }

  private stepupError(ws: WebSocket, frameId: unknown, token: unknown, purpose: string): boolean {
    if (typeof token !== 'string') {
      this.error(ws, 'to_app', 'stepup_required', `step-up ${purpose} required`, frameId)
      return true
    }
    if (this.stepups.get(token) !== purpose) {
      this.error(ws, 'to_app', 'stepup_invalid', 'step-up token is invalid for this purpose', frameId)
      return true
    }
    this.stepups.delete(token) // single use
    return false
  }

  private onAppFrame(ws: WebSocket, frame: Frame, raw: Record<string, unknown>) {
    if (SCHEDULE_OWNER.has(frame.type)) return this.onScheduleFrame(ws, frame, raw)
    if (V2_READ.has(frame.type)) return this.onReadFrame(ws, frame, raw)
    if (frame.type === 'app.request') {
      if (!this.bridgeConnected)
        return this.sendTo(
          ws,
          'to_app',
          mkFrame('app.response', {
            view_id: frame.view_id,
            request_id: frame.request_id,
            state: 'failed',
            error: { code: 'mac_offline', message: 'Your Mac is offline.' },
          }),
        )
      this.appReqs.set(frame.request_id, ws)
      return void this.sendToBridge(raw, { durable: false })
    }
    if (OWNER_FRAMES.has(frame.type)) {
      // A replayed owner frame (same id) is acked again and never forwarded twice.
      const dup = this.seenOwnerIds.get(frame.id)
      if (dup !== undefined) return this.sendTo(ws, 'to_app', mkFrame('ack', { ref: frame.id, seq: dup }))
    }
    switch (frame.type) {
      case 'ping':
        return this.sendTo(ws, 'to_app', mkFrame('pong', { nonce: frame.nonce }))
      case 'message':
      case 'voice_note': {
        const dup = this.seenClientMsg.get(frame.client_msg_id)
        if (dup !== undefined) return this.sendTo(ws, 'to_app', mkFrame('ack', { ref: frame.id, seq: dup }))
        const stamped = this.stamp(raw)
        const seq = (stamped.relay as { seq: number }).seq
        this.seenClientMsg.set(frame.client_msg_id, seq)
        this.seenOwnerIds.set(frame.id, seq)
        this.refSockets.set(frame.id, ws)
        this.sendTo(ws, 'to_app', mkFrame('ack', { ref: frame.id, seq }))
        const message: MessageT = {
          id: frame.client_msg_id,
          thread_id: frame.thread_id,
          seq,
          author: 'owner',
          kind: frame.type === 'message' ? 'text' : 'voice_note',
          format: 'plain',
          attachments: frame.type === 'message' ? frame.attachments : [frame.attachment],
          via: 'app',
          created_at: now(),
          ...(frame.type === 'message' ? { text: frame.text } : {}),
          // like the real relay (hub.ts): the quote survives the echo
          ...(frame.type === 'message' && frame.reply_to ? { reply_to: frame.reply_to } : {}),
        }
        this.sendToApps(mkFrame('message.stored', { client_msg_id: frame.client_msg_id, message }))
        return this.forwardOwnerFrame(stamped)
      }
      case 'card.resolve': {
        // Like the real relay (core/hub.ts, core/cards.ts): a card it never carried is not pending, step-up comes
        // before the card's own state, then expired, already decided and a changed card are each refused by name.
        const known = this.cards.get(frame.card_id)
        if (!known) return this.error(ws, 'to_app', 'card_not_pending', 'unknown card', frame.id)
        if (known.card.risk === 'high' && frame.action === 'primary') {
          if (this.stepupError(ws, frame.id, frame.stepup_token, `card:${frame.card_id}`)) return
        }
        const refused = this.cards.checkResolve(frame)
        if (refused) {
          this.error(ws, 'to_app', refused.code, refused.message, frame.id)
          // A card that lapsed by the clock is expired for good, and every app is told (hub.ts expireCard).
          if (refused.expired && this.cards.expire(refused.expired.id))
            this.fanOutStamped(
              mkFrame('card.update', { card_id: refused.expired.id, state: 'expired', reason: 'expired' }),
            )
          return
        }
        this.cards.update(frame.card_id, { state: 'resolved' })
        this.resolveRefs.set(frame.id, frame.card_id)
        return this.acceptOwnerFrame(ws, frame.id, raw)
      }
      case 'session.control':
      case 'thread.session.control':
        return this.acceptOwnerFrame(ws, frame.id, raw)
      case 'agent.recover':
        // Like the real relay: only a restart goes on; a restore from an old app is told it needs the Mac now
        if (frame.action !== 'restart') return this.error(ws, 'to_app', 'bad_frame', RECOVER_NEEDS_MAC_TEXT, frame.id)
        if (!this.bridgeConnected) return this.error(ws, 'to_app', 'mac_offline', 'your Mac is offline', frame.id)
        return this.acceptOwnerFrame(ws, frame.id, raw)
      case 'config.patch': {
        const check = checkConfigPatch(frame.patch)
        // Like the real relay: a field the app may never change is refused here and never reaches the Mac.
        if (!check.ok)
          return this.error(ws, 'to_app', 'config_field_forbidden', `field not allowed: ${check.path}`, frame.id)
        if (check.ok && check.touchesWorkEnabled) {
          if (this.stepupError(ws, frame.id, frame.stepup_token, 'config:work')) return
        }
        if (check.ok && check.stepupPurpose === 'config:session') {
          if (this.stepupError(ws, frame.id, frame.stepup_token, 'config:session')) return
        }
        return this.acceptOwnerFrame(ws, frame.id, raw)
      }
      case 'voice.ask':
        // The real relay acks an accepted ask WITHOUT a seq (the voice module forwards it; it is not an app event).
        return this.acceptOwnerFrame(ws, frame.id, raw, false)
      case 'inbox.update': {
        if (this.inboxError)
          return this.error(ws, 'to_app', this.inboxError, 'The relay could not save that.', frame.id)
        // The relay owns inbox state: store, ack, tell the owner's other devices. The bridge does not receive it.
        const stamped = this.stamp(raw)
        this.sendTo(ws, 'to_app', mkFrame('ack', { ref: frame.id, seq: (stamped.relay as { seq: number }).seq }))
        for (const a of this.receivers('inbox.update', ws)) this.sendTo(a, 'to_app', stamped)
        return
      }
      case 'thread.read':
        for (const a of this.receivers('thread.read', ws)) this.sendTo(a, 'to_app', raw)
        return
      case 'thread.unread': {
        // Like the real relay: the mark goes just under the thread's newest counting row (a non-silent agent reply); with
        // none stored the answer carries a count and no mark. Every device gets it, the sender included.
        let last = 0
        for (const e of this.stored) {
          const seq = (e.relay as { seq: number } | undefined)?.seq ?? 0
          const msg = e.message as { thread_id?: string; author?: string } | undefined
          if (e.type === 'reply' && !e.silent && msg?.thread_id === frame.thread_id && msg.author !== 'owner')
            last = Math.max(last, seq)
        }
        const out = mkFrame('thread.unread', {
          thread_id: frame.thread_id,
          ...(last > 0 ? { up_to_seq: last - 1 } : {}),
          count: 1,
        })
        for (const a of this.receivers('thread.unread')) this.sendTo(a, 'to_app', out)
        return
      }
      case 'catchup.request':
        return this.sendCatchup(ws, frame.since_seq)
      case 'history.request':
        if (!this.bridgeConnected) {
          return this.sendTo(
            ws,
            'to_app',
            mkFrame('history.page', {
              request_id: frame.request_id,
              thread_id: frame.thread_id,
              messages: [],
              has_more: false,
              unavailable: 'mac_offline',
            }),
          )
        }
        // an `error{ref}` from the Mac (unsigned, forged, replayed) goes back to this socket, like the real relay does
        this.readRefs.set(frame.id, ws)
        return void this.sendToBridge(raw, { durable: false })
      case 'media.fetch':
        if (!this.bridgeConnected) return this.error(ws, 'to_app', 'mac_offline', 'your Mac is offline', frame.id)
        this.readRefs.set(frame.id, ws) // the Mac's refusal (unsigned, forged, replayed) goes back to this socket
        return void this.sendToBridge(raw, { durable: false })
      case 'visibility':
      case 'hello':
      case 'pong':
      case 'error':
        return
      default:
        return this.error(ws, 'to_app', 'bad_frame', `unexpected ${frame.type} from app`, raw.id)
    }
  }

  /** Signed v2 reads: forwarded live, never stored, answered to the asking socket only; offline = mac_offline at once. */
  private onReadFrame(ws: WebSocket, frame: Frame, raw: Record<string, unknown>) {
    if (!this.bridgeConnected) return this.error(ws, 'to_app', 'mac_offline', 'Your Mac is offline.', frame.id)
    const rid = String((raw as { request_id?: unknown }).request_id)
    if (this.readReqs.has(rid)) return
    this.readReqs.set(rid, {
      ws,
      want: V2_READ_RESPONSE_FOR[frame.type as keyof typeof V2_READ_RESPONSE_FOR],
      frameId: frame.id,
    })
    this.readRefs.set(frame.id, ws)
    this.sendToBridge(raw, { durable: false })
  }

  /** Owner schedule frames: forwarded live to the bridge without a seq or a buffer entry (S4). */
  private onScheduleFrame(ws: WebSocket, frame: Frame, raw: Record<string, unknown>) {
    if (this.scheduleSeen.has(frame.id)) return this.sendTo(ws, 'to_app', mkFrame('ack', { ref: frame.id }))
    if (!this.bridgeConnected) return this.error(ws, 'to_app', 'mac_offline', 'Your Mac is offline.', frame.id)
    this.scheduleSeen.add(frame.id)
    this.scheduleRefs.set(frame.id, ws)
    const rid = (raw as { request_id?: unknown }).request_id
    if (typeof rid === 'string') this.scheduleReqs.set(rid, ws)
    this.sendToBridge(raw, { durable: false })
  }

  private acceptOwnerFrame(ws: WebSocket, id: string, raw: Record<string, unknown>, ackSeq = true) {
    const stamped = this.stamp(raw)
    const seq = (stamped.relay as { seq: number }).seq
    this.seenOwnerIds.set(id, seq)
    this.refSockets.set(id, ws)
    this.sendTo(ws, 'to_app', mkFrame('ack', ackSeq ? { ref: id, seq } : { ref: id }))
    this.forwardOwnerFrame(stamped)
  }

  /** Strips `stepup_token` (the relay checks it, the bridge never sees it) and buffers for the bridge. */
  private forwardOwnerFrame(stamped: Record<string, unknown>) {
    const { stepup_token: _drop, ...forwarded } = stamped
    this.sendToBridge(forwarded)
  }
}
