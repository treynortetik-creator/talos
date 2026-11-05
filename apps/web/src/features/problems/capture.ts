// Turning a caught error into a `Problem`, and deciding which errors are not worth a report (docs/ERRORS.md). The report is
// built from the error's NAME, a scrubbed message, and stack frames inside our own build: never a message, a card or
// anything else the page was showing. The scrubbing is the protocol's; this file only picks what goes in.
import {
  newUlid,
  PROBLEM_LIMITS,
  type ProblemFrameT,
  type ProblemT,
  problemFingerprint,
  scrubProblem,
} from '@talos-app/protocol'
import ErrorStackParser from 'error-stack-parser'
import { isChunkError } from '../../ui/chunkError.ts'

export type CaptureEnv = {
  /** `location.origin` of the page: a frame from any other origin is not our code. */
  origin: string
  versions: ProblemT['versions']
  device: ProblemT['device']
  routes: string[]
  now: () => number
}

const NOISE = /ResizeObserver loop|Script error\.?$/i
/** A fetch that did not get an answer: the network, or the page leaving. Not a bug in the app. */
const NETWORK =
  /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i

/** A path inside our build, from a frame's URL: `assets/index-abc.js`. Null for a frame that is not ours. */
function ownFile(fileName: string | undefined, origin: string): string | null | undefined {
  if (!fileName) return undefined // no file at all (native code): keep the frame, it is not foreign
  try {
    const u = new URL(fileName, origin)
    if (u.origin !== origin) return null
    return u.pathname.replace(/^\/+/, '').split('/').slice(-2).join('/')
  } catch {
    return null
  }
}

function framesOf(error: Error, origin: string): { frames: ProblemFrameT[]; foreign: number } {
  let parsed: ReturnType<typeof ErrorStackParser.parse> = []
  try {
    parsed = ErrorStackParser.parse(error)
  } catch {
    return { frames: [], foreign: 0 }
  }
  const frames: ProblemFrameT[] = []
  let foreign = 0
  for (const f of parsed) {
    const file = ownFile(f.fileName, origin)
    if (file === null) {
      foreign++
      continue
    }
    frames.push({
      ...(f.functionName ? { fn: f.functionName } : {}),
      ...(file ? { file } : {}),
      ...(f.lineNumber !== undefined ? { line: f.lineNumber } : {}),
      ...(f.columnNumber !== undefined ? { col: f.columnNumber } : {}),
    })
  }
  return { frames, foreign }
}

/** Why an error is not reported, or null when it is. Chunk errors reload the page; aborts are the user leaving. */
export function skipReason(error: unknown, origin: string): string | null {
  const e = error instanceof Error ? error : null
  if (!e) return null
  if (
    e.name === 'AbortError' ||
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError')
  )
    return 'abort'
  if (isChunkError(e)) return 'chunk'
  if (NOISE.test(e.message)) return 'noise'
  if (e.name === 'TypeError' && NETWORK.test(e.message)) return 'network'
  const { frames, foreign } = framesOf(e, origin)
  // Every frame came from somewhere else (an extension, an injected script): not ours to fix.
  if (foreign > 0 && frames.length === 0) return 'foreign'
  return null
}

/** The stack of what was thrown, or none for something that is not an Error (`throw "text"` carries no frames). */
export function problemFromError(
  error: unknown,
  env: CaptureEnv,
  opts: { kind?: 'auto' | 'owner'; steps?: string; id?: string } = {},
): ProblemT {
  const e = error instanceof Error ? error : null
  // `throw "some text"` or a rejected string can hold anything: only its type is kept.
  const name = e ? e.name || 'Error' : `non-error ${typeof error}`
  const message = e ? e.message : ''
  const { frames } = e ? framesOf(e, env.origin) : { frames: [] as ProblemFrameT[] }
  const kind = opts.kind ?? 'auto'
  const draft: ProblemT = {
    id: opts.id ?? newUlid(),
    source: 'web',
    kind,
    fingerprint: '0'.repeat(32),
    at: new Date(env.now()).toISOString(),
    name,
    message,
    frames: frames.slice(0, PROBLEM_LIMITS.stackFrames),
    versions: env.versions,
    device: env.device,
    routes: env.routes.slice(-PROBLEM_LIMITS.routes),
    truncated: false,
    ...(kind === 'owner' && opts.steps !== undefined ? { steps: opts.steps } : {}),
  }
  const clean = scrubProblem(draft)
  return { ...clean, fingerprint: problemFingerprint(clean) }
}

/** An owner report with no error to attach (from Health): the name says so. */
export function ownerReport(steps: string, env: CaptureEnv, error?: unknown, id?: string): ProblemT {
  if (error !== undefined) return problemFromError(error, env, { kind: 'owner', steps, ...(id ? { id } : {}) })
  const clean = scrubProblem({
    id: id ?? newUlid(),
    source: 'web',
    kind: 'owner',
    fingerprint: '0'.repeat(32),
    at: new Date(env.now()).toISOString(),
    name: 'Report',
    message: 'Reported from the app',
    frames: [],
    versions: env.versions,
    device: env.device,
    routes: env.routes.slice(-PROBLEM_LIMITS.routes),
    steps,
    truncated: false,
  })
  return { ...clean, fingerprint: problemFingerprint(clean) }
}

/**
 * Keeps the first of a repeat: the same fingerprint at most once per window, and a hard cap per page session. A refusal
 * is counted, never silent, so the owner can see "N more were held back" in Health.
 */
export class CaptureThrottle {
  private last = new Map<string, number>()
  sent = 0
  held = 0
  constructor(private now: () => number) {}
  allow(fingerprint: string): boolean {
    const t = this.now()
    const prev = this.last.get(fingerprint)
    if ((prev !== undefined && t - prev < PROBLEM_LIMITS.samePerWindowMs) || this.sent >= PROBLEM_LIMITS.perSession) {
      this.held++
      return false
    }
    this.last.set(fingerprint, t)
    if (this.last.size > 100) this.last.delete(this.last.keys().next().value as string)
    this.sent++
    return true
  }
}
