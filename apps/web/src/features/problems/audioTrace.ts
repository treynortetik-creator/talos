// A compact trace of a failed or stalled audio start, recorded as an ordinary automatic Problem so it is queued, sent and shown
// where Problems already go. It holds codes and numbers only: the event, the element's readyState / networkState / paused /
// rounded position / speed, the kind of screen (thread, card or other), the file's MIME type and a size bucket, the platform and
// WebKit or browser version from the user agent, native or web, the restart count and (for a pause nobody asked for, a restart and
// a give-up) the order of the audio-route call and play() as three ages in ms. Never a file name, URL, message text,
// thread name or id: the caller does not pass one in, and `scrubProblem` is run over the result as for every report.
import { newUlid, PROBLEM_LIMITS, type ProblemT, problemFingerprint, scrubProblem } from '@talos-app/protocol'
import { isNativeShell } from '../../lib/native.ts'
import { problems } from './controller.ts'

export type AudioTraceCode =
  | 'play-rejected' // play() refused (the error name says why)
  | 'restart' // the stall self-heal paused and played again
  | 'reload' // its last try: the source loaded again at the same spot
  | 'give-up' // it did not help: the clip was stopped
  | 'media-error' // the element's own `error` (the MediaError code)
  | 'stalled-long' // `stalled` or `waiting` that did not end within STALL_TRACE_MS
  | 'interrupted' // a pause nobody asked for (a call, Siri, another app took the route)
  | 'session-interrupted' // the page's audio session reported `interrupted`

/** The codes that carry the `order` field: the rows a report reads to see whether play() came before or after the route answer. */
export const ORDER_CODES: ReadonlySet<AudioTraceCode> = new Set<AudioTraceCode>(['interrupted', 'give-up', 'restart'])
/** An age above this is clamped: a start this old says nothing about the order, and the line stays short for the scrubber. */
export const ORDER_MAX_MS = 999_999

export const STALL_TRACE_MS = 8000
export const TRACE_PER_CODE_MS = 60_000
export const TRACE_PER_MINUTE = 5

/**
 * Ages in ms since the last start asked the native shell for the audio route (`r`), since the shell answered it (`a`: `'cap'` when
 * play() was let through by the wait's cap and no answer had come yet; absent when there is no native answer or it has not come),
 * and since play() was called (`p`; absent while it has not been).
 */
export type AudioOrder = { r?: number; a?: number | 'cap'; p?: number }

/** What the player knows when it records. Numbers, codes and a MIME type: nothing the owner wrote or named. */
export type AudioTraceInput = {
  code: AudioTraceCode
  /** The DOMException name of a rejected play(), a `waiting`/`stalled` event name, or a session state. */
  detail?: string
  /** `MediaError.code` (1 to 4). */
  mediaError?: number
  readyState?: number
  networkState?: number
  paused?: boolean
  currentTime?: number
  playbackRate?: number
  restarts?: number
  /** Only for `ORDER_CODES`. */
  order?: AudioOrder
  mime?: string
  size?: number
  /** `location.pathname`: only its KIND is kept. */
  pathname?: string
}

const SAFE_WORD = /^[A-Za-z][A-Za-z0-9-]{0,39}$/
const SAFE_MIME = /^(audio|video|application)\/[a-z0-9][a-z0-9.+-]{0,40}$/

export function sizeBucket(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 100 * 1024) return 'lt100k'
  if (bytes < 1024 * 1024) return '100k-1m'
  if (bytes < 10 * 1024 * 1024) return '1m-10m'
  return 'gt10m'
}

/** thread, card or other: the first path segment only, never the id after it. */
export function screenKind(pathname: string | undefined): 'thread' | 'card' | 'other' {
  const seg = (pathname ?? '').split('/').filter(Boolean)[0]
  return seg === 't' ? 'thread' : seg === 'card' ? 'card' : 'other'
}

/** `ios17.5 webkit605`, `android14 chrome126`, `mac safari605`: the platform and engine versions, nothing else of the UA. */
export function platformOf(ua: string | undefined): string {
  const u = ua ?? ''
  const ios = /\bOS (\d+)[_.](\d+)/.exec(u)
  const platform = /iPhone|iPad|iPod/.test(u)
    ? `ios${ios ? `${ios[1]}.${ios[2]}` : ''}`
    : /Android (\d+)/.exec(u)
      ? `android${/Android (\d+)/.exec(u)?.[1]}`
      : /Mac OS X/.test(u)
        ? 'mac'
        : /Windows/.test(u)
          ? 'windows'
          : /Linux/.test(u)
            ? 'linux'
            : 'other'
  const engine = /Firefox\/(\d+)/.exec(u)
    ? `firefox${/Firefox\/(\d+)/.exec(u)?.[1]}`
    : /(?:Chrome|CriOS|Edg)\/(\d+)/.exec(u)
      ? `chrome${/(?:Chrome|CriOS|Edg)\/(\d+)/.exec(u)?.[1]}`
      : /AppleWebKit\/(\d+)/.exec(u)
        ? `webkit${/AppleWebKit\/(\d+)/.exec(u)?.[1]}`
        : 'unknown'
  return `${platform} ${engine}`
}

/** The input for one trace from what the player holds: the element's state, the loaded clip's type and size, and the page's place. */
export function playerTrace(
  i: AudioTraceInput,
  a: HTMLAudioElement | null,
  it: { mime?: string; size?: number } | null | undefined,
): AudioTraceInput {
  return {
    ...i,
    ...(a
      ? {
          readyState: a.readyState,
          networkState: a.networkState,
          paused: a.paused,
          currentTime: a.currentTime,
          playbackRate: a.playbackRate,
        }
      : {}),
    ...(it?.mime ? { mime: it.mime } : {}),
    ...(it?.size !== undefined ? { size: it.size } : {}),
    ...(typeof location !== 'undefined' ? { pathname: location.pathname } : {}),
  }
}

const n = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? '?' : String(Math.round(v)))

/** `none` for anything that is not a finite number: the field can carry numbers, `cap` and `none` and nothing else. */
const age = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(Math.min(ORDER_MAX_MS, Math.max(0, Math.round(v)))) : 'none'

/** `r-812/a-640/p-640`: ms since the route call, since its answer (or `cap` / `none`), since play() (or `none`). */
function orderField(o: AudioOrder): string {
  return `order=r-${age(o.r)}/a-${o.a === 'cap' ? 'cap' : age(o.a)}/p-${age(o.p)}`
}

/** The one-line body: `key=value` pairs, in a fixed order, well under the message cap. */
export function traceMessage(i: AudioTraceInput, ua: string | undefined, native: boolean): string {
  const detail = i.detail && SAFE_WORD.test(i.detail) ? i.detail : i.detail ? 'other' : '-'
  const mime = i.mime && SAFE_MIME.test(i.mime.toLowerCase()) ? i.mime.toLowerCase() : i.mime ? 'other' : '-'
  const parts = [
    `ev=${i.code}`,
    `detail=${detail}`,
    `merr=${i.mediaError ?? '-'}`,
    `rs=${n(i.readyState)}`,
    `ns=${n(i.networkState)}`,
    `paused=${i.paused === undefined ? '?' : i.paused ? 1 : 0}`,
    `t=${n(i.currentTime)}`,
    `rate=${i.playbackRate === undefined || !Number.isFinite(i.playbackRate) ? '?' : Math.round(i.playbackRate * 100) / 100}`,
    `restarts=${i.restarts ?? 0}`,
    ...(i.order ? [orderField(i.order)] : []),
    `screen=${screenKind(i.pathname)}`,
    `mime=${mime}`,
    `size=${sizeBucket(i.size)}`,
    `plat=${platformOf(ua).replace(/ /, '/')}`,
    `shell=${native ? 'native' : 'web'}`,
  ]
  return parts.join(' ')
}

export type TraceEnv = Pick<ProblemT, 'versions' | 'device' | 'routes'> & { now: () => number }

/** The Problem for one trace: named by its event, `frames` empty (there is no stack), the routes Problems already keeps. */
export function buildAudioTrace(i: AudioTraceInput, env: TraceEnv, ua: string | undefined, native: boolean): ProblemT {
  const draft: ProblemT = {
    id: newUlid(),
    source: 'web',
    kind: 'auto',
    fingerprint: '0'.repeat(32),
    at: new Date(env.now()).toISOString(),
    name: `Audio trace: ${i.code}`.slice(0, PROBLEM_LIMITS.nameChars),
    message: traceMessage(i, ua, native),
    frames: [],
    versions: env.versions,
    device: env.device,
    routes: env.routes.slice(-PROBLEM_LIMITS.routes),
    truncated: false,
  }
  const clean = scrubProblem(draft)
  return { ...clean, fingerprint: problemFingerprint(clean) }
}

/** At most one entry per code per minute and TRACE_PER_MINUTE a minute in all (the session cap is the controller's, shared). */
export class AudioTraceLimiter {
  private lastByCode = new Map<string, number>()
  private recent: number[] = []
  held = 0
  constructor(private now: () => number) {}
  allow(code: string): boolean {
    const t = this.now()
    this.recent = this.recent.filter((x) => t - x < 60_000 && x <= t)
    const prev = this.lastByCode.get(code)
    if ((prev !== undefined && t - prev < TRACE_PER_CODE_MS && prev <= t) || this.recent.length >= TRACE_PER_MINUTE) {
      this.held++
      return false
    }
    this.lastByCode.set(code, t)
    this.recent.push(t)
    return true
  }
}

/** The last few trace lines, kept for "Report a problem": what an owner report carries along (codes and numbers only). */
const RECENT_MAX = 3
const recent: string[] = []

/** The owner's note with the recent audio trace lines after it, cut so the whole stays inside the note's cap. */
export function withAudioTrace(steps: string): string {
  if (recent.length === 0) return steps
  const trailer = `\n\nAudio trace (codes and numbers only):\n${recent.join('\n')}`
  return steps.slice(0, Math.max(0, PROBLEM_LIMITS.stepsChars - trailer.length)) + trailer
}

let clock: () => number = () => Date.now()
let limiter: AudioTraceLimiter | null = null

/** Records one trace through the page's Problems controller. Does nothing without one; never throws; never blocks playback. */
export function recordAudioTrace(i: AudioTraceInput): void {
  try {
    const ctl = problems()
    if (!ctl) return
    limiter ??= new AudioTraceLimiter(() => clock())
    if (!limiter.allow(i.code)) {
      ctl.throttle.held++ // counted, so Health can say "N held back"
      return
    }
    if (!ctl.throttle.takeSession()) return // the same per-session cap as every other automatic report
    const env = ctl.env()
    const ua = globalThis.navigator?.userAgent
    const entry = buildAudioTrace(i, env, ua, isNativeShell())
    recent.push(entry.message)
    while (recent.length > RECENT_MAX) recent.shift()
    void ctl.submit(entry)
  } catch {
    // a trace that fails stays quiet: audio must not break for a report
  }
}

/** Tests only: a fresh limiter, and optionally the clock it reads. */
export function __resetAudioTraceForTests(now?: () => number): void {
  limiter = null
  recent.length = 0
  clock = now ?? (() => Date.now())
}
