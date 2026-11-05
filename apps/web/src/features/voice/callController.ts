// One live call, end to end (spec 6.2, 6.3). Not a React hook so it can be driven from tests and from two components
// (the composer's button and the call bar) that share one call. `useLiveCall` in index.tsx binds it to the app client.
import { routes } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import { audioDock } from '../threads/audioDock.ts'
import { type CallStore, createCallStore } from './callStore.ts'
import { loadTalkMode, saveTalkMode, type TalkMode } from './prefs.ts'
import { buildAsk, type Utterance } from './question.ts'
import type { CallDeps, DataChannelLike, PeerLike } from './types.ts'

const ICE_TIMEOUT_MS = 10_000
const STARTED_TIMEOUT_MS = 15_000
/** The relay opens a session with the model before it answers, so this is generous; it is not unbounded. */
// Must outlast the relay's own worst case (about 20 s: up to 10 s closing a call it supersedes, then at most 10 s waiting
// for the provider), or the app abandons a session the relay is still about to create.
const POST_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 8_000
const GENERIC_FAIL = "Couldn't start the call. Try again."
const MAX_UTTERANCES = 200
const CAPTION_LINES = 40

type Live = {
  stream: MediaStream
  track: MediaStreamTrack | undefined
  pc: PeerLike
  dc: DataChannelLike
  audio: ReturnType<CallDeps['createAudio']>
  releases: Array<() => void>
}

const CAP_GRACE_S = 15
/** A failed call's line fades after this, like the other short-lived results in the app (the session panel's 10 s). */
const ERROR_SHOWN_MS = 10_000
/** A call needs no touching, so the screen would look idle to the relay; say someone is here this often (its window is 60 s). */
const PRESENCE_EVERY_MS = 20_000

export class CallController {
  readonly store: CallStore
  /** Input / output loudness 0..1, read by the waveform every frame (kept out of the store on purpose). */
  readonly levels = { input: 0, output: 0 }
  private live: Live | null = null
  private client: TalosClient | null = null
  private unsubscribers: Array<() => void> = []
  private utterances: Utterance[] = []
  private pending: Utterance | null = null
  private lastDelegationAt: number | null = null
  private startedWaiter: { resolve(): void; reject(e: Error): void } | null = null
  /** Counts calls; bumped by every start and every end, so a start can tell it has been overtaken. */
  private current = 0
  /** Relay sessions already being closed, so one call is never closed twice. */
  private closing = new Set<string>()
  /** `session.started` can land before `start` begins waiting for it. */
  private sawStarted = false
  /** R5: backstop that hangs up shortly after `max_minutes` even if the relay's `ended` never reaches this app. */
  private capTimer: unknown = null
  /** Keeps the relay counting this screen as attended for the length of the call. */
  private presenceTimer: unknown = null
  /** Takes the failed call's line away again; replaced or cancelled whenever the error changes. */
  private errorTimer: unknown = null
  /** Page visibility listeners that pause and resume the error's fade. */
  /** The start whose call was ended by the page going hidden (not by a tap on End). */
  private leftHidden = 0
  private startSeq = 0
  private errorThread: string | null = null
  private errorWatch: Array<() => void> = []

  constructor(private readonly deps: CallDeps) {
    this.store = createCallStore(loadTalkMode())
  }

  // ---- start ----------------------------------------------------------------------------------------------------

  async start(client: TalosClient, threadId: string): Promise<void> {
    if (this.store.getState().phase !== 'idle') return
    const { deps, store } = this
    audioDock.pause({ handOver: true }) // a call owns the speaker: a clip playing in the dock waits
    this.client = client
    // This start's own token. Anything that ends the call (`finish`, `teardown`) moves the counter on, so after every
    // await a start that no longer holds the current token frees what it opened itself and leaves the store alone.
    const token = ++this.current
    const seq = ++this.startSeq
    const stale = () => token !== this.current
    this.sawStarted = false
    this.resetTranscript()
    this.clearErrorTimer()
    store.setState({
      phase: 'connecting',
      threadId,
      voiceSessionId: null,
      muted: false,
      talking: false,
      needsTapToHear: false,
      error: null,
      captions: [],
      handoffs: [],
      startedAt: deps.now(),
    })
    let sessionId: string | null = null
    const own: Partial<Live> & { releases: Array<() => void> } = { releases: [] }
    try {
      // Registered before the microphone is asked for. While the permission sheet is up nothing is open, so a hidden
      // page only matters once a stream exists (it is checked again the moment the stream arrives).
      this.unsubscribers.push(
        deps.lifecycle.onHidden(() => {
          if (!this.live) return
          this.leftHidden = token
          void this.end()
        }),
      )
      deps.media.setPlayAndRecord()
      try {
        own.stream = await deps.getUserMedia()
      } catch (err) {
        throw new MicError(err)
      }
      if (stale()) throw new Stale()
      // The owner left while the sheet or the request was up: do not keep a microphone open in the background.
      if (deps.lifecycle.isHidden()) throw new QuietEnd()
      const stream = own.stream
      const pc = deps.createPeer()
      own.pc = pc
      const audio = deps.createAudio()
      own.audio = audio
      const track = stream.getAudioTracks()[0]
      const dc = pc.createDataChannel('oai-events')
      own.dc = dc
      const live: Live = { stream, track, pc, dc, audio, releases: own.releases }
      this.live = live
      // The data channel must exist before the offer, so it is in the SDP.
      // Hold-to-talk promises the microphone is open only while the button is down. The track is closed before the peer
      // has it, not after the call goes live, so no room audio can reach the model while the call connects.
      if (track && store.getState().mode === 'hold') track.enabled = false
      if (track) pc.addTrack(track, stream)
      pc.addEventListener('track', (ev) => {
        const remote = ev.streams[0]
        if (!remote || this.live !== live) return
        audio.srcObject = remote
        live.releases.push(deps.media.meter(remote, (l) => (this.levels.output = l)))
        void audio.play().catch(() => store.setState({ needsTapToHear: true }))
      })
      live.releases.push(deps.media.meter(stream, (l) => (this.levels.input = l)))
      this.wireChannel(dc)

      const offer = await pc.createOffer()
      if (stale()) throw new Stale()
      await pc.setLocalDescription(offer)
      await this.waitForIce(pc)
      if (stale()) throw new Stale()
      const sdp = pc.localDescription?.sdp ?? offer.sdp
      if (!sdp) throw new CallError('Could not start the call.')

      const res = await this.post(sdp, threadId, (id) => (sessionId = id))
      sessionId = res.voice_session_id
      // A session this start created is closed in the catch below even when the call was ended during the POST.
      if (stale()) throw new Stale()
      store.setState({ voiceSessionId: sessionId })
      this.capTimer = deps.setTimeout(() => void this.end(), (res.max_minutes * 60 + CAP_GRACE_S) * 1000)
      this.unsubscribers.push(
        client.onFrame('reply', (f) => this.onReply(f)),
        client.onFrame('voice.state', (f) => {
          if (f.voice_session_id === sessionId && f.state === 'ended') void this.finish(false)
        }),
      )
      // The owner left the app while the call was connecting. Not a failure: end it and say nothing.
      if (deps.lifecycle.isHidden()) throw new QuietEnd()
      const started = new Promise<void>((resolve, reject) => {
        this.startedWaiter = { resolve, reject }
        if (this.sawStarted) resolve()
      })
      started.catch(() => {}) // observed below; this keeps a rejection during the awaits before it from going unhandled
      const timer = deps.setTimeout(
        () => this.startedWaiter?.reject(new CallError('The call did not connect.')),
        STARTED_TIMEOUT_MS,
      )
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp_answer })
        await started
      } finally {
        deps.clearTimeout(timer)
      }
      if (stale()) throw new Stale()
      const release = await deps.media.keepAwake()
      if (stale()) {
        release() // teardown already walked the list; this one arrived after it
        throw new Stale()
      }
      live.releases.push(release)
      store.setState({ phase: 'live' })
      this.startPresence()
      if (store.getState().mode === 'hold') this.setInputEnabled(false)
    } catch (err) {
      // The relay session this start created is always closed, whoever ended the call.
      if (sessionId) void this.closeRemote(sessionId)
      if (stale()) {
        // Ended on purpose (End, hidden, cap) or replaced by a newer start. Free only what this start opened; the
        // store and the newer call's state are not ours any more.
        this.free(own)
        // The owner left the app, not hung up: if the relay then refused the call, he still gets to read why when he
        // is back. A tap on End, or a newer call, makes the answer irrelevant.
        if (
          this.leftHidden === token &&
          seq === this.startSeq &&
          err instanceof CallError &&
          store.getState().phase === 'idle'
        ) {
          this.fail(err.message)
        }
        return
      }
      // Not an error, so no red line: the owner left the app while the call was connecting, or the microphone request
      // was cut off because the page went to the background. A refusal, a missing microphone, a relay failure or a
      // peer failure is still shown, even while hidden: the owner needs to know the call did not start.
      const quiet = err instanceof QuietEnd || (err instanceof MicError && err.aborted && deps.lifecycle.isHidden())
      const message =
        err instanceof CallError ? err.message : err instanceof MicError ? micMessage(err.original) : GENERIC_FAIL
      this.free(own)
      this.teardown()
      if (!quiet) this.fail(message)
    }
  }

  /** Stops everything one start opened, even if it never became `this.live`. Safe to run twice. */
  private free(own: Partial<Live> & { releases: Array<() => void> }): void {
    for (const r of own.releases.splice(0)) r()
    for (const t of own.stream?.getTracks() ?? []) t.stop()
    try {
      own.dc?.close()
    } catch {
      /* already closed */
    }
    try {
      own.pc?.close()
    } catch {
      /* already closed */
    }
    if (own.audio) {
      own.audio.srcObject = null
      own.audio.remove()
    }
  }

  /** Shows a call error. It fades 10 s after the owner can see it, not after it was raised. */
  private fail(message: string): void {
    this.clearErrorTimer()
    this.store.setState({ error: message })
    const { lifecycle } = this.deps
    this.errorWatch = [lifecycle.onHidden(() => this.stopFade()), lifecycle.onVisible(() => this.startFade())]
    if (!lifecycle.isHidden()) this.startFade()
  }

  private startFade(): void {
    if (this.errorTimer !== null) return
    this.errorTimer = this.deps.setTimeout(() => {
      this.errorTimer = null
      this.clearErrorTimer()
      this.store.setState({ error: null })
    }, ERROR_SHOWN_MS)
  }

  private stopFade(): void {
    if (this.errorTimer !== null) this.deps.clearTimeout(this.errorTimer)
    this.errorTimer = null
  }

  private clearErrorTimer(): void {
    this.stopFade()
    this.errorThread = null
    for (const u of this.errorWatch.splice(0)) u()
  }

  /**
   * A thread screen reports the thread the owner is on. The error belongs to the first thread it was seen on (a call
   * that failed after he moved on is still news there); seeing it from another thread means he moved, so it goes.
   * Lives here, not in the line, because the thread screen is remounted per thread and would forget.
   */
  noteViewing(threadId: string): void {
    if (this.store.getState().error === null) this.errorThread = null
    else if (this.errorThread === null) this.errorThread = threadId
    else if (this.errorThread !== threadId) this.dismissError()
  }

  /** The owner tapped the line, or moved to another thread. */
  dismissError(): void {
    this.clearErrorTimer()
    if (this.store.getState().error !== null) this.store.setState({ error: null })
  }

  private async post(sdp: string, threadId: string, onCreated: (id: string) => void) {
    const r = routes.voiceSession
    const ac = new AbortController()
    const timer = this.deps.setTimeout(() => ac.abort(), POST_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await this.deps.fetch(r.path, {
          method: 'POST',
          credentials: 'same-origin',
          signal: ac.signal,
          headers: { 'content-type': 'application/json', 'X-Talos-CSRF': '1' },
          body: JSON.stringify({ thread_id: threadId, sdp }),
        })
      } catch {
        throw new CallError(ac.signal.aborted ? 'The relay took too long. Try again.' : GENERIC_FAIL)
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: unknown } | null
        if (res.status === 429 && typeof body?.message === 'string') throw new CallError(body.message)
        if (res.status === 503) throw new CallError("Live voice isn't set up on this relay.")
        if (res.status === 401) throw new CallError('Sign in again to start a call.')
        throw new CallError(GENERIC_FAIL)
      }
      let raw: unknown
      try {
        raw = await res.json()
      } catch {
        throw new CallError(ac.signal.aborted ? 'The relay took too long. Try again.' : GENERIC_FAIL)
      }
      const parsed = r.res.safeParse(raw)
      if (parsed.success) return parsed.data
      // A reply we cannot read may still name the session the relay opened: hand the id back so it gets closed.
      const id = (raw as { voice_session_id?: unknown } | null)?.voice_session_id
      if (typeof id === 'string' && id) onCreated(id)
      throw new CallError(GENERIC_FAIL)
    } finally {
      this.deps.clearTimeout(timer)
    }
  }

  private waitForIce(pc: PeerLike): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const timer = this.deps.setTimeout(resolve, ICE_TIMEOUT_MS)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          this.deps.clearTimeout(timer)
          resolve()
        }
      })
    })
  }

  // ---- data channel ---------------------------------------------------------------------------------------------

  private wireChannel(dc: DataChannelLike): void {
    // A channel that belongs to an earlier, ended call may still deliver events (a real one fires `close` after
    // `close()`); they must not touch the call that is current now.
    dc.addEventListener('message', (ev) => {
      if (this.live?.dc !== dc) return
      let msg: unknown
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null
      } catch {
        return
      }
      if (msg && typeof msg === 'object') this.onServerEvent(msg as { type?: unknown } & Record<string, unknown>)
    })
    dc.addEventListener('close', () => {
      if (this.live?.dc === dc && this.store.getState().phase === 'live') void this.finish(false)
    })
  }

  private onServerEvent(e: { type?: unknown } & Record<string, unknown>): void {
    switch (e.type) {
      case 'session.started':
        this.sawStarted = true
        this.startedWaiter?.resolve()
        this.startedWaiter = null
        break
      case 'session.input_transcript.delta':
        this.addDelta('owner', e.delta)
        break
      case 'session.output_transcript.delta':
        this.addDelta('agent', e.delta)
        break
      case 'session.delegation.created': {
        const id = (e.delegation as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') void this.handOff(id)
        break
      }
      case 'session.closed':
        void this.finish(false)
        break
    }
  }

  private addDelta(who: 'owner' | 'agent', delta: unknown): void {
    if (typeof delta !== 'string' || !delta) return
    if (this.pending && this.pending.who !== who) this.flushPending()
    this.pending ??= { who, text: '', at: this.deps.now() }
    this.pending = { ...this.pending, text: this.pending.text + delta, at: this.deps.now() }
    this.publishCaptions()
  }

  private flushPending(): void {
    if (this.pending?.text.trim()) this.utterances.push(this.pending)
    this.pending = null
    if (this.utterances.length > MAX_UTTERANCES) this.utterances.splice(0, this.utterances.length - MAX_UTTERANCES)
  }

  private publishCaptions(): void {
    const all = this.pending ? [...this.utterances, this.pending] : this.utterances
    this.store.setState({ captions: all.slice(-CAPTION_LINES).map((u) => ({ who: u.who, text: u.text.trim() })) })
  }

  private resetTranscript(): void {
    this.utterances = []
    this.pending = null
    this.lastDelegationAt = null
  }

  // ---- the hand-off ---------------------------------------------------------------------------------------------

  private async handOff(delegationId: string): Promise<void> {
    const { client } = this
    const s = this.store.getState()
    if (!client || !s.voiceSessionId || !s.threadId || s.handoffs.some((h) => h.delegationId === delegationId)) return
    const now = this.deps.now()
    const all = this.pending ? [...this.utterances, this.pending] : this.utterances
    const { question, transcriptTail } = buildAsk({ utterances: all, lastDelegationAt: this.lastDelegationAt, now })
    this.lastDelegationAt = now
    if (!question) return // nothing the owner said to carry; the relay tells the model it could not reach the agent
    this.store.setState((st) => ({ handoffs: [...st.handoffs, { delegationId, question, state: 'working' }] }))
    try {
      await client.sendVoiceAsk({
        voiceSessionId: s.voiceSessionId,
        delegationId,
        threadId: s.threadId,
        question,
        transcriptTail,
      })
    } catch {
      this.setHandoff(delegationId, { state: 'failed' })
    }
  }

  private onReply(f: {
    message: { text?: string | undefined; card_id?: string | undefined }
    voice_delegation_id?: string | undefined
  }) {
    const id = f.voice_delegation_id
    if (!id) return
    this.setHandoff(id, {
      state: 'done',
      answer: f.message.text ?? (f.message.card_id ? 'A card is waiting in the thread.' : ''),
    })
  }

  private setHandoff(id: string, patch: Partial<import('./callStore.ts').Handoff>): void {
    this.store.setState((st) => ({
      handoffs: st.handoffs.map((h) => (h.delegationId === id ? { ...h, ...patch } : h)),
    }))
  }

  // ---- controls -------------------------------------------------------------------------------------------------

  /** Mute sends `session.input_audio.mute` AND disables the local track (spec 6.2). */
  setMuted(muted: boolean): void {
    this.setInputEnabled(!muted)
  }

  private setInputEnabled(enabled: boolean): void {
    const { live } = this
    if (!live) return
    if (live.track) live.track.enabled = enabled
    this.sendEvent({ type: enabled ? 'session.input_audio.unmute' : 'session.input_audio.mute' })
    this.store.setState({ muted: !enabled })
  }

  setMode(mode: TalkMode): void {
    saveTalkMode(mode)
    this.store.setState({ mode, talking: false })
    if (this.live) this.setInputEnabled(mode === 'hands_free')
  }

  pressToTalk(): void {
    if (this.store.getState().mode !== 'hold' || !this.live) return
    this.store.setState({ talking: true })
    this.setInputEnabled(true)
  }

  releaseToTalk(): void {
    if (this.store.getState().mode !== 'hold' || !this.live) return
    this.store.setState({ talking: false })
    this.setInputEnabled(false)
  }

  /** The "Tap to hear" button. */
  async playAudio(): Promise<void> {
    try {
      await this.live?.audio.play()
      this.store.setState({ needsTapToHear: false })
    } catch {
      /* still blocked */
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    const dc = this.live?.dc
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(event))
  }

  // ---- end ------------------------------------------------------------------------------------------------------

  async end(): Promise<void> {
    await this.finish(true)
  }

  private async finish(tellRelay: boolean): Promise<void> {
    const { store } = this
    const { phase, voiceSessionId } = store.getState()
    if (phase === 'idle' || phase === 'ending') return
    // Overtake any start still waiting on the microphone, the relay or the wake lock, then let go of the microphone
    // before anything that can be slow.
    this.current++
    store.setState({ phase: 'ending' })
    for (const t of this.live?.stream.getTracks() ?? []) t.stop()
    if (tellRelay) {
      this.sendEvent({ type: 'session.close' })
      if (voiceSessionId) await this.closeRemote(voiceSessionId)
    }
    this.teardown()
  }

  private async closeRemote(id: string): Promise<void> {
    if (this.closing.has(id)) return
    this.closing.add(id)
    const ac = new AbortController()
    const timer = this.deps.setTimeout(() => ac.abort(), CLOSE_TIMEOUT_MS)
    try {
      await this.deps.fetch(routes.voiceSessionClose.path.replace(':id', encodeURIComponent(id)), {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        signal: ac.signal,
        headers: { 'content-type': 'application/json', 'X-Talos-CSRF': '1' },
        body: '{}',
      })
    } catch {
      /* the relay closes the call itself when the sideband drops */
    } finally {
      this.deps.clearTimeout(timer)
    }
  }

  private startPresence(): void {
    const beat = () => {
      this.client?.reportPresence?.()
      this.presenceTimer = this.deps.setTimeout(beat, PRESENCE_EVERY_MS)
    }
    beat()
  }

  private teardown(): void {
    const live = this.live
    this.live = null
    this.current++
    if (this.presenceTimer !== null) this.deps.clearTimeout(this.presenceTimer)
    this.presenceTimer = null
    if (this.capTimer !== null) this.deps.clearTimeout(this.capTimer)
    this.capTimer = null
    this.startedWaiter?.reject(new Stale())
    this.startedWaiter = null
    for (const u of this.unsubscribers.splice(0)) u()
    if (live) {
      for (const r of live.releases) r()
      for (const t of live.stream.getTracks()) t.stop()
      try {
        live.dc.close()
      } catch {
        /* already closed */
      }
      live.pc.close()
      live.audio.srcObject = null
      live.audio.remove()
    }
    this.flushPending()
    this.levels.input = 0
    this.levels.output = 0
    this.store.setState({ phase: 'idle', muted: false, talking: false, needsTapToHear: false })
  }
}

class CallError extends Error {}
/** Thrown to stop a start that was overtaken by an end or a newer start. */
class Stale extends Error {}
/** The microphone request failed; keeps the browser's error for the message. */
class MicError extends Error {
  constructor(readonly original: unknown) {
    super('microphone')
  }
  get aborted(): boolean {
    return (this.original as { name?: string } | null)?.name === 'AbortError'
  }
}
/** Thrown to stop a start that has nothing to report. */
class QuietEnd extends Error {}

function micMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow the microphone to start a call.'
  if (name === 'NotFoundError') return 'No microphone found.'
  return "Couldn't start the call. Try again."
}
