// The message audio player. One <audio> element lives in this module, shared by every message's own player: a row is a view
// of this store (it asks to play and reads back playing / position), and only one clip plays at a time. One element on purpose:
// iOS lets an element that has played from a tap start its next source without another tap (the next voice note, a follow-up
// reply), which a fresh element per message would not. There is no floating player: audio starts and stops from the message's
// own button. Leaving the screen stops it only where nothing else could (no system controls: AudioOnLeave); with lock-screen,
// Control Center or media-key controls it plays on. The store also owns the saved position, the lock-screen
// session and the queue of voice notes that follows the one playing (captured at play time, so it survives a scrolled-away row).
import { useSyncExternalStore } from 'react'
import { getPlatform } from '../../lib/platform.ts'
import {
  type AudioTraceCode,
  type AudioTraceInput,
  ORDER_CODES,
  playerTrace,
  recordAudioTrace,
  STALL_TRACE_MS,
} from '../problems/audioTrace.ts'
import { claimDecodeRetry, resetDecodeRetry } from './audioDecodeRetry.ts'
import {
  __resetPositionsForTests,
  clearSavedPositions,
  NEAR_END_S,
  onPositionsChanged,
  resumeAt,
  storePosition,
} from './audioPositions.ts'
import {
  beginRouteWait,
  cancelRouteWait,
  finishRouteWait,
  markCapped,
  markPlayed,
  markRoute,
  orderNow,
  pendingWait,
  type RouteWait,
} from './audioRouteWait.ts'
import { mediaUrl } from './media.ts'
import { loadSpeed, type Speed, saveSpeed } from './speed.ts'

export type AudioItem = {
  /** The row key: a message id (voice notes) or `<message id>:<media id>` (audio files). */
  key: string
  mediaId: string
  title: string
  durationMs?: number
  /** The file's MIME type and size: only for the audio trace (a bucket and a type, never a name). */
  mime?: string
  size?: number
}

export type AudioState = {
  item: AudioItem | null
  src: string
  playing: boolean
  /** Seconds. */
  cur: number
  /** Seconds, 0 until the browser knows (Chrome's recorder WebM reports Infinity: the attachment's duration stands in). */
  duration: number
  /** The file would not load. A mounted row hears it through `useMediaSrc.onError` and starts the rehydrate. */
  failed: boolean
  /** The browser refused to start playing (iOS refuses play() that did not start from a tap) or the start never took: the row says so. */
  refused: boolean
  /** The clip is wanted but not moving yet (waiting for data, a jump, a fix, or a start being helped along): the row says so, and the lock-screen clock stands still. */
  buffering: boolean
  speed: Speed
  /** Bumped when a saved position changes, so rows showing a saved position redraw. */
  rev: number
}

type RowHandle = { src: string; onError: () => void }

export { isTransientPath, screenOf } from './audioPaths.ts'

export const SAVE_EVERY_MS = 5000
export const SEEK_STEP_S = 10
export { ROUTE_WAIT_MS } from './audioRouteWait.ts'
export const AUDIO_ELEMENT_ID = 'talos-audio'
export { clearSavedPositions, MAX_SAVED, NEAR_END_S, POSITIONS_KEY, savedPosition } from './audioPositions.ts'

onPositionsChanged(() => set({ rev: state.rev + 1 }))

// ---- the store -----------------------------------------------------------------------------------------------------------
let state: AudioState = {
  item: null,
  src: '',
  playing: false,
  cur: 0,
  duration: 0,
  failed: false,
  refused: false,
  buffering: false,
  speed: 1,
  rev: 0,
}
const listeners = new Set<() => void>()
let speedLoaded = false

function set(patch: Partial<AudioState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function getAudioState(): AudioState {
  if (!speedLoaded) {
    speedLoaded = true
    state = { ...state, speed: loadSpeed() }
  }
  return state
}
export function subscribeAudio(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Selectors must return primitives or stable references (they run on every store change). */
export function useAudio<T>(select: (s: AudioState) => T): T {
  return useSyncExternalStore(subscribeAudio, () => select(getAudioState()))
}

// ---- the element ---------------------------------------------------------------------------------------------------------
let el: HTMLAudioElement | null = null
/** The queue after the current clip: captured when playback starts, so it works after the thread is gone. */
let queue: AudioItem[] = []
/** Where to jump once the browser has the metadata (a seek before that is ignored, notably on iOS). */
let pendingSeek: number | null = null
/** Chrome's recorder WebM has no duration: seeking to the end makes the browser compute it. */
let fixing = false
let lastSave = 0
/** Set when a clip ends: the element then reads its own end, which must not be saved as a spot to resume. */
let finished = false
/** The lock-screen controls are set (cleared by `stop`). */
let sessionHeld = false
/**
 * The audio route: 'playing' (category playback, taking the route), 'paused' (a clip is loaded and stopped; held but quiet so
 * the lock screen stays Talos's), or 'none' (given back: music resumes, the microphone and calls own the route).
 */
let routeState: 'none' | 'playing' | 'paused' = 'none'
/** A clip that was playing when the unsized-WebM fix paused it: play it again once the fix is done. */
let fixResume = false
const rows = new Map<string, () => RowHandle>()

/** Same cache-buster `useMediaSrc` puts on every media URL (a bare 410 is cached forever by old Chromium). */
const fallbackSrc = (mediaId: string) => `${mediaUrl(mediaId)}?c=2`

function audio(): HTMLAudioElement {
  if (el) return el
  const a = new Audio()
  a.id = AUDIO_ELEMENT_ID
  a.preload = 'metadata'
  a.hidden = true
  a.addEventListener('play', () => {
    nudgePausePending = false // a restart's pause event has come and gone
    askedPause = false
    // It started on waking with no tap behind it (a play() swallowed before the sleep): stopped again, not followed.
    if (watchOverdue() || endedBySleep) return endAfterSuspension(a)
    const rw = pendingWait(startGen)
    if (rw && !a.paused) rw.still = false // it started by itself in the wait: a pause now is its own
    if (!a.paused) wanted = true // it plays: the intent follows the element
    set({ playing: true, refused: false })
    applySpeed() // WebKit can fall back to 1x when a paused clip starts again
    pushPosition()
  })
  a.addEventListener('playing', () => {
    applySpeed()
    if (waitTimer) clearTimeout(waitTimer) // whatever it was waiting for has come
    waitTimer = null
    set({ buffering: false })
    pushPosition() // the clock runs again
    armStallWatch()
  })
  a.addEventListener('pause', () => {
    const asked = askedPause
    askedPause = false
    if (nudgePausePending) {
      nudgePausePending = false
      return // the one pause our own restart caused, not a stop
    }
    if (pendingWait(startGen)?.still && !fixing) {
      // The event of an earlier pause of ours (Pause, then Play at once) lands during the wait: the start stands, the row catches up.
      set({ playing: false, buffering: false })
      savePosition()
      pushPosition(false)
      return
    }
    // The element goes on saying it plays (a pause that was meant for an earlier play, or WebKit's media session interrupted):
    // follow the element, not the event. The clip is still wanted, so the watch checks that it really moves.
    if (!a.paused && wanted && state.item && !fixing) {
      if (!asked) trace('interrupted', { detail: 'stale' })
      armStallWatch()
      return
    }
    // A pause nobody asked for while a clip was playing: a call, Siri or another app took the audio route.
    if (!asked && !a.ended && !fixing && state.item && state.playing) trace('interrupted')
    if (fixing)
      armStallWatch() // the fix's own pause: a fix seek that never lands must still end in a line
    else {
      wanted = false
      disarmStallWatch()
    }
    set({ playing: false, buffering: false })
    savePosition()
    pushPosition()
    if (!fixing) releaseRoute(false, !asked) // a pause nobody asked for: iOS has the route, no call to the shell
  })
  a.addEventListener('loadedmetadata', onMetadata)
  a.addEventListener('durationchange', () => {
    if (Number.isFinite(a.duration) && a.duration > 0 && state.item) {
      set({ duration: a.duration })
      pushPosition()
    }
  })
  a.addEventListener('timeupdate', onTime)
  a.addEventListener('stalled', () => armWaitTrace('stalled'))
  a.addEventListener('waiting', () => armWaitTrace('waiting'))
  a.addEventListener('ended', onEnded)
  a.addEventListener('error', onError)
  try {
    document.body.appendChild(a)
  } catch {
    /* no document (a unit test of the store) */
  }
  if (typeof window !== 'undefined') {
    // The page can be gone before a timer fires: keep the spot when it goes to the background or closes.
    window.addEventListener('pagehide', savePosition)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && savePosition())
  }
  // WebKit's audio session API says when the system interrupts the page's audio (not every browser has it).
  try {
    const session = (navigator as unknown as { audioSession?: EventTarget & { state?: string } }).audioSession
    session?.addEventListener?.('statechange', () => {
      if (session.state === 'interrupted' && state.item && state.playing)
        trace('session-interrupted', { detail: 'interrupted' })
    })
  } catch {
    /* no audio session API */
  }
  el = a
  applySpeed()
  return a
}

/** The element itself, for the Playwright specs and unit tests. */
export const audioElement = (): HTMLAudioElement => audio()
/** Row mount: makes sure the element (and its speed) exists, without loading anything. */
export const ensureAudio = (): void => void audio()

function applySpeed(): void {
  const a = el
  if (!a) return
  const s = getAudioState().speed
  a.preservesPitch = true
  if (a.defaultPlaybackRate !== s) a.defaultPlaybackRate = s
  if (a.playbackRate !== s) a.playbackRate = s
}

function applyPending(a: HTMLAudioElement): void {
  if (pendingSeek === null || !Number.isFinite(a.duration) || !(a.duration > 0)) return
  const t = Math.max(0, Math.min(pendingSeek, a.duration))
  pendingSeek = null
  try {
    a.currentTime = t
  } catch {
    /* not seekable yet */
  }
  set({ cur: t })
  armStallWatch() // the jump is not movement: look again from here
}

function onMetadata(): void {
  const a = el
  if (!a || !state.item) return
  if (Number.isFinite(a.duration) && a.duration > 0) {
    set({ duration: a.duration })
    applyPending(a)
  } else if (a.duration === Number.POSITIVE_INFINITY) {
    // Seeking to the end of a playing element ends it (and would wipe the saved spot, or skip to the next note): do the
    // fix paused, then carry on playing.
    fixing = true
    fixResume = state.playing || pendingWait(startGen) !== null // a start waiting for the route plays after the fix
    cancelRouteWait()
    if (fixResume) {
      try {
        askedPause = true
        a.pause()
      } catch {
        /* ignore */
      }
    }
    a.currentTime = 1e101
  }
  applySpeed()
}

function onTime(): void {
  const a = el
  if (!a || !state.item) return
  if (fixing) {
    fixing = false
    if (Number.isFinite(a.duration) && a.duration > 0) set({ duration: a.duration })
    const back = pendingSeek ?? 0
    pendingSeek = null
    a.currentTime = back
    set({ cur: back })
    armStallWatch() // the jump is not movement: look again from here
    if (fixResume) {
      fixResume = false
      if (!watchOverdue()) startPlayback(undefined, true) // resuming after the fix is not a tap; after a sleep the overdue tick ends it
    }
    return
  }
  if (pendingSeek !== null) return // the jump has not landed yet: the element still reads 0
  if (Math.abs(a.currentTime - state.cur) > MOVED_S) {
    nudges = 0
    if (waitTimer) clearTimeout(waitTimer) // it is moving: a `waiting` that came before is over
    waitTimer = null
    if (state.buffering) {
      set({ buffering: false })
      pushPosition() // the clock runs again
    }
  }
  set({ cur: a.currentTime })
  if (Date.now() - lastSave >= SAVE_EVERY_MS) {
    savePosition()
    pushPosition() // the lock screen's clock follows the same 5 s tick as the saved spot
  }
}

function onError(): void {
  const it = state.item
  if (!it || state.failed) return // a stop() cleared the source, or this failure was told already (a rejected play(), then the element's own event)
  const code = el?.error?.code ?? 0
  trace('media-error', { mediaError: code })
  if (el && claimDecodeRetry(`${it.key} ${state.src}`, code)) {
    // A decode error on bytes that are fine: the same source once more at this spot, and on if he was listening. Once per clip.
    const listening = wanted // what he wants now: a Pause still in flight (its event not here yet) is not undone
    reloadSource(el, 'decode', listening)
    if (listening) startPlayback(undefined, true)
    return
  }
  wanted = false
  disarmStallWatch()
  savePosition()
  // A row says it through its rehydrate line; a clip with no row registered (the Files sheet) says it as a refusal.
  set({ failed: true, playing: false, refused: !rows.has(it.key), buffering: false })
  pushPosition(false) // no 'pause' event follows a failed load: the lock screen's clock must stop here
  // A mounted row owns the rehydrate (`useMediaSrc` asks the Mac and bumps the URL); a gone row leaves the failed state until a row mounts (`registerRow`).
  rows.get(it.key)?.().onError()
}

function onEnded(): void {
  const done = state.item
  if (!done || fixing) return // a fix's seek to the end is not the clip ending
  storePosition(done.mediaId, null) // heard to the end: the next play starts from the top
  finished = true
  const next = queue.shift()
  if (next) {
    open(next, rows.get(next.key)?.().src ?? fallbackSrc(next.mediaId), queue, { play: true })
    return
  }
  stop()
}

/** Saves where he is. Near the end the entry is dropped instead (the clip counts as heard). */
function savePosition(): void {
  const it = state.item
  const a = el
  if (!it || !a || finished || pendingSeek !== null || fixing || state.failed) return
  lastSave = Date.now()
  const t = a.currentTime
  const dur = state.duration || (it.durationMs ?? 0) / 1000
  if (!(t > 1)) return
  if (dur > 0 && dur - t < NEAR_END_S) storePosition(it.mediaId, null)
  else storePosition(it.mediaId, t)
}

// ---- lock screen / audio route ---------------------------------------------------------------------------------------------
/** The lock-screen controls for the loaded clip; the audio route too only when `route` (a clip that is playing). */
function applySession(route: boolean): Promise<void> | undefined {
  const it = state.item
  if (!it) return undefined
  const p = getPlatform()
  sessionHeld = true
  let answer: Promise<void> | undefined
  if (route) {
    routeState = 'playing'
    const r = p.audioSession.set('playback') as Promise<void> | undefined
    if (r && typeof r.then === 'function') answer = r // the iPhone app answers; a browser returns nothing
  }
  p.mediaSession.set(
    { title: it.title, artist: 'Talos' },
    {
      play: () => resume(),
      pause: () => pause(),
      seekbackward: () => seekBy(-SEEK_STEP_S),
      seekforward: () => seekBy(SEEK_STEP_S),
      seekto: (t) => seek(t),
    },
  )
  pushPosition(route)
  return answer
}

/**
 * Tells the lock screen where the clip is and whether it is moving (audit D37). Called on the 5 s tick, on a seek, on pause
 * and play, on a speed change and when the length becomes known. `playing` overrides the stored flag for the instant before
 * the element's own event lands; a clip that is wanted but not moving yet (`buffering`) reads as stopped, so the clock does not run
 * ahead of the sound. Does nothing without a held session: a tick that fires after `stop()` cannot revive it.
 */
function pushPosition(playing: boolean = state.playing): void {
  const it = state.item
  if (!it || !sessionHeld) return
  const a = el
  const dur = state.duration || (it.durationMs ?? 0) / 1000
  const cur = pendingSeek ?? (a && a.readyState > 0 && Number.isFinite(a.currentTime) ? a.currentTime : state.cur)
  getPlatform().mediaSession.position?.({
    duration: dur,
    position: cur,
    rate: playing && !state.buffering ? state.speed : 0,
  })
}

/**
 * A pause. With a clip still loaded the route stays held but quiet ('paused': not mixing, so iOS keeps Talos as the Now Playing
 * app and the lock screen's Play and scrubber stay live). `handOver` gives it back instead ('auto': music resumes), for a
 * Drive, which is about to own the route itself; so does a pause with nothing loaded. A pause the SYSTEM caused (`bySystem`) changes
 * only what we remember: no call while iOS has the route; a later Play sends 'playback' again, a stop or hand-over still gives it back.
 */
function releaseRoute(handOver = false, bySystem = false): void {
  if (routeState === 'none') return
  if (handOver || !state.item) {
    routeState = 'none'
    getPlatform().audioSession.set('auto')
  } else if (routeState === 'playing') {
    routeState = 'paused'
    if (!bySystem) getPlatform().audioSession.set('paused')
  }
}

function releaseSession(): void {
  routeState = 'none'
  if (!sessionHeld) return
  sessionHeld = false
  const p = getPlatform()
  p.mediaSession.clear()
  p.audioSession.set('auto')
}

/** Whether the system can show and drive playback controls for a clip (lock screen, Control Center, media keys): a capability of this device. */
export function mediaControlsAvailable(): boolean {
  try {
    return getPlatform().mediaSession.controls?.() === true
  } catch {
    return false
  }
}

/** True while a loaded clip has live system controls, so he can stop it without the screen it started on. */
export const controlsActive = (): boolean => sessionHeld && mediaControlsAvailable()

/**
 * Drive takes the audio route for itself and gives it back with `mediaSession.clear()` / `'auto'`. If a clip is
 * still loaded, put its session back so those exits cannot wipe the lock-screen controls of a live clip.
 */
export function reclaimSession(): void {
  if (state.item) applySession(state.playing)
}

// ---- transport -----------------------------------------------------------------------------------------------------------
// ---- a start that does not move ----------------------------------------------------------------------------------------
// WebKit (Safari and the iPhone shell) can start a clip, take a pause in the first instants and then start again, and sit
// there: not paused, enough data, the position stuck at the start, for good. Only a fresh pause and play gets it going (found
// with Playwright's WebKit: play, pause, play again stalled about one run in five). It can also answer play() with nothing at
// all (no event, a promise that never settles) while its media session counts as interrupted. So a start the owner asked for
// (`wanted`) that has not moved after a moment is helped, within MAX_NUDGES tries: a pause and play, and last the source loaded
// again at the same spot with the audio route taken anew. Then it stops, and the row says so. The watch never helps a clip the
// system paused (a call), and never after the page was suspended: it only completes what a tap asked for.
export const STALL_MS = 1500
const MAX_NUDGES = 2
/** A watch tick this much later than it was due means the page was suspended (a locked phone): what it saw before is no longer true. */
const SUSPENDED_MS = 10_000
/** Less than this much movement in STALL_MS is not playing. */
const MOVED_S = 0.1
let stallTimer: ReturnType<typeof setTimeout> | null = null
/** When the watch was armed; kept across a re-arm of a watch that is overdue, so a suspension is not forgotten by an event on waking. */
let watchArmedAt = 0
let nudges = 0
/** Our own restart is about to cause exactly one 'pause' event: that one is not a stop. */
let nudgePausePending = false
/** We asked the element to pause: its next 'pause' event is ours, not an interruption by the system. */
let askedPause = false
/**
 * The owner wants the clip to play: set by `startPlayback`; cleared by a pause, `stop`, a real pause event (the element is
 * paused and it is not our own), the end, a refusal, an error and the give-up. The element and the store follow it, not the other
 * way round: a stale event cannot unset it.
 */
let wanted = false
/** Bumped by every start, open and stop: a refusal from an older start (its promise settles late) does nothing. */
let startGen = 0
let waitTimer: ReturnType<typeof setTimeout> | null = null
/** A start the page slept through ended with the line: until the next start, open or stop, an element that starts by itself is stopped. */
let endedBySleep = false

function clearStallTimer(): void {
  if (stallTimer) clearTimeout(stallTimer)
  stallTimer = null
}

/** Both timers (the stall restart and the slow-wait trace), and a start still waiting for the route. */
function disarmStallWatch(): void {
  cancelRouteWait()
  clearStallTimer()
  if (waitTimer) clearTimeout(waitTimer)
  waitTimer = null
}

/** Records one audio trace (codes and numbers; see problems/audioTrace.ts): the element's state and the loaded clip's type and size. */
function trace(code: AudioTraceCode, extra: Pick<AudioTraceInput, 'detail' | 'mediaError'> = {}): void {
  const order = ORDER_CODES.has(code) ? { order: orderNow() } : {}
  recordAudioTrace(playerTrace({ code, ...extra, restarts: nudges, ...order }, el, state.item))
}

/** `stalled` or `waiting` is normal for a moment; one that outlasts STALL_TRACE_MS while the clip should be playing is recorded. */
function armWaitTrace(event: 'stalled' | 'waiting'): void {
  if (waitTimer) clearTimeout(waitTimer)
  waitTimer = null
  if (!state.item || !state.playing) return
  const at = el?.currentTime ?? 0
  waitTimer = setTimeout(() => {
    waitTimer = null
    const b = el
    if (!b || !state.item || !state.playing || b.paused) return
    if (b.readyState >= 3 && Math.abs(b.currentTime - at) > MOVED_S) return
    trace('stalled-long', { detail: event })
  }, STALL_TRACE_MS)
}

/** A watch whose tick should have come long ago: the page was suspended. */
const watchOverdue = (): boolean => stallTimer !== null && Date.now() - watchArmedAt > SUSPENDED_MS

/** `fresh`: a tap starts its own clock, whatever the old watch was owed. */
function armStallWatch(fresh = false): void {
  const overdue = !fresh && watchOverdue()
  clearStallTimer()
  const a = el
  if (!a || !state.item || !wanted) return
  const at = a.currentTime
  if (!overdue) watchArmedAt = Date.now()
  const armedAt = watchArmedAt
  stallTimer = setTimeout(() => {
    stallTimer = null
    const b = el
    if (!b || !state.item || !wanted) return
    // The page was suspended since the watch was armed (a locked phone, a call): the element has moved on without us. Whatever the
    // element does by itself now is not what the owner asked for a moment ago, so a clip that is not moving is stopped (a start still
    // pending ends in the line, and its play() is aborted so it cannot come alive late). One that has moved is playing: left alone.
    if (Date.now() - armedAt > SUSPENDED_MS && (b.paused || Math.abs(b.currentTime - at) <= MOVED_S))
      return endAfterSuspension(b)
    // A start still waiting for the route (cap and answer both late: a page whose timers were held back) has not called play(): let it through.
    const rw = pendingWait(startGen)
    if (rw) {
      endRouteWait(rw, 'watch')
      if (rw.rearm || !wanted) return // it re-armed the watch; a joining tap's wait does not own it: judge the try as usual
    }
    // Waiting for the file, a jump or the fix to land is slow, not stuck: say so, and look again later.
    if (fixing || b.seeking || pendingSeek !== null || (!b.paused && b.readyState < 3)) {
      if (!state.buffering) {
        set({ buffering: true })
        pushPosition(false)
      }
      return armStallWatch()
    }
    // The system paused the element and its 'pause' event has not come yet (a call): that is a stop, not a start to help along.
    if (b.paused && state.playing && nudges === 0) return pausedBySystem()
    if (!b.paused && Math.abs(b.currentTime - at) > MOVED_S) {
      // moving (a stuck clip creeps by microseconds)
      if (state.buffering) set({ buffering: false })
      return pushPosition()
    }
    if (nudges >= MAX_NUDGES) {
      // Nothing helped: stop here and say so, so the screen matches the element (Play is there to try again).
      wanted = false
      nudgePausePending = false
      trace('give-up', { detail: b.paused ? 'silent' : 'frozen' })
      pauseElement(b)
      set({ playing: false, refused: true, buffering: false })
      pushPosition(false)
      releaseRoute()
      nudges = 0 // a new tap on Play gets its own tries
      return
    }
    nudges++
    set({ buffering: true }) // being helped: not playing yet, so the clock stands still
    pushPosition(false)
    if (nudges < MAX_NUDGES) {
      trace('restart')
      nudgePausePending = !b.paused
      pauseElement(b)
    } else reloadSource(b)
    startPlayback(undefined, true)
  }, STALL_MS)
}

/** A start that the page slept through, with nothing moving: nobody asked for what the element does now. It is stopped (with the refused line when it was still pending), and so is a wait for the route. */
function endAfterSuspension(a: HTMLAudioElement): void {
  const pending = !state.playing || state.buffering
  clearStallTimer()
  cancelRouteWait()
  if (!a.paused || pending) pauseElement(a)
  pausedBySystem()
  if (pending) {
    set({ refused: true })
    endedBySleep = true // a play() the page swallowed may still come alive: that is stopped too, until the next start
  }
}

/** The element is paused and the store still says playing: the same as a real 'pause' event, which will come (or has been lost). */
function pausedBySystem(): void {
  trace('interrupted', { detail: 'tick' })
  wanted = false
  savePosition()
  set({ playing: false, buffering: false })
  pushPosition(false)
  releaseRoute(false, true)
}

function pauseElement(a: HTMLAudioElement): void {
  try {
    askedPause = true
    a.pause()
  } catch {
    /* ignore */
  }
}

/**
 * The last try: the source again at the same spot (as `rowSrcChanged` does). The audio route is given back and taken anew, but
 * only on a page that can be seen: a hidden page cannot take it back, so it keeps what it has. `takeRoute` false (a clip that is
 * not wanted playing) leaves the route as it is.
 */
function reloadSource(a: HTMLAudioElement, detail?: string, takeRoute = true): void {
  trace('reload', detail ? { detail } : {})
  const at = Number.isFinite(a.currentTime) ? a.currentTime : state.cur
  nudgePausePending = !a.paused
  pauseElement(a)
  pendingSeek = at > 0 ? at : null
  if (takeRoute && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
    getPlatform().audioSession.set('auto')
    routeState = 'none'
  }
  a.src = state.src
  try {
    a.load?.()
  } catch {
    /* jsdom */
  }
  applySpeed() // a load can start the element over at 1x: put the speed back before play()
}

function startPlayback(onRefused?: () => void, recovery = false): void {
  const a = audio()
  // A tap while an earlier start is still waiting for the route joins it: one route call, one play(), the timer goes on.
  const waiting = wanted && !recovery ? pendingWait(startGen, SUSPENDED_MS) : null
  if (waiting) {
    waiting.at = Date.now() // the owner tapped just now
    waiting.onRefused = onRefused ?? waiting.onRefused
    return
  }
  cancelRouteWait() // an older wait (a source change, a restart) is replaced by this start
  endedBySleep = false
  // A tap while an earlier one is still being tried joins it: its tries and timer go on, so tapping again and again cannot keep a
  // start from ending in sound or in the line. The tap still calls play().
  const joins = !recovery && wanted && stallTimer !== null && !state.playing && !watchOverdue()
  const gen = ++startGen
  if (!recovery && !joins) {
    nudges = 0 // a tap's own tries
    if (state.refused) set({ refused: false })
  }
  const tapAt = Date.now()
  markRoute(tapAt)
  const answered = applySession(true)
  lastSave = Date.now()
  wanted = true
  if (!joins) armStallWatch(!recovery)
  if (!answered) {
    playNow(a, gen, onRefused) // a browser: inside the tap
    return
  }
  beginRouteWait(
    { gen, at: tapAt, rearm: !joins, still: a.paused, pos: a.currentTime, onRefused },
    answered,
    () => gen === startGen,
    endRouteWait,
  )
}

/** The wait ends once (the shell's answer, the cap, or the watch's tick on a page whose timers are held back); play() follows unless the start was cancelled. */
function endRouteWait(rw: RouteWait, how: 'answer' | 'cap' | 'watch'): void {
  if (!finishRouteWait(rw) || rw.gen !== startGen || !wanted || !state.item) return // already over, or cancelled meanwhile
  const a = audio()
  // Slept through (nobody tapped a moment ago), unless the element has moved since: that one is playing.
  if (Date.now() - rw.at > SUSPENDED_MS && (a.paused || Math.abs(a.currentTime - rw.pos) <= MOVED_S)) {
    endAfterSuspension(a)
    return
  }
  markCapped(how !== 'answer')
  playNow(a, rw.gen, rw.onRefused)
  if (rw.rearm) armStallWatch(true) // the watch counts from play(), not from the tap (a tap that renewed the wait is a fresh one)
}

/** Calls play() for the start `gen`: a refusal is told, an older start's answer is ignored. */
function playNow(a: HTMLAudioElement, gen: number, onRefused?: () => void): void {
  markPlayed()
  let p: Promise<void> | undefined
  try {
    p = a.play()
  } catch (e) {
    refuse((e as { name?: string } | null)?.name ?? 'threw')
    return
  }
  p?.catch((e: unknown) => {
    const name = (e as { name?: string } | null)?.name
    if (gen !== startGen) return // a newer start, a load or a stop came since: this answer is old
    if (name === 'AbortError') return // the browser aborted it (a pause, a load): the watch sees to the rest
    refuse(name ?? 'unknown')
    // A file this client cannot decode is a load failure: the row's rehydrate line says it (the element's own 'error' may not have come).
    if (name === 'NotSupportedError') onError()
    // Safari and the Home Screen app refuse play() that did not start from a tap: whoever asked for it can say so in words.
    if (name === 'NotAllowedError') onRefused?.()
  })
}

/** play() failed outright: never silent, the row shows the refusal, and the route is not held for a clip that is not playing. */
function refuse(name: string): void {
  wanted = false
  disarmStallWatch()
  trace('play-rejected', { detail: name })
  // A load failure the element already told (its error event came first, with no row to say it) keeps the line it set.
  set({ playing: false, refused: name !== 'NotSupportedError' || (state.failed && state.refused), buffering: false })
  pushPosition(false)
  releaseRoute()
}

/**
 * Loads a clip into the player (and plays it). `rest` is the queue that follows it, captured now. A clip already loaded is
 * not reloaded, so tapping a row's play on what is already loaded just continues it.
 */
export function open(
  item: AudioItem,
  src: string,
  rest: AudioItem[] = [],
  opts: { play: boolean; at?: number; onRefused?: () => void } = { play: true },
): void {
  const a = audio()
  getAudioState()
  const cur = state.item
  queue = [...rest]
  if (cur && cur.key === item.key && state.src === src && !state.failed) {
    if (opts.at !== undefined) seek(opts.at)
    if (opts.play) startPlayback(opts.onRefused)
    return
  }
  if (cur) savePosition() // flush the clip he is leaving
  resetDecodeRetry()
  disarmStallWatch()
  endedBySleep = false
  startGen++
  nudges = 0
  nudgePausePending = false
  wanted = false
  finished = false
  const at =
    opts.at ??
    (cur && cur.key === item.key && state.failed ? state.cur : resumeAt(item.mediaId, (item.durationMs ?? 0) / 1000))
  pendingSeek = at > 0 ? at : null
  fixing = false
  fixResume = false
  set({ item, src, playing: false, cur: at, duration: 0, failed: false, refused: false, buffering: false })
  a.src = src
  applySpeed()
  try {
    a.load?.()
  } catch {
    /* jsdom */
  }
  if (opts.play) startPlayback(opts.onRefused)
  else if (state.item) applySession(false)
}

export function resume(): void {
  if (!state.item) return
  if (state.failed) {
    rows.get(state.item.key)?.().onError() // the row says so (the rehydrate line); a row that mounts later hears it too
    return
  }
  startPlayback()
}

/**
 * Counts every request to pause, even one with nothing loaded. Drive asks the player to step aside
 * as it starts, so a caller that began waiting earlier can tell the route was taken from under it (see speak.ts).
 */
let pauseRequests = 0
export const pauseRequestCount = (): number => pauseRequests

/** Pauses the clip. `handOver`: the caller (Drive) takes the audio route next, so it is given back, not held. */
export function pause(opts: { handOver?: boolean } = {}): void {
  pauseRequests++
  const a = el
  if (!a || !state.item) return
  wanted = false
  fixResume = false // a pause during the unsized-WebM fix is not undone when the fix lands
  disarmStallWatch()
  nudgePausePending = false // this pause is a real one, even right after a restart
  const still = a.paused // already paused (a restart's wait): no pause event will come to say so
  pauseElement(a)
  if (state.buffering || (still && state.playing)) set({ buffering: false, ...(still ? { playing: false } : {}) })
  savePosition()
  pushPosition(false)
  // The element's own 'pause' event comes later; Drive starting right now must not wait for it.
  releaseRoute(opts.handOver === true)
}

export function toggle(): void {
  if (state.playing) pause()
  else resume()
}

export function seek(t: number): void {
  const a = el
  const it = state.item
  if (!a || !it) return
  const dur = state.duration || (it.durationMs ?? 0) / 1000
  if (!dur) return
  const next = Math.max(0, Math.min(dur, t))
  if (!(next > 1)) storePosition(it.mediaId, null) // back at the top: the old spot is no longer where he is
  if (pendingSeek !== null || a.readyState === 0) pendingSeek = next
  else {
    try {
      a.currentTime = next
    } catch {
      /* ignore */
    }
  }
  set({ cur: next })
  armStallWatch() // the jump is not movement: look again from here
  pushPosition()
}

/**
 * A seek on a row whose clip is not the one loaded: it moves that row's saved spot and leaves the playing clip alone
 * (taking over the player would stop the report he is listening to).
 */
export function seekSaved(mediaId: string, t: number): void {
  storePosition(mediaId, t > 1 ? t : null)
}

export function seekBy(delta: number): void {
  const a = el
  // The lock screen can ask between two timeupdate events: read the element, not the last stored value.
  const now = pendingSeek ?? (a && a.readyState > 0 && Number.isFinite(a.currentTime) ? a.currentTime : state.cur)
  seek(now + delta)
}

export function setSpeed(s: Speed): void {
  saveSpeed(s)
  getAudioState()
  set({ speed: s })
  audio()
  applySpeed()
  pushPosition()
}

/** Unloads the clip, clears the lock-screen controls and gives the audio route back. */
export function stop(): void {
  const a = el
  wanted = false
  endedBySleep = false
  startGen++
  if (a && state.item) {
    savePosition()
    pauseElement(a)
  }
  disarmStallWatch()
  resetDecodeRetry()
  nudges = 0
  nudgePausePending = false
  finished = false
  queue = []
  pendingSeek = null
  fixing = false
  fixResume = false
  // State first: the element's own events for the removed source (pause, emptied) must find nothing loaded.
  set({ item: null, src: '', playing: false, cur: 0, duration: 0, failed: false, refused: false, buffering: false })
  if (a) {
    a.removeAttribute('src')
    try {
      a.load?.()
    } catch {
      /* jsdom */
    }
  }
  releaseSession()
}

/** Sign-out: stop at once and forget what was listened to. */
export function resetForSignOut(): void {
  stop()
  clearSavedPositions()
}

// ---- rows ----------------------------------------------------------------------------------------------------------------
/**
 * A mounted row registers its current `useMediaSrc` result. A load error on the player then reaches that row's `onError`
 * (the #110 rehydrate), and a source that changes (the Mac sent the file back) reloads the player at the same spot. A row that
 * mounts onto a clip that already failed hears the error at once, so coming back to the thread starts the rehydrate.
 */
export function registerRow(key: string, get: () => RowHandle): () => void {
  rows.set(key, get)
  if (state.item?.key === key && state.failed) {
    if (state.refused) set({ refused: false }) // the row's own line takes over
    get().onError()
  }
  return () => {
    if (rows.get(key) === get) rows.delete(key)
  }
}

export function rowSrcChanged(key: string, src: string): void {
  const it = state.item
  const a = el
  if (!it || !a || it.key !== key || (state.src === src && !state.failed)) return
  const was = state.failed
  startGen++
  const at = pendingSeek ?? (Number.isFinite(a.currentTime) ? a.currentTime : 0)
  pendingSeek = at > 0 ? at : null
  fixing = false
  fixResume = false
  // The load starts the element over (paused, nothing playing): the store says so too, or a play() that then does nothing would
  // read as a system pause.
  set({ src, failed: false, cur: at, playing: false })
  a.src = src
  applySpeed()
  try {
    a.load?.()
  } catch {
    /* jsdom */
  }
  if (was || (wanted && !watchOverdue())) startPlayback() // a start that slept is ended by the overdue tick, not begun again
}

/**
 * True while the owner wants sound: from a tap (or the system starting the element) until a pause, stop, refusal, error, end or
 * give-up, so a start still being tried counts and a pause counts at once. Whatever else makes sound (a video, read aloud) asks
 * this, not `state.playing`, so it cannot start over a start that is about to be heard.
 */
function active(): boolean {
  return wanted
}

/** What the rest of the app calls (and a test hook). */
export const audioPlayer = {
  open,
  resume,
  pause,
  pauseRequestCount,
  toggle,
  seek,
  seekSaved,
  seekBy,
  setSpeed,
  stop,
  active,
  resetForSignOut,
  reclaimSession,
  registerRow,
  rowSrcChanged,
  ensure: ensureAudio,
  element: audioElement,
  state: getAudioState,
}

/** Test only: back to an empty player with no element. */
export function __resetAudioForTests(): void {
  stop()
  if (el) {
    el.remove()
    el = null
  }
  __resetPositionsForTests()
  rows.clear()
  speedLoaded = false
  routeState = 'none'
  sessionHeld = false
  fixResume = false
  wanted = false
  endedBySleep = false
  markRoute(null)
  state = { ...state, speed: 1, rev: 0 }
}
