// FakeBridge: a ws client that behaves like the Mac bridge, and as strictly as the spec requires:
//  - signs its hello with Ed25519 (pass `key`: the relay's `relay.bridgeKey` / the harness key),
//  - acks durable frames in two stages (delivered, then consumed) and dedupes on id at the moment it notifies,
//  - verifies EVERY owner frame on the raw JSON (pinned device, signature, `ts` within now+2 min / now-8 days, ids not
//    seen) unless you opt out with `verifyOwner: false`; a rejected frame gets `error` and is then acked `consumed`
//    so it does not sit in the relay's buffer,
//  - answers frames it cannot parse with `error{bad_frame}`,
//  - by default answers every owner message with `echo: <text>`,
//  - with a `scheduler` (FakeScheduler or any SchedulerAdapter), answers the signed schedule frames the way docs/SCHEDULES.md
//    S2.2/S3.4 says the bridge does: ack{ref} (no seq) or error{ref, code, fields?}, snapshots and details to the asking
//    request_id, schedule.patch -> a composeScheduleCard() card, PRIMARY on it -> apply + card.update + schedule.status.
//  - answers the signed v2 reads (docs/V2-FEATURES.md V1.3) from `reads` (default: valid empty answers): search.results,
//    memory.listing, memory.file, memory.results to the asking request_id, or error{ref, code}. No ack, nothing stored.
import {
  type BridgeKeyPair,
  bindingFrom,
  type CardT,
  CONSUMABLE_FRAME_TYPES,
  composeScheduleCard,
  type Frame,
  type FrameType,
  fromChronosChange,
  generateBridgeKey,
  type JwkP256T,
  newId,
  parseFrameText,
  payloadHash,
  SCHEDULE_OWNER_FRAME_TYPES,
  SCHEDULES_FEATURE,
  ScheduleCardBindingError,
  type ScheduleCardPayloadT,
  type SchedulerAdapter,
  signChallenge,
  toChronosChange,
  V2_READ_OWNER_FRAME_TYPES,
  V2_READ_RESPONSE_FOR,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { WebSocket } from 'ws'
import { buildCard, type CardInput, mkFrame, now, waitFor } from './frame-utils.ts'
import { type ExpectOptions, Recorder } from './recorder.ts'

export type BridgeDirection = 'in' | 'out'

/** State that survives a "crash": ids already seen and ids delivered but never consumed. */
export class BridgeState {
  readonly seen = new Set<string>()
  readonly unconsumed = new Set<string>()
  readonly consumed = new Set<string>()
  readonly clientMsgIds = new Set<string>()
  /** The real Mac forgets seen ids after about 8 days. */
  forgetSeen() {
    this.seen.clear()
    this.clientMsgIds.clear()
  }
}

export type FakeBridgeOptions = {
  /** Base ws url of the relay, e.g. `relay.wsBase`. */
  relayWs: string
  /** The key the relay trusts (`relay.bridgeKey`). Random if omitted, which a relay that checks keys will refuse (4401). */
  key?: BridgeKeyPair
  headers?: Record<string, string>
  state?: BridgeState
  /** The Mac's clock for owner-frame age checks. Default `Date.now`. */
  now?: () => number
  /** Reply `echo: <text>` to owner messages once they are consumed. Default true. */
  autoReply?: boolean
  /** 'auto' (default): consume right after delivering. 'manual': call consume() yourself (a busy or crashed Claude). */
  consume?: 'auto' | 'manual'
  /** Device id -> public key. Owner frames from any other device are rejected with `device_not_pinned`. */
  pinnedDevices?: Record<string, JwkP256T>
  /** Default true. false = accept owner frames without checking (only for tests that are not about signatures). */
  verifyOwner?: boolean
  /** Send `replay.request` for unconsumed ids after `ready` (an optional hint; the relay already re-sends them). */
  requestReplay?: boolean
  agentConfigRev?: number
  clientName?: string
  /** Answer schedule frames from this adapter (and advertise 'schedules/1'). Without it they get scheduler_unavailable. */
  scheduler?: SchedulerAdapter
  /** `hello.client.features`. Default: ['schedules/1'] when a scheduler is set, else none. */
  features?: string[]
  /**
   * Answers to the signed v2 reads, by frame type: the body of the answer frame (request_id is filled in), or
   * `{ error: code }`. Unset types get a valid empty answer.
   */
  reads?: Partial<Record<FakeReadType, (frame: Record<string, unknown>) => FakeReadAnswer>>
}

export type FakeReadType = (typeof V2_READ_OWNER_FRAME_TYPES)[number]
export type FakeReadAnswer = Record<string, unknown> | { error: string; message?: string }

const EMPTY_READ: Record<FakeReadType, (f: Record<string, unknown>) => Record<string, unknown>> = {
  'search.query': () => ({ hits: [], next_cursor: null, total_estimate: 0, took_ms: 1, index: 'ready' }),
  'memory.tree': (f) => ({
    ...(f.root_id === null ? { roots: [] } : { root_id: f.root_id, path: f.path }),
    entries: [],
    next_cursor: null,
  }),
  'memory.read': (f) => ({
    root_id: f.root_id,
    path: f.path,
    mime: 'text/markdown',
    text: '',
    offset: 0,
    next_offset: null,
    size: 0,
    mtime: now(),
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  }),
  'memory.search': () => ({ hits: [], next_cursor: null, index: 'ready' }),
  'speak.request': () => ({ state: 'failed', reason: 'no_tts', message: 'Your Mac has no voice set up yet.' }),
}

const OWNER_TYPES = new Set(['message', 'voice_note', 'card.resolve', 'voice.ask'])
const MAX_AGE_MS = 8 * 24 * 3600_000
const MAX_FUTURE_MS = 2 * 60_000
const SCHEDULE_OWNER = new Set<string>(SCHEDULE_OWNER_FRAME_TYPES)
const V2_READ = new Set<string>(V2_READ_OWNER_FRAME_TYPES)
const SCHEDULE_FRESH_MS = 2 * 60_000 // run_now / control (S2.2)

export class FakeBridge {
  readonly rec = new Recorder<BridgeDirection>()
  readonly state: BridgeState
  /** Frames "pushed into Claude as a channel notification", in order. */
  readonly notified: Frame[] = []
  readonly cards = new Map<string, CardT>()
  /** Frames dropped because the owner checks failed. */
  readonly dropped: Array<Record<string, unknown>> = []
  readonly pinned: Record<string, JwkP256T>
  key!: BridgeKeyPair
  ws: WebSocket | null = null
  closeCode: number | null = null
  private opts: FakeBridgeOptions
  private pending = new Map<string, Frame>()
  private queue: Promise<void> = Promise.resolve()
  private scheduleSeen = new Set<string>()
  private scheduleCards = new Map<string, ScheduleCardPayloadT>()
  private lastStatus = new Map<string, string>()

  constructor(opts: FakeBridgeOptions) {
    this.opts = opts
    this.state = opts.state ?? new BridgeState()
    this.pinned = { ...(opts.pinnedDevices ?? {}) }
  }

  get autoReply() {
    return this.opts.autoReply ?? true
  }
  set autoReply(v: boolean) {
    this.opts.autoReply = v
  }
  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Pins a device (what the Mac does after the owner answers y). */
  pin(device: { deviceId: string; publicJwk: JwkP256T }) {
    this.pinned[device.deviceId] = device.publicJwk
  }

  async connect(): Promise<this> {
    this.key = this.opts.key ?? this.key ?? (await generateBridgeKey())
    this.closeCode = null
    const startAt = this.rec.length
    const ws = new WebSocket(`${this.opts.relayWs}/bridge`, { headers: this.opts.headers ?? {} })
    this.ws = ws
    ws.on('close', (code) => {
      this.closeCode = code
    })
    ws.on('message', (data) => this.enqueue(data.toString()))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('close', (code) => reject(new Error(`bridge socket closed ${code} before ready`)))
    })
    await this.rec
      .expectFrame('ready', () => true, { direction: 'in', since: startAt, timeoutMs: 3000 })
      .catch(() => {
        throw new Error(`bridge did not get ready (close code ${this.closeCode})`)
      })
    return this
  }

  /**
   * Connects expecting the relay to refuse the bridge. Resolves with the close code (4401 for a bad key).
   */
  async connectExpectingRefusal(): Promise<number> {
    this.key = this.opts.key ?? this.key ?? (await generateBridgeKey())
    const ws = new WebSocket(`${this.opts.relayWs}/bridge`, { headers: this.opts.headers ?? {} })
    this.ws = ws
    ws.on('message', (data) => this.enqueue(data.toString()))
    return new Promise<number>((resolve, reject) => {
      ws.once('close', (code) => resolve(code))
      ws.once('error', reject)
      setTimeout(() => reject(new Error('relay did not close the socket')), 3000)
    })
  }

  async close(code = 1000): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((r) => {
      ws.once('close', () => r())
      ws.close(code)
    })
  }

  /** A crash: the socket dies with no close handshake and nothing in memory survives except `state`. */
  crash(): void {
    this.ws?.terminate()
  }

  send(frame: Record<string, unknown>) {
    const f = { ...mkFrame(String(frame.type)), ...frame }
    this.rec.record('out', f, JSON.stringify(f))
    this.ws?.send(JSON.stringify(f))
    return f
  }

  expectFrame<T extends FrameType>(
    type: T,
    predicate?: (f: Extract<Frame, { type: T }>) => boolean,
    opts?: ExpectOptions & { direction?: BridgeDirection },
  ) {
    return this.rec.expectFrame(type, predicate, opts)
  }

  // ---- the two ack stages --------------------------------------------------------------------------------------

  /** ids delivered to us but not yet pushed into Claude */
  unconsumedIds(): string[] {
    return [...this.state.unconsumed]
  }

  /** Pushes a delivered frame into "Claude" (records the notification) and sends ack stage 'consumed'. */
  consume(id: string): boolean {
    const frame = this.pending.get(id)
    if (!frame) return false
    this.pending.delete(id)
    if (!this.state.consumed.has(id)) this.notified.push(frame)
    this.state.unconsumed.delete(id)
    this.state.consumed.add(id)
    this.send({ type: 'ack', ref: id, stage: 'consumed' })
    if (frame.type === 'message' && this.autoReply) {
      this.reply(frame.thread_id, `echo: ${frame.text}`)
    } else if (frame.type === 'voice_note' && this.autoReply) {
      this.reply(frame.thread_id, 'echo: (voice note)')
    } else if (frame.type === 'card.resolve') {
      this.resolveCard(frame)
    }
    return true
  }

  consumeAll(): number {
    let n = 0
    for (const id of [...this.pending.keys()]) if (this.consume(id)) n++
    return n
  }

  // ---- sending helpers -----------------------------------------------------------------------------------------

  reply(thread_id: string, text: string, extra: Record<string, unknown> = {}) {
    return this.send({
      type: 'reply',
      message: {
        id: newId('m'),
        thread_id,
        author: 'agent',
        kind: 'text',
        text,
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: now(),
      },
      ...extra,
    })
  }

  /** Creates a valid pending card (correct payload_hash), remembers it and sends `card.create`. */
  createCard(input: CardInput): CardT {
    const card = buildCard(input)
    this.cards.set(card.id, card)
    this.send({ type: 'card.create', card })
    return card
  }

  get features(): string[] {
    return this.opts.features ?? (this.opts.scheduler ? [SCHEDULES_FEATURE] : [])
  }

  // ---- schedules -----------------------------------------------------------------------------------------------

  private async onScheduleFrame(frame: Frame, raw: Record<string, unknown>) {
    const id = frame.id
    const err = (code: string, message: string, fields?: Array<{ path: string; message: string }>) =>
      void this.send({ type: 'error', ref: id, code, message, ...(fields ? { fields } : {}) })
    if (this.opts.verifyOwner !== false) {
      const jwk = this.pinned[String(raw.device_id)]
      if (!jwk) return err('device_not_pinned', 'owner frame check failed')
      if (!(await verifyOwnerFrame(raw, jwk))) return err('sig_invalid', 'owner frame check failed')
      const ts = Date.parse(frame.ts)
      const t = (this.opts.now ?? Date.now)()
      const strict = frame.type === 'schedule.run_now' || frame.type === 'schedule.control'
      if (strict && Math.abs(t - ts) > SCHEDULE_FRESH_MS) return err('stale', 'this request is too old')
      if (ts > t + MAX_FUTURE_MS || ts < t - MAX_AGE_MS) return err('sig_invalid', 'owner frame check failed')
      if (this.scheduleSeen.has(id)) return err('sig_invalid', 'replayed frame')
    }
    this.scheduleSeen.add(id)
    const sch = this.opts.scheduler
    if (!sch) return err('scheduler_unavailable', 'No scheduler is installed on this Mac.')
    switch (frame.type) {
      case 'schedules.list': {
        this.send({ type: 'ack', ref: id })
        this.send({ type: 'schedules.snapshot', request_id: frame.request_id, snapshot: await sch.snapshot() })
        return
      }
      case 'schedule.get': {
        const d = await sch.detail(frame.schedule_id, frame.report_run_id)
        if (!d) return err('schedule_not_found', 'No such scheduled job.')
        this.send({ type: 'ack', ref: id })
        this.send({
          type: 'schedule.detail',
          request_id: frame.request_id,
          detail: d.detail,
          report: d.report !== null && frame.report_run_id ? { run_id: frame.report_run_id, text: d.report } : null,
        })
        return
      }
      case 'schedule.patch': {
        const { chronos, threadId } = toChronosChange(frame.change)
        const v = await sch.validate(chronos)
        if (!v.ok) {
          if (v.code === 'schedule_invalid')
            return err('schedule_invalid', 'The scheduler refused this change.', v.errors.slice(0, 20))
          return err(v.code, v.errors[0]?.message ?? v.code)
        }
        const change = fromChronosChange(v.normalized, threadId) // the card binds what Chronos will write
        // ONE detail call is the base: its schedule.etag/content_hash is what the card shows AND binds (review F4)
        const cur = change.op === 'create' ? null : await sch.detail(change.id, null)
        const approved = change.op === 'adopt' ? await sch.approved(change.id) : null
        let card: CardT
        try {
          card = composeScheduleCard(change, v.preview, approved, {
            cardId: newId('c'),
            threadId: frame.thread_id,
            now: now(),
            origin: 'chat',
            proposedBy: 'owner_form',
            agentName: 'Talos',
            expectedEtag: v.expectedEtag,
            clientRef: id,
            threadName: (t) => t ?? 'the default thread',
            base: cur ? { schedule: cur.detail.schedule, prompt: cur.detail.prompt, guard: cur.detail.guard } : null,
          })
        } catch (e) {
          if (e instanceof ScheduleCardBindingError)
            return err('schedule_conflict', 'The job changed on your Mac. Nothing was drawn. Ask again.')
          throw e
        }
        this.cards.set(card.id, card)
        this.scheduleCards.set(card.id, card.payload as ScheduleCardPayloadT)
        this.send({ type: 'ack', ref: id })
        this.send({ type: 'card.create', card })
        return
      }
      case 'schedule.run_now': {
        const snap = await sch.snapshot()
        const job = snap.schedules.find((s) => s.id === frame.schedule_id)
        if (!job) return err('schedule_not_found', 'No such scheduled job.')
        if (job.today === 'held') return err('held', 'On hold: review the change first')
        if (job.runner !== 'session' && frame.where === 'default') {
          const r = await sch.startHeadless(job.id, { again: frame.again })
          if (!r.ok) return err(r.code, r.message)
        } else if (job.permissions === 'restricted') {
          return err('schedule_read_only', 'Restricted jobs only run in the background.')
        }
        this.send({ type: 'ack', ref: id })
        await this.emitScheduleStatus()
        return
      }
      case 'schedule.control': {
        const a = frame.action
        if (a === 'pause' || a === 'resume') await sch.setPaused({ id: frame.schedule_id as string }, a === 'pause')
        else if (a === 'pause_all' || a === 'resume_all') await sch.setPaused('all', a === 'pause_all')
        else if (a === 'disable') await sch.disable(frame.schedule_id as string)
        else await sch.retryHeadless()
        this.send({ type: 'ack', ref: id })
        await this.emitScheduleStatus()
        return
      }
      default:
        return
    }
  }

  /** Sends `schedule.status` with every job whose etag or state_rev moved since the last one (ids and hashes only). */
  async emitScheduleStatus(alert: { kind: 'job_failed' | 'scheduler_stuck'; key: string } | null = null) {
    const sch = this.opts.scheduler
    if (!sch) return
    const snap = await sch.snapshot()
    const changed = snap.schedules
      .filter((s) => this.lastStatus.get(s.id) !== `${s.etag}|${s.state_rev}`)
      .map((s) => ({ id: s.id, etag: s.etag, state_rev: s.state_rev }))
    const ids = new Set(snap.schedules.map((s) => s.id))
    const removed = [...this.lastStatus.keys()].filter((k) => !ids.has(k))
    this.lastStatus = new Map(snap.schedules.map((s) => [s.id, `${s.etag}|${s.state_rev}`]))
    this.send({ type: 'schedule.status', health: snap.health, changed, removed, alert })
  }

  private async applyScheduleCard(card: CardT, payload: ScheduleCardPayloadT) {
    const sch = this.opts.scheduler
    const done = (ok: boolean, text: string) =>
      this.send({
        type: 'card.update',
        card_id: card.id,
        state: ok ? 'done' : 'failed',
        result: { ok, text, at: now() },
      })
    if (!sch) return done(false, 'No scheduler is installed on this Mac.')
    const { chronos } = toChronosChange(payload.change)
    const r = await sch.apply(chronos, payload.expected_etag)
    if (!r.ok)
      return done(
        false,
        r.code === 'schedule_conflict'
          ? 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.'
          : r.message.slice(0, 500),
      )
    if (r.etag !== payload.expected_etag) return done(false, 'The saved job did not match the card. Reported.')
    done(true, 'Saved.')
    await this.emitScheduleStatus()
  }

  private resolveCard(frame: Extract<Frame, { type: 'card.resolve' }>) {
    const card = this.cards.get(frame.card_id)
    if (card?.state !== 'pending') {
      return void this.send({ type: 'error', ref: frame.id, code: 'card_not_pending', message: 'card is not pending' })
    }
    if (frame.payload_hash !== payloadHash(bindingFrom(card))) {
      return void this.send({
        type: 'error',
        ref: frame.id,
        code: 'card_hash_mismatch',
        message: 'hash does not match the ledger',
      })
    }
    card.state = 'resolved'
    const schedulePayload = this.scheduleCards.get(card.id)
    const resolution = {
      action: frame.action,
      at: now(),
      edited: Boolean(frame.edited),
      payload_hash: frame.payload_hash,
      ...(frame.note ? { note: frame.note } : {}),
    }
    this.send({ type: 'card.update', card_id: card.id, state: 'resolved', resolution })
    if (frame.action !== 'primary') {
      // Like the real bridge: nothing runs for a kill or revise, so no result follows and the card ends here.
      card.state = 'done'
      this.send({ type: 'card.update', card_id: card.id, state: 'done', resolution })
    }
    if (schedulePayload && frame.action === 'primary') void this.applyScheduleCard(card, schedulePayload)
  }

  // ---- inbound -------------------------------------------------------------------------------------------------

  // ---- v2 reads (docs/V2-FEATURES.md V1.3) -----------------------------------------------------------------------

  private readSeen = new Set<string>()

  private async onReadFrame(frame: Frame, raw: Record<string, unknown>): Promise<void> {
    const id = frame.id
    const err = (code: string, message: string): void => {
      this.send({ type: 'error', ref: id, code, message })
    }
    if (this.opts.verifyOwner !== false) {
      const jwk = this.pinned[String(raw.device_id)]
      if (!jwk) return err('device_not_pinned', 'owner frame check failed')
      if (!(await verifyOwnerFrame(raw, jwk))) return err('sig_invalid', 'owner frame check failed')
    }
    if (this.readSeen.has(id)) return // a replayed id: dropped, the first one was answered
    this.readSeen.add(id)
    const type = frame.type as FakeReadType
    const answer = (this.opts.reads?.[type] ?? EMPTY_READ[type])(raw)
    if ('error' in answer && typeof answer.error === 'string')
      return err(answer.error, typeof answer.message === 'string' ? answer.message : answer.error)
    this.send({ type: V2_READ_RESPONSE_FOR[type], request_id: raw.request_id, ...answer })
    return
  }

  /** Frames are processed strictly one at a time, in arrival order (signature checks are async; a bridge that races them reorders messages). */
  private enqueue(text: string) {
    this.queue = this.queue.then(() => this.onMessage(text)).catch(() => {})
  }

  /** Owner-frame checks (3.5). Returns an ErrorCode when the frame must be dropped. */
  private async ownerCheck(
    frame: Frame,
    raw: Record<string, unknown>,
  ): Promise<'device_not_pinned' | 'sig_invalid' | null> {
    const jwk = this.pinned[String(raw.device_id)]
    if (!jwk) return 'device_not_pinned'
    if (!(await verifyOwnerFrame(raw, jwk))) return 'sig_invalid'
    const ts = Date.parse(frame.ts)
    const t = (this.opts.now ?? Date.now)()
    if (ts > t + MAX_FUTURE_MS || ts < t - MAX_AGE_MS) return 'sig_invalid'
    // A re-send of a frame we delivered but never consumed (after a crash) is legitimate; anything else with a seen id is a replay.
    if (this.state.unconsumed.has(frame.id)) return null
    if (this.state.seen.has(frame.id)) return 'sig_invalid'
    if ((frame.type === 'message' || frame.type === 'voice_note') && this.state.clientMsgIds.has(frame.client_msg_id))
      return 'sig_invalid'
    return null
  }

  private async onMessage(text: string) {
    const parsed = parseFrameText(text, { authenticated: true, direction: 'relay_to_bridge' })
    if (!parsed.ok) {
      const id = (parsed.raw as { id?: unknown } | undefined)?.id
      this.send({
        type: 'error',
        ...(typeof id === 'string' ? { ref: id } : {}),
        code: 'bad_frame',
        message: parsed.message,
      })
      return
    }
    const raw = parsed.raw as Record<string, unknown>
    this.rec.record('in', raw, text)
    const frame = parsed.frame
    switch (frame.type) {
      case 'challenge': {
        const sig = await signChallenge(this.key.privateKey, frame)
        this.send({
          type: 'hello',
          role: 'bridge',
          key_id: this.key.keyId,
          sig,
          client: {
            name: this.opts.clientName ?? 'fake-bridge',
            version: '0.0.0',
            ...(this.features.length ? { features: this.features } : {}),
          },
          agent_config_rev: this.opts.agentConfigRev ?? 0,
        })
        return
      }
      case 'ready': {
        const ids = this.unconsumedIds()
        if (this.opts.requestReplay)
          for (let i = 0; i < ids.length; i += 200) this.send({ type: 'replay.request', ids: ids.slice(i, i + 200) })
        return
      }
      case 'ping':
        this.send({ type: 'pong', nonce: frame.nonce })
        return
      default:
        break
    }

    if (SCHEDULE_OWNER.has(frame.type)) return this.onScheduleFrame(frame, raw)
    if (V2_READ.has(frame.type)) return this.onReadFrame(frame, raw)

    if (!(CONSUMABLE_FRAME_TYPES as readonly string[]).includes(frame.type)) {
      if (['config.patch', 'device.enrolled', 'device.revoked'].includes(frame.type))
        this.send({ type: 'ack', ref: frame.id })
      return
    }

    const id = frame.id
    if (this.state.consumed.has(id)) {
      // A resend of something we already pushed to Claude: confirm, never notify twice.
      this.send({ type: 'ack', ref: id, stage: 'consumed' })
      return
    }
    if (this.pending.has(id)) {
      this.send({ type: 'ack', ref: id, stage: 'delivered' })
      return
    }

    if (this.opts.verifyOwner !== false && OWNER_TYPES.has(frame.type)) {
      const bad = await this.ownerCheck(frame, raw)
      if (bad) {
        this.dropped.push(raw)
        this.send({ type: 'error', ref: id, code: bad, message: 'owner frame check failed' })
        // Rejected frames are acked consumed after their error so the relay does not keep them for days.
        this.send({ type: 'ack', ref: id, stage: 'consumed' })
        this.state.consumed.add(id)
        return
      }
    }
    this.state.seen.add(id)
    if (frame.type === 'message' || frame.type === 'voice_note') this.state.clientMsgIds.add(frame.client_msg_id)
    this.state.unconsumed.add(id)
    this.pending.set(id, frame)
    this.send({ type: 'ack', ref: id, stage: 'delivered' })
    if ((this.opts.consume ?? 'auto') === 'auto') this.consume(id)
  }

  /** Waits until n frames of this type have been notified to "Claude". */
  async waitNotified(type: FrameType, n = 1, timeoutMs = 3000) {
    await waitFor(
      () => this.notified.filter((f) => f.type === type).length >= n,
      timeoutMs,
      `${n} ${type} notification(s)`,
    )
  }
}
