// Markdown for agent and owner text only (spec 5.4): markdown-it {html:false, linkify:true} -> DOMPurify; links are
// http/https/mailto, open outside the app through `platform.openExternal` and carry rel="noopener noreferrer".
// Hook-origin text never comes through here (it renders as plain text).
//
// Task lists (`- [x] done`) render as a glyph and the text, never an <input>. Math (`$x^2$`, `$$...$$`) renders as MathML
// through Temml (audit D34): MathML only, no fonts, no style attributes, loaded on first use so the first-load bundle does not
// carry it. Until Temml has loaded (or if the formula does not parse) the formula shows as its own source in a code span.
import DOMPurify, { type Config } from 'dompurify'
import MarkdownIt from 'markdown-it'
import type * as TemmlModule from 'temml'
import shortcodes from './emoji-shortcodes.json' with { type: 'json' }

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })

// ---- task lists (audit D34) ----------------------------------------------------------------------------------------
const TASK = /^\[([ xX])\](?=\s|$)\s?/
export const TASK_DONE = '\u2611' // ballot box with check
export const TASK_OPEN = '\u2610' // ballot box

md.core.ruler.after('inline', 'task_lists', (state) => {
  const t = state.tokens
  for (let i = 0; i < t.length; i++) {
    const open = t[i]
    if (open?.type !== 'list_item_open') continue
    // The item's first inline: directly after the open (tight list) or after a paragraph_open (loose list).
    const inline = t[i + 1]?.type === 'inline' ? t[i + 1] : t[i + 2]?.type === 'inline' ? t[i + 2] : undefined
    const first = inline?.children?.[0]
    if (!inline || !first || first.type !== 'text') continue
    const m = TASK.exec(first.content)
    if (!m) continue
    first.content = `${m[1] === ' ' ? TASK_OPEN : TASK_DONE} ${first.content.slice(m[0].length)}`
    open.attrJoin('class', m[1] === ' ' ? 'md-task md-task-open' : 'md-task md-task-done')
  }
  return true
})

// ---- emoji shortcodes ----------------------------------------------------------------------------------------------
// `:rocket:` becomes the emoji, in running text only. Names come from gemoji's list (MIT, see THIRD_PARTY_NOTICES.md), kept as a
// Map so a name such as "constructor" is never a hit. The result stays a text token, so the renderer escapes it like any other
// text: a shortcode can only ever add emoji characters, never markup. Code spans and blocks are other token types and are never
// visited; text inside a link (including bare URLs that linkify turned into links) is skipped; images and math carry their
// content outside text tokens.
const EMOJI = new Map<string, string>(Object.entries(shortcodes as Record<string, string>))
// not after a letter or digit and not before one, so IPv6 (fe80::ab:1) and 'a:on:off' stay as typed
const SHORTCODE = /(?<![A-Za-z0-9])(:)([a-z0-9_+-]{1,64}):(?![A-Za-z0-9])/g

/** `text` with each known `:name:` replaced by its emoji; unknown names, and everything else, exactly as typed. */
export function expandShortcodes(text: string): string {
  if (!text.includes(':')) return text
  return text.replace(SHORTCODE, (whole: string, _c: string, name: string) => EMOJI.get(name) ?? whole)
}

md.core.ruler.after('linkify', 'emoji_shortcodes', (state) => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue
    let inLink = 0
    for (const t of block.children) {
      if (t.type === 'link_open') inLink++
      else if (t.type === 'link_close') inLink--
      else if (t.type === 'text' && inLink === 0) t.content = expandShortcodes(t.content)
    }
  }
  return true
})

// ---- math (audit D34) ----------------------------------------------------------------------------------------------
const MAX_TEX = 2000
type Temml = typeof TemmlModule
let temml: Temml | null = null
let loading: Promise<void> | null = null
let mathVersion = 0
const mathListeners = new Set<() => void>()

/** Bumps when Temml finishes loading, so a view showing formula source can render again. */
export const getMathVersion = (): number => mathVersion
export function subscribeMath(l: () => void): () => void {
  mathListeners.add(l)
  return () => void mathListeners.delete(l)
}

function loadTemml(): void {
  if (temml || loading) return
  loading = import('temml')
    .then((m) => {
      temml = (m as unknown as { default?: Temml }).default ?? m
      mathVersion++
      for (const l of [...mathListeners]) l()
    })
    .catch(() => {
      loading = null // try again on the next formula
    })
}

const escapeHtml = (s: string) => md.utils.escapeHtml(s)

/** Each formula sits in its own box that scrolls sideways: WebKit lets a wide <math> push the whole timeline, and `overflow` on <math> itself is ignored there. */
const boxed = (html: string, display: boolean) =>
  `<span class="md-math${display ? ' md-math-display' : ''}">${html}</span>`

function renderTex(tex: string, display: boolean): string {
  if (tex.length > MAX_TEX) return source(tex, display)
  if (!temml) {
    loadTemml()
    return source(tex, display)
  }
  try {
    return boxed(
      temml.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: false,
        maxExpand: 200,
        maxSize: [20, 20],
      }),
      display,
    )
  } catch {
    return source(tex, display)
  }
}

const source = (tex: string, display: boolean) =>
  `<code class="md-math-src${display ? ' md-math-block' : ''}">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`

/** `$...$` and `$$...$$` inside a paragraph. Pandoc's rules, tightened: no space just inside the `$`, and no letter or digit right after the closing one, so "$5 and $10" is money and "$HOME/$USER" is a path. */
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const src = state.src
  const start = state.pos
  if (src.charCodeAt(start) !== 0x24) return false
  const display = src.charCodeAt(start + 1) === 0x24
  const open = display ? 2 : 1
  const first = src.charCodeAt(start + open)
  if (Number.isNaN(first)) return false
  // `$$ x $$` may have blanks just inside (pandoc's rule is for the single `$`, where "$5 and $10" must stay money).
  if (!display && (first === 0x20 || first === 0x0a || first === 0x09 || first === 0x24)) return false
  let end = start + open
  while (end < src.length) {
    const c = src.charCodeAt(end)
    if (c === 0x5c) {
      end += 2
      continue
    }
    if (c === 0x24 && (!display || src.charCodeAt(end + 1) === 0x24)) break
    end++
  }
  if (end >= src.length) return false
  const body = src.slice(start + open, end)
  const before = src.charCodeAt(end - 1)
  const after = src.charCodeAt(end + open)
  if (body.length === 0 || body.length > MAX_TEX) return false
  // A closing `$` followed by a letter or digit is not a closer: "$HOME/$USER" and "PATH=$HOME/bin:$PATH" are shell, not maths.
  const word = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
  if (!display && (before === 0x20 || before === 0x0a || before === 0x09 || word(after))) return false
  if (!silent) {
    const tok = state.push('math', '', 0)
    tok.content = body
    tok.markup = display ? '$$' : '$'
  }
  state.pos = end + open
  return true
})

/** A `$$` line opens a display formula that runs to the next `$$` line (or the same line, `$$ x $$`). It can end a paragraph, a quote or a list item, so "The formula is:\n$$" does not swallow it. */
md.block.ruler.before(
  'fence',
  'math_block',
  (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine]! + state.tShift[startLine]!
    const max = state.eMarks[startLine]!
    if (state.sCount[startLine]! - state.blkIndent >= 4) return false
    if (state.src.slice(pos, pos + 2) !== '$$') return false
    let body = state.src.slice(pos + 2, max)
    let next = startLine
    let closed = false
    if (body.trimEnd().endsWith('$$') && body.trim().length > 2) {
      body = body.trimEnd().slice(0, -2)
      closed = true
    } else {
      while (++next < endLine) {
        const line = state.src.slice(state.bMarks[next]! + state.tShift[next]!, state.eMarks[next]!)
        if (line.trimEnd().endsWith('$$')) {
          body += `\n${line.trimEnd().slice(0, -2)}`
          closed = true
          break
        }
        body += `\n${line}`
      }
    }
    if (!closed || body.trim() === '') return false
    if (silent) return true
    state.line = next + 1
    const tok = state.push('math_block', '', 0)
    tok.content = body.trim()
    tok.map = [startLine, state.line]
    tok.markup = '$$'
    return true
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
)

md.renderer.rules.math = (tokens, i) => renderTex(tokens[i]!.content, tokens[i]!.markup === '$$')
md.renderer.rules.math_block = (tokens, i) => `${renderTex(tokens[i]!.content, true)}\n`

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

md.validateLink = (url) => {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url, 'https://invalid.example').protocol)
  } catch {
    return false
  }
}

// MathML Core presentation elements only. Deliberately absent: maction (statusline and toggle actions), mglyph (loads an image),
// semantics and annotation-xml (carry foreign content), ms. `style` survives only on MathML elements and only as a short list of
// box properties with plain lengths (see `cleanStyle`); no `href` or `xlink:href` on any of them (the afterSanitizeAttributes
// hook below removes `href` from everything but <a>). Lengths over MAX_EM are dropped, so TeX cannot paint outside its message.
const MATHML_TAGS = [
  'math',
  'mrow',
  'mi',
  'mn',
  'mo',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mover',
  'munder',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'menclose',
  'mpadded',
  'mphantom',
  'mstyle',
  'mmultiscripts',
  'mprescripts',
]
const MATHML_ATTRS = [
  'display',
  'displaystyle',
  'scriptlevel',
  'mathvariant',
  'stretchy',
  'symmetric',
  'fence',
  'form',
  'separator',
  'accent',
  'accentunder',
  'movablelimits',
  'largeop',
  'lspace',
  'rspace',
  'minsize',
  'maxsize',
  'linethickness',
  'notation',
  'columnalign',
  'rowalign',
  'columnspacing',
  'rowspacing',
  'columnlines',
  'rowlines',
  'width',
  'height',
  'depth',
  'voffset',
  'mathcolor',
  'mathbackground',
]

// ---- lengths and style on MathML ----------------------------------------------------------------------------------------
/** The biggest length a formula may ask for, in em. Temml's `maxSize` clamps only positive sizes; `\raisebox{-300em}` and `\rule[-300em]` get past it. */
const MAX_EM = 20
const EM_PER: Record<string, number> = {
  '': 1,
  em: 1,
  ex: 0.5,
  rem: 1,
  pt: 1 / 12,
  px: 1 / 16,
  pc: 1,
  mu: 1 / 18,
  cm: 2.4,
  mm: 0.24,
  in: 6,
  '%': 0.01,
}
const MATHML_SET = new Set(MATHML_TAGS)
const LENGTH_ATTRS = ['width', 'height', 'depth', 'voffset', 'lspace', 'rspace', 'minsize', 'maxsize']
const NUM_UNIT = /([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)/gi

/** True when every number-with-unit in `value` is within MAX_EM. An unknown unit counts as too big. */
function lengthsOk(value: string): boolean {
  for (const m of value.matchAll(NUM_UNIT)) {
    const per = EM_PER[(m[2] ?? '').toLowerCase()]
    if (per === undefined || Math.abs(Number(m[1])) * per > MAX_EM) return false
  }
  return true
}

const STYLE_PROPS =
  /^(?:padding(?:-(?:left|right|top|bottom))?|border(?:-(?:left|right|top|bottom))?(?:-(?:width|style))?|math-depth|math-style)$/
const SAFE_VALUE = /^[a-z0-9.,%+\-\s#]*$/i

/** Keeps only box properties with plain values (Temml's \boxed, \hline, column padding); anything else, and anything huge, goes. */
function cleanStyle(style: string): string {
  const out: string[] = []
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (!STYLE_PROPS.test(prop) || !SAFE_VALUE.test(value) || !lengthsOk(value)) continue
    out.push(`${prop}:${value}`)
  }
  return out.join(';')
}

const COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i

function cleanMathNode(node: Element): void {
  const style = node.getAttribute('style')
  if (style !== null) {
    const clean = cleanStyle(style)
    if (clean) node.setAttribute('style', clean)
    else node.removeAttribute('style')
  }
  for (const a of LENGTH_ATTRS) {
    const v = node.getAttribute(a)
    if (v === null) continue
    const t = v.trim()
    if (/^[a-z]+$/i.test(t)) continue // a named space such as "thinmathspace"
    if (!lengthsOk(t) || !/^[+-]?[\d.]+[a-z%]*$/i.test(t)) node.removeAttribute(a)
  }
  for (const a of ['mathcolor', 'mathbackground']) {
    const v = node.getAttribute(a)
    if (v !== null && !COLOR.test(v.trim())) node.removeAttribute(a)
  }
}

const SANITIZE: Config = {
  ALLOWED_TAGS: [
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
    'span',
    ...MATHML_TAGS,
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'style', ...MATHML_ATTRS],
  // MathML attributes hold lengths, keywords and booleans, never URLs: without this DOMPurify tests each value against the
  // link pattern below and drops `display="block"` and the like.
  ADD_URI_SAFE_ATTR: [...MATHML_ATTRS, 'style'],
  // markdown-it emits no data-* attributes; none are wanted from anywhere else either.
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  RETURN_DOM_FRAGMENT: false,
}

let hooked = false
function hookOnce() {
  if (hooked) return
  hooked = true
  // An image is never loaded: `img` is not an allowed tag, and before it would be dropped it becomes a link chip the
  // reader can tap (an agent's text cannot trigger a remote fetch just by being shown).
  DOMPurify.addHook('beforeSanitizeElements', (node) => {
    if (node.nodeType !== 1 || (node as Element).tagName !== 'IMG') return
    const img = node as Element
    const src = img.getAttribute('src') ?? ''
    const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim()
    const text = `Image: ${alt ? (alt.length > 60 ? `${alt.slice(0, 59)}…` : alt) : 'open'}`
    // An image inside a link (a badge): the link keeps its real destination and just gets the label.
    if (img.parentElement?.closest('a')) {
      img.parentNode?.replaceChild(img.ownerDocument.createTextNode(text), img)
      return
    }
    const a = img.ownerDocument.createElement('a')
    if (/^https?:/i.test(src)) a.setAttribute('href', src)
    a.setAttribute('class', 'md-image-chip')
    a.setAttribute('title', alt || src)
    a.textContent = text
    img.parentNode?.replaceChild(a, img)
  })
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // `href` is only a link on <a>. MathML elements take one too, and a formula must never become a link.
    if (node.tagName !== 'A' && node.hasAttribute('href')) node.removeAttribute('href')
    // `style` is for MathML only; on anything else it goes. MathML nodes get their lengths and style checked.
    if (MATHML_SET.has(node.localName)) cleanMathNode(node)
    else if (node.hasAttribute('style')) node.removeAttribute('style')
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (!/^(?:https?:|mailto:)/i.test(href)) {
        node.removeAttribute('href')
        return
      }
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/** The allow-list pass on its own, for tests that feed it hostile HTML directly. */
export function sanitizeMarkdownHtml(html: string): string {
  hookOnce()
  return String(DOMPurify.sanitize(html, SANITIZE))
}

/** Renders markdown to sanitized HTML. Safe to hand to `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string): string {
  return sanitizeMarkdownHtml(md.render(source))
}

/** The block tokens of a message, from the same parser that draws it (the Run button reads its code blocks from here). */
export const parseMarkdown = (source: string) => md.parse(source, {})

/** Test only: Temml is loaded (resolves once it has) so a formula renders as MathML instead of its source. */
export async function __loadMathForTests(): Promise<void> {
  loadTemml()
  await loading
}
