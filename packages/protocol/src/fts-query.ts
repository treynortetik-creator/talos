// SQLite FTS5 query building for search (docs/V2-FEATURES.md V3.1) and the memory browser (V5.2). Pure: the bridge passes
// the result to `MATCH ?` as a bound parameter, and raw owner input never reaches MATCH. Every term becomes an FTS5 string
// literal ("..." with `"` doubled), so operators, column filters, NEAR(), `*` and `^` typed by the owner are plain text.
import { z } from 'zod'

/** `[start, end)` UTF-16 offsets into a snippet (search hits and memory hits share it). Never HTML. */
export const Marks = z.array(z.tuple([z.number().int(), z.number().int()])).max(20)

export const MAX_QUERY_TERMS = 12
export const MAX_QUERY_CHARS = 200

/**
 * Lone UTF-16 surrogates become U+FFFD. bun:sqlite encodes `\uD800"` as ONE 4-byte UTF-8 sequence, which swallows the closing
 * quote of an FTS5 literal and lets what follows run as FTS5 syntax; Node's SQLite does not, so a Node-only test misses it.
 */
export function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
}

export type FtsQuery = {
  /** The MATCH expression, or null when nothing searchable is left (the caller answers with no hits). */
  match: string | null
  /** The positive words and phrases, for highlighting in the app's offline fallback. */
  terms: string[]
}

// Whitespace and the Unicode separators a paste can carry.
const SPACE_CLASS = '\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const SPACE = new RegExp(`[${SPACE_CLASS}]`)
const SPACE_ALL = new RegExp(`[${SPACE_CLASS}]+`, 'g')
const LEAD_SPACE = new RegExp(`^[${SPACE_CLASS}]+`)
const WORD = new RegExp(`^[^${SPACE_CLASS}]+`)
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/g

const literal = (t: string) => `"${t.replace(/"/g, '""')}"`

/**
 * Builds the FTS5 expression for what the owner typed.
 * - Split on whitespace; `"a phrase"` stays one term (an unclosed quote runs to the end).
 * - At most 12 terms, 200 characters in all.
 * - `-word` becomes `NOT "word"`, but never as the only kind of term (a NOT-only query is an FTS5 syntax error), so a
 *   query that is all negatives is dropped.
 * - The last bare (unquoted, non-negated) term of 2+ characters gets a prefix `*`.
 */
export function buildFtsQuery(input: string): FtsQuery {
  // well-formed first, then cut by code points (never inside a surrogate pair)
  const text = Array.from(wellFormed(String(input ?? '')).replace(CONTROL, ' '))
    .slice(0, MAX_QUERY_CHARS)
    .join('')
  type Term = { text: string; quoted: boolean; neg: boolean }
  const terms: Term[] = []
  let i = 0
  while (i < text.length && terms.length < MAX_QUERY_TERMS) {
    const rest = text.slice(i)
    const lead = rest.match(LEAD_SPACE)
    if (lead) {
      i += lead[0].length
      continue
    }
    let neg = false
    let at = i
    if (text[at] === '-' && at + 1 < text.length && !SPACE.test(text[at + 1] as string)) {
      neg = true
      at++
    }
    if (text[at] === '"') {
      const close = text.indexOf('"', at + 1)
      const end = close < 0 ? text.length : close
      const body = text.slice(at + 1, end).trim()
      if (body) terms.push({ text: body.replace(SPACE_ALL, ' '), quoted: true, neg })
      i = close < 0 ? text.length : close + 1
      continue
    }
    const m = text.slice(at).match(WORD)
    const word = m ? m[0] : ''
    i = at + Math.max(word.length, 1)
    // a word is only its letters, digits and inner punctuation; stray quotes inside it are kept as literal characters
    if (word && /[\p{L}\p{N}]/u.test(word)) terms.push({ text: word, quoted: false, neg })
  }
  const pos = terms.filter((t) => !t.neg)
  if (pos.length === 0) return { match: null, terms: [] }
  let lastBare = -1
  terms.forEach((t, k) => {
    if (!t.neg && !t.quoted) lastBare = k
  })
  const parts: string[] = []
  terms.forEach((t, k) => {
    const lit = literal(t.text)
    if (t.neg) parts.push(`NOT ${lit}`)
    else parts.push(k === lastBare && [...t.text].length >= 2 ? `${lit}*` : lit)
  })
  // FTS5: `a NOT b` is valid, `NOT b a` is not. Positives first, then negatives.
  const positives = parts.filter((p) => !p.startsWith('NOT '))
  const negatives = parts.filter((p) => p.startsWith('NOT '))
  return { match: [...positives, ...negatives].join(' '), terms: pos.map((t) => t.text) }
}

/** Case- and accent-folded substring test, for the app's offline fallback over cached messages (V3.2). */
export function foldForSearch(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}
