// Small helpers shared by the WP7 screens (cards, home, inbox, integrations, agent config).
import { INVISIBLE_OR_BIDI } from '@talos-app/protocol'
import { useEffect, useState } from 'react'

/** Wall-clock `HH:MM` of an ISO timestamp in `timeZone` (the agent config's zone; UTC before the config arrives). */
export function formatClock(iso: string, timeZone = 'UTC'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
      d,
    )
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d)
  }
}

/**
 * When a card runs out, for a card that can live a day: the time alone only when it is today in `timeZone`, else with
 * "tomorrow" or the weekday, so "Expires 14:00" never reads as already past at 15:00 with 23 hours left.
 */
export function formatExpiry(iso: string, timeZone: string, nowMs: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const clock = formatClock(iso, timeZone)
  const day = (t: number): string | null => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
    } catch {
      return null
    }
  }
  const a = day(d.getTime())
  const b = day(nowMs)
  if (a === null || b === null || a === b) return clock
  const days = Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
  if (days === 1) return `tomorrow ${clock}`
  if (days > 1 && days < 7) {
    const wd = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(d)
    return `${wd} ${clock}`
  }
  return `${a} ${clock}`
}

/** "now", "4 min", "3 h", "2 d". */
export function relativeTime(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - Date.parse(iso))
  const s = Math.floor(diff / 1000)
  if (Number.isNaN(s)) return ''
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.round(h / 24)} d`
}

/** Re-renders every `intervalMs` and returns Date.now(). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Best-effort clipboard write; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// The three flags that are drawn from tag characters (England, Scotland, Wales): a black flag, the tag letters of the region
// code, then the cancel tag. Nothing else is accepted, so tag characters cannot carry a hidden message past the reader.
const FLAG_SEQUENCE =
  /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/u
const HIDDEN = new RegExp(`(${FLAG_SEQUENCE.source})|(${INVISIBLE_OR_BIDI.source})`, 'gu')

const PICTO = /\p{Extended_Pictographic}/u
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u
const KEYCAP_BASE = /[0-9#*]/
const LETTER_OR_MARK = /[\p{L}\p{M}]/u
// Scripts whose words are spelled with a zero-width non-joiner or joiner. Both neighbours must be in the same one.
const JOINING_SCRIPTS = [
  'Arab',
  'Syrc',
  'Thaa',
  'Deva',
  'Beng',
  'Guru',
  'Gujr',
  'Orya',
  'Taml',
  'Telu',
  'Knda',
  'Mlym',
  'Sinh',
  'Khmr',
  'Mymr',
].map((sc) => new RegExp(`^\\p{scx=${sc}}$`, 'u'))
const LETTER = /^\p{L}$/u
const MARK = /^\p{M}$/u
const RTL_SCRIPT = /^[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]$/u
const isRtlLetter = (ch: string): boolean => LETTER.test(ch) && RTL_SCRIPT.test(ch)
const HEBREW = /[\p{Script=Hebrew}]/u

const cpBefore = (text: string, at: number): string => Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? ''
/** The code point before `at`, skipping combining marks back to the character they belong to. */
function baseBefore(text: string, at: number): string {
  const chars = Array.from(text.slice(0, at))
  let i = chars.length - 1
  while (i >= 0 && MARK.test(chars[i] as string)) i--
  return chars[i] ?? ''
}
const cpAt = (text: string, at: number): string => String.fromCodePoint(text.codePointAt(at) ?? 0x20)
const sameJoiningScript = (a: string, b: string): boolean =>
  JOINING_SCRIPTS.some((re) => re.test(a) && re.test(b) && LETTER_OR_MARK.test(a) && LETTER_OR_MARK.test(b))

/** True when the invisible character `c` at `at` is doing ordinary work in the text around it. */
function isOrdinary(text: string, at: number, c: string): boolean {
  const prev = cpBefore(text, at)
  const next = cpAt(text, at + c.length)
  switch (c) {
    case '\n':
    case '\t':
      return true
    case '\r':
      return next === '\n'
    case '️':
    case '︎': // emoji or text presentation, after the emoji it applies to (or a keycap digit)
      return PICTO.test(prev) || KEYCAP_BASE.test(prev)
    case '‍': // joins the parts of one emoji, or two letters of a script that is written with it
      return (
        ((PICTO.test(prev) || prev === '️' || EMOJI_MODIFIER.test(prev)) && PICTO.test(next)) ||
        sameJoiningScript(prev, next)
      )
    case '‌':
      return sameJoiningScript(prev, next)
    case '͏': // combining grapheme joiner, used between Hebrew points
      return HEBREW.test(prev) && HEBREW.test(next)
    case '‎':
    case '‏':
    case '؜': // direction marks, in text that is already right-to-left on at least one side
      // A letter, not any character of the script: a lone Hebrew point must not unlock a mark in Latin text. Marks before the
      // mark are stepped over to find the letter they sit on (a pointed Hebrew word).
      return isRtlLetter(baseBefore(text, at)) || isRtlLetter(next)
    default:
      return false
  }
}

/**
 * Anything that changes how text renders without being a letter (direction overrides and isolates, zero-width and other
 * invisible characters, variation selectors, control codes) shown as a visible `⟦U+XXXX⟧` token instead of obeyed. It starts
 * from the character list the notification text uses (`INVISIBLE_OR_BIDI`) and then lets through only the uses that are
 * ordinary: line breaks and tabs, an emoji's presentation selector, a joiner inside one emoji, a flag's tag letters, a
 * joiner or non-joiner inside a word of a script that is spelled with them, and a direction mark beside right-to-left
 * text. Overrides, embeds and isolates, and every other zero-width character, are always shown.
 */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (m: string, flag: string | undefined, hidden: string | undefined, at: number) => {
    if (flag) return m
    const c = hidden ?? m
    if (isOrdinary(text, at, c)) return c
    return `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`
  })
}
