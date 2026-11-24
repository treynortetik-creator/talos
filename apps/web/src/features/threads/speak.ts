// Read aloud (the play button on an agent message). One tap asks the Mac to read that message with its own voice command and
// plays the audio in the shared message player (audioPlayer.ts), the same one the voice notes use. This module owns the part
// the player does not: the asking (a first request, then follow-ups while the Mac makes
// the audio), the plain-words failures and the "only the first N characters" note. It lives outside React, so a tap survives
// leaving the thread. If he has left by the time the audio is ready, it plays only where system controls (lock screen, Control
// Center, media keys) can stop it; otherwise it waits for the next Listen. Nothing here plays out loud without a tap that asked for it.
import { SPEAK_FEATURE, SPEAK_POLL_MS } from '@talos-app/protocol'
import { useSyncExternalStore } from 'react'
import { type TalosClient, TalosClientError } from '../../lib/client.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { audioPlayer, mediaControlsAvailable, screenOf, subscribeAudio } from './audioPlayer.ts'
import { mediaUrl } from './media.ts'

export type SpeakView = {
  /** 'loading' from the tap until the audio is ready; 'failed' keeps `message` on screen until the next tap. */
  status: 'idle' | 'loading' | 'failed'
  message?: string
  /** Shown while this message's audio exists: the cap cut the message ("Reading the first 4,000 of 9,300 characters."). */
  note?: string
  /** Why the audio is not playing although it is ready (the browser refused sound, or something else had the speaker). Cleared by the next tap. */
  hint?: string
}

export const speakKey = (messageId: string) => `speak:${messageId}`

/** How long past the Mac's own give-up time the app keeps asking before it says the Mac is taking too long. */
const SLACK_MS = 20_000
/** When the Mac does not say how long it may take (an older answer shape). */
const DEFAULT_WAIT_S = 150
/** A file the relay no longer holds is asked back from the Mac; this long without an answer is a failure. */
export const REHYDRATE_MS = 20_000
const IDLE: SpeakView = { status: 'idle' }
/** The words when the audio is made but nothing was started, because the owner moved on to something that needs the speaker. */
export const READY_HINT = 'The audio is ready. Tap Listen to hear it.'
export const REFUSED_HINT = 'Your browser blocked the sound. Tap Resume to hear it.'
/** The lock screen title. Fixed on purpose: message text (code, tokens, untrusted content) never goes there. */
export const NOW_PLAYING_TITLE = 'Message from Talos'

const views = new Map<string, SpeakView>()
const listeners = new Set<() => void>()
/** A running tap: bumping `gen` (cancel, reset, a newer tap) ends its loop at the next await. */
const runs = new Map<string, number>()
let epoch = 0

function setView(id: string, v: SpeakView): void {
  if (v.status === 'idle' && !v.note && !v.hint) views.delete(id)
  else views.set(id, v)
  for (const l of [...listeners]) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const speakView = (id: string): SpeakView => views.get(id) ?? IDLE
export function useSpeak(id: string): SpeakView {
  return useSyncExternalStore(subscribe, () => speakView(id))
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The words for a failed ask. Known codes get their own sentence; anything else shows what the app was told. */
export function speakErrorText(e: unknown): string {
  if (e instanceof TalosClientError) {
    if (e.code === 'mac_offline')
      return "Your Mac is offline or didn't answer, so the audio couldn't be made. Try again when it's back."
    if (e.code === 'rate_limited') return 'Too many requests just now. Wait a few seconds and tap again.'
    if (e.code === 'device_not_pinned') return 'Waiting for your Mac to confirm this device. Try again in a moment.'
    return e.message || "Couldn't ask your Mac to read this."
  }
  return "Couldn't ask your Mac to read this."
}

function countNote(chars?: number, total?: number, truncated?: boolean): string | undefined {
  if (!truncated || chars === undefined || total === undefined) return undefined
  return `Reading the first ${chars.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters. The rest is left out.`
}

/** What can be known before asking: this app version, the Mac being offline, a Mac whose Talos predates read aloud. */
function refusal(client: TalosClient): string | null {
  if (!client.speak) return "This version of the app can't read messages aloud."
  const p = client.store.getState().presence
  if (!p.bridge_online) return "Your Mac is offline, so it can't make the audio. Try again when it's back."
  if (p.features && p.features.length > 0 && !p.features.includes(SPEAK_FEATURE))
    return "Your Mac's Talos is too old to read messages aloud. Update it, then try again."
  return null
}

export function cancelSpeak(id: string): void {
  if (!runs.delete(id)) return
  const v = speakView(id)
  setView(id, v.note ? { status: 'idle', note: v.note } : IDLE)
}

/**
 * True when the speaker belongs to someone else by the time the audio is ready: Drive
 * asked the player to step aside since the tap, another clip is playing right now, or he has left the screen he tapped on and the
 * device has no system controls to stop it from (with them it plays on, as a clip does when he leaves the thread). The tap is not a licence to talk over any of that, minutes later and from
 * another screen.
 */
function speakerTaken(pausesAtTap: number, key: string, screenAtTap: string): boolean {
  if (audioPlayer.pauseRequestCount() !== pausesAtTap) return true
  // With system controls he can stop it from anywhere; without them a clip on a screen he left could not be stopped.
  if (currentScreen() !== screenAtTap && !mediaControlsAvailable()) return true
  const s = audioPlayer.state()
  return Boolean(s.item && s.item.key !== key && audioPlayer.active()) // a start still being tried counts as playing
}

/** The screen on show (a thread and its sub-pages count as one). No window (a unit test of the store) reads as one fixed screen. */
const currentScreen = (): string => (typeof location === 'undefined' ? '' : screenOf(location.pathname))

/** Sign-out: stop every ask in flight and forget every note. */
export function resetSpeak(): void {
  epoch++
  runs.clear()
  views.clear()
  for (const off of registered.values()) off()
  registered.clear()
  for (const l of [...listeners]) l()
}

// A player item for this message that fails to load gets one ask to the Mac for the file (the relay keeps media about a week).
const registered = new Map<string, () => void>()
let watching = false
function watchPlayer() {
  if (watching) return
  watching = true
  // A row handle for a message that is no longer loaded is dropped, so handles never pile up.
  subscribeAudio(() => {
    const st = audioPlayer.state()
    const cur = st.item?.key
    // Playing now: a "blocked" or "ready" hint for this message is out of date.
    if (st.playing && cur?.startsWith('speak:')) {
      const id = cur.slice('speak:'.length)
      const v = views.get(id)
      if (v?.hint)
        setView(id, {
          status: v.status,
          ...(v.message ? { message: v.message } : {}),
          ...(v.note ? { note: v.note } : {}),
        })
    }
    for (const [key, off] of registered)
      if (key !== cur) {
        off()
        registered.delete(key)
      }
  })
}

function keepFileReachable(client: TalosClient, key: string, mediaId: string, onFailed: (msg: string) => void): void {
  watchPlayer()
  registered.get(key)?.()
  let src = `${mediaUrl(mediaId)}?c=2`
  let asked = false
  /** The Mac sent the file back: an error after that is real. Before it, a repeat of the first error (a Play tap on the failed clip) is not. */
  let back = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const offReady = client.onFrame('media.ready', (f) => {
    if (f.media_id !== mediaId || !asked) return
    clearTimeout(timer)
    back = true
    src = `${mediaUrl(mediaId)}?c=2&r=1`
    audioPlayer.rowSrcChanged(key, src)
  })
  // Once the owner has been told it failed, a file that turns up later must not start playing by itself.
  const gaveUp = () => {
    offReady()
    onFailed("The audio couldn't be loaded. Tap to make it again.")
  }
  const unregister = audioPlayer.registerRow(key, () => ({
    src,
    onError: () => {
      if (asked) {
        if (!back) return // the wait for the Mac goes on
        clearTimeout(timer)
        gaveUp()
        return
      }
      asked = true
      if ('fetchMedia' in client) (client as SocketClient).fetchMedia(mediaId)
      timer = setTimeout(gaveUp, REHYDRATE_MS)
    },
  }))
  registered.set(key, () => {
    clearTimeout(timer)
    offReady()
    unregister()
  })
}

/**
 * The tap. Asks the Mac, follows its answers until 'ready' or 'failed', then hands the audio to the player. A second tap while
 * asking is `cancelSpeak`'s business, not this function's. No message text is sent anywhere or kept here (not even for the lock-screen title): the Mac reads its own copy.
 */
export function startSpeak(client: TalosClient, m: { id: string; thread_id: string }): void {
  if (runs.has(m.id)) return
  const pausesAtTap = audioPlayer.pauseRequestCount()
  const screenAtTap = currentScreen()
  const why = refusal(client)
  if (why) {
    setView(m.id, { status: 'failed', message: why })
    return
  }
  const speak = client.speak
  if (!speak) return
  const mine = ++epoch
  runs.set(m.id, mine)
  const live = () => runs.get(m.id) === mine
  const prior = speakView(m.id).note
  setView(m.id, { status: 'loading', ...(prior ? { note: prior } : {}) })
  void (async () => {
    let fresh = true
    let deadline = 0
    try {
      for (;;) {
        const a = await speak.request({ messageId: m.id, threadId: m.thread_id, fresh })
        if (!live()) return
        fresh = false
        if (a.state === 'failed') {
          runs.delete(m.id)
          setView(m.id, { status: 'failed', message: a.message })
          return
        }
        if (a.state === 'ready') {
          runs.delete(m.id)
          const key = speakKey(m.id)
          const note = countNote(a.chars, a.totalChars, a.truncated)
          const base: SpeakView = { status: 'idle', ...(note ? { note } : {}) }
          if (speakerTaken(pausesAtTap, key, screenAtTap)) {
            // Nothing is loaded and nothing plays: the Mac keeps the audio, so the next Listen is instant.
            setView(m.id, { ...base, hint: READY_HINT })
            return
          }
          keepFileReachable(client, key, a.media.media_id, (msg) => setView(m.id, { status: 'failed', message: msg }))
          setView(m.id, base)
          audioPlayer.open(
            { key, mediaId: a.media.media_id, title: NOW_PLAYING_TITLE, mime: a.media.mime, size: a.media.size },
            `${mediaUrl(a.media.media_id)}?c=2`,
            [],
            { play: true, onRefused: () => setView(m.id, { ...speakView(m.id), hint: REFUSED_HINT }) },
          )
          return
        }
        if (!deadline) deadline = Date.now() + (a.waitS ?? DEFAULT_WAIT_S) * 1000 + SLACK_MS
        if (Date.now() > deadline) {
          runs.delete(m.id)
          setView(m.id, {
            status: 'failed',
            message: 'Your Mac is taking too long to make the audio. Tap to try again.',
          })
          return
        }
        await sleep(SPEAK_POLL_MS)
        if (!live()) return
      }
    } catch (e) {
      if (!live()) return
      runs.delete(m.id)
      setView(m.id, { status: 'failed', message: speakErrorText(e) })
    }
  })()
}
