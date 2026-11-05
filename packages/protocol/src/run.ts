// The Run button: the owner's tap on a script in a thread. It is an ordinary signed `message` frame with `intent: 'run'`
// whose text has one fixed shape, and the Mac (not the agent) decides whether it counts. The app builds the text with
// `runText`; the Mac accepts it only if `parseRun` reads it back as exactly that. One list, used by both sides.
import { decodeTime } from 'ulid'
import { z } from 'zod'
import { MsgId } from './ids.ts'
import { INVISIBLE_OR_BIDI } from './permission.ts'

/** A Mac that lists this accepts `intent: 'run'`; the app shows no Run button, and sends none, without it. */
export const RUN_FEATURE = 'run/1'

/** First line of a Run message. Text that merely says this, without the signed intent, is only text. */
export const RUN_PREFIX = 'Run exactly this:'

/** A Run is for now: the Mac refuses one signed longer ago than this (by the owner's first signing time). */
export const RUN_MAX_AGE_MS = 24 * 3600_000

/** Shell blocks, and blocks with no language. `console` and `shell-session` carry prompts, so they are not here. */
export const RUN_LANGS: readonly string[] = ['', 'sh', 'bash', 'zsh', 'shell']

/** The longest script a Run can carry at all (a hard cap; one tap is far shorter, see below). Any longer has no Run. */
export const RUN_SCRIPT_MAX_CHARS = 4000

/**
 * Which block a Run is for: the agent message it is in, and its place among that message's code blocks (fenced and indented,
 * in order, counted from 0). Carried on the `message` frame as `run_block`, inside the signature, and required when
 * `intent` is `run`. The Mac allows each block one Run, ever (within its seen-id memory): the app is not the guard.
 */
export const RunBlockRef = z.strictObject({ message_id: MsgId, index: z.number().int().min(0).max(999) })
export type RunBlockRefT = z.infer<typeof RunBlockRef>

/**
 * A block older than this, by the time in its message id (a ULID), is refused: the Mac's memory of which blocks ran lasts a
 * day longer (8 days and an hour), so a block inside this limit is always still remembered.
 */
export const RUN_BLOCK_MAX_AGE_MS = 7 * 24 * 3600_000

/** When the block's message was made, from its id; null when the id's time will not parse. */
export function runBlockMadeAt(b: RunBlockRefT): number | null {
  try {
    return decodeTime(b.message_id.slice(2))
  } catch {
    return null
  }
}

/** The seen-store key that marks a block as run. One definition, for the Mac. */
export const runBlockKey = (b: RunBlockRefT): string => `run:${b.message_id}:${b.index}`

/** What the agent's channel note carries when the Mac has accepted a Run (`run="tap"`). The agent trusts this and nothing else. */
export const RUN_META_VALUE = 'tap'

/**
 * Printable ASCII, plus line feeds and tabs. A script made only of these has no character that looks like another; anything
 * else (a look-alike letter, a non-breaking or full-width space, an accent) needs a second confirm in the app.
 */
export const isPlainRunScript = (script: string): boolean => /^[\x20-\x7e\n\t]*$/.test(script)

/**
 * One tap is for a script that is plain (above) and short: at most this many lines and characters. A trailing line break
 * does not count as a line (`echo a\n` is one line); every character counts, line breaks and tabs included. Anything longer
 * is still a Run, with a second confirm. The app decides one tap or two from this (phone and web alike), on the bytes
 * alone: no part of it looks at the screen. The Mac does not use it; it accepts a Run of any length up to the cap.
 */
export const RUN_ONE_TAP_MAX_LINES = 6
export const RUN_ONE_TAP_MAX_CHARS = 300
export const isOneTapRunScript = (script: string): boolean =>
  isPlainRunScript(script) &&
  script.length <= RUN_ONE_TAP_MAX_CHARS &&
  script.replace(/\n$/, '').split('\n').length <= RUN_ONE_TAP_MAX_LINES

/** Controls other than line feed and tab, and every invisible or direction-changing character. */
const hasHiddenChars = (script: string): boolean => INVISIBLE_OR_BIDI.test(script.replace(/[\n\t]/g, ''))

/**
 * The message a tap sends: the Run line, a blank line, and the script in one fence that is longer than any run of
 * backticks inside it. `script` is what the block shows, so it ends with a line break. Null when it cannot be a Run.
 */
export function runText(script: string, lang: string): string | null {
  if (!RUN_LANGS.includes(lang) || !script.trim() || !script.endsWith('\n')) return null
  if (script.length > RUN_SCRIPT_MAX_CHARS || hasHiddenChars(script)) return null
  let longest = 0
  for (const m of script.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${RUN_PREFIX}\n\n${fence}${lang}\n${script}${fence}`
}

export type RunShape = { ok: true; lang: string; script: string } | { ok: false }

/** Reads a Run text back. It must be exactly what `runText` builds for what it holds: one block, nothing before or after. */
export function parseRun(text: string): RunShape {
  const head = `${RUN_PREFIX}\n\n`
  if (!text.startsWith(head)) return { ok: false }
  const rest = text.slice(head.length)
  const open = /^(`{3,})([a-z]*)\n/.exec(rest)
  if (!open) return { ok: false }
  const [line, fence, lang] = open as unknown as [string, string, string]
  if (!rest.endsWith(`\n${fence}`)) return { ok: false }
  const script = rest.slice(line.length, rest.length - fence.length)
  return runText(script, lang) === text ? { ok: true, lang, script } : { ok: false }
}
