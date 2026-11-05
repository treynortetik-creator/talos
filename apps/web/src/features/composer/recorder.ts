// MediaRecorder wrapper for voice notes (8.3): first supported of webm/opus, mp4/aac, mp4; 64 peaks via AnalyserNode.
import { audioDock } from '../threads/audioDock.ts'

export const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'] as const
export const MAX_RECORD_MS = 10 * 60 * 1000

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  return RECORDER_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null
}

export const extFor = (mime: string) => (mime.includes('mp4') ? 'm4a' : 'webm')

/** Reduces amplitude samples to exactly 64 bytes (0-255), base64. */
export function compressPeaks(samples: number[]): string {
  const out = new Uint8Array(64)
  if (samples.length > 0) {
    for (let i = 0; i < 64; i++) {
      const from = Math.floor((i * samples.length) / 64)
      const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / 64))
      let peak = 0
      for (let j = from; j < to && j < samples.length; j++) peak = Math.max(peak, samples[j] as number)
      out[i] = Math.min(255, Math.round(peak * 255))
    }
  }
  let bin = ''
  for (const b of out) bin += String.fromCharCode(b)
  return btoa(bin)
}

export type Recording = {
  blob: Blob
  mime: string
  durationMs: number
  waveform: string
  /** The browser or the microphone ended the recording; the person did not tap stop. What was captured is all there is. */
  endedByItself: boolean
}

/** Shorter than this, or nothing captured: an accidental touch, not a recording. One rule for voice notes and dictation. */
export const MIN_RECORD_MS = 400
export const isStrayTap = (r: Pick<Recording, 'durationMs' | 'blob'>): boolean =>
  r.durationMs < MIN_RECORD_MS || r.blob.size === 0

export type RecorderHandle = {
  stop(): Promise<Recording>
  cancel(): void
  pause(): void
  resume(): void
  /** Blob of everything recorded so far (while paused) for the preview. */
  snapshot(): Promise<Blob>
  elapsedMs(): number
  /** True once the recorder has stopped without being asked to (the microphone went away, the browser cut it). */
  endedByItself(): boolean
}

/** `analyse: false` skips the AudioContext meter (driving mode: no Web Audio, WebKit 291892); the waveform is then flat. */
export async function startRecorder(
  onLevel?: (level: number) => void,
  opts: { analyse?: boolean } = {},
): Promise<RecorderHandle> {
  const mime = pickMime()
  if (!mime) throw new Error('unsupported')
  audioDock.pause({ handOver: true }) // recording takes the microphone and the audio route: a clip playing in the dock waits
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  const samples: number[] = []
  let ctx: AudioContext | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  if (Ctx && opts.analyse !== false) {
    ctx = new Ctx()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    timer = setInterval(() => {
      if (rec.state !== 'recording') return
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
      samples.push(peak)
      onLevel?.(peak)
    }, 80)
  }

  // Time comes from stamps, never from the recorder's state: a recorder that stopped by itself still has a true length.
  let liveSince: number | null = performance.now()
  let accumulated = 0
  let asked = false // stop() or cancel() was called
  let selfEnded = false
  const closeSegment = () => {
    if (liveSince === null) return
    accumulated += performance.now() - liveSince
    liveSince = null
  }
  rec.addEventListener('stop', () => {
    closeSegment()
    if (!asked) selfEnded = true
  })
  rec.start(250)

  const cleanup = () => {
    if (timer) clearInterval(timer)
    for (const t of stream.getTracks()) t.stop()
    void ctx?.close().catch(() => {})
  }
  const elapsedMs = () => accumulated + (liveSince === null ? 0 : performance.now() - liveSince)

  return {
    elapsedMs,
    endedByItself: () => selfEnded,
    pause() {
      if (rec.state !== 'recording') return
      closeSegment()
      rec.pause()
      rec.requestData()
    },
    resume() {
      if (rec.state !== 'paused') return
      liveSince = performance.now()
      rec.resume()
    },
    async snapshot() {
      if (rec.state === 'recording' || rec.state === 'paused') rec.requestData()
      await new Promise((r) => setTimeout(r, 50))
      return new Blob(chunks, { type: mime })
    },
    cancel() {
      asked = true
      try {
        rec.ondataavailable = null
        if (rec.state !== 'inactive') rec.stop()
      } finally {
        cleanup()
      }
    },
    stop() {
      asked = true
      return new Promise<Recording>((resolve, reject) => {
        rec.onstop = () => {
          cleanup()
          closeSegment() // the stamp of the stop itself, if the stop event has not run yet
          resolve({
            blob: new Blob(chunks, { type: mime }),
            mime,
            durationMs: accumulated,
            waveform: compressPeaks(samples),
            endedByItself: selfEnded,
          })
        }
        rec.onerror = () => {
          cleanup()
          reject(new Error('recorder failed'))
        }
        if (rec.state === 'inactive') rec.onstop?.(new Event('stop'))
        else rec.stop()
      })
    },
  }
}
