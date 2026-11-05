// Driving mode's voice queue (docs/V2-FEATURES.md V4.1). ONE HTMLAudioElement plays every voice reply, first in first
// out, at the saved speed. The element is unlocked by the tap that turns driving on (a 50 ms silent clip), so replies
// that arrive later can start without another tap. No Web Audio: WebKit 291892 leaves an AudioContext silent after a
// PWA returns from the background.
import { createStore, type StoreApi } from 'zustand/vanilla'

export type QueueItem = {
  /** The message id of the voice reply (dedup key). */
  id: string
  url: string
  durationMs?: number
  /** First line of the text it answers, for the lock screen. */
  label?: string
  /** The text message this clip speaks (its phone-voice backup is cancelled when the clip starts, and only then). */
  replyTo?: string
}

export type QueueState = {
  /** The audio element has been unlocked by a tap. */
  armed: boolean
  current: QueueItem | null
  pending: QueueItem[]
  playing: boolean
  /** play() was refused (the page has no audio permission): the big Play button is the way out. */
  blocked: boolean
  position: number
  duration: number
  /** The listener paused the current reply; a new reply resumes it. */
  paused: boolean
  /** The silent unlock clip is still on the element. */
  unlocking: boolean
  /** A clip was asked to play and has not really started yet (bounded by LOAD_TIMEOUT_MS). */
  loading: boolean
  /** The next clip is waiting for the phone voice to finish an earlier reply (bounded by SPEECH_WAIT_MAX_MS). */
  waitingSpeech: boolean
}

export type VoiceQueue = {
  store: StoreApi<QueueState>
  /** Call from a tap handler: plays a 50 ms silent clip on the shared element. */
  unlock(): Promise<void>
  enqueue(item: QueueItem): void
  /** Play/pause the current reply; unlocks and starts it when nothing has played yet. */
  toggle(): void
  /** Idempotent: the lock screen and car send `play` and `pause` as separate actions. */
  play(): void
  pause(): void
  skip(): void
  /** Drops every queued (not yet playing) clip for a text the phone voice already read. */
  removeReply(replyTo: string): void
  back(seconds: number): void
  /** Recording (or anything else that must be heard) pauses playback; `release` resumes it. */
  hold(reason: string): void
  release(reason: string): void
  /** Re-applies the saved speed (after the speed button). */
  applySpeed(): void
  clear(): void
}

/** Wait before the one retry of a clip that would not load. */
const RETRY_CLIP_MS = 300
/** A clip that has not started playing this long after it was asked to (a hung download, a play() that never settles)
 * is given up: nothing may wait on one item forever. */
export const LOAD_TIMEOUT_MS = 8_000
/** A clip that stops making progress mid-way (buffer ran dry, the network went away) is given up after this long. */
export const STALL_TIMEOUT_MS = 10_000
/** How often a clip waiting for the phone voice looks again, and the longest it waits before cutting the voice off. */
const SPEECH_POLL_MS = 250
export const SPEECH_WAIT_MAX_MS = 45_000

/** 50 ms of 8 kHz 8-bit silence as a data: URI. */
export function silentWavDataUri(): string {
  const n = 400
  const bytes = new Uint8Array(44 + n).fill(0x80)
  const dv = new DataView(bytes.buffer)
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + n, true)
  ascii(8, 'WAVEfmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, 8000, true)
  dv.setUint32(28, 8000, true)
  dv.setUint16(32, 1, true)
  dv.setUint16(34, 8, true)
  ascii(36, 'data')
  dv.setUint32(40, n, true)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:audio/wav;base64,${btoa(bin)}`
}

export function createVoiceQueue(opts: {
  audio: HTMLAudioElement
  speed: () => number
  /** A clip started playing (its play() resolved). */
  onStart?: (item: QueueItem) => void
  /** A clip could not be played (404, pruned, network, hung): the queue has already moved on to the next one.
   * `started` is true when it broke after it had started playing. */
  onFail?: (item: QueueItem, info: { started: boolean }) => void
  /** True while the phone voice is still reading something: a new clip waits for it (one voice at a time). */
  speaking?: () => boolean
  /** Stops the phone voice (only used when it has kept a clip waiting for SPEECH_WAIT_MAX_MS). */
  cancelSpeech?: () => void
}): VoiceQueue {
  const { audio } = opts
  const store = createStore<QueueState>(() => ({
    armed: false,
    current: null,
    pending: [],
    playing: false,
    blocked: false,
    position: 0,
    duration: 0,
    paused: false,
    unlocking: false,
    loading: false,
    waitingSpeech: false,
  }))
  const set = (p: Partial<QueueState>) => store.setState(p)
  const holds = new Set<string>()
  const seen = new Set<string>()
  let silent = false // the unlock clip is on the element
  let userPaused = false // the listener paused it: a hold's release must not restart it
  const started = new Set<string>()
  const failed = new Set<string>()
  const retried = new Set<string>()
  /** A retry is already scheduled: the same failure reported twice (play() rejection + error event) is one failure. */
  const retrying = new Set<string>()
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let speechTimer: ReturnType<typeof setTimeout> | null = null
  let speechWait: { id: string; since: number } | null = null

  const stopLoadWatch = () => {
    if (loadTimer) clearTimeout(loadTimer)
    loadTimer = null
  }
  const stopStallWatch = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = null
  }
  const stopSpeechWait = () => {
    if (speechTimer) clearTimeout(speechTimer)
    speechTimer = null
    if (store.getState().waitingSpeech) set({ waitingSpeech: false })
  }
  /** Every wait on the current item ends here. */
  const stopWatches = () => {
    stopLoadWatch()
    stopStallWatch()
    stopSpeechWait()
    if (store.getState().loading) set({ loading: false })
  }
  const sameItem = (item: QueueItem) => store.getState().current?.id === item.id
  const onCurrentSrc = (item: QueueItem) => !!audio.src && (audio.src === item.url || audio.src.endsWith(item.url))

  const applySpeed = () => {
    const s = opts.speed()
    audio.defaultPlaybackRate = s
    audio.playbackRate = s
  }

  const startCurrent = () => {
    const { current, armed } = store.getState()
    if (!current || !armed || holds.size > 0 || userPaused) return
    // One voice at a time: a clip never starts over the phone voice reading an earlier reply. It waits, bounded.
    if (opts.speaking?.()) {
      if (speechWait?.id !== current.id) speechWait = { id: current.id, since: Date.now() }
      if (Date.now() - speechWait.since < SPEECH_WAIT_MAX_MS) {
        if (!store.getState().waitingSpeech) set({ waitingSpeech: true })
        if (!speechTimer)
          speechTimer = setTimeout(() => {
            speechTimer = null
            startCurrent()
          }, SPEECH_POLL_MS)
        return
      }
      // The phone voice has been "speaking" far longer than any reply (a stuck engine): the clip wins.
      opts.cancelSpeech?.()
    }
    stopSpeechWait()
    speechWait = null
    silent = false
    if (!onCurrentSrc(current)) audio.src = current.url
    applySpeed()
    set({ blocked: false, position: audio.currentTime || 0, duration: (current.durationMs ?? 0) / 1000 })
    begin(current)
  }

  /** Asks the element to play `item` with a bounded wait: no real start within LOAD_TIMEOUT_MS gives it up. */
  const begin = (item: QueueItem) => {
    stopLoadWatch()
    set({ loading: true })
    loadTimer = setTimeout(() => {
      loadTimer = null
      if (!sameItem(item) || holds.size > 0 || userPaused || store.getState().blocked) return
      giveUp(item)
    }, LOAD_TIMEOUT_MS)
    play(item)
  }

  /** The clip really started (or resumed) making sound. */
  const progressed = () => {
    stopLoadWatch()
    stopStallWatch()
    if (store.getState().loading) set({ loading: false })
  }

  /** Final failure, no retry (a hung or stalled clip would hang again): move on and say so. */
  const giveUp = (item: QueueItem) => {
    if (failed.has(item.id)) return
    failed.add(item.id)
    retrying.delete(item.id)
    stopWatches()
    if (!sameItem(item)) return
    audio.pause()
    // Drop the hung download so a late answer can never start it behind the next reply.
    try {
      audio.removeAttribute('src')
      audio.load()
    } catch {
      /* not a real element (tests) */
    }
    opts.onFail?.(item, { started: started.has(item.id) })
    next()
  }

  const fail = (item: QueueItem) => {
    if (failed.has(item.id) || retrying.has(item.id)) return
    // One quiet retry first: a blip on mobile data should not cost the owner a reply.
    if (!retried.has(item.id) && sameItem(item)) {
      retried.add(item.id)
      retrying.add(item.id)
      stopWatches()
      setTimeout(() => {
        retrying.delete(item.id)
        if (!sameItem(item) || holds.size > 0 || failed.has(item.id)) return
        audio.load()
        begin(item)
      }, RETRY_CLIP_MS)
      return
    }
    failed.add(item.id)
    stopWatches()
    if (!sameItem(item)) return
    audio.pause()
    opts.onFail?.(item, { started: started.has(item.id) })
    next()
  }

  /** play() for the current reply. NotAllowed = no audio permission yet (a tap fixes it); Abort = we paused it; else the clip is bad. */
  const play = (item: QueueItem) => {
    audio.play().then(
      () => {
        if (sameItem(item)) progressed()
        set({ playing: !audio.paused, blocked: false })
        if (!started.has(item.id)) {
          started.add(item.id)
          opts.onStart?.(item)
        }
      },
      (e: unknown) => {
        const name = e instanceof DOMException ? e.name : ''
        if (name === 'AbortError') return
        if (name === 'NotAllowedError') {
          stopWatches()
          set({ playing: false, blocked: true })
        } else fail(item)
      },
    )
  }

  const next = () => {
    stopWatches()
    const [head, ...rest] = store.getState().pending
    userPaused = false
    set({
      current: head ?? null,
      pending: rest,
      playing: false,
      paused: false,
      position: 0,
      duration: (head?.durationMs ?? 0) / 1000,
    })
    if (head) startCurrent()
  }

  audio.addEventListener('play', () => {
    if (!silent) set({ playing: true, blocked: false })
  })
  audio.addEventListener('pause', () => {
    if (!silent) set({ playing: false })
  })
  audio.addEventListener('playing', () => {
    if (!silent) progressed()
  })
  audio.addEventListener('ended', () => {
    if (silent) return
    next()
  })
  audio.addEventListener('error', () => {
    if (silent) return
    const cur = store.getState().current
    // Only an error about the clip that is on the element now counts against it.
    if (cur && onCurrentSrc(cur)) fail(cur)
  })
  audio.addEventListener('timeupdate', () => {
    if (!silent) set({ position: audio.currentTime })
  })
  // Out of data mid-clip: give it STALL_TIMEOUT_MS to make progress again, then move on.
  const onStall = () => {
    const cur = store.getState().current
    if (silent || !cur || stallTimer || audio.paused) return
    const at = audio.currentTime
    stallTimer = setTimeout(() => {
      stallTimer = null
      if (!sameItem(cur) || audio.paused || holds.size > 0 || userPaused) return
      if (audio.currentTime > at) return
      giveUp(cur)
    }, STALL_TIMEOUT_MS)
  }
  audio.addEventListener('waiting', onStall)
  audio.addEventListener('stalled', onStall)
  const dur = () => {
    if (silent) return
    if (Number.isFinite(audio.duration) && audio.duration > 0) set({ duration: audio.duration })
    applySpeed()
  }
  audio.addEventListener('loadedmetadata', dur)
  audio.addEventListener('durationchange', dur)

  let unlocking: Promise<void> | null = null
  const doUnlock = async (attempt = 0): Promise<void> => {
    silent = true
    set({ unlocking: true })
    // Never let a hung play() hold the phone voice back for long.
    const guard = setTimeout(() => set({ unlocking: false }), 1000)
    audio.src = silentWavDataUri()
    try {
      // A play() that never settles (WebKit under load) is not a refusal: carry on, the first real reply will tell.
      await Promise.race([audio.play(), new Promise<void>((resolve) => setTimeout(resolve, 1500))])
    } catch (e) {
      // Interrupted (something paused or reloaded the element mid-unlock): try again, a few times.
      if (e instanceof DOMException && e.name === 'AbortError' && attempt < 3) {
        clearTimeout(guard)
        return doUnlock(attempt + 1)
      }
      // Refused: the next tap on Play tries again with a real reply.
      silent = false
      clearTimeout(guard)
      set({ armed: false, blocked: true, unlocking: false })
      return
    }
    // The 'pause' event arrives as a later task; it must still be read as the silent clip's, not a real reply's.
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(done, 150)
      audio.addEventListener('pause', done, { once: true })
      audio.pause()
    })
    clearTimeout(guard)
    silent = false
    set({ armed: true, blocked: false, unlocking: false })
    startCurrent()
  }

  return {
    store,
    unlock() {
      // One unlock at a time, and none once armed: a second would swap the element's src out from under a real reply.
      if (store.getState().armed) return Promise.resolve()
      unlocking ??= doUnlock().finally(() => {
        unlocking = null
      })
      return unlocking
    },
    enqueue(item) {
      if (seen.has(item.id)) return
      seen.add(item.id)
      const s = store.getState()
      if (!s.current) {
        set({ current: item, duration: (item.durationMs ?? 0) / 1000, position: 0 })
        startCurrent()
      } else {
        set({ pending: [...s.pending, item] })
        // A new reply ends a pause: silence is the failure while driving.
        if (userPaused) {
          userPaused = false
          set({ paused: false })
          this.play()
        }
      }
    },
    toggle() {
      const s = store.getState()
      if (!s.armed) {
        // This tap is the user gesture that unlocks the element, then the first reply starts.
        void this.unlock()
        return
      }
      if (!s.current) return
      if (s.playing) this.pause()
      else this.play()
    },
    play() {
      const s = store.getState()
      if (!s.armed) {
        void this.unlock()
        return
      }
      if (!s.current || s.playing) return
      userPaused = false
      set({ paused: false })
      if (!silent && onCurrentSrc(s.current)) {
        applySpeed()
        stopSpeechWait()
        begin(s.current)
      } else startCurrent()
    },
    pause() {
      if (!store.getState().playing) return
      userPaused = true
      stopWatches()
      set({ paused: true })
      audio.pause()
    },
    removeReply(replyTo) {
      set({ pending: store.getState().pending.filter((i) => i.replyTo !== replyTo) })
    },
    skip() {
      if (!store.getState().current) return
      audio.pause()
      next()
    },
    back(seconds) {
      try {
        audio.currentTime = Math.max(0, audio.currentTime - seconds)
      } catch {
        /* not seekable yet */
      }
      set({ position: audio.currentTime })
    },
    hold(reason) {
      holds.add(reason)
      stopWatches()
      if (!audio.paused && !silent) audio.pause()
      // Remember it was playing so release resumes: the current item stays in `current`.
    },
    release(reason) {
      holds.delete(reason)
      if (holds.size === 0) startCurrent()
    },
    applySpeed,
    clear() {
      stopWatches()
      speechWait = null
      audio.pause()
      holds.clear()
      userPaused = false
      set({ current: null, pending: [], playing: false, blocked: false, paused: false, position: 0, duration: 0 })
    },
  }
}
