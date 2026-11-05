// Live-voice session manager (spec 6.2 - 6.5): call setup, sideband events, the `ask_agent` hand-off, timers, caps and
// the records written when a call ends. Time only ever comes from `services.clock`, so tests drive it with a fake clock.
import { type FrameOf, type MessageT, newId, newUlid, type PushIntent, type ThreadT } from '@talos-app/protocol'
import type { RelayServices } from '../services.ts'
import { resolvePorts, type VoicePorts } from './ports.ts'
import { renderPrompt } from './prompt.ts'
import type { Sideband, SidebandEvent, VoiceProvider } from './provider.ts'
import { buildSeed } from './seed.ts'

export const NO_ASK_MS = 3_000
export const STILL_WORKING_MS = 20_000
export const CLOSE_WAIT_MS = 10_000
export const DAILY_LIMIT_MESSAGE = "Today's live-voice limit is used up."
const COMMENTARY_MAX_CHARS = 1_500 // ~500 tokens
const MAX_TURNS = 500
const MAX_TURN_CHARS = 4_000
const MAX_DELEGATIONS_KEPT = 200
export const CHECKPOINT_MS = 30_000
/** Transcript text kept in `voice.ended`; the frame limit after auth is 256 KiB, so this leaves a wide margin. */
const ENDED_TRANSCRIPT_MAX_BYTES = 128 * 1024
export const TRUNCATED_NOTE = '[Earlier part of the transcript was cut to fit.]'

export class VoiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Turn = { who: 'owner' | 'agent'; text: string; at: string }

type Delegation = {
  id: string
  sessionId: string
  threadId: string
  asked: boolean
  done: boolean
  stillSaid: boolean
  askTimer: unknown
  stillTimer: unknown
}

type Session = {
  id: string
  providerId: string
  threadId: string
  agentName: string
  startedMs: number
  maxMs: number
  state: 'open' | 'closing' | 'closed'
  sideband: Sideband
  turns: Turn[]
  current: { who: 'owner' | 'agent'; text: string; at: string } | null
  delegations: number
  timers: unknown[]
  closeTimer: unknown
  finished: Promise<void>
  finish: () => void
}

/** Finished call rows older than this are dropped; the daily cap only ever looks back one day. */
const VOICE_USAGE_KEEP_MS = 8 * 86_400_000

/** Deletes closed voice_usage rows past the keep window. */
export function pruneVoiceUsage(services: RelayServices): number {
  const cutoff = new Date(services.clock.now() - VOICE_USAGE_KEEP_MS).toISOString()
  return services.db.prepare('delete from voice_usage where open = 0 and started_at < ?').run(cutoff).changes
}

export class VoiceManager {
  private readonly sessions = new Map<string, Session>()
  private readonly delegations = new Map<string, Delegation>()
  private readonly ports: VoicePorts
  /** R1: set synchronously while a start is in flight, so a second concurrent start is refused. */
  private starting = false
  private checkpointTimer: unknown = null

  constructor(
    private readonly services: RelayServices,
    private readonly provider: VoiceProvider,
  ) {
    this.ports = resolvePorts(services)
    this.reconcileOrphans()
  }

  /** R2: calls still marked open belong to a dead process. Count them pessimistically (up to the session cap). */
  private reconcileOrphans(): void {
    const { services } = this
    const now = services.clock.now()
    const capS = services.env.VOICE_SESSION_MAX_MIN * 60
    const rows = services.db
      .prepare('select voice_session_id, started_at, seconds from voice_usage where open = 1')
      .all() as Array<{
      voice_session_id: string
      started_at: string
      seconds: number
    }>
    const upd = services.db.prepare('update voice_usage set seconds = ?, open = 0 where voice_session_id = ?')
    for (const r of rows) {
      const sinceStart = Math.max(0, Math.round((now - Date.parse(r.started_at)) / 1000))
      upd.run(Math.max(r.seconds, Math.min(capS, sinceStart)), r.voice_session_id)
    }
    if (rows.length)
      services.log.warn({ count: rows.length }, 'voice: closed out calls left open by a previous process')
  }

  /** R2: writes elapsed seconds for every live call, then re-arms itself while any call is live. */
  checkpoint(): void {
    const { services } = this
    const now = services.clock.now()
    const upd = services.db.prepare('update voice_usage set seconds = ?, last_seen_at = ? where voice_session_id = ?')
    let live = false
    for (const s of this.sessions.values()) {
      if (s.state === 'closed') continue
      live = true
      upd.run(Math.max(0, Math.round((now - s.startedMs) / 1000)), new Date(now).toISOString(), s.id)
    }
    services.clock.clearTimeout(this.checkpointTimer)
    this.checkpointTimer = live ? services.clock.setTimeout(() => this.checkpoint(), CHECKPOINT_MS) : null
  }

  /** Called on process shutdown: save usage for calls in progress (the next start reconciles them). */
  shutdown(): void {
    try {
      this.checkpoint()
    } catch {
      /* database already closed */
    }
    this.services.clock.clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
  }

  // ---- call setup -----------------------------------------------------------------------------------------------

  async createSession(args: { threadId: string; sdp: string }): Promise<{
    voice_session_id: string
    sdp_answer: string
    max_minutes: number
  }> {
    // R1: one start at a time. The flag is set before the first await, so two requests in flight cannot both pass the
    // supersede loop and the cap check against the same budget.
    if (this.starting) throw new VoiceError(409, 'call_starting', 'A call is already starting.')
    this.starting = true
    try {
      return await this.createSessionLocked(args)
    } finally {
      this.starting = false
    }
  }

  private async createSessionLocked(args: { threadId: string; sdp: string }) {
    const { services } = this
    const config = services.agentConfig()
    const thread: ThreadT | undefined = config?.threads.find((t) => t.id === args.threadId)
    if (!thread) throw new VoiceError(404, 'not_found', 'Unknown thread.')
    if (thread.kind === 'system' || thread.archived)
      throw new VoiceError(400, 'bad_request', "You can't start a call in this thread.")

    // A call the app abandoned (crash, lost network) must not block the next one.
    for (const s of [...this.sessions.values()]) if (s.state === 'open') await this.endSession(s, 'superseded')

    const remainingS = this.dailyRemainingSeconds()
    if (remainingS <= 0) throw new VoiceError(429, 'rate_limited', DAILY_LIMIT_MESSAGE)
    const maxMin = Math.min(services.env.VOICE_SESSION_MAX_MIN, Math.max(1, Math.ceil(remainingS / 60)))

    let seed: ReturnType<typeof buildSeed> = []
    if (thread.voice_context !== 'none') {
      try {
        seed = buildSeed(await this.ports.history.recent(thread.id, 100), thread)
      } catch (err) {
        services.log.warn({ err: String(err) }, 'voice history unavailable; starting without seed')
      }
    }
    const instructions = renderPrompt({
      agentName: config?.agent.name ?? 'Talos',
      ownerName: config?.owner.display_name ?? 'You',
      threadName: thread.name,
      voicePersona: config?.agent.voice_persona ?? '',
    })

    let created: { provider_session_id: string; sdp_answer: string }
    try {
      created = await this.provider.create({
        sdp: args.sdp,
        instructions,
        voice: config?.agent.voice ?? 'meridian',
        seed,
      })
    } catch (err) {
      services.log.warn({ err: String(err) }, 'voice provider create failed')
      throw new VoiceError(502, 'voice_unavailable', "Live voice isn't available right now.")
    }

    const id = newId('v')
    const now = services.clock.now()
    services.db
      .prepare(
        'insert into voice_usage (voice_session_id, started_at, seconds, last_seen_at, open) values (?, ?, 0, ?, 1)',
      )
      .run(id, new Date(now).toISOString(), new Date(now).toISOString())

    let finish: () => void = () => {}
    const finished = new Promise<void>((r) => {
      finish = r
    })
    const sideband = this.provider.attach(created.provider_session_id)
    const s: Session = {
      id,
      providerId: created.provider_session_id,
      threadId: thread.id,
      agentName: config?.agent.name ?? 'Talos',
      startedMs: now,
      maxMs: maxMin * 60_000,
      state: 'open',
      sideband,
      turns: [],
      current: null,
      delegations: 0,
      timers: [],
      closeTimer: null,
      finished,
      finish,
    }
    this.sessions.set(id, s)
    sideband.onEvent((e) => this.onSidebandEvent(s, e))
    sideband.onDisconnect(() => {
      if (s.state !== 'closed') void this.finalize(s, null)
    })
    s.timers.push(
      services.clock.setTimeout(
        () => this.say(s, 'One minute left on this call.', null),
        Math.max(0, s.maxMs - 60_000),
      ),
      services.clock.setTimeout(() => void this.endSession(s, 'cap'), s.maxMs),
    )
    if (!this.checkpointTimer) this.checkpointTimer = services.clock.setTimeout(() => this.checkpoint(), CHECKPOINT_MS)
    void this.sendState(s, 'connecting')
    return { voice_session_id: id, sdp_answer: created.sdp_answer, max_minutes: maxMin }
  }

  /** Ends a call and resolves once it has been finalised. Idempotent. */
  async endSession(s: Session | string, reason = 'requested'): Promise<void> {
    const session = typeof s === 'string' ? this.sessions.get(s) : s
    if (!session) throw new VoiceError(404, 'not_found', 'Unknown call.')
    if (session.state === 'open') {
      session.state = 'closing'
      this.services.log.info({ voice_session_id: session.id, reason }, 'voice session closing')
      session.closeTimer = this.services.clock.setTimeout(() => void this.finalize(session, null), CLOSE_WAIT_MS)
      try {
        session.sideband.send({ type: 'session.close' })
      } catch {
        void this.finalize(session, null)
      }
    }
    await session.finished
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id)
  }

  // ---- sideband events ------------------------------------------------------------------------------------------

  private onSidebandEvent(s: Session, e: SidebandEvent): void {
    if (s.state === 'closed') return
    // Event names only, never payloads (smoke test: LOG_LEVEL=debug shows what the model sent).
    this.services.log.debug({ voice_session_id: s.id, type: e.type }, 'voice event')
    switch (e.type) {
      case 'session.started':
        void this.sendState(s, 'live')
        break
      case 'session.input_transcript.delta':
        this.addTranscript(s, 'owner', e.delta)
        break
      case 'session.output_transcript.delta':
        this.addTranscript(s, 'agent', e.delta)
        break
      case 'session.delegation.created':
        this.onDelegationCreated(s, e)
        break
      case 'session.closed': {
        const seconds = (e.usage as { seconds?: unknown } | undefined)?.seconds
        void this.finalize(s, typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null)
        break
      }
      case 'error':
        // Codes only: an error event can echo user input.
        this.services.log.warn(
          { voice_session_id: s.id, code: (e.error as { code?: unknown } | undefined)?.code },
          'voice provider error',
        )
        break
    }
  }

  private addTranscript(s: Session, who: 'owner' | 'agent', delta: unknown): void {
    if (typeof delta !== 'string' || !delta) return
    if (s.current && s.current.who !== who) this.flushTurn(s)
    if (!s.current) s.current = { who, text: '', at: new Date(this.services.clock.now()).toISOString() }
    if (s.current.text.length < MAX_TURN_CHARS) s.current.text = (s.current.text + delta).slice(0, MAX_TURN_CHARS)
  }

  private flushTurn(s: Session): void {
    const c = s.current
    s.current = null
    if (c?.text.trim() && s.turns.length < MAX_TURNS) s.turns.push({ ...c, text: c.text.trim() })
  }

  // ---- the hand-off (6.3) ---------------------------------------------------------------------------------------

  private onDelegationCreated(s: Session, e: SidebandEvent): void {
    const d = e.delegation as { id?: unknown; target?: unknown } | undefined
    if (!d || typeof d.id !== 'string' || (d.target !== undefined && d.target !== 'client')) return
    if (this.delegations.has(d.id)) return
    s.delegations++
    const dg: Delegation = {
      id: d.id,
      sessionId: s.id,
      threadId: s.threadId,
      asked: false,
      done: false,
      stillSaid: false,
      askTimer: null,
      stillTimer: null,
    }
    this.delegations.set(d.id, dg)
    while (this.delegations.size > MAX_DELEGATIONS_KEPT) {
      const oldest = this.delegations.keys().next().value
      if (oldest === undefined) break
      this.clearDelegation(this.delegations.get(oldest))
      this.delegations.delete(oldest)
    }
    void this.sendState(s, 'delegating')
    dg.askTimer = this.services.clock.setTimeout(() => {
      if (dg.asked || dg.done) return
      dg.done = true
      this.say(s, `I couldn't reach ${s.agentName} just now.`, dg.id)
      this.settle(s)
    }, NO_ASK_MS)
  }

  /** A signed `voice.ask` from the app. Returns an error message when the frame is refused. */
  async handleAsk(frame: FrameOf<'voice.ask'>, raw: Record<string, unknown>): Promise<string | null> {
    const s = this.sessions.get(frame.voice_session_id)
    const dg = this.delegations.get(frame.delegation_id)
    if (s?.state !== 'open') return 'No live call with that id.'
    if (!dg || dg.sessionId !== s.id) return 'Unknown hand-off.'
    if (frame.thread_id !== s.threadId) return 'Hand-off is for a different thread.'
    if (dg.asked || dg.done) return 'That hand-off was already used.'
    dg.asked = true
    this.services.clock.clearTimeout(dg.askTimer)
    this.armStill(s, dg)
    // The frame goes on exactly as the app signed it (spec 3.5: raw JSON in, raw JSON out).
    await this.services.bus.toBridge(raw, { durable: true })
    return null
  }

  private armStill(s: Session, dg: Delegation): void {
    this.services.clock.clearTimeout(dg.stillTimer)
    if (dg.stillSaid || dg.done) return
    dg.stillTimer = this.services.clock.setTimeout(() => {
      if (dg.done || dg.stillSaid) return
      dg.stillSaid = true
      this.say(s, `${s.agentName}'s still on it. I'll ping you when it's done.`, dg.id)
    }, STILL_WORKING_MS)
  }

  handleProgress(f: FrameOf<'voice.progress'>): void {
    const dg = this.delegations.get(f.voice_delegation_id)
    const s = dg && this.sessions.get(dg.sessionId)
    if (!dg || !s || dg.done || s.state !== 'open' || !dg.asked) return
    this.armStill(s, dg)
    const content = f.text.slice(0, COMMENTARY_MAX_CHARS)
    if (!content.trim()) return
    s.sideband.send({
      type: f.say ? 'session.commentary.append' : 'session.thinking.append',
      content,
      delegation_id: dg.id,
    })
  }

  /** The agent's `reply` for a delegation. `text` is stored in the thread by the core module; this only speaks or pushes. */
  async handleReply(f: FrameOf<'reply'>): Promise<void> {
    const id = f.voice_delegation_id
    const dg = id ? this.delegations.get(id) : undefined
    if (!dg || dg.done) return
    dg.done = true
    this.clearDelegation(dg)
    const s = this.sessions.get(dg.sessionId)
    if (s && s.state === 'open') {
      if (f.speak?.trim()) this.say(s, f.speak.slice(0, COMMENTARY_MAX_CHARS), dg.id)
      this.settle(s)
    } else {
      const intent: PushIntent = { template: 'answer_ready', thread_id: dg.threadId }
      await this.services.push.notify(intent)
    }
    this.delegations.delete(dg.id)
  }

  private clearDelegation(dg: Delegation | undefined): void {
    if (!dg) return
    this.services.clock.clearTimeout(dg.askTimer)
    this.services.clock.clearTimeout(dg.stillTimer)
  }

  /** Back to `live` once no hand-off is outstanding. */
  private settle(s: Session): void {
    for (const dg of this.delegations.values()) if (dg.sessionId === s.id && !dg.done) return
    if (s.state === 'open') void this.sendState(s, 'live')
  }

  private say(s: Session, content: string, delegationId: string | null): void {
    if (s.state !== 'open') return
    s.sideband.send({ type: 'session.commentary.append', content, delegation_id: delegationId })
  }

  // ---- end of call ----------------------------------------------------------------------------------------------

  private async finalize(s: Session, usageSeconds: number | null): Promise<void> {
    if (s.state === 'closed') return
    s.state = 'closed'
    const { services } = this
    for (const t of s.timers) services.clock.clearTimeout(t)
    services.clock.clearTimeout(s.closeTimer)
    this.flushTurn(s)
    const elapsed = Math.max(0, Math.round((services.clock.now() - s.startedMs) / 1000))
    const seconds = Math.max(0, Math.round(usageSeconds ?? elapsed))
    services.db.prepare('update voice_usage set seconds = ?, open = 0 where voice_session_id = ?').run(seconds, s.id)

    // Unanswered hand-offs outlive the call: their answer arrives as a push. Unasked ones are dropped.
    for (const [id, dg] of this.delegations) {
      if (dg.sessionId !== s.id) continue
      services.clock.clearTimeout(dg.askTimer)
      services.clock.clearTimeout(dg.stillTimer)
      if (!dg.asked) this.delegations.delete(id)
    }

    const at = new Date(services.clock.now()).toISOString()
    const minutes = Math.max(1, Math.round(seconds / 60))
    const records: MessageT[] = [
      ...s.turns.map(
        (t): MessageT => ({
          id: newId('m'),
          thread_id: s.threadId,
          author: t.who,
          kind: 'voice_turn',
          text: t.text,
          format: 'plain',
          attachments: [],
          via: 'voice',
          created_at: t.at,
        }),
      ),
      {
        id: newId('m'),
        thread_id: s.threadId,
        author: 'system',
        kind: 'call_record',
        text: `Voice call · ${minutes} min`,
        format: 'plain',
        attachments: [],
        via: 'voice',
        call: { voice_session_id: s.id, duration_s: seconds, delegations: s.delegations },
        created_at: at,
      },
    ]
    try {
      await this.ports.sink.append(records)
    } catch (err) {
      services.log.error({ err: String(err), voice_session_id: s.id }, 'could not store call messages')
    }
    try {
      await services.bus.toBridge(
        {
          v: 1,
          type: 'voice.ended',
          id: newUlid(),
          ts: at,
          voice_session_id: s.id,
          thread_id: s.threadId,
          duration_s: seconds,
          transcript: capTranscript(s.turns),
        },
        { durable: true },
      )
    } catch (err) {
      services.log.error({ err: String(err), voice_session_id: s.id }, 'could not queue voice.ended')
    }
    await this.sendState(s, 'ended')
    try {
      await this.provider.close(s.providerId)
    } catch {
      /* already gone */
    }
    this.sessions.delete(s.id)
    s.finish()
  }

  // ---- caps (6.5) -----------------------------------------------------------------------------------------------

  /** Seconds left today (UTC day), counting calls still in progress. */
  dailyRemainingSeconds(): number {
    const { services } = this
    const now = services.clock.now()
    const dayStart = new Date(now)
    dayStart.setUTCHours(0, 0, 0, 0)
    const row = services.db
      .prepare('select coalesce(sum(seconds), 0) as s from voice_usage where started_at >= ? and open = 0')
      .get(dayStart.toISOString()) as { s: number }
    let used = row.s
    for (const s of this.sessions.values()) if (s.state !== 'closed') used += Math.max(0, (now - s.startedMs) / 1000)
    return Math.floor(services.env.VOICE_DAILY_MAX_MIN * 60 - used)
  }

  private async sendState(s: Session, state: 'connecting' | 'live' | 'delegating' | 'ended'): Promise<void> {
    await this.services.bus.toApps({
      v: 1,
      type: 'voice.state',
      id: newUlid(),
      ts: new Date(this.services.clock.now()).toISOString(),
      voice_session_id: s.id,
      state,
    })
  }
}

/** R3: newest turns that fit in ENDED_TRANSCRIPT_MAX_BYTES; a leading note says when older turns were dropped. */
export function capTranscript(turns: Turn[]): Array<{ who: 'owner' | 'agent'; text: string; at: string }> {
  const out: Turn[] = []
  let bytes = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as Turn
    const size = Buffer.byteLength(t.text) + 64
    if (bytes + size > ENDED_TRANSCRIPT_MAX_BYTES) {
      out.unshift({ who: 'agent', text: TRUNCATED_NOTE, at: t.at })
      break
    }
    bytes += size
    out.unshift(t)
  }
  return out.map((t) => ({ who: t.who, text: t.text, at: t.at }))
}
