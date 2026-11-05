// One DriveController, one queue and one audio element per client, created on first use and kept for the life of the
// page, so replies keep playing when the owner leaves /drive for another screen.
import type { TalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { startRecorder } from '../composer/recorder.ts'
import { loadSpeed } from '../threads/speed.ts'
import { getCallController } from '../voice/controller.ts'
import { DriveController } from './controller.ts'
import {
  loadDriveThread,
  loadHeard,
  loadLocal,
  loadPhoneVoiceFallback,
  loadTouch,
  saveDriveThread,
  saveHeard,
  saveLocal,
  saveTouch,
} from './prefs.ts'
import { createVoiceQueue, type VoiceQueue } from './queue.ts'

export type Drive = { controller: DriveController; queue: VoiceQueue; audio: HTMLAudioElement }

const instances = new WeakMap<object, Drive>()

function createAudio(): HTMLAudioElement {
  const el = document.createElement('audio')
  el.setAttribute('data-testid', 'drive-audio')
  el.setAttribute('playsinline', '')
  el.preload = 'auto'
  el.hidden = true
  document.body.appendChild(el)
  return el
}

/** Roughly how long the phone voice takes to read `text` (about 16 characters a second, plus a start-up beat). */
export const speechEstimateMs = (text: string) => 300 + text.length * 60

/**
 * The phone voice, with a bound on how long it counts as "speaking": `speechSynthesis.speaking` can stay true on iOS
 * after the voice has stopped, and a clip must never wait on it for good. Speaking = the engine says so AND we are
 * still inside the estimated time of what we asked it to read.
 */
export function createSpeech() {
  let until = 0
  return {
    speak(text: string) {
      until = Math.max(until, Date.now()) + speechEstimateMs(text)
      void getPlatform().speech.speak(text)
    },
    cancel() {
      until = 0
      getPlatform().speech.cancel()
    },
    speaking(): boolean {
      if (Date.now() >= until) return false
      return getPlatform().speech.speaking?.() ?? true
    },
  }
}

export function getDrive(client: TalosClient): Drive {
  let d = instances.get(client)
  if (!d) {
    const audio = createAudio()
    const speech = createSpeech()
    // The queue's callbacks need the controller, which needs the queue: wire them through a late reference.
    let controller!: DriveController
    const queue = createVoiceQueue({
      audio,
      speed: loadSpeed,
      onStart: (i) => controller.onClipStart(i),
      onFail: (i, info) => controller.onClipFail(i, info),
      speaking: () => speech.speaking(),
      cancelSpeech: () => speech.cancel(),
    })
    controller = new DriveController({
      client,
      queue,
      speech: { speak: (t) => speech.speak(t), cancel: () => speech.cancel() },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      fallbackEnabled: loadPhoneVoiceFallback,
      loadThread: loadDriveThread,
      saveThread: saveDriveThread,
      recorder: () => startRecorder(undefined, { analyse: false }),
      persist: { loadHeard, saveHeard, loadTouch, saveTouch, loadLocal, saveLocal },
      audioSession: { set: (t) => getPlatform().audioSession.set(t) },
    })
    controller.watch()
    // A live call (Talk live, here or from a thread) holds every clip and stops the phone voice until it ends.
    const calls = getCallController().store
    controller.setOnCall(calls.getState().phase !== 'idle')
    calls.subscribe((s) => controller.setOnCall(s.phase !== 'idle'))
    d = { controller, queue, audio }
    instances.set(client, d)
  }
  return d
}
