// FakeApp: a ws client that behaves like the PWA. Holds a device key, signs owner frames over the RAW object, keeps
// the exact bytes it sent (the outbox resends bytes unchanged) and records everything it receives.
import {
  type CardT,
  createDeviceKey,
  type DeviceKey,
  type Frame,
  type FrameType,
  newId,
  newUlid,
  parseFrameText,
  signOwnerFrame,
} from '@talos-app/protocol'
import { WebSocket } from 'ws'
import { mkFrame } from './frame-utils.ts'
import { type ExpectOptions, Recorder } from './recorder.ts'

export type AppDirection = 'in' | 'out'

export type FakeAppOptions = {
  /** Base ws url of the relay, e.g. `relay.wsBase`. */
  relayWs: string
  deviceKey?: DeviceKey
  /** Extra headers on the upgrade request (the session cookie or `X-Test-Session`, Origin). */
  headers?: Record<string, string>
  lastSeq?: number
  visible?: boolean
  platform?: string
  standalone?: boolean
}

export class FakeApp {
  readonly rec = new Recorder<AppDirection>()
  /** Exact JSON text of every frame sent, in order (the signed bytes an outbox would store). */
  readonly sentBytes: string[] = []
  device!: DeviceKey
  ws: WebSocket | null = null
  lastSeq: number
  private opts: FakeAppOptions

  constructor(opts: FakeAppOptions) {
    this.opts = opts
    this.lastSeq = opts.lastSeq ?? 0
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Connects expecting the upgrade to be refused. Resolves with the HTTP status (401, 403). */
  async connectExpectingRefusal(): Promise<number> {
    this.device = this.opts.deviceKey ?? this.device ?? (await createDeviceKey())
    const ws = new WebSocket(`${this.opts.relayWs}/ws`, { headers: this.opts.headers ?? {} })
    return new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      ws.once('open', () => {
        ws.close()
        reject(new Error('upgrade was accepted'))
      })
      ws.once('error', () => {})
      setTimeout(() => reject(new Error('no response to the upgrade')), 3000)
    })
  }

  async connect(): Promise<Extract<Frame, { type: 'ready' }>> {
    this.device = this.opts.deviceKey ?? this.device ?? (await createDeviceKey())
    const ws = new WebSocket(`${this.opts.relayWs}/ws`, { headers: this.opts.headers ?? {} })
    this.ws = ws
    const startAt = this.rec.length
    ws.on('message', (data) => {
      const text = data.toString()
      const parsed = parseFrameText(text, { authenticated: true })
      if (!parsed.ok) return
      const raw = parsed.raw as Record<string, unknown>
      this.rec.record('in', raw, text)
      const seq = (raw.relay as { seq?: number } | undefined)?.seq
      if (typeof seq === 'number') this.lastSeq = Math.max(this.lastSeq, seq)
      if (raw.type === 'ping') this.send({ type: 'pong', nonce: raw.nonce })
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    this.send({
      type: 'hello',
      role: 'app',
      device_id: this.device.deviceId,
      last_seq: this.lastSeq,
      visible: this.opts.visible ?? true,
      client: { version: '0.0.0', standalone: this.opts.standalone ?? true, platform: this.opts.platform ?? 'test' },
    })
    return this.rec.expectFrame('ready', () => true, { since: startAt })
  }

  async close(code = 1000) {
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((r) => {
      ws.once('close', () => r())
      ws.close(code)
    })
  }

  send(frame: Record<string, unknown>) {
    const f = { ...mkFrame(String(frame.type)), ...frame }
    const text = JSON.stringify(f)
    this.rec.record('out', f, text)
    this.sentBytes.push(text)
    this.ws?.send(text)
    return f
  }

  /** Sends exact text as-is (use for outbox resends, malformed frames, oversize frames). */
  sendRaw(text: string) {
    this.sentBytes.push(text)
    this.ws?.send(text)
  }

  expectFrame<T extends FrameType>(
    type: T,
    predicate?: (f: Extract<Frame, { type: T }>) => boolean,
    opts?: ExpectOptions & { direction?: AppDirection },
  ) {
    return this.rec.expectFrame(type, predicate, opts)
  }

  // ---- owner frames --------------------------------------------------------------------------------------------

  /** Signs the raw object (adds device_id and osig). Every signed field must already be present, empty arrays included. */
  async sign<T extends Record<string, unknown>>(frame: T): Promise<T & { device_id: string; osig: string }> {
    const withDevice = { ...frame, device_id: this.device.deviceId }
    return signOwnerFrame(withDevice, this.device.privateKey)
  }

  /** Builds a signed `message` frame without sending it. */
  async buildMessage(thread_id: string, text: string, extra: Record<string, unknown> = {}) {
    return this.sign({
      ...mkFrame('message'),
      thread_id,
      client_msg_id: newId('m'),
      text,
      attachments: [],
      ...extra,
    })
  }

  /**
   * Builds a signed `history.request` (docs/PROTOCOL.md "Signed history reads"). Every field is explicit, as the raw-JSON
   * rule needs; `fields` carries `before_seq` / `before_id` / `after_id` / `around_id`.
   */
  async buildHistoryRequest(thread_id: string, fields: Record<string, unknown> = {}) {
    return this.sign({ ...mkFrame('history.request'), request_id: newUlid(), thread_id, limit: 50, ...fields })
  }

  /** A signed `media.fetch` (the Mac re-uploads an old file only for a pinned device's signature). */
  async buildMediaFetch(media_id: string) {
    return this.sign({ ...mkFrame('media.fetch'), media_id })
  }

  async sendHistoryRequest(thread_id: string, fields: Record<string, unknown> = {}) {
    const f = await this.buildHistoryRequest(thread_id, fields)
    this.send(f)
    return f
  }

  async sendMessage(thread_id: string, text: string, extra: Record<string, unknown> = {}) {
    const f = await this.buildMessage(thread_id, text, extra)
    this.send(f)
    return f
  }

  async sendVoiceNote(thread_id: string, attachment: Record<string, unknown>) {
    const f = await this.sign({ ...mkFrame('voice_note'), thread_id, client_msg_id: newId('m'), attachment })
    this.send(f)
    return f
  }

  /** `payloadHash` must be the hash the app recomputed from what it rendered. */
  async resolveCard(
    card: Pick<CardT, 'id'>,
    action: 'primary' | 'kill' | 'revise',
    payloadHash: string,
    extra: Record<string, unknown> = {},
  ) {
    const f = await this.sign({
      ...mkFrame('card.resolve'),
      card_id: card.id,
      action,
      payload_hash: payloadHash,
      ...extra,
    })
    this.send(f)
    return f
  }

  /** Signs and sends a `session.control` (docs/CLAUDE-CODE.md C2.5). `fields` supplies action and its arguments. */
  async sendSessionControl(thread_id: string, fields: Record<string, unknown>) {
    const f = await this.sign({ ...mkFrame('session.control'), control_id: newUlid(), thread_id, ...fields })
    this.send(f)
    return f
  }

  /** Signs and sends a `thread.session.control` (docs/OPTION-C.md): park, resume, restart or fresh. */
  async sendThreadSessionControl(thread_id: string, action: 'park' | 'resume' | 'restart' | 'fresh') {
    const f = await this.sign({ ...mkFrame('thread.session.control'), control_id: newUlid(), thread_id, action })
    this.send(f)
    return f
  }

  /** Signs and sends an `agent.recover`: 'restart', or the retired 'restore_last_good' an old app may still send. */
  async sendAgentRecover(action: string, extra: { control_id?: string; stepup_token?: string } = {}) {
    const f = await this.sign({ ...mkFrame('agent.recover'), control_id: extra.control_id ?? newUlid(), action })
    this.send(extra.stepup_token ? { ...f, stepup_token: extra.stepup_token } : f)
    return f
  }

  async sendConfigPatch(base_rev: number, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const f = await this.sign({ ...mkFrame('config.patch'), base_rev, patch, ...extra })
    this.send(f)
    return f
  }

  // ---- schedules (docs/SCHEDULES.md S2.2) ------------------------------------------------------------------------

  /** Signs and sends any owner schedule frame (`schedules.list`, `schedule.get`, `.patch`, `.run_now`, `.control`). */
  async sendSchedule(type: string, fields: Record<string, unknown> = {}) {
    const f = await this.sign({ ...mkFrame(type), ...fields })
    this.send(f)
    return f
  }
  /** `reads` is what the app says it can read (`app_features`); a current app says schedules/2, `null` is an app from before it. */
  listSchedules(reads: string[] | null = ['schedules/2']) {
    return this.sendSchedule('schedules.list', { request_id: newUlid(), ...(reads ? { app_features: reads } : {}) })
  }
  getSchedule(schedule_id: string, report_run_id: string | null = null, reads: string[] | null = ['schedules/2']) {
    return this.sendSchedule('schedule.get', {
      request_id: newUlid(),
      schedule_id,
      report_run_id,
      ...(reads ? { app_features: reads } : {}),
    })
  }
  patchSchedule(change: Record<string, unknown>, thread_id: string) {
    return this.sendSchedule('schedule.patch', { change, thread_id })
  }
  runScheduleNow(schedule_id: string, opts: { again?: boolean; where?: 'default' | 'session' } = {}) {
    return this.sendSchedule('schedule.run_now', {
      schedule_id,
      again: opts.again ?? false,
      where: opts.where ?? 'default',
    })
  }
  controlSchedule(action: string, schedule_id: string | null) {
    return this.sendSchedule('schedule.control', { action, schedule_id })
  }

  async sendVoiceAsk(
    thread_id: string,
    question: string,
    transcript_tail: Array<{ who: 'owner' | 'agent'; text: string }> = [],
    voiceSessionId: string = newId('v'),
  ) {
    const f = await this.sign({
      ...mkFrame('voice.ask'),
      voice_session_id: voiceSessionId,
      delegation_id: newUlid(),
      thread_id,
      question,
      transcript_tail,
    })
    this.send(f)
    return f
  }
}
