// Long Markdown is drawn in pieces (0.18): one piece is about a screen, so a phone parses and sanitizes a screenful at a time and
// a growing reply only draws its last piece again. The cutting is lib/markdownChunks.ts; this is the glue the renderer uses.
import { LARGE_MARKDOWN_CHUNK_MAX_CHARS, splitMarkdown, withMarkdownDefinitions } from '../../lib/markdownChunks.ts'

/** Text up to this long is drawn whole, exactly as before (twice the target size of a piece). */
export const CHUNK_THRESHOLD_CHARS = 8 * 1024

/** `source` is a piece too large to parse: it is shown as its text. */
export type Piece = { text: string; source: boolean }

/** The pieces of `text`, or null when it is short enough to draw whole. */
export function markdownPieces(text: string, threshold = CHUNK_THRESHOLD_CHARS): Piece[] | null {
  if (text.length <= threshold) return null
  // Line ends are normalised the way the Run button reads them, so a piece and the parsed blocks agree.
  const { chunks, definitions } = splitMarkdown(text.replace(/\r\n?/g, '\n'))
  return chunks.map((c) =>
    c.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS
      ? { text: c.text, source: true }
      : { text: withMarkdownDefinitions(c.text, definitions), source: false },
  )
}

/** Draws each piece to HTML (a source piece draws nothing here), reusing what `cache` holds for a piece's exact text. */
export function renderPieces(
  pieces: readonly Piece[],
  draw: (text: string) => string,
  cache: Map<string, string>,
): string[] {
  const used = new Set<string>()
  const out = pieces.map((p) => {
    if (p.source) return ''
    used.add(p.text)
    let html = cache.get(p.text)
    if (html === undefined) {
      html = draw(p.text)
      cache.set(p.text, html)
    }
    return html
  })
  for (const key of cache.keys()) if (!used.has(key)) cache.delete(key)
  return out
}
