// Read-aloud on request (the play button on an agent message). The app sends a signed `speak.request` for one message id;
// the Mac turns THAT stored message into speech with the owner's own TTS command and answers `speak.result` with the audio
// as a media ref. The text is never sent by the app: the Mac reads its own copy, so a request cannot make it speak
// anything the agent did not write. Pure helpers here; the bridge and the app both import them.
import { markdownToPlain } from './markdown-plain.ts'
import { stripExternalBlocks } from './untrusted.ts'

export const SPEAK_FEATURE = 'speak/1'

/** The most characters read aloud for one message. About five minutes of speech; the rest is left unread and the app says so. */
export const SPEAK_MAX_CHARS = 4000
/** Anything shorter than this after cleaning is not worth a synthesis (a lone emoji, a bare "ok"). */
export const SPEAK_MIN_CHARS = 2
/** How often the app asks again while the Mac is still making the audio. */
export const SPEAK_POLL_MS = 1500
/** Never read more than this much of the message into memory before cleaning it. */
const SPEAK_INPUT_CAP = 200_000

/** Why a request failed. The list is open: an app that meets a value it does not know shows the Mac's own `message`. */
export const SPEAK_REASONS = [
  'no_tts', // TALOS_APP_TTS_CMD is not set on the Mac
  'not_found', // no such agent message in that thread
  'nothing_to_read', // only code or markup: nothing to say
  'tts_failed', // the command failed, timed out or wrote no audio
  'upload_failed', // the audio was made but the relay would not take it
  'busy', // too many syntheses at once
] as const
export type SpeakReason = (typeof SPEAK_REASONS)[number]

export type Speakable = {
  text: string
  /** Characters in the cleaned message before the cap. */
  total: number
  truncated: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters (NUL would make the command fail to start)
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const FENCE = /^\s*(```|~~~)/

/** Drops fenced code blocks entirely (an unclosed fence takes the rest of the message). */
function dropFences(md: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = FENCE.exec(line)
    if (fence === null) {
      if (m) fence = (m[1] as string)[0] as string
      else out.push(line)
    } else if (m && (m[1] as string)[0] === fence) fence = null
  }
  return out.join('\n')
}

/**
 * What the speaker reads for a stored message: no code blocks, no markdown marks, no link addresses, no untrusted-content
 * wrappers, no control characters, at most `SPEAK_MAX_CHARS` (cut at a sentence end when there is one near the cap).
 */
export function speakableText(md: string): Speakable {
  let s = stripExternalBlocks(md.length > SPEAK_INPUT_CAP ? md.slice(0, SPEAK_INPUT_CAP) : md)
  s = dropFences(s)
  s = s
    .replace(/<\/?[A-Za-z][^>\n]{0,200}>/g, ' ') // html tags
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ') // images say nothing aloud
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1') // a link reads as its words, not its address
    .replace(/\bhttps?:\/\/[^\s)>\]]+/gi, 'a link')
    .replace(/\$\$[^$]*\$\$/g, ' ') // display math is not speakable
  s = markdownToPlain(s)
    .replace(/`+/g, '')
    .replace(/^(\s*)- \[[ xX]\]\s+/gm, '$1- ') // task list boxes
    .replace(/^(\s*)- /gm, '$1') // bullets are line breaks when spoken
    .replace(/ · /g, ', ') // table cells
    .replace(CONTROL, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  const chars = Array.from(s)
  if (chars.length <= SPEAK_MAX_CHARS) return { text: s, total: chars.length, truncated: false }
  const head = chars.slice(0, SPEAK_MAX_CHARS).join('')
  // prefer ending on a sentence or line end in the last fifth, else on a word
  const floor = Math.floor(head.length * 0.8)
  let cut = -1
  for (let i = head.length - 1; i >= floor; i--) {
    const c = head[i] as string
    if (c === '\n' || ((c === '.' || c === '!' || c === '?') && (head[i + 1] === ' ' || i === head.length - 1))) {
      cut = i + 1
      break
    }
  }
  if (cut < 0) cut = Math.max(head.lastIndexOf(' '), floor)
  return { text: head.slice(0, cut).trim(), total: chars.length, truncated: true }
}
