// Adapted from t3code packages/shared/src/markdownChunks.ts, commit a22a4f9b.
// MIT, Copyright (c) 2026 T3 Tools Inc. Licence text: THIRD_PARTY_NOTICES.md.
// Changes: reformatted for Biome (single quotes, no semicolons); the two interfaces are no longer exported (nothing imports
// them by name). The splitting logic is unchanged. Ours: withMarkdownDefinitions puts the definitions before a block a piece
// opened and has not closed (a fence a growing reply is still writing), not inside it.
// About one screen of rendered Markdown; parsing costs up to ~40 ms per KB with tables and math.
const CHUNK_TARGET_CHARS = 4 * 1024
// A chunk past this (one huge fence or HTML block) is too slow to parse at once; show source.
export const LARGE_MARKDOWN_CHUNK_MAX_CHARS = 128 * 1024
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_OPEN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/
const ATX_HEADING = /^#{1,6}(?:[ \t]|\r?$)/
// A thematic break, or a "---" setext underline; no paragraph stays open after either. A lone
// "===" is paragraph text unless it underlines one, so it is left out.
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/
// A column-0 paragraph, quote or table after a blank line closes any open list, quote or table.
const BLOCK_START = /^[\p{L}\p{N}`[!|>]/u
const ORDERED_ITEM = /^\d{1,9}[.)](?:[ \t]|\r?$)/
// CommonMark HTML blocks of types 1-5 and display math run past blank lines until their closer.
const SPANNING_BLOCKS: ReadonlyArray<readonly [open: RegExp, close: RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  // "<!-->" and "<!--->" close themselves, so the closer is searched from just after "<!".
  [/^ {0,3}<!(?=--)/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}\$\$/, /\$\$/],
]

// A tag name, not an autolink such as <https://example.com>.
const HTML_BLOCK_START = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)/
const closesAtBlankLine = (next: string) => next.trim() === ''

// A <details> or <table> wraps the Markdown between its tags, across the blank lines that end
// each HTML block, so a cut waits until the ones an HTML block opened are closed.
const WRAPPER_TAG = /<(\/?)(?:details|table)(?=[\s/>]|$)/gi
// An end tag that never comes, or back-to-back wrappers, must not make one huge piece.
const WRAPPED_MAX_CHARS = 32 * 1024

function withoutComments(line: string): string {
  let kept = ''
  let at = 0
  for (let open = line.indexOf('<!--'); open !== -1; open = line.indexOf('<!--', at)) {
    const close = line.indexOf('-->', open + 4)
    if (close === -1) break
    kept += line.slice(at, open)
    at = close + 3
  }
  return kept + line.slice(at)
}

function openedWrappers(line: string): number {
  let opened = 0
  for (const [, closing] of withoutComments(line).matchAll(WRAPPER_TAG)) {
    opened += closing ? -1 : 1
  }
  return opened
}

/** Returns how to recognize the end of a block that `line` opens, or null for none. */
function blockCloser(line: string): ((line: string) => boolean) | null {
  const fence = FENCE_OPEN.exec(line)?.[1]
  if (fence) {
    return (next) => {
      const closer = FENCE_OPEN.exec(next)?.[1]
      return (
        closer !== undefined &&
        closer[0] === fence[0] &&
        closer.length >= fence.length &&
        !next.trim().slice(closer.length)
      )
    }
  }
  for (const [open, close] of SPANNING_BLOCKS) {
    const opener = open.exec(line)?.[0]
    if (opener === undefined) continue
    return close.test(line.slice(opener.length)) ? null : (next) => close.test(next)
  }
  // Other HTML blocks (CommonMark types 6 and 7) run until a blank line.
  return HTML_BLOCK_START.test(line) ? closesAtBlankLine : null
}

interface MarkdownChunk {
  readonly text: string
  readonly lines: number
}

const FRONTMATTER_OPEN = /^\uFEFF?---[ \t]*\r?$/
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/
// An opening rule with no closer is a thematic break, not frontmatter; stop waiting for one.
const FRONTMATTER_MAX_LINES = 1000

// A one-line link reference definition; footnotes are left alone so each piece does not grow
// a footnote section.
const LINK_DEFINITION =
  /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(?:<[^<>\n]*>|[^\s<]\S*)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\r?$/
// Definitions past this are not repeated into every piece; their parse cost would outweigh links.
const SHARED_DEFINITIONS_MAX_CHARS = 16 * 1024

interface SplitMarkdown {
  readonly chunks: readonly MarkdownChunk[]
  readonly definitions: string
}

/**
 * Cuts Markdown into pieces of roughly `targetChars`, only at column-0 headings or paragraphs
 * that start a new top-level block. Leading frontmatter stays in the first piece. Link
 * definitions are collected so every piece can resolve them; footnotes resolve only inside their
 * own piece, and duplicate heading slugs restart per piece.
 */
export function splitMarkdown(text: string, targetChars = CHUNK_TARGET_CHARS): SplitMarkdown {
  const chunks: MarkdownChunk[] = []
  const definitions: string[] = []
  let lines: string[] = []
  let first = true
  let chars = 0
  let closes: ((line: string) => boolean) | null = null
  let afterBlankLine = false
  let afterDefinition = false
  let afterHeading = false
  let openedFence = false
  let definitionChars = 0
  let openWrappers = 0
  let heldCut = 0
  const flush = () => {
    chunks.push({ text: lines.join('\n'), lines: lines.length })
    lines = []
    chars = 0
    heldCut = 0
  }
  for (const line of text.split('\n')) {
    if (closes !== null) {
      if (closes(line)) closes = null
    } else if (first && FRONTMATTER_OPEN.test(line)) {
      let seen = 0
      closes = (next) => FRONTMATTER_CLOSE.test(next) || ++seen >= FRONTMATTER_MAX_LINES
    } else {
      if (chars >= WRAPPED_MAX_CHARS) openWrappers = 0
      const cutPoint =
        chars >= targetChars &&
        (ATX_HEADING.test(line) || (afterBlankLine && BLOCK_START.test(line) && !ORDERED_ITEM.test(line)))
      if (cutPoint && openWrappers === 0) flush()
      else if (cutPoint) heldCut = lines.length
      closes = blockCloser(line)
      // An indented fence may sit in a list item, which this does not track.
      openedFence = /^[`~]/.test(line) && FENCE_OPEN.test(line)
      // A definition cannot interrupt a paragraph, so it follows a blank line, a heading,
      // a closing code fence or another definition.
      const definition: boolean =
        (first || afterBlankLine || afterDefinition || afterHeading) && LINK_DEFINITION.test(line)
      afterDefinition = definition
      if (definition && definitionChars + line.length < SHARED_DEFINITIONS_MAX_CHARS) {
        definitions.push(line.trim())
        definitionChars += line.length + 1
      }
    }
    if (closes === closesAtBlankLine) openWrappers = Math.max(0, openWrappers + openedWrappers(line))
    first = false
    lines.push(line)
    chars += line.length + 1
    // A piece too large to render goes back to the last cut a wrapper held.
    if (heldCut > 0 && chars - 1 > LARGE_MARKDOWN_CHUNK_MAX_CHARS) {
      const rest = lines.splice(heldCut)
      flush()
      lines = rest
      chars = rest.reduce((sum, kept) => sum + kept.length + 1, 0)
      openWrappers = 0
    }
    afterBlankLine = line.trim() === ''
    afterHeading = closes === null && (openedFence || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line))
  }
  flush()
  return { chunks, definitions: definitions.join('\n') }
}

/** Appends shared link definitions after a piece, leaving its own offsets unchanged. */
export function withMarkdownDefinitions(text: string, definitions: string): string {
  if (!definitions) return text
  // A piece that ends inside a block it opened and has not closed (a fence a growing reply is still writing) would take the
  // definitions as that block's own text: they go just before the block instead, so links above it in the piece keep theirs.
  const open = openBlockStart(text)
  if (open === null) return `${text}\n\n${definitions}`
  const lines = text.split('\n')
  const before = lines.slice(0, open).join('\n').replace(/\n+$/, '')
  return `${before ? `${before}\n\n` : ''}${definitions}\n\n${lines.slice(open).join('\n')}`
}

/** The line where `text` opens a fence or other spanning block it does not close, or null when it ends outside any. */
function openBlockStart(text: string): number | null {
  let close: ((line: string) => boolean) | null = null
  let start = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (close) {
      if (close(line)) close = null
      continue
    }
    close = blockCloser(line)
    if (close) start = i
  }
  // An HTML block that ends at a blank line is closed by the blank line the definitions come after.
  return close !== null && close !== closesAtBlankLine ? start : null
}
