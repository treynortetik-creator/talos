// Error loop (problem reports). An error in the app, the relay, the iPhone shell or the bridge, or a "Report a problem"
// from the owner, becomes one `Problem`. It travels to the Mac as the durable, consumable `problem.item` frame and is
// filed in `$TALOS_APP_HOME/problems/open/` for a builder to read. Nothing in it is message or card text by design: the
// scrubber below removes quoted strings (an error message often quotes the input it choked on), addresses, tokens and
// home folders before anything is stored or sent, and the Mac scrubs it again because the relay is not trusted.
import { z } from 'zod'
import { sha256Hex } from './hash.ts'
import { IsoTs, Ulid } from './ids.ts'
import { AttachmentRef } from './models.ts'
import { sanitizeExternal } from './untrusted.ts'

export const PROBLEMS_FEATURE = 'problems/1'

const KIB = 1024
const MIB = KIB * KIB

/** One list of every cap, so the app, the relay and the Mac read the same numbers. */
export const PROBLEM_LIMITS = {
  messageChars: 300,
  nameChars: 80,
  stackBytes: 4 * KIB,
  stackFrames: 40,
  stepsChars: 2000,
  routes: 10,
  routeChars: 60,
  screenshotBytes: 5 * MIB,
  /** The relay refuses a POST body larger than this (the schema alone bounds it far lower). */
  bodyBytes: 64 * KIB,
  /** Files kept on the Mac (open and closed together) and their total size; the oldest closed one goes first. */
  files: 200,
  totalBytes: 100 * MIB,
  /** Relay bucket `problems`: one budget for the owner. */
  perHour: 30,
  /** App side: the same fingerprint at most once per window, and at most this many automatic reports per page session. */
  samePerWindowMs: 10 * 60_000,
  perSession: 20,
  /** Relay and bridge (long-running processes): at most `perSession` automatic reports in any rolling window this long. */
  perProcessWindowMs: 60 * 60_000,
  /** Notices to the Inbox thread: first sighting only, this many per hour; dropped counts post once a day. */
  noticesPerHour: 5,
} as const

export const ProblemSource = z.enum(['web', 'ios', 'relay', 'bridge'])
export const ProblemKind = z.enum(['auto', 'owner'])
export const ProblemDevice = z.enum(['browser', 'mac_app', 'iphone_app', 'relay', 'bridge'])

const Short = z.string().max(40)

/** A frame of the stack: names and positions only. `file` is a path inside our own build, never a full URL. */
export const ProblemFrame = z
  .object({
    fn: z.string().max(120).optional(),
    file: z.string().max(120).optional(),
    line: z.number().int().nonnegative().max(10_000_000).optional(),
    col: z.number().int().nonnegative().max(10_000_000).optional(),
  })
  .strict()

export const ProblemVersions = z
  .object({
    app: Short.optional(),
    protocol: Short.optional(),
    relay: Short.optional(),
    bridge: Short.optional(),
    shell: Short.optional(),
  })
  .strict()

/** The strict report. A key that is not listed here (for instance `text`) is refused, not ignored. */
export const Problem = z
  .object({
    id: Ulid,
    source: ProblemSource,
    kind: ProblemKind,
    /** Lowercase hex. The Mac recomputes it and uses its own answer; this one is only a hint. */
    fingerprint: z.string().regex(/^[0-9a-f]{16,64}$/),
    at: IsoTs,
    name: z.string().max(PROBLEM_LIMITS.nameChars),
    message: z.string().max(PROBLEM_LIMITS.messageChars),
    frames: z
      .array(ProblemFrame)
      .max(PROBLEM_LIMITS.stackFrames)
      .refine((f) => JSON.stringify(f).length <= PROBLEM_LIMITS.stackBytes, 'stack too large'),
    versions: ProblemVersions,
    device: ProblemDevice,
    /** Route NAMES the owner passed through (`thread`, `settings`), never paths: a path can hold a thread id. */
    routes: z.array(z.string().max(PROBLEM_LIMITS.routeChars)).max(PROBLEM_LIMITS.routes),
    /** What the owner typed in "Report a problem". Only on kind 'owner'. */
    steps: z.string().max(PROBLEM_LIMITS.stepsChars).optional(),
    /** A screenshot the owner added, uploaded through /api/media; the Mac fetches and verifies it. */
    screenshot: AttachmentRef.optional(),
    /** Something was cut to fit a cap. */
    truncated: z.boolean(),
  })
  .strict()
  .refine((p) => p.kind === 'owner' || (p.steps === undefined && p.screenshot === undefined), {
    message: 'steps and a screenshot belong to an owner report',
  })
  .refine((p) => p.screenshot === undefined || p.screenshot.kind === 'image', {
    message: 'screenshot must be an image',
  })
  .refine((p) => p.screenshot === undefined || p.screenshot.size <= PROBLEM_LIMITS.screenshotBytes, {
    message: 'screenshot too large',
  })

export type ProblemT = z.infer<typeof Problem>
export type ProblemFrameT = z.infer<typeof ProblemFrame>

/**
 * A rolling cap for a process that lives for weeks: `take` is true while fewer than `limit` takes fell in the last
 * `windowMs`. A fixed count per process would let one repeating bug use the budget up and mute every other error until
 * the next deploy.
 */
export class RollingLimit {
  private at: number[] = []
  constructor(
    private limit: number = PROBLEM_LIMITS.perSession,
    private windowMs: number = PROBLEM_LIMITS.perProcessWindowMs,
  ) {}

  /** Checks and counts in one step. A clock that went backwards drops the future stamps rather than blocking for hours. */
  take(now: number): boolean {
    this.at = this.at.filter((t) => t <= now && now - t < this.windowMs)
    if (this.at.length >= this.limit) return false
    this.at.push(now)
    return true
  }
}

// ---- scrubbing --------------------------------------------------------------------------------------------------------

const ELLIPSIS = '…'

/**
 * The most input any scrub reads, as a multiple of the length it will keep. The regexes below can go quadratic on a long
 * hostile run, and this runs on the main thread (web, the bridge log tap, the relay's error hook), so the cut comes first.
 */
const READ_FACTOR = 4
const READ_FLOOR = 512
const readLimit = (maxChars: number) => Math.max(maxChars * READ_FACTOR, READ_FLOOR)

/** Where each unescaped quote `q` sits, in order. One pass. */
function unescapedAt(s: string, q: string): number[] {
  const at: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === q) at.push(i)
  }
  return at
}

/**
 * Replaces every quoted string with `[text]` and cuts from a quote that never closes. One pass, linear.
 * Double quotes and backticks run to the LAST unescaped quote of the same kind, not the next one: an engine quotes the
 * input back unescaped (`Unexpected token 'x', "["hi",x]" is not valid JSON`), so a quote inside the input would end a
 * nearest-match early and leave the rest of the input in the report. If the quotes from here on are an odd number, one of
 * them is unpaired and the pairing cannot be trusted, so it counts as never closed. This loses the words between two
 * separate quoted values; that is the price. A single quote opens only after a non-alphanumeric ("can't" survives) and
 * closes at a single quote that no letter or digit follows ("'it's'" is one string).
 */
function stripQuoted(s: string): string {
  const doubles = unescapedAt(s, '"')
  const ticks = unescapedAt(s, '`')
  let di = 0
  let ti = 0
  let out = ''
  let i = 0
  const paired = (at: number[], from: number) => {
    // `from` is the first unescaped quote at or after the opener: the opener itself when it is unescaped
    const rest = at.length - from
    return rest >= 2 && rest % 2 === 0 && at[from] !== undefined ? (at[at.length - 1] as number) : -1
  }
  while (i < s.length) {
    const c = s[i] as string
    let close = -1
    if (c === '"' || c === '`') {
      const at = c === '"' ? doubles : ticks
      let k = c === '"' ? di : ti
      while (k < at.length && (at[k] as number) < i) k++
      if (c === '"') di = k
      else ti = k
      close = at[k] === i ? paired(at, k) : -1
    } else if (c === "'" && !/[A-Za-z0-9]/.test(s[i - 1] ?? ' ')) {
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') j++
        else if (s[j] === "'" && !/[A-Za-z0-9]/.test(s[j + 1] ?? ' ')) {
          close = j
          break
        }
      }
    } else {
      out += c
      i++
      continue
    }
    // a quote that never closed (the engine cut the input short): everything after it is the input
    if (close < 0) return `${out}${ELLIPSIS}`
    out += '[text]'
    i = close + 1
  }
  return out
}

/**
 * Removes what could be content from an error message. Order matters: the length cut first (so the work is bounded), then
 * quoted strings (a `JSON.parse` error quotes the input), then anything shaped like an address, a secret, a link's query
 * or a home folder. Not a proof: it is a net with a short message cap behind it.
 */
export function scrubProblemText(input: string, maxChars: number = PROBLEM_LIMITS.messageChars): string {
  let s = stripQuoted(input.slice(0, readLimit(maxChars)).normalize('NFC'))
  s = s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]}>,;]*/gi, (u) => {
      const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]*)/i.exec(u)
      return m?.[1] ? `${m[1]}/${ELLIPSIS}` : '[url]'
    })
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /([A-Za-z0-9_.-]*(?:authorization|token|secret|passw(?:or)?d|cookie|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*\s*[:=]\s*)\S+/gi,
      '$1[redacted]',
    )
    .replace(/(?:\/Users|\/home)\/[^/\s]+/g, '~')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, '[redacted]')
    .replace(/\d{9,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitizeExternal(s, maxChars)
}

/** For the owner's own typed words: injection and secret scrubbing, but their sentences stay. */
export function scrubOwnerText(input: string, maxChars: number): string {
  const s = input
    .slice(0, readLimit(maxChars))
    .normalize('NFC')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, '[redacted]')
  return sanitizeExternal(s, maxChars)
}

const stackSize = (f: ProblemFrameT[]) => JSON.stringify(f).length

/** Cleans every string and trims every list to its cap. Sets `truncated` when anything was cut. Pure: same input, same output. */
export function scrubProblem(p: ProblemT): ProblemT {
  let truncated = p.truncated
  const message = scrubProblemText(p.message)
  if (message.length < p.message.length) truncated = truncated || p.message.length > PROBLEM_LIMITS.messageChars
  let frames = p.frames.slice(0, PROBLEM_LIMITS.stackFrames).map((f) => ({
    ...(f.fn !== undefined ? { fn: scrubProblemText(f.fn, 120) } : {}),
    ...(f.file !== undefined ? { file: scrubProblemText(f.file, 120) } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.col !== undefined ? { col: f.col } : {}),
  }))
  if (frames.length < p.frames.length) truncated = true
  while (frames.length > 0 && stackSize(frames) > PROBLEM_LIMITS.stackBytes) {
    frames = frames.slice(0, -1)
    truncated = true
  }
  const routes = p.routes.slice(0, PROBLEM_LIMITS.routes).map((r) => scrubProblemText(r, PROBLEM_LIMITS.routeChars))
  if (routes.length < p.routes.length) truncated = true
  const out: ProblemT = {
    ...p,
    name: scrubProblemText(p.name, PROBLEM_LIMITS.nameChars),
    message,
    frames,
    routes,
    versions: Object.fromEntries(
      Object.entries(p.versions).map(([k, v]) => [k, scrubProblemText(String(v), 40)]),
    ) as ProblemT['versions'],
    truncated,
  }
  if (p.steps !== undefined) out.steps = scrubOwnerText(p.steps, PROBLEM_LIMITS.stepsChars)
  return out
}

/**
 * Frames from a V8-style stack (`at fn (file:line:col)`, which Node and Bun both print). Only the last two path
 * segments of a file are kept: the folder above them holds a user name. Lines that do not match are skipped.
 */
export function framesFromV8Stack(stack: string, max: number = PROBLEM_LIMITS.stackFrames): ProblemFrameT[] {
  const out: ProblemFrameT[] = []
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line)
    if (!m) continue
    const file = (m[2] ?? '')
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[\\/]/)
      .slice(-2)
      .join('/')
    out.push({
      ...(m[1] ? { fn: m[1].slice(0, 120) } : {}),
      ...(file ? { file: file.slice(0, 120) } : {}),
      line: Math.min(Number(m[3]), 10_000_000),
      col: Math.min(Number(m[4]), 10_000_000),
    })
    if (out.length >= max) break
  }
  return out
}

// ---- identity ---------------------------------------------------------------------------------------------------------

/** The 8-character content hash a build puts in a file name (`index-Dx3kQ9aZ.js`); it changes on every deploy. */
const BUILD_HASH = /-(?=[A-Za-z0-9_-]{0,7}[A-Z0-9])[A-Za-z0-9_-]{8}(?=\.[A-Za-z]+$)/

/**
 * Same error, same fingerprint: the source, name, message with numbers and ids flattened, and the top three frames by
 * function and file (not line: a rebuild moves lines; not the hash in a built file's name: every deploy renames it). An owner report is its own id, so two reports never merge.
 * Anyone can send any hex string as `fingerprint`; the Mac calls this on the scrubbed content and trusts only its answer.
 */
export function problemFingerprint(
  p: Pick<ProblemT, 'id' | 'source' | 'kind' | 'name' | 'message' | 'frames'>,
): string {
  if (p.kind === 'owner') return sha256Hex(`owner\n${p.id}`).slice(0, 32)
  const flat = p.message.replace(/0x[0-9a-f]+|\d+/gi, '#').slice(0, PROBLEM_LIMITS.messageChars)
  const top = p.frames
    .slice(0, 3)
    .map((f) => `${f.fn ?? ''}@${(f.file ?? '').replace(BUILD_HASH, '-#')}`)
    .join('|')
  return sha256Hex(`auto\n${p.source}\n${p.name}\n${flat}\n${top}`).slice(0, 32)
}
