// The app-level audio player (audit D37). One <audio> element lives in this module, not in a message row, so leaving a
// thread (or any route change) no longer stops a 12-minute report. A row is a view of this store: it asks the dock to
// play and reads back playing / position. The dock also owns the saved position, the lock-screen session and the queue of
// voice notes that follows the one playing (captured at play time, because the rows that knew about the next note are
// gone once he leaves the thread).
import { useSyncExternalStore } from 'react'
import { getPlatform } from '../../lib/platform.ts'
import { mediaUrl } from './media.ts'
import { loadSpeed, type Speed, saveSpeed } from './speed.ts'

export type DockItem = {
  /** The row key: a message id (voice notes) or `<message id>:<media id>` (audio files). */
  key: string
  mediaId: string
  title: string
  threadId?: string
  durationMs?: number
}

export type DockState = {
  item: DockItem | null
  src: string
  playing: boolean
  /** Seconds. */
  cur: number
  /** Seconds, 0 until the browser knows (Chrome's recorder WebM reports Infinity: the attachment's duration stands in). */
  duration: number
  /** The file would not load. The pill says so; a mounted row also hears it through `useMediaSrc.onError`. */
  failed: boolean
  speed: Speed
  /** Bumped when a saved position changes, so rows showing a saved position redraw. */
  rev: number
}

type RowHandle = { src: string; onError: () => void }

export const SAVE_EVERY_MS = 5000
export const MAX_SAVED = 50
/** A saved position this close to the end is not resumed: the clip is treated as heard. */
export const NEAR_END_S = 5
export const SEEK_STEP_S = 10
export const POSITIONS_KEY = 'talos.audio.pos'
export const DOCK_ELEMENT_ID = 'talos-audio-dock'

// ---- saved positions -----------------------------------------------------------------------------------------------------
// Per media_id, newest 50. A convenience only: every storage call is guarded, and an in-memory copy keeps working when
// storage is blocked (private window).
type Saved = { t: number; at: number }
let positions: Map<string, Saved> | null = null

function loadPositions(): Map<string, Saved> {
  if (positions) return positions
  const m = new Map<string, Saved>()
  try {
    const raw = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '[]') as unknown
    if (Array.isArray(raw))
      for (const e of raw) {
        if (Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && Number.isFinite(e[2]))
          m.set(e[0], { t: e[1], at: e[2] })
      }
  } catch {
    /* blocked storage or a damaged value: start empty */
  }
  positions = m
  return m
}

function persistPositions(m: Map<string, Saved>): void {
  if (m.size > MAX_SAVED) {
    const oldest = [...m.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, m.size - MAX_SAVED)
    for (const [id] of oldest) m.delete(id)
  }
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([...m.entries()].map(([id, v]) => [id, v.t, v.at])))
  } catch {
    /* private window or blocked storage */
  }
}

export function savedPosition(mediaId: string): number {
  return loadPositions().get(mediaId)?.t ?? 0
}

function storePosition(mediaId: string, t: number | null): void {
  const m = loadPositions()
  if (t === null) {
    if (!m.delete(mediaId)) return
  } else m.set(mediaId, { t, at: Date.now() })
  persistPositions(m)
  set({ rev: state.rev + 1 })
}

/** Sign-out (audit D21): the positions say what he listened to, so they go with the chats. */
export function clearSavedPositions(): void {
  positions = new Map()
  try {
    localStorage.removeItem(POSITIONS_KEY)
  } catch {
    /* ignore */
  }
  set({ rev: state.rev + 1 })
}

/** Where a clip starts: the saved spot, unless it is close to the end (then from the top). */
function resumeAt(mediaId: string, durationS: number): number {
  const t = savedPosition(mediaId)
  if (!(t > 0)) return 0
  if (durationS > 0 && durationS - t < NEAR_END_S) return 0
  return t
}

// ---- the store -----------------------------------------------------------------------------------------------------------
let state: DockState = {
  item: null,
  src: '',
  playing: false,
  cur: 0,
  duration: 0,
  failed: false,
  speed: 1,
  rev: 0,
}
const listeners = new Set<() => void>()
let speedLoaded = false

function set(patch: Partial<DockState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function getDockState(): DockState {
  if (!speedLoaded) {
    speedLoaded = true
    state = { ...state, speed: loadSpeed() }
  }
  return state
}
export function subscribeDock(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Selectors must return primitives or stable references (they run on every store change). */
export function useDock<T>(select: (s: DockState) => T): T {
  return useSyncExternalStore(subscribeDock, () => select(getDockState()))
}

// ---- the element ---------------------------------------------------------------------------------------------------------
let el: HTMLAudioElement | null = null
/** The queue after the current clip: captured when playback starts, so it works after the thread is gone. */
let queue: DockItem[] = []
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
  a.id = DOCK_ELEMENT_ID
  a.preload = 'metadata'
  a.hidden = true
  a.addEventListener('play', () => {
    set({ playing: true })
    pushPosition()
  })
  a.addEventListener('pause', () => {
    set({ playing: false })
    savePosition()
    pushPosition()
    if (!fixing) releaseRoute()
  })
  a.addEventListener('loadedmetadata', onMetadata)
  a.addEventListener('durationchange', () => {
    if (Number.isFinite(a.duration) && a.duration > 0 && state.item) {
      set({ duration: a.duration })
      pushPosition()
    }
  })
  a.addEventListener('timeupdate', onTime)
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
  el = a
  applySpeed()
  return a
}

/** The element itself, for the Playwright specs and unit tests. */
export const dockElement = (): HTMLAudioElement => audio()
/** Row mount: makes sure the element (and its speed) exists, without loading anything. */
export const ensureDock = (): void => void audio()

function applySpeed(): void {
  const a = el
  if (!a) return
  const s = getDockState().speed
  a.preservesPitch = true
  a.defaultPlaybackRate = s
  a.playbackRate = s
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
    fixResume = state.playing
    if (fixResume) {
      try {
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
    if (fixResume) {
      fixResume = false
      startPlayback()
    }
    return
  }
  if (pendingSeek !== null) return // the jump has not landed yet: the element still reads 0
  set({ cur: a.currentTime })
  if (Date.now() - lastSave >= SAVE_EVERY_MS) {
    savePosition()
    pushPosition() // the lock screen's clock follows the same 5 s tick as the saved spot
  }
}

function onError(): void {
  const it = state.item
  if (!it) return // a stop() cleared the source
  savePosition()
  set({ failed: true, playing: false })
  pushPosition(false) // no 'pause' event follows a failed load: the lock screen's clock must stop here
  // A mounted row owns the rehydrate (`useMediaSrc` asks the Mac and bumps the URL); a gone row leaves the pill's failed state.
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
function applySession(route: boolean): void {
  const it = state.item
  if (!it) return
  const p = getPlatform()
  sessionHeld = true
  if (route) {
    routeState = 'playing'
    p.audioSession.set('playback')
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
}

/**
 * Tells the lock screen where the clip is and whether it is moving (audit D37). Called on the 5 s tick, on a seek, on pause
 * and play, on a speed change and when the length becomes known. `playing` overrides the stored flag for the instant before
 * the element's own event lands. Does nothing without a held session: a tick that fires after `stop()` cannot revive it.
 */
function pushPosition(playing: boolean = state.playing): void {
  const it = state.item
  if (!it || !sessionHeld) return
  const a = el
  const dur = state.duration || (it.durationMs ?? 0) / 1000
  const cur = pendingSeek ?? (a && a.readyState > 0 && Number.isFinite(a.currentTime) ? a.currentTime : state.cur)
  getPlatform().mediaSession.position?.({ duration: dur, position: cur, rate: playing ? state.speed : 0 })
}

/**
 * A pause. With a clip still loaded the route stays held but quiet ('paused': not mixing, so iOS keeps Talos as the Now Playing
 * app and the lock screen's Play and scrubber stay live). `handOver` gives it back instead ('auto': music resumes), for a
 * recording, a call or Drive that is about to own the route itself; so does a pause with nothing loaded.
 */
function releaseRoute(handOver = false): void {
  if (routeState === 'none') return
  if (handOver || !state.item) {
    routeState = 'none'
    getPlatform().audioSession.set('auto')
  } else if (routeState === 'playing') {
    routeState = 'paused'
    getPlatform().audioSession.set('paused')
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

/**
 * Drive and a call take the audio route for themselves and give it back with `mediaSession.clear()` / `'auto'`. If a clip is
 * still loaded, put its session back so those exits cannot wipe the lock-screen controls of a live dock.
 */
export function reclaimSession(): void {
  if (state.item) applySession(state.playing)
}

// ---- transport -----------------------------------------------------------------------------------------------------------
function startPlayback(onRefused?: () => void): void {
  const a = audio()
  applySession(true)
  lastSave = Date.now()
  let p: Promise<void> | undefined
  try {
    p = a.play()
  } catch {
    set({ playing: false })
    pushPosition(false)
    return
  }
  p?.catch((e: unknown) => {
    const name = (e as { name?: string } | null)?.name
    if (name === 'AbortError') return // a newer load replaced this one
    set({ playing: false })
    pushPosition(false)
    // Safari and the Home Screen app refuse play() that did not start from a tap: whoever asked for it can say so in words.
    if (name === 'NotAllowedError') onRefused?.()
  })
}

/**
 * Loads a clip into the dock (and plays it). `rest` is the queue that follows it, captured now. A clip already loaded is
 * not reloaded, so tapping a row's play on what is already in the pill just continues it.
 */
export function open(
  item: DockItem,
  src: string,
  rest: DockItem[] = [],
  opts: { play: boolean; at?: number; onRefused?: () => void } = { play: true },
): void {
  const a = audio()
  getDockState()
  const cur = state.item
  queue = [...rest]
  if (cur && cur.key === item.key && state.src === src && !state.failed) {
    if (opts.at !== undefined) seek(opts.at)
    if (opts.play) startPlayback(opts.onRefused)
    return
  }
  if (cur) savePosition() // flush the clip he is leaving
  finished = false
  const at =
    opts.at ??
    (cur && cur.key === item.key && state.failed ? state.cur : resumeAt(item.mediaId, (item.durationMs ?? 0) / 1000))
  pendingSeek = at > 0 ? at : null
  fixing = false
  fixResume = false
  set({ item, src, playing: false, cur: at, duration: 0, failed: false })
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
  if (state.failed) return
  startPlayback()
}

/**
 * Counts every request to pause, even one with nothing loaded. A recording, a call and Drive each ask the dock to step aside
 * as they start, so a caller that began waiting earlier can tell the route was taken from under it (see speak.ts).
 */
let pauseRequests = 0
export const pauseRequestCount = (): number => pauseRequests

/** Pauses the clip. `handOver`: the caller (a recording, a call, Drive) takes the audio route next, so it is given back, not held. */
export function pause(opts: { handOver?: boolean } = {}): void {
  pauseRequests++
  const a = el
  if (!a || !state.item) return
  try {
    a.pause()
  } catch {
    /* ignore */
  }
  savePosition()
  pushPosition(false)
  // The element's own 'pause' event comes later; a recording or call that starts right now must not wait for it.
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
  pushPosition()
}

/**
 * A seek on a row whose clip is not the one loaded: it moves that row's saved spot and leaves the playing clip alone
 * (taking over the dock would stop the report he is listening to).
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
  getDockState()
  set({ speed: s })
  audio()
  applySpeed()
  pushPosition()
}

/** Unloads the clip, clears the lock-screen controls and gives the audio route back. */
export function stop(): void {
  const a = el
  if (a && state.item) {
    savePosition()
    try {
      a.pause()
    } catch {
      /* ignore */
    }
  }
  finished = false
  queue = []
  pendingSeek = null
  fixing = false
  fixResume = false
  // State first: the element's own events for the removed source (pause, emptied) must find nothing loaded.
  set({ item: null, src: '', playing: false, cur: 0, duration: 0, failed: false })
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
 * A mounted row registers its current `useMediaSrc` result. A load error on the dock then reaches that row's `onError`
 * (the #110 rehydrate), and a source that changes (the Mac sent the file back) reloads the dock at the same spot. A row that
 * mounts onto a clip that already failed hears the error at once, so coming back to the thread starts the rehydrate.
 */
export function registerRow(key: string, get: () => RowHandle): () => void {
  rows.set(key, get)
  if (state.item?.key === key && state.failed) get().onError()
  return () => {
    if (rows.get(key) === get) rows.delete(key)
  }
}

export function rowSrcChanged(key: string, src: string): void {
  const it = state.item
  const a = el
  if (!it || !a || it.key !== key || (state.src === src && !state.failed)) return
  const was = state.failed
  const at = pendingSeek ?? (Number.isFinite(a.currentTime) ? a.currentTime : 0)
  pendingSeek = at > 0 ? at : null
  fixing = false
  fixResume = false
  set({ src, failed: false, cur: at })
  a.src = src
  applySpeed()
  try {
    a.load?.()
  } catch {
    /* jsdom */
  }
  if (was || state.playing) startPlayback()
}

/** The pill's return target and a test hook. */
export const audioDock = {
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
  resetForSignOut,
  reclaimSession,
  registerRow,
  rowSrcChanged,
  ensure: ensureDock,
  element: dockElement,
  state: getDockState,
}

/** Test only: back to an empty dock with no element. */
export function __resetDockForTests(): void {
  stop()
  if (el) {
    el.remove()
    el = null
  }
  positions = null
  rows.clear()
  speedLoaded = false
  routeState = 'none'
  sessionHeld = false
  fixResume = false
  state = { ...state, speed: 1, rev: 0 }
}
