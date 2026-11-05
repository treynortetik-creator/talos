// Pure helpers for the memory browser: titles, frontmatter, links. No file access.
import { posix } from 'node:path'
import { type MemoryLinkT, type RawLink, scanLinks } from '@talos-app/protocol'

/** The frontmatter block at the top of a note, and the body after it. */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { front: '', body: text }
  return { front: m[1] as string, body: text.slice(m[0].length) }
}

/** `title:` from frontmatter, else the first `# ` heading, else the file name. */
export function titleOf(text: string, fileName: string): string {
  const { front, body } = splitFrontmatter(text)
  const t = /^title:\s*(.+?)\s*$/im
    .exec(front)?.[1]
    ?.replace(/^["']|["']$/g, '')
    .trim()
  if (t) return t.slice(0, 200)
  const h = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim()
  if (h) return h.slice(0, 200)
  return fileName.replace(/\.[^.]+$/, '').slice(0, 200)
}

export type { RawLink }

/**
 * `[[name]]`, `[[name|alias]]` and `[text](relative.md)`, each distinct link once, in the order it first appears. Links in
 * code (fenced, indented or inline) are not links. The rule lives in the protocol package so the app reads a note the
 * same way; see `scanLinks` there.
 */
export const extractLinks = (text: string, max = 5000): RawLink[] => scanLinks(text, max)

export type FileIndex = {
  /** Every visible file, per root. */
  has(rootId: string, path: string): boolean
  /** Visible paths of one root. */
  paths(rootId: string): Iterable<string>
  rootIds(): string[]
}

/** A normalised path that leaves the root (`..`, `../x`) or is absolute. A file called `..notes.md` is not one. */
const climbs = (p: string) => p === '..' || p.startsWith('../') || p.startsWith('/')

const stem = (p: string) => p.toLowerCase().replace(/\.(md|markdown|txt)$/, '')

/** Directory distance: shared leading folders first (more = nearer), then shorter path, then name. */
function nearness(from: string, cand: string): [number, number, string] {
  const a = from.split('/').slice(0, -1)
  const b = cand.split('/').slice(0, -1)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  // distance = steps up from `from` plus steps down to `cand`
  return [a.length - i + (b.length - i), b.length, cand]
}

/**
 * Resolves each link against VISIBLE files only, so a link to a hidden note is `path:null`, the same as a missing one.
 * `[[name]]`: the first visible `name.md` (or `a/b.md` for `[[a/b]]`) in this root, nearest folder first, then the other
 * roots. Relative links resolve against the note's folder and must stay inside the root.
 */
export function resolveLinks(
  links: RawLink[],
  from: { rootId: string; path: string },
  index: FileIndex,
  visible: (rootId: string, path: string) => boolean,
): MemoryLinkT[] {
  const out: MemoryLinkT[] = []
  const better = (x: [number, number, string], y: [number, number, string]) =>
    x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2]
  const findIn = (rootId: string, want: string): string | null => {
    let best: { key: [number, number, string]; path: string } | null = null
    for (const p of index.paths(rootId)) {
      const s = stem(p)
      if (s !== want && !s.endsWith(`/${want}`)) continue
      const key = nearness(rootId === from.rootId ? from.path : '', p)
      if (!best || better(key, best.key)) best = { key, path: p }
    }
    return best?.path ?? null
  }
  for (const l of links) {
    let rootId: string | null = null
    let path: string | null = null
    if (l.kind === 'wiki') {
      const raw = l.target.replace(/\\/g, '/').replace(/^\/+/, '')
      if (/^\.{1,2}(\/|$)/.test(raw)) {
        // `[[../people/foo]]`: relative to this note's folder, exact path, and never out of the root
        const joined = posix.normalize(posix.join(posix.dirname(from.path), raw))
        if (!climbs(joined) && joined !== '.') {
          const want = stem(joined)
          for (const p of index.paths(from.rootId)) {
            if (stem(p) === want) {
              rootId = from.rootId
              path = p
              break
            }
          }
        }
      } else {
        const norm = posix.normalize(raw)
        // `a/../b` inside the name is fine; one that climbs out is not a name at all
        const want = climbs(norm) ? null : stem(norm)
        const order = [from.rootId, ...index.rootIds().filter((r) => r !== from.rootId)]
        for (const r of order) {
          const hit = want === null ? null : findIn(r, want)
          if (hit) {
            rootId = r
            path = hit
            break
          }
        }
      }
    } else {
      const joined = posix.normalize(posix.join(posix.dirname(from.path), l.target))
      if (!climbs(joined) && index.has(from.rootId, joined)) {
        rootId = from.rootId
        path = joined
      }
    }
    // the final gate: whatever was found must pass the full check (deny, private, include, exclude) right now
    if (rootId && path && !visible(rootId, path)) {
      rootId = null
      path = null
    }
    out.push({ text: l.text.slice(0, 200), root_id: rootId, path })
  }
  return out
}

/** Whole links, in order, that fit `maxBytes` of encoded JSON (each counted with its comma). */
export function capLinks(links: MemoryLinkT[], maxBytes: number): MemoryLinkT[] {
  const kept: MemoryLinkT[] = []
  let bytes = 0
  for (const l of links) {
    const b = Buffer.byteLength(JSON.stringify(l), 'utf8') + 1
    if (bytes + b > maxBytes) break
    bytes += b
    kept.push(l)
  }
  return kept
}
