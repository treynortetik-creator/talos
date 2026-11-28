// The last lines of a quiet session's pane, shown IN THE APP under the "has been quiet" notice (apps/bridge/src/router/quiet-watch.ts).
//   - The supervisor takes the rows just above the input box and publishes at most PANE_LINES_MAX of them, each cut to PANE_LINE_CHARS, in
//     workers.json (`quiet_lines`, only while the pane has been idle for a while), after `sanitizePaneLines`.
//   - The bridge runs `sanitizePaneLines` again (a supervisor of another kind is not trusted to have done it) and sends the lines in a
//     separate EPHEMERAL frame, `quiet.lines`, right after the notice: never in the notice (which is stored and pushed), never queued.
//   - Only a relay that lists QUIET_LINES_FEATURE gets the frame, and only an app whose hello lists it is sent it, so an older peer never
//     sees a frame type it does not know.
import { z } from 'zod'
import { frame } from './frame-base.ts'
import { MsgId, ThreadId } from './ids.ts'
import { INVISIBLE_OR_BIDI } from './permission.ts'
import { redact } from './redact.ts'

export const QUIET_LINES_FEATURE = 'quiet-lines/1'

/** At most this many lines, of at most this many characters each. */
export const PANE_LINES_MAX = 3
export const PANE_LINE_CHARS = 100

export const QuietLinesFrame = frame('quiet.lines', {
  /** The notice these lines belong to. */
  message_id: MsgId,
  thread_id: ThreadId,
  /** Already cleaned and redacted: at most 3, each at most 100 characters (code points; 400 allows for how they count in UTF-16 and a newer build). */
  lines: z.array(z.string().max(400)).max(PANE_LINES_MAX),
})
export const QUIET_LINES_BRIDGE_FRAME_TYPES = ['quiet.lines'] as const

const INVISIBLE = new RegExp(
  `${INVISIBLE_OR_BIDI.source}|[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]`,
  'gu',
)
/** White-space controls are word breaks (a space); every other control and invisible character is DELETED, so one inside a token cannot split it. */
const BREAKS = [9, 10, 13, 0x0b, 0x0c, 0x85, 0x2028, 0x2029] // tab, line feed, carriage return, vertical tab, form feed, next line, line and paragraph separators
/** redact() masks tokens, keys, passwords and links; it has no rule for a mail address, so this one does. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const MASK = '[redacted]'

/** One row as plain text on one line: breaks are spaces, invisible and control characters are gone (BEFORE any redaction), white space collapsed. */
const flat = (row: string): string =>
  [...row]
    .map((ch) => (BREAKS.includes(ch.codePointAt(0) ?? 0) ? ' ' : ch))
    .join('')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Letters AND digits in one piece. */
const mixed = (t: string): boolean => /[A-Za-z]/.test(t) && /\d/.test(t)
/** A chunk that mixes letters and digits for 16+ characters: a token, never a word. */
const mixedChunk = (t: string): boolean => t.length >= 16 && mixed(t)
/** A segment that begins with a known token prefix (GitHub, GitLab, Slack, Stripe/OpenAI-style, AWS key ids): never a path segment. */
const TOKEN_PREFIX = /^(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[a-z]|sk|AKIA|ASIA)(?![a-z])/
/** Eight or more characters mixing upper case, lower case and digits: not a word in any case convention. */
const caseSoup = (t: string): boolean => t.length >= 8 && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t)
/**
 * A run with `/` in it that reads as a path: every segment a word (no token prefix, no 16+ mixed chunk, no upper/lower/digit soup of 8+), and the
 * mixed letter-and-digit segments together fewer than 20 characters (a secret split on slashes adds up). Privacy wins when in doubt.
 */
const pathLike = (run: string): boolean => {
  if (!run.includes('/')) return false
  const segs = run.split('/')
  if (segs.some((seg) => TOKEN_PREFIX.test(seg) || mixedChunk(seg) || caseSoup(seg))) return false
  return segs.filter(mixed).reduce((n, seg) => n + seg.length, 0) < 20
}
/** Letters AND digits, and not a path: what the end or the start of a wrapped token or a key's base64 line looks like. */
const tokenEdge = (run: string): boolean => mixed(run) && !pathLike(run)
/** 40 base64 characters bounded by a `/`, a run edge or another character (an AWS secret key's shape), wherever it sits in a slash run. */
const AWS_WINDOW = /(?<![A-Za-z0-9+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9+])/g

/** What redact() does not know (it reads `name=value` and `name: value`): the value after a bare password word, a mysql `-p<password>`, a lone secret key. */
function extras(row: string): string {
  let t = row
  if (/\b(?:mysql|mariadb|mysqldump|mysqladmin)\b/i.test(t)) t = t.replace(/(^|\s)-p(?!assword\b)\S+/g, `$1-p${MASK}`)
  t = t.replace(/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*\s+)(?!\[redacted\])\S+/gi, `$1${MASK}`)
  t = t.replace(/\b(pass(?:word|phrase|wd)\s+(?:is|was)\s*:?\s*)(?!\[redacted\])\S+/gi, `$1${MASK}`)
  t = t.replace(/\b(pass(?:word|phrase|wd)\s*[:=]\s*)(?!\[redacted\])\S+/gi, `$1${MASK}`)
  // a whole word of 32+ key characters (base64 may hold / and +, which redact()'s own run rule does not take) with a letter and a digit in it: masked unless
  // it is a path (pathLike); in a path, any 40-character base64 window (an AWS secret key's shape) inside it is masked
  t = t.replace(
    /(?<![A-Za-z0-9/+=_.:~-])(?=[A-Za-z0-9/+=_-]*[A-Za-z])(?=[A-Za-z0-9/+=_-]*\d)[A-Za-z0-9/+=_-]{32,}(?![A-Za-z0-9/+=_-])/g,
    (w) => (pathLike(w) ? w.replace(AWS_WINDOW, (win) => (mixed(win) ? MASK : win)) : MASK),
  )
  return t
}

/** redact() and the extras, on a row that is already flat. */
const core = (row: string): string => extras(redact(row))

/** A long run of key characters (letters and digits, not a path) touching an edge of a row is the start or end of something wrapped: masked (Ink wraps at the pane width). */
const edges = (row: string): string =>
  row
    .replace(/^[A-Za-z0-9_+/=-]{16,}/, (run) => (tokenEdge(run) ? MASK : run))
    .replace(/[A-Za-z0-9_+/=-]{16,}$/, (run) => (tokenEdge(run) ? MASK : run))

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/

/**
 * Every row from a private key's BEGIN line through its END line is dropped; with no END in sight, every row after the BEGIN; and an END with no
 * BEGIN before it in the window drops every row before it too, and itself.
 */
function withoutKeys(rows: string[]): string[] {
  const out: string[] = []
  let inKey = false
  for (const r of rows) {
    if (inKey) {
      if (KEY_END.test(r)) inKey = false
      continue
    }
    if (KEY_BEGIN.test(r)) {
      inKey = !KEY_END.test(r)
      continue
    }
    if (KEY_END.test(r)) {
      out.length = 0 // its BEGIN has scrolled out of view: what came before it in the window is the key's body
      continue
    }
    out.push(r)
  }
  return out
}

/**
 * The last PANE_LINES_MAX non-blank rows of `rows`, made safe to show. Anything that is not an array of strings gives no lines.
 * Order: invisible characters out, private keys out, each row redacted whole (so a secret across the 100-character cut is never half shown), and a
 * secret WRAPPED across rows (a token longer than the pane is wide): each pair of neighbouring rows is redacted joined with nothing between, and both
 * rows are masked when that finds more than the rows did alone; a run of key characters at the start or the end of a row is masked too.
 */
export function sanitizePaneLines(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  const rs = withoutKeys(
    rows
      .filter((r): r is string => typeof r === 'string')
      .map(flat)
      .filter((r) => r !== ''),
  )
  const hidden = new Set<number>()
  for (let i = 0; i + 1 < rs.length; i++) {
    const a = rs[i] as string
    const b = rs[i + 1] as string
    if (core(a + b) !== core(a) + core(b)) {
      hidden.add(i)
      hidden.add(i + 1)
    }
  }
  const out: string[] = []
  rs.forEach((r, i) => {
    const safe = hidden.has(i) ? MASK : edges(core(r).replace(EMAIL, '[email]'))
    const cut = [...safe.trim()].slice(0, PANE_LINE_CHARS).join('').trim()
    if (cut !== '') out.push(cut)
  })
  return out.slice(-PANE_LINES_MAX)
}

/** One row on its own, made safe to show (kept for callers of the old name). */
export const cleanPaneLine = (row: string): string => sanitizePaneLines([row])[0] ?? ''
