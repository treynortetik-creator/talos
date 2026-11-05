// Browser-only helpers for a call. Kept in the voice feature (not `lib/platform.ts`, which WP6 owns) and written so
// each one degrades to a no-op where the API is missing (older iOS, jsdom).
import type { AudioOut, CallDeps, VoiceMedia } from './types.ts'

export const browserMedia: VoiceMedia = {
  setPlayAndRecord() {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'play-and-record'
  },
  async keepAwake() {
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } })
      .wakeLock
    if (!wl) return () => {}
    // A request that never settles (some embedded browsers) must not hold the call up, so give up after a moment.
    let abandoned = false
    let release: () => void = () => {}
    const request = wl
      .request('screen')
      .then((lock) => {
        release = () => void lock.release().catch(() => {})
        if (abandoned) release()
      })
      .catch(() => {})
    await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 1500))])
    abandoned = true
    return () => release()
  },
  meter(stream, onLevel) {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
    if (!Ctx || stream.getAudioTracks().length === 0) return () => {}
    let ctx: AudioContext
    try {
      ctx = new Ctx()
    } catch {
      return () => {}
    }
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      onLevel(Math.min(1, peak / 64))
    }, 33)
    return () => {
      clearInterval(timer)
      void ctx.close().catch(() => {})
    }
  },
}

function browserAudio(): AudioOut {
  const el = document.createElement('audio')
  el.autoplay = true
  el.setAttribute('playsinline', '')
  el.hidden = true
  document.body.appendChild(el)
  return {
    get srcObject() {
      return el.srcObject as MediaStream | null
    },
    set srcObject(v) {
      el.srcObject = v
    },
    play: () => el.play(),
    remove: () => el.remove(),
  }
}

export function browserDeps(): CallDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createPeer: () => new RTCPeerConnection() as unknown as ReturnType<CallDeps['createPeer']>,
    createAudio: browserAudio,
    media: browserMedia,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    lifecycle: {
      isHidden: () => document.visibilityState === 'hidden',
      onHidden(listener) {
        const onVis = () => {
          if (document.visibilityState === 'hidden') listener()
        }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('pagehide', listener)
        return () => {
          document.removeEventListener('visibilitychange', onVis)
          window.removeEventListener('pagehide', listener)
        }
      },
      onVisible(listener) {
        const onVis = () => {
          if (document.visibilityState === 'visible') listener()
        }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('pageshow', onVis)
        return () => {
          document.removeEventListener('visibilitychange', onVis)
          window.removeEventListener('pageshow', onVis)
        }
      },
    },
  }
}
