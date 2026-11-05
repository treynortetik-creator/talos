// Read aloud on request (the play button on an agent message). The app names a message; this reads the Mac's OWN stored copy,
// cleans it (no code, no markup), makes the audio with the owner's TTS command, uploads it as media and answers with the
// media ref. The audio is kept per message, so a second tap is instant. A tap never waits on the synthesis: the first ask
// of a tap (`fresh`) starts it (or joins one already running) and waits a moment for a quick one; every follow-up ask answers
// at once ('working' or the outcome), because these asks run on the Mac's shared read queue and must not hold up search and
// history behind them. The app asks again until 'ready' or 'failed'. This code calls no paid service itself, but the voice
// command is the owner's own (TALOS_APP_TTS_CMD, any program): if it is a cloud voice, each job sends the cleaned message
// text (at most SPEAK_MAX_CHARS characters) to it. A job cannot be cancelled once asked for; the number waiting is capped
// (SPEAK_MAX_WAITING) and a further message gets 'busy'.
import { join } from 'node:path'
import {
  type AttachmentRefT,
  type FrameOf,
  newId,
  SPEAK_MIN_CHARS,
  type SpeakReason,
  sha256Hex,
  speakableText,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import type { BridgeEnv, BridgePaths } from '../config.ts'
import { writeFileAtomic } from '../fsutil.ts'
import type { HistoryStore } from '../history-store.ts'
import type { Logger } from '../log.ts'
import type { MediaStore } from '../media.ts'
import { readRegularFile } from '../safe-open.ts'
import { SPEAK_CACHE_PREFIX, synthesize } from '../tts.ts'
import type { SpeakBody } from '../v2-seams.ts'

/** Syntheses running at once. A Mac's voice model is heavy; more than this queue (the app sees 'working'). */
export const SPEAK_MAX_PARALLEL = 2
/** Jobs that may wait for a free slot behind the running ones. One more is refused with 'busy' instead of queueing for ever. */
export const SPEAK_MAX_WAITING = 6
/** A first ask waits this long for a quick synthesis before it answers 'working'. */
export const SPEAK_GRACE_MS = 2500
/** A finished job (either way) is remembered this long, so a follow-up ask after it finished still hears the outcome. */
export const SPEAK_JOB_MEMORY_MS = 60_000
/** The relay keeps uploaded media about a week; audio older than this is put back before it is handed out. */
export const SPEAK_REUPLOAD_AFTER_MS = 24 * 3600_000

export const BUSY_MESSAGE = 'Your Mac is already making audio for other messages. Wait a minute, then tap again.'
export const NO_TTS_MESSAGE =
  'Your Mac has no voice set up yet. Set TALOS_APP_TTS_CMD in bridge.env to a text-to-speech command (a JSON list, see docs/SETUP.md) and restart Talos.'

type Entry = { ref: AttachmentRefT; sha: string; at: number; chars: number; total: number; truncated: boolean }
type Failure = { reason: SpeakReason; message: string }
type Outcome = { ok: true; entry: Entry } | ({ ok: false } & Failure)
type Job = { promise: Promise<Outcome>; outcome?: Outcome; doneAt?: number }

export type SpeakDeps = {
  env: BridgeEnv
  paths: BridgePaths
  store: Pick<HistoryStore, 'getMessage'>
  media: Pick<MediaStore, 'upload' | 'rehydrate' | 'hasKept'>
  clock: Clock
  log: Logger
}

export type SpeakOptions = {
  graceMs?: number
  maxParallel?: number
  maxWaiting?: number
  /** Tests swap the synthesis; production uses the real command runner. */
  synth?: typeof synthesize
}

const failed = (f: Failure): SpeakBody => ({ state: 'failed', reason: f.reason, message: f.message })

export class SpeakService {
  readonly available = true
  private jobs = new Map<string, Job>()
  /** Day-old answers being put back on the relay: one per message, never on the read queue. */
  private reuploads = new Map<string, { promise: Promise<void>; done: boolean }>()
  private running = 0
  private waiters: Array<() => void> = []
  private readonly graceMs: number
  private readonly maxParallel: number
  private readonly maxWaiting: number
  private readonly synth: typeof synthesize

  constructor(
    private d: SpeakDeps,
    o: SpeakOptions = {},
  ) {
    this.graceMs = o.graceMs ?? SPEAK_GRACE_MS
    this.maxParallel = o.maxParallel ?? SPEAK_MAX_PARALLEL
    this.maxWaiting = o.maxWaiting ?? SPEAK_MAX_WAITING
    this.synth = o.synth ?? synthesize
  }

  /** Jobs not finished yet (tests). */
  get active(): number {
    let n = 0
    for (const j of this.jobs.values()) if (!j.outcome) n++
    return n
  }

  async request(f: Pick<FrameOf<'speak.request'>, 'message_id' | 'thread_id' | 'fresh'>): Promise<SpeakBody> {
    const { env, store } = this.d
    if (!env.ttsCmd) return failed({ reason: 'no_tts', message: NO_TTS_MESSAGE })
    // Identity: the id names a message, the Mac's own row decides everything else. Only an agent message in the thread the
    // app named is read; the app never supplies text.
    const msg = store.getMessage(f.message_id)
    if (!msg || msg.thread_id !== f.thread_id || msg.author !== 'agent' || !msg.text) {
      return failed({
        reason: 'not_found',
        message: 'That message is no longer on your Mac, so it cannot be read aloud.',
      })
    }
    const say = speakableText(msg.text)
    if (Array.from(say.text).length < SPEAK_MIN_CHARS || !/[\p{L}\p{N}]/u.test(say.text)) {
      return failed({
        reason: 'nothing_to_read',
        message: 'This message is only code or formatting, so there is nothing to read aloud.',
      })
    }
    const sha = sha256Hex(new TextEncoder().encode(say.text))
    const waitS = 2 * env.ttsTimeoutS + 30
    const body = (extra: Partial<SpeakBody> & Pick<SpeakBody, 'state'>): SpeakBody => ({
      chars: Array.from(say.text).length,
      total_chars: say.total,
      truncated: say.truncated,
      ...extra,
    })

    const hit = this.readCache(f.message_id, sha)
    if (hit) {
      const moving = this.reupload(f.message_id, hit)
      if (!moving) return body({ state: 'ready', media: hit.ref })
      if (f.fresh) await this.pause(moving.promise)
      return moving.done ? body({ state: 'ready', media: hit.ref }) : body({ state: 'working', wait_s: waitS })
    }

    this.forgetOld()
    let job = this.jobs.get(f.message_id)
    if (job?.outcome) {
      const o = job.outcome
      // Retry drops the remembered failure; a remembered success whose audio has since gone is stale. A running job is never dropped.
      if ((!o.ok && f.fresh) || (o.ok && !this.d.media.hasKept(o.entry.ref.media_id))) {
        this.jobs.delete(f.message_id)
        job = undefined
      }
    }
    if (!job) {
      // A new job past the cap is refused where the owner sees it; a job already running is always joined.
      if (this.active >= this.maxParallel + this.maxWaiting) return failed({ reason: 'busy', message: BUSY_MESSAGE })
      job = this.start(f.message_id, say.text, sha, say)
    }
    // Only the first ask of a tap waits (for a quick synthesis). A follow-up answers now.
    if (!job.outcome && f.fresh) await this.pause(job.promise)
    const out = job.outcome
    if (!out) return body({ state: 'working', wait_s: waitS })
    if (!out.ok) return failed(out)
    return body({ state: 'ready', media: out.entry.ref })
  }

  private start(messageId: string, text: string, sha: string, say: { total: number; truncated: boolean }): Job {
    const job = {} as Job
    job.promise = this.run(messageId, text, sha, say).then(
      (o) => this.finish(job, o),
      (e) => {
        this.d.log.error('read aloud crashed', { error: (e as Error).message })
        return this.finish(job, { ok: false, reason: 'tts_failed', message: "Your Mac couldn't make the audio." })
      },
    )
    this.jobs.set(messageId, job)
    return job
  }

  private finish(job: Job, o: Outcome): Outcome {
    job.outcome = o
    job.doneAt = this.d.clock.now()
    return o
  }

  private forgetOld() {
    const now = this.d.clock.now()
    for (const [id, j] of this.jobs)
      if (j.doneAt !== undefined && now - j.doneAt > SPEAK_JOB_MEMORY_MS) this.jobs.delete(id)
  }

  private async slot(): Promise<void> {
    if (this.running < this.maxParallel) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
  private release() {
    const next = this.waiters.shift()
    if (next)
      next() // the slot passes straight on
    else this.running--
  }

  private async run(
    messageId: string,
    text: string,
    sha: string,
    say: { total: number; truncated: boolean },
  ): Promise<Outcome> {
    const { env, paths, media, log } = this.d
    await this.slot()
    try {
      const tts = await this.synth(env, paths, text, newId('m').slice(2))
      if (!tts.ok) {
        log.warn('read aloud failed', { reason: tts.reason })
        return { ok: false, reason: 'tts_failed', message: `Your Mac couldn't make the audio (${tts.reason}).` }
      }
      let ref: AttachmentRefT
      try {
        ref = await media.upload(tts.path, {
          role: 'voice_reply',
          name: `read-aloud.${tts.ext}`,
          mime: tts.mime,
          kind: 'audio',
        })
      } catch (e) {
        log.warn('read aloud upload failed', { error: (e as Error).message })
        return {
          ok: false,
          reason: 'upload_failed',
          message: "The audio was made, but your Mac couldn't send it to the relay.",
        }
      }
      const entry: Entry = {
        ref,
        sha,
        at: this.d.clock.now(),
        chars: Array.from(text).length,
        total: say.total,
        truncated: say.truncated,
      }
      try {
        writeFileAtomic(this.cachePath(messageId), JSON.stringify(entry), 0o600)
      } catch (e) {
        log.warn('read aloud index not written', { error: (e as Error).message }) // the answer still goes out; a second tap just makes it again
      }
      return { ok: true, entry }
    } finally {
      this.release()
    }
  }

  private cachePath(messageId: string): string {
    return join(this.d.paths.media, `${SPEAK_CACHE_PREFIX}${messageId.replace(/^m_/, '')}.json`)
  }

  /** The kept answer for this message, only while its text is unchanged and the audio is still on this Mac. */
  private readCache(messageId: string, sha: string): Entry | null {
    if (!/^m_[0-9A-HJKMNP-TV-Z]{26}$/.test(messageId)) return null
    const raw = readRegularFile(this.cachePath(messageId), 64 * 1024)
    if (!raw) return null
    try {
      const e = JSON.parse(raw.toString('utf8')) as Partial<Entry>
      if (e.sha !== sha || typeof e.at !== 'number' || !e.ref || typeof e.ref.media_id !== 'string') return null
      if (!this.d.media.hasKept(e.ref.media_id)) return null
      return e as Entry
    } catch {
      return null
    }
  }

  /** Waits for `p` at most the grace time. */
  private async pause(p: Promise<unknown>): Promise<void> {
    const { clock } = this.d
    let timer: unknown
    const grace = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, this.graceMs)
    })
    await Promise.race([p.then(() => undefined), grace])
    clock.clearTimeout(timer)
  }

  /**
   * The relay forgets media after about a week: a day-old answer is put back on it before the app is pointed at it. The upload
   * runs on its own (it can take as long as the relay is slow), never inside the read that asked: `null` means nothing to do,
   * otherwise the one upload for this message, with `done` set once it has settled either way. A failed upload still lets the
   * answer out; the app's own file recovery (a media.fetch) is the net behind it.
   */
  private reupload(messageId: string, e: Entry): { promise: Promise<void>; done: boolean } | null {
    const cur = this.reuploads.get(messageId)
    if (cur?.done) {
      this.reuploads.delete(messageId)
      return null
    }
    if (cur) return cur
    if (this.d.clock.now() - e.at <= SPEAK_REUPLOAD_AFTER_MS) return null
    const t: { promise: Promise<void>; done: boolean } = { promise: Promise.resolve(), done: false }
    t.promise = (async () => {
      try {
        if (await this.d.media.rehydrate(e.ref.media_id)) {
          writeFileAtomic(this.cachePath(messageId), JSON.stringify({ ...e, at: this.d.clock.now() }), 0o600)
        }
      } catch (err) {
        this.d.log.warn('read aloud re-upload failed', { error: (err as Error).message })
      } finally {
        t.done = true
      }
    })()
    this.reuploads.set(messageId, t)
    return t
  }
}
