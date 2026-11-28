// Real words for a browser push. A web push is encrypted to the one browser that subscribed, so unlike an APNs request it
// can carry the thread name and a short look at the reply (the owner's switch "Show message text in browser notifications"
// turns the look off). Everything here is pure: the relay calls it, and the tests and the service worker's parser rely on
// the limits below.
import { visibleText } from './permission.ts'
import type { PushPayloadT } from './push.ts'
import { redact } from './redact.ts'

/** The title and body limits of `PushPayload` (a longer one makes the whole payload unreadable to the service worker). */
export const PUSH_TITLE_MAX = 40
export const PUSH_BODY_MAX = 80

const MARKER = /(\[U\+[0-9A-F]{4,6}\])/
/** Made on first use, not at import (the protocol index is loaded by the web app and the service worker); a runtime without `Intl.Segmenter` cuts by code point. */
let graphemes: Intl.Segmenter | null | undefined
function splitGraphemes(text: string): string[] {
  if (graphemes === undefined) {
    try {
      graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })
    } catch {
      graphemes = null
    }
  }
  return graphemes ? [...graphemes.segment(text)].map((s) => s.segment) : [...text]
}

/** Cuts to `max` UTF-16 units with an ellipsis, never inside a grapheme (a flag, an accent, an emoji) or a `[U+XXXX]` marker. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const part of text.split(MARKER)) {
    const units = MARKER.test(part) ? [part] : splitGraphemes(part)
    for (const u of units) {
      if (out.length + u.length > max - 1) return `${out.trimEnd()}…`
      out += u
    }
  }
  return out
}

/**
 * One line of a reply for a lock screen. Whitespace is flattened first and secrets are redacted after that, so one split
 * across a line break is still caught (`redact`: link codes, passwords, bearer tokens, keys). Emoji joiners and variation
 * selectors are dropped (they are ordinary in emoji, and marking them breaks ⚠️ and 👨‍💻); every other hidden or
 * direction-changing character is shown as `[U+XXXX]`.
 */
function oneLine(text: string, max: number): string {
  // `talos-link:` then a space is a code a line break pulled apart: the strict redactor needs them joined (the shared one stays strict, since the card text the phone signs a hash of passes through it).
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/[\u200D\uFE00-\uFE0F]/g, '')
    .replace(/talos-link: /gi, 'talos-link:')
    .trim()
  return clip(visibleText(redact(flat)), max)
}

/**
 * The reply push with its words: the thread's name as the title (when "Show thread names" allowed one) and a one-line
 * preview of the reply as the body. A payload that is not a reply, or a reply with nothing to show, comes back unchanged
 * (the fixed text). Older apps show these two fields as they are, so nothing needs to understand a new shape.
 */
export function withPushWords(p: PushPayloadT, words: { thread?: string; text: string }): PushPayloadT {
  if (p.talos.kind !== 'reply') return p
  const preview = oneLine(words.text, PUSH_BODY_MAX)
  if (!preview) return p
  const thread = words.thread ? oneLine(words.thread, PUSH_TITLE_MAX) : ''
  const n = p.notification
  // The thread's banner is replaced by the next reply (they share a tag), and the words now differ: it must still be heard.
  return { ...p, notification: { ...n, title: thread || n.title, body: preview, ...(n.tag ? { renotify: true } : {}) } }
}
