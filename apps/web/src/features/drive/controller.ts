// Driving mode's brain (docs/V2-FEATURES.md V4.1). Watches the client store while `driving_until` is in the future:
//   - a voice reply that arrives LIVE goes into the FIFO (queue.ts); history is never spoken (judged by relay seq);
//   - each agent text reply has its OWN 20 s phone-voice backup; only its own clip STARTING cancels it, a clip that
//     fails leaves it running, and a reply the phone already read drops a late clip;
//   - one speaker at a time: the phone voice waits while Talk is held, a live call is on, or a clip is starting or
//     playing (every one of those waits is bounded); Talk and a live call cancel it, and a clip waits for it;
//   - only the device that is driving reads aloud: the one whose tap turned driving on, or that has /drive open
//     (a relaunch keeps it if driving_until is still the window it claimed). Other open devices stay silent;
//   - pending cards and permission requests are counted and announced once, never approved here;
//   - hold-to-talk records a voice note into the chosen thread, pausing playback while it records.
// Rule behind all of it: a failure must never be silent, because the owner cannot look at the phone.
import { DETAILS_IN_THREAD, drivingActive, type MessageT, spokenText } from '@talos-app/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ClientState, TalosClient } from '../../lib/client.ts'
import { micOffText } from '../../lib/micOff.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { RecorderHandle } from '../composer/recorder.ts'
import { extFor } from '../composer/recorder.ts'
import type { Heard } from './prefs.ts'
import type { QueueItem, VoiceQueue } from './queue.ts'

export const FALLBACK_MS = 20_000
/** How often a waiting phone voice looks again for a quiet moment. */
export const RETRY_MS = 1_500
/** Auto-extend only if the owner talked or tapped within this long. */
export const IDLE_END_MS = 2 * 3600_000
const THINKING_MAX_MS = 90_000
const MIN_NOTE_MS = 400
/** Messages with no relay seq (local ones) count as new if created this close to activation or later. */
const LIVE_SLACK_MS = 5_000

export type DriveStatus = 'ready' | 'listening' | 'sending' | 'thinking' | 'speaking'

export type DriveState = {
  active: boolean
  status: DriveStatus
  /** First line of the latest agent reply (28 px on the screen). */
  line: string
  thread: string
  cardsWaiting: number
  error: string | null
}

export type DriveDeps = {
  client: TalosClient
  queue: VoiceQueue
  speech: { speak(text: string): void; cancel(): void }
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  fallbackEnabled(): boolean
  loadThread(): string | null
  saveThread(id: string): void
  recorder(): Promise<RecorderHandle>
  audioSession: { set(t: 'playback' | 'play-and-record'): void }
  /** Survives the PWA being killed. Optional: tests run without. */
  persist?: {
    loadHeard(): Heard | null
    saveHeard(h: Heard | null): void
    loadTouch(): number | null
    saveTouch(t: number): void
    /** The `driving_until` (ms) of the window this device claimed (it is the one driving), or null. */
    loadLocal?(): number | null
    saveLocal?(until: number | null): void
  }
}

type PendingText = { thread: string; text: string; handle: unknown }

const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim()

export class DriveController {
  readonly store: StoreApi<DriveState>
  private active = false
  private seen = new Set<string>()
  private texts = new Map<string, string>()
  private pending = new Map<string, PendingText>()
  /** Texts the phone voice already read (a late clip for one of these is dropped). */
  private spoken = new Set<string>()
  private announced = new Set<string>()
  private sayQueue: string[] = []
  private sayTimer: unknown = null
  private lastMessages: ClientState['messages'] | null = null
  private recording: RecorderHandle | Promise<RecorderHandle> | null = null
  private sending = false
  private thinking = false
  private thinkingTimer: unknown = null
  private expiryTimer: unknown = null
  private expiryFor: string | null = null
  private watching = false
  private heardSeq = 0
  private activatedAt = 0
  private memTouch: number | null = null
  /** This device is the one driving: it reads replies aloud. */
  private local = false
  /** A tap here turned driving on (kept until driving goes off). */
  private claimed = false
  /** /drive is open on this device. */
  private screenOpen = false
  private onCall = false
  private textThread = new Map<string, string>()

  constructor(private readonly d: DriveDeps) {
    this.store = createStore<DriveState>(() => ({
      active: false,
      status: 'ready',
      line: '',
      thread: d.loadThread() ?? 'general',
      cardsWaiting: 0,
      error: null,
    }))
  }

  /** Starts following the client store (idempotent). */
  watch(): void {
    if (this.watching) return
    this.watching = true
    this.d.client.store.subscribe((s) => this.onState(s))
    this.d.queue.store.subscribe(() => this.refresh())
    this.onState(this.d.client.store.getState())
  }

  /** The queue calls these: a clip started (cancels only its own reply's backup) or failed (spoken note). */
  onClipStart = (item: QueueItem): void => {
    if (item.replyTo) this.clearPending(item.replyTo)
  }
  onClipFail = (item: QueueItem, info: { started: boolean } = { started: false }): void => {
    if (!this.active || !this.local) return
    const rt = item.replyTo
    const text = rt ? this.texts.get(rt) : undefined
    // It broke after it started, which had cancelled its text's backup: the phone reads the text instead.
    if (info.started && rt && text && !this.spoken.has(rt) && !this.pending.has(rt) && this.d.fallbackEnabled()) {
      this.arm(rt, this.textThread.get(rt) ?? this.store.getState().thread, text, 0)
      return
    }
    this.say("Couldn't play that reply. It's in the thread.")
  }

  // ---- which device reads aloud ---------------------------------------------------------------------------------------
  /** A tap on this device turned driving on (Settings, the thread menu, Start driving). */
  claim(): void {
    this.claimed = true
    this.becomeLocal()
  }
  /** A turn-on tap that did not go through. */
  unclaim(): void {
    if (!this.active) this.claimed = false
  }
  /** /drive is open (or closed) on this device. Opening it while driving is on makes this the driving device. */
  setScreenOpen(open: boolean): void {
    this.screenOpen = open
    if (open) this.becomeLocal()
  }
  /** True while this device reads replies aloud. */
  isLocal(): boolean {
    return this.active && this.local
  }
  private becomeLocal() {
    if (!this.active || this.local) return
    this.local = true
    this.saveLocal()
    // Cards that are already waiting get their one line now.
    this.scanCards(this.d.client.store.getState())
  }
  private saveLocal() {
    const u = Date.parse(this.d.client.store.getState().config?.voice_notes.driving_until ?? '')
    if (Number.isFinite(u)) this.d.persist?.saveLocal?.(u)
  }

  /** A live call started or ended: nothing else talks while it is on, and the phone voice stops. */
  setOnCall(on: boolean): void {
    if (on === this.onCall) return
    this.onCall = on
    if (on) {
      if (this.active) this.d.speech.cancel()
      this.d.queue.hold('call')
    } else this.d.queue.release('call')
  }

  private set(p: Partial<DriveState>) {
    this.store.setState(p)
  }

  private refresh() {
    const q = this.d.queue.store.getState()
    const status: DriveStatus = this.recording
      ? 'listening'
      : this.sending
        ? 'sending'
        : q.playing
          ? 'speaking'
          : this.thinking
            ? 'thinking'
            : 'ready'
    if (status !== this.store.getState().status) this.set({ status })
  }

  // ---- touch (F13: auto-extend only for an owner who is still there) -------------------------------------------------
  touch(): void {
    const t = Date.now()
    this.memTouch = t
    this.d.persist?.saveTouch(t)
  }
  lastTouch(): number {
    return this.memTouch ?? this.d.persist?.loadTouch() ?? 0
  }

  // ---- state ---------------------------------------------------------------------------------------------------------
  private onState(s: ClientState) {
    const act = s.config ? drivingActive(s.config, Date.now()) : false
    if (act && !this.active) this.activate(s)
    else if (!act && this.active) this.deactivate()
    if (!this.active) return
    const until = s.config?.voice_notes.driving_until ?? null
    if (until !== this.expiryFor && this.expiryFor !== null) {
      // Re-extended: the saved marks follow the new window, so a relaunch still finds them.
      this.saveHeard()
      if (this.local) this.saveLocal()
    }
    this.armExpiry(until)
    this.scanMessages(s)
    this.scanCards(s)
  }

  private activate(s: ClientState) {
    this.active = true
    this.activatedAt = Date.now()
    const until = s.config?.voice_notes.driving_until
    const untilMs = until ? Date.parse(until) : 0
    const maxSeq = Math.max(s.lastSeq, ...Object.values(s.messages).flatMap((l) => l.map((m) => m.seq ?? 0)), 0)
    // Relaunched mid-drive (iOS killed the app): replies since the last handled one are still owed.
    const saved = this.d.persist?.loadHeard()
    this.heardSeq = saved && saved.until > Date.now() ? saved.seq : maxSeq
    this.seen = new Set()
    this.lastMessages = null
    if (this.d.persist && this.lastTouch() === 0) this.touch()
    const savedLocal = this.d.persist?.loadLocal?.() ?? null
    this.local = this.claimed || this.screenOpen || (savedLocal !== null && savedLocal === untilMs)
    this.set({ active: true, error: null })
    this.saveHeard(untilMs)
    if (this.local) this.saveLocal()
    else this.d.persist?.saveLocal?.(null)
    // A thread that no longer exists falls back to the first fixed one.
    const threads = this.fixedThreads(s)
    const cur = this.store.getState().thread
    if (threads.length && !threads.some((t) => t.id === cur)) this.set({ thread: threads[0]?.id ?? 'general' })
  }

  private armExpiry(until: string | null) {
    if (until === this.expiryFor) return
    this.expiryFor = until
    if (this.expiryTimer) this.d.clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const left = until ? Date.parse(until) - Date.now() : 0
    if (left > 0)
      this.expiryTimer = this.d.setTimeout(
        () => this.onState(this.d.client.store.getState()),
        Math.min(left + 50, 2 ** 31 - 1),
      )
  }

  private deactivate() {
    this.active = false
    this.local = false
    this.claimed = false
    this.d.persist?.saveLocal?.(null)
    for (const p of this.pending.values()) this.d.clearTimeout(p.handle)
    this.pending.clear()
    this.spoken.clear()
    if (this.expiryTimer) this.d.clearTimeout(this.expiryTimer)
    if (this.thinkingTimer) this.d.clearTimeout(this.thinkingTimer)
    this.expiryTimer = this.thinkingTimer = null
    this.expiryFor = null
    this.thinking = false
    this.d.queue.clear()
    this.d.persist?.saveHeard(null)
    this.set({ active: false, status: 'ready', cardsWaiting: 0 })
  }

  private saveHeard(until?: number) {
    const u = until ?? Date.parse(this.d.client.store.getState().config?.voice_notes.driving_until ?? '')
    if (Number.isFinite(u)) this.d.persist?.saveHeard({ seq: this.heardSeq, until: u })
  }

  // ---- messages ------------------------------------------------------------------------------------------------------
  /** Live = arrived after driving began. Relay seq decides; a message with no seq falls back to its timestamp. */
  private isLive(m: MessageT): boolean {
    if (m.seq !== undefined) return m.seq > this.heardSeq
    const t = Date.parse(m.created_at)
    return Number.isFinite(t) && t >= this.activatedAt - LIVE_SLACK_MS
  }

  private scanMessages(s: ClientState) {
    if (s.messages === this.lastMessages) return
    this.lastMessages = s.messages
    const fresh: MessageT[] = []
    for (const list of Object.values(s.messages))
      for (const m of list)
        if (!this.seen.has(m.id)) {
          this.seen.add(m.id)
          if (m.text) {
            this.texts.set(m.id, m.text)
            this.textThread.set(m.id, m.thread_id)
          }
          if (this.isLive(m)) fresh.push(m)
        }
    // Oldest first, so a burst of missed replies keeps its order.
    fresh.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
    for (const m of fresh) this.onNew(m)
  }

  private onNew(m: MessageT) {
    if (m.seq !== undefined && m.seq > this.heardSeq) {
      this.heardSeq = m.seq
      this.saveHeard()
    }
    if (m.author !== 'agent') return
    // Another device is the one driving: this one shows the reply and stays silent.
    if (!this.local) return
    const voice = m.attachments.find((a) => a.role === 'voice_reply')
    if (voice) {
      const rt = m.reply_to
      // The phone already read this reply aloud: a late clip would say it twice.
      if (rt && this.spoken.has(rt)) return
      const answered = rt ? this.texts.get(rt) : undefined
      const text = answered ?? m.text
      if (text) this.set({ line: firstLine(spokenText(text) ?? text) })
      this.d.queue.enqueue({
        id: m.id,
        url: `/media/${voice.media_id}`,
        ...(voice.duration_ms ? { durationMs: voice.duration_ms } : {}),
        ...(text ? { label: firstLine(text) } : {}),
        ...(rt ? { replyTo: rt } : {}),
      })
      return
    }
    if (m.kind === 'text' && m.text) {
      this.endThinking()
      this.set({ line: firstLine(spokenText(m.text) ?? m.text) })
      if (this.d.fallbackEnabled()) this.arm(m.id, m.thread_id, m.text)
    }
  }

  private clearPending(id: string) {
    const p = this.pending.get(id)
    if (!p) return
    this.d.clearTimeout(p.handle)
    this.pending.delete(id)
  }

  /** True while the phone voice must stay quiet: Talk is held, a live call is on, or a clip is starting or playing.
   * Every one of these ends by itself: the queue gives a clip LOAD_TIMEOUT_MS to start and the phone voice
   * SPEECH_WAIT_MAX_MS, so a clip that never loads cannot keep the phone quiet for good. */
  private busy(): boolean {
    const q = this.d.queue.store.getState()
    return this.recording !== null || this.onCall || q.playing || q.unlocking || q.loading || q.waitingSpeech
  }

  private arm(id: string, thread: string, text: string, ms = FALLBACK_MS) {
    const fire = () => {
      const p = this.pending.get(id)
      if (!p) return
      if (this.busy()) {
        p.handle = this.d.setTimeout(fire, RETRY_MS)
        return
      }
      this.pending.delete(id)
      if (!this.active || !this.local) return
      this.spoken.add(id)
      this.d.queue.removeReply(id)
      const say = spokenText(text) ?? DETAILS_IN_THREAD
      if (say) this.d.speech.speak(say)
    }
    this.pending.set(id, { thread, text, handle: this.d.setTimeout(fire, ms) })
  }

  // ---- one speaker at a time: notes and card lines wait for a quiet moment ------------------------------------------------
  say(text: string): void {
    if (!this.local) return
    this.sayQueue.push(text)
    this.drainSay()
  }

  private drainSay() {
    if (this.sayTimer || this.sayQueue.length === 0) return
    if (this.busy()) {
      this.sayTimer = this.d.setTimeout(() => {
        this.sayTimer = null
        this.drainSay()
      }, RETRY_MS)
      return
    }
    const next = this.sayQueue.shift()
    if (next && this.local) this.d.speech.speak(next)
    if (this.sayQueue.length) {
      this.sayTimer = this.d.setTimeout(() => {
        this.sayTimer = null
        this.drainSay()
      }, RETRY_MS)
    }
  }

  private scanCards(s: ClientState) {
    const waiting = s.cards.filter((c) => c.state === 'pending')
    if (waiting.length !== this.store.getState().cardsWaiting) this.set({ cardsWaiting: waiting.length })
    // Only the driving device announces; another device's cards stay unannounced until it is the one.
    if (!this.local) return
    const fresh = waiting.filter((c) => !this.announced.has(c.id))
    if (fresh.length === 0) return
    for (const c of fresh) this.announced.add(c.id)
    this.say(`${s.config?.agent.name ?? 'Talos'} is waiting for an approval`)
  }

  // ---- threads -------------------------------------------------------------------------------------------------------
  fixedThreads(s: ClientState = this.d.client.store.getState()) {
    return (s.config?.threads ?? []).filter((t) => t.kind === 'fixed' && !t.archived).sort((a, b) => a.order - b.order)
  }

  cycleThread(): void {
    const list = this.fixedThreads()
    if (list.length === 0) return
    const i = list.findIndex((t) => t.id === this.store.getState().thread)
    const next = list[(i + 1) % list.length]
    if (!next) return
    this.set({ thread: next.id })
    this.d.saveThread(next.id)
  }

  // ---- talking -------------------------------------------------------------------------------------------------------
  private endThinking() {
    this.thinking = false
    if (this.thinkingTimer) this.d.clearTimeout(this.thinkingTimer)
    this.thinkingTimer = null
    this.refresh()
  }

  async beginTalk(): Promise<void> {
    if (this.recording) return
    this.touch()
    this.set({ error: null })
    // The phone voice must not go into the voice note, and nothing plays while he talks.
    this.d.speech.cancel()
    this.d.queue.hold('record')
    this.d.audioSession.set('play-and-record')
    getPlatform().haptic('light')
    const p = this.d.recorder()
    this.recording = p
    this.refresh()
    try {
      this.recording = await p
    } catch (e) {
      this.recording = null
      this.d.audioSession.set('playback')
      this.d.queue.release('record')
      this.say("Couldn't record. Try again.")
      this.set({
        error:
          e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
            ? micOffText()
            : "Couldn't record. Try again.",
      })
      this.refresh()
    }
  }

  async endTalk(send: boolean): Promise<void> {
    const rec = this.recording
    if (!rec) return
    this.recording = null
    const handle = await rec
    this.d.audioSession.set('playback')
    let note: Awaited<ReturnType<RecorderHandle['stop']>> | null = null
    try {
      if (send) note = await handle.stop()
      else handle.cancel()
    } catch {
      note = null
    }
    this.d.queue.release('record')
    if (!note || note.durationMs < MIN_NOTE_MS) {
      this.refresh()
      return
    }
    this.sending = true
    this.refresh()
    const thread = this.store.getState().thread
    try {
      const att = await this.d.client.uploadMedia(note.blob, {
        name: `voice-note-${Date.now()}.${extFor(note.mime)}`,
        durationMs: note.durationMs,
        waveform: note.waveform,
      })
      await this.d.client.sendVoiceNote({ threadId: thread, attachment: { ...att, kind: 'voice_note' } })
      getPlatform().haptic('success')
      this.thinking = true
      this.thinkingTimer = this.d.setTimeout(() => this.endThinking(), THINKING_MAX_MS)
    } catch {
      this.say("Couldn't send that. Try again.")
      this.set({ error: "Couldn't send. Try again." })
      getPlatform().haptic('error')
    } finally {
      this.sending = false
      this.refresh()
    }
  }
}
