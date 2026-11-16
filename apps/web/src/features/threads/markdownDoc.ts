// The .md viewer's data side: what counts as a Markdown attachment, the sibling-image map, the outline and the chunking for big files.
import type { AttachmentRefT } from '@talos-app/protocol'
import type { MdImages } from '../../lib/markdown.ts'
import { mediaUrl } from './media.ts'

/** A file bigger than this is cut into chunks and drawn as the reader scrolls (never all at once). */
export const LARGE_BYTES = 1024 * 1024
/** About this much source per chunk (a chunk ends at the first blank line outside a code fence after it). */
export const CHUNK_BYTES = 64 * 1024

export const isMarkdownAtt = (a: AttachmentRefT): boolean =>
  a.kind === 'file' && (/^text\/(x-)?markdown\b/i.test(a.mime) || /\.(md|markdown)$/i.test(a.name))

/** Bare file name -> `/media/:id` of every image attachment of the same message. Nothing else can ever be shown as an image. */
export function siblingImages(self: AttachmentRefT, all: readonly AttachmentRefT[]): MdImages {
  const m = new Map<string, string>()
  for (const a of all)
    if (a.kind === 'image' && a.media_id !== self.media_id) m.set(a.name, `${mediaUrl(a.media_id)}?c=2`)
  return m
}

export type Chunk = { text: string; firstHeading: number }
export type Heading = { level: number; text: string; index: number; chunk: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

/** Plain text of a heading line: inline markers and link syntax removed, enough for an outline label. */
const label = (s: string) =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()

/**
 * Cuts the source into chunks and lists the headings, in one pass over the lines (cheap enough for tens of MB; the parser
 * only ever sees one chunk). A chunk never ends inside a fenced block. Under LARGE_BYTES there is one chunk.
 */
export function splitDoc(src: string, chunkBytes = CHUNK_BYTES): { chunks: Chunk[]; headings: Heading[] } {
  const lines = src.split('\n')
  const chunks: Chunk[] = []
  const headings: Heading[] = []
  const whole = src.length <= LARGE_BYTES
  let buf: string[] = []
  let size = 0
  let fence: string | null = null
  let start = 0
  const flush = () => {
    chunks.push({ text: buf.join('\n'), firstHeading: start })
    buf = []
    size = 0
    start = headings.length
  }
  for (const line of lines) {
    const f = FENCE.exec(line)
    if (f) {
      const mark = f[1] as string
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
    } else if (fence === null) {
      const h = HEADING.exec(line)
      if (h)
        headings.push({
          level: (h[1] as string).length,
          text: label(h[2] as string),
          index: headings.length,
          chunk: chunks.length,
        })
    }
    buf.push(line)
    size += line.length + 1
    if (!whole && fence === null && size >= chunkBytes && line.trim() === '') flush()
  }
  if (buf.length || chunks.length === 0) flush()
  return { chunks, headings }
}
