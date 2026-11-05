// Pure helpers for the memory browser UI (docs/V2-FEATURES.md V5.3): frontmatter, links, copy. No React.
import {
  frontmatterRows,
  type LinkPlan,
  type MemoryLinkT,
  planLinks,
  type RawLink,
  relLink,
  splitNote,
  WIKI_SOURCE,
  wikiLink,
} from '@talos-app/protocol'
import DOMPurify from 'dompurify'
import MarkdownIt, { type StateInline } from 'markdown-it'

export const OFF_TEXT = 'The memory browser is off. Turn it on at your Mac: talos-app memory on'

/** `---` frontmatter as `key: value` rows (one line each; nested YAML is shown as its raw text), and the text after it. */
export function splitFrontmatter(text: string): { rows: Array<[string, string]>; body: string } {
  const { front, body } = splitNote(text)
  return { rows: front ? frontmatterRows(front) : [], body }
}

export type { LinkPlan }
/**
 * Which entry of the Mac's list belongs to which link of the note. The Mac and this app read the note with the same scanner
 * (packages/protocol/src/memory-links.ts); a link the list cannot vouch for stays plain text. `text` is the whole note
 * (properties included), `from` its path, `complete` false while only the first chunk is loaded.
 */
export const linkPlan = (text: string, links: readonly MemoryLinkT[], from: string, complete = true): LinkPlan =>
  planLinks(text, links, from, complete)

const wikiGlobal = () => new RegExp(WIKI_SOURCE, 'g')

export type FrontPart = { text: string; link?: { index: number } }

/**
 * A frontmatter value as text and links. `[[name]]` is a link (index into the note's links) when the Mac listed it, and
 * index -1 (shown grey, without brackets) when it did not.
 */
export function frontmatterParts(value: string, plan: LinkPlan): FrontPart[] {
  const parts: FrontPart[] = []
  let at = 0
  for (const m of value.matchAll(wikiGlobal())) {
    const idx = m.index as number
    if (idx > at) parts.push({ text: value.slice(at, idx) })
    const link = wikiLink(m[1] as string, m[2])
    parts.push({ text: ((m[2] ?? m[1]) as string).trim(), link: { index: link ? plan.slotOf(link) : -1 } })
    at = idx + m[0].length
  }
  if (at < value.length) parts.push({ text: value.slice(at) })
  return parts
}

// Own markdown-it and own DOMPurify instance. The renderer itself decides what is code: a link is only ever made where
// markdown-it is reading plain text, so nothing inside a fence, an indented block or a code span can turn into a link,
// whatever the Mac's scanner thought. Slots are carried by a token and an attribute the note's own text cannot produce
// (raw HTML is off), and are decided INSIDE the sanitizer's attribute hook, so the HTML that reaches the page is exactly
// what DOMPurify serialised. No placeholder address is ever written into the note text.
const purify = DOMPurify(window)
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })
const WEB = /^(?:https?:|mailto:)/i
// One-shot: markdown-it's link rule checks the address once, before it reads the label. The relative rule below arms this
// for that one check only, so an autolink inside the label (`[<javascript:x>](a.md)`) is judged as usual.
let openRelative = false
md.validateLink = (url) => {
  if (openRelative) {
    openRelative = false
    return true
  }
  return WEB.test(url)
}

type Env = { plan?: LinkPlan; bar?: string }

// A bar inside `[[name|alias]]` does not split a table cell (the scanner agrees: `wikiSpanEnd`). markdown-it splits cells
// before it reads inline text, so before the block pass the bars inside wiki links are swapped for a character the note
// does not contain, and swapped back in every block's text before the inline pass. Same length, so no offset moves.
export function pickBar(src: string): string {
  // One pass over the note, whatever its size: mark every private-use code unit it holds, then take the first unmarked one.
  const seen = new Uint8Array(0xf8ff - 0xe000)
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i) - 0xe000
    if (c >= 0 && c < seen.length) seen[c] = 1
  }
  for (let c = 0; c < seen.length; c++) if (!seen[c]) return String.fromCharCode(0xe000 + c)
  // Known limit: a crafted note that holds every one of these 6399 characters leaves nothing to borrow. The bars are then
  // left alone: the renderer may split a cell inside `[[..]]` where the scanner does not, so that cell's link can drop to
  // plain text. It can never open a different note (a link is only made from a slot the Mac listed for that exact text).
  return ''
}
md.core.ruler.after('normalize', 'memory_protect_bars', (state) => {
  const bar = pickBar(state.src)
  if (!bar) return
  ;(state.env as Env).bar = bar
  state.src = state.src.replace(wikiGlobal(), (m) => m.replace(/\|/g, bar))
})
md.core.ruler.after('block', 'memory_restore_bars', (state) => {
  const bar = (state.env as Env).bar
  if (!bar) return
  const back = new RegExp(bar, 'g')
  for (const t of state.tokens) {
    if (t.content.includes(bar)) t.content = t.content.replace(back, '|')
    if (t.info.includes(bar)) t.info = t.info.replace(back, '|')
  }
  // A reference definition (`[x]: address "title"`) is taken out of the token stream by the block pass and kept here, with
  // the address already percent-encoded: the borrowed character is in there as its encoded form, and a bar is `%7C`.
  const refs = (state.env as { references?: Record<string, { href: string; title: string }> }).references
  if (!refs) return
  const encoded = new RegExp(encodeURIComponent(bar), 'g')
  const fixed: typeof refs = {}
  for (const [k, v] of Object.entries(refs)) {
    fixed[k.replace(back, '|')] = {
      href: v.href.replace(encoded, '%7C').replace(back, '|'),
      title: v.title.replace(back, '|'),
    }
  }
  ;(state.env as { references?: typeof refs }).references = fixed
})
const SLOT_ATTR = 'data-mem-slot'
const WIKI_AT = new RegExp(WIKI_SOURCE, 'y')
const REL_AT = /\(([^()\s]{1,400})(?:[ \t]+"[^"\n]{0,300}")?\)/y

const slotOf = (state: StateInline, link: RawLink | null): number =>
  link ? ((state.env as Env | undefined)?.plan?.slotOf(link) ?? -1) : -1

/** `[[name]]` and `[[name|alias]]`: a slot link when the Mac listed it, plain text otherwise. */
function wikiRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const pos = state.pos
  // Never in silent mode: markdown-it scans a link label that way, and a `[[..]]` swallowed whole there hides the brackets
  // it counts, so `[see [[x]]](https://e.com)` would stop being a link. In a label it is plain text.
  if (silent || state.linkLevel > 0 || src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
  WIKI_AT.lastIndex = pos
  const m = WIKI_AT.exec(src)
  if (!m) return false
  const slot = slotOf(state, wikiLink(m[1] as string, m[2]))
  if (slot < 0) return false
  const end = pos + m[0].length
  {
    const labelStart = m[2] === undefined ? pos + 2 : pos + 2 + (m[1] as string).length + 1
    const labelEnd = labelStart + (m[2] ?? (m[1] as string)).length
    const open = state.push('link_open', 'a', 1)
    open.attrs = [[SLOT_ATTR, String(slot)]]
    const oldMax = state.posMax
    state.pos = labelStart
    state.posMax = labelEnd
    state.linkLevel++
    state.md.inline.tokenize(state)
    state.linkLevel--
    state.posMax = oldMax
    state.push('link_close', 'a', -1)
  }
  state.pos = end
  return true
}

/** `![label](address)`: markdown-it reads that as an image (which this page never shows), not as a link after a `!`. */
function isImage(src: string, at: number): boolean {
  if (src.charCodeAt(at - 1) !== 0x21) return false
  let slashes = 0
  while (src.charCodeAt(at - 2 - slashes) === 0x5c) slashes++
  return slashes % 2 === 0 // `\!` is a plain bang
}

type InlineRule = (state: StateInline, silent: boolean) => boolean
/**
 * markdown-it's own `link` rule, with one change: a `[label](note.md)` the Mac listed is allowed through its address check
 * and comes out as a slot link, not an address.
 */
function relativeRule(inner: InlineRule): InlineRule {
  return (state, silent) => {
    const src = state.src
    const start = state.pos
    if (src.charCodeAt(start) !== 0x5b || state.linkLevel > 0) return inner(state, silent)
    const labelEnd = state.md.helpers.parseLinkLabel(state, start, false)
    let slot = -1
    if (labelEnd >= 0) {
      REL_AT.lastIndex = labelEnd + 1
      const m = REL_AT.exec(src)
      if (m) {
        const label = src.slice(start + 1, labelEnd)
        const inner = m[0].slice(1, -1)
        slot = slotOf(state, relLink(label, inner))
        // inside a table cell markdown-it has already turned `\|` into `|`; the scanner keeps the label as written
        if (slot < 0 && label.includes('|')) slot = slotOf(state, relLink(label.replace(/\|/g, '\\|'), inner))
      }
    }
    if (slot < 0 || isImage(src, start)) return inner(state, silent)
    if (!silent) state.pushPending() // text before the link becomes its own token first, so the link is the next one
    const before = state.tokens.length
    openRelative = true
    try {
      const ok = inner(state, silent)
      if (ok && !silent)
        (state.tokens[before] as { attrs: [string, string][] | null }).attrs = [[SLOT_ATTR, String(slot)]]
      return ok
    } finally {
      openRelative = false
    }
  }
}

md.inline.ruler.before('link', 'memory_wiki', wikiRule)
{
  const rules = (md.inline.ruler as unknown as { __rules__: Array<{ name: string; fn: InlineRule }> }).__rules__
  const link = rules.find((r) => r.name === 'link')
  if (!link) throw new Error('markdown-it has no link rule')
  md.inline.ruler.at('link', relativeRule(link.fn))
}

let hookLinks: readonly MemoryLinkT[] = []
let hooked = false
function hookOnce() {
  if (hooked) return
  hooked = true
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return
    const raw = node.getAttribute(SLOT_ATTR)
    node.removeAttribute(SLOT_ATTR)
    if (raw !== null) {
      const idx = /^\d{1,5}$/.test(raw) ? Number(raw) : -1
      const l = hookLinks[idx]
      node.removeAttribute('href')
      node.removeAttribute('target')
      node.removeAttribute('rel')
      node.removeAttribute('title')
      if (l?.path && l.root_id) {
        node.setAttribute('href', '#')
        node.setAttribute('data-mem-link', String(idx))
      } else {
        // missing or hidden: grey text, not a link
        node.setAttribute('class', 'text-text-2')
        node.setAttribute('data-testid', 'memory-link-null')
      }
      return
    }
    const href = node.getAttribute('href') ?? ''
    if (!WEB.test(href)) {
      node.removeAttribute('href')
      return
    }
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  })
}

const TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

/**
 * Markdown to HTML for a note: raw HTML is text, links are http/https/mailto or one of the Mac's listed notes, and the
 * sanitizer runs LAST. A listed note becomes an in-app link (`data-mem-link`) or, when the Mac said the target is missing
 * or hidden, grey text. `plan` says which entry belongs to which link (see `linkPlan`); without one the body is planned
 * on its own, which is right for a note with no properties.
 */
export function renderNote(
  body: string,
  links: readonly MemoryLinkT[],
  plan: LinkPlan = planLinks(body, links, ''),
): string {
  hookOnce()
  hookLinks = links
  try {
    return String(
      purify.sanitize(md.render(body, { plan } satisfies Env), {
        ALLOWED_TAGS: TAGS,
        ALLOWED_ATTR: ['href', SLOT_ATTR], // no title: its text is the note's, and a `>` in it must not look like markup
        ADD_URI_SAFE_ATTR: [SLOT_ATTR], // its value is a number, not an address
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
      }),
    )
  } finally {
    hookLinks = []
  }
}

export type Crumb = { label: string; root: string; path: string }

/** `Notes ▸ projects ▸ example` for a folder. */
export function crumbs(rootId: string, rootLabel: string, dir: string): Crumb[] {
  const out: Crumb[] = [{ label: rootLabel, root: rootId, path: '' }]
  let acc = ''
  for (const part of dir.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    out.push({ label: part, root: rootId, path: acc })
  }
  return out
}

export const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
export const baseName = (p: string) => p.split('/').pop() ?? p

export function errorWords(code: string | undefined): string {
  switch (code) {
    case 'memory_off':
      return OFF_TEXT
    case 'memory_not_found':
      return "That isn't shared any more."
    case 'mac_offline':
      return 'Needs your Mac.'
    case 'bad_query':
      return "That search isn't valid."
    case 'rate_limited':
      return 'Too many requests. Wait a moment.'
    default:
      return "Couldn't load that. Try again."
  }
}
