// One rule for "what is a link in a note", shared by the bridge (which lists the links) and the app (which matches its
// own reading of the note against that list). No file access, no DOM. The scan is one pass over the text, and block
// nesting is capped at MAX_NESTING levels (the cap markdown-it applies), so a hostile note costs time in proportion to its
// size times that fixed cap, and no more. Deeper containers are read as plain paragraph text.
//
// The scanner reads a note the way a CommonMark renderer does, as far as links care:
//   - fenced blocks (``` or ~~~, any length, closed by the same character at least as long, or by the end of the note),
//   - indented code (4 spaces) that is not a continuation of a paragraph,
//   - inline `code spans` (a run of backticks closed by a run of the same length, inside one paragraph or table cell),
//   - list items, block quotes and table rows as their own paragraphs, and `\` escapes,
// and it lists `[[name]]`, `[[name|alias]]` and `[text](relative.md)` that sit outside all of that, once each, in the order
// they first appear. The app does not trust this to agree with its renderer: it only uses the result to decide which
// entry of the bridge's list belongs to which link, and a link it cannot place stays plain text (see `planLinks`).

export type RawLink = { text: string; kind: 'wiki' | 'rel'; target: string }

/** The identity of a link: two copies with the same key are one entry in the list. */
export const linkKey = (l: RawLink) => `${l.kind}\0${l.text}\0${l.target}`

/** `[[name]]` or `[[name|alias]]`; no brackets, no line break, no bar in the name. */
export const WIKI_SOURCE = String.raw`\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]`
/** `[label](target)` or `[label](target "title")`. A label has no brackets; an image (`!` before) is not a link. */
const REL_SOURCE = String.raw`(?<!!)\[([^[\]\n]{1,200})\]\(([^()\s]{1,400})(?:[ \t]+"[^"\n]{0,300}")?\)`
const REL_INNER = /^([^()\s]{1,400})(?:[ \t]+"[^"\n]{0,300}")?$/
const REL_LABEL = /^[^[\]\n]{1,200}$/

/** A wiki link from the two halves of `[[name|alias]]`, or null when it names nothing (`[[#heading]]`). */
export function wikiLink(name: string, alias?: string): RawLink | null {
  // a table cell writes the alias bar as `\|`; the backslash is not part of the name
  const target = name.split('#')[0]?.trim().replace(/\\+$/, '').trim() ?? ''
  return target ? { kind: 'wiki', target, text: alias ?? name } : null
}

/** A relative note link from `label` and what sits between the parentheses, or null when it is not one the Mac lists. */
export function relLink(label: string, inner: string): RawLink | null {
  if (!REL_LABEL.test(label)) return null
  const m = REL_INNER.exec(inner)
  if (!m) return null
  const raw = (m[1] as string).split('#')[0] ?? ''
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null
  let target = raw
  try {
    target = decodeURI(raw)
  } catch {
    // keep it raw
  }
  return /\.(md|markdown|txt)$/i.test(target) ? { kind: 'rel', target, text: label } : null
}

// ---- frontmatter ---------------------------------------------------------------------------------------------------

/** The frontmatter block at the top of a note, and the body after it. */
export function splitNote(text: string): { front: string; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { front: '', body: text }
  return { front: m[1] as string, body: text.slice(m[0].length) }
}

/** Frontmatter as `key: value` rows (one line each; a YAML list joins with commas, nested YAML is shown as raw text). */
export function frontmatterRows(front: string): Array<[string, string]> {
  // each row collects its pieces and joins them once at the end, so a long YAML list costs time in proportion to its size
  const rows: Array<{ key: string; parts: string[]; any: boolean }> = []
  for (const line of front.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_][\w .-]{0,40}):\s*(.*)$/.exec(line)
    if (kv) {
      const v = (kv[2] as string).replace(/^["']|["']$/g, '')
      rows.push({ key: kv[1] as string, parts: [v], any: v !== '' })
    } else if (rows.length && (/^\s+\S/.test(line) || /^-\s/.test(line))) {
      const last = rows[rows.length - 1] as { key: string; parts: string[]; any: boolean }
      const item = /^\s*-\s+(.*)$/.exec(line)
      if (item) {
        // a YAML list item (indented or not) joins the value with a comma, without its dash or quotes
        const t = (item[1] as string).trim().replace(/^["']|["']$/g, '')
        if (t) {
          last.parts.push(last.any ? `, ${t}` : t)
          last.any = true
        }
      } else {
        last.parts.push(last.any ? ` ${line.trim()}` : line.trim())
        last.any = true
      }
    }
  }
  return rows.map((r) => [r.key, r.parts.join('')])
}

// ---- the scanner ---------------------------------------------------------------------------------------------------

const MASK = 1 // stands in for a character that cannot start or end a link
const isWs = (c: number) => c === 32 || c === 9
const isPunct = (c: number) =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)

/**
 * Backslash escapes and code spans of one paragraph (or table cell), as ranges into `v`. A backtick run closes the
 * nearest later run of exactly its own length; a backslash before the first backtick of a run makes that backtick plain.
 * One pass: the "next run of this length" lookup only ever moves forward.
 */
function inlineCode(v: string): { spans: Array<[number, number]>; escapes: number[] } {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < v.length; ) {
    if (v.charCodeAt(i) !== 96) {
      i++
      continue
    }
    let j = i
    while (j < v.length && v.charCodeAt(j) === 96) j++
    runs.push([i, j])
    i = j
  }
  const spans: Array<[number, number]> = []
  const escapes: number[] = []
  if (!runs.length) {
    for (let i = 0; i < v.length; i++) {
      if (v.charCodeAt(i) === 92 && i + 1 < v.length && isPunct(v.charCodeAt(i + 1))) {
        if (v.charCodeAt(i + 1) !== 124) escapes.push(i)
        i++
      }
    }
    return { spans, escapes }
  }
  const byLen = new Map<number, { at: number[]; cur: number }>()
  runs.forEach((r, idx) => {
    const len = r[1] - r[0]
    const e = byLen.get(len) ?? { at: [], cur: 0 }
    e.at.push(idx)
    byLen.set(len, e)
  })
  let p = 0 // the first run that ends after i
  let i = 0
  while (i < v.length) {
    const c = v.charCodeAt(i)
    if (c === 92 && i + 1 < v.length && isPunct(v.charCodeAt(i + 1))) {
      if (v.charCodeAt(i + 1) !== 124) escapes.push(i)
      i += 2
      continue
    }
    if (c !== 96) {
      i++
      continue
    }
    while ((runs[p] as [number, number])[1] <= i) p++
    const run = runs[p] as [number, number]
    const len = run[1] - i // an escaped first backtick leaves a shorter run
    const e = byLen.get(len)
    let q = -1
    if (e) {
      while (e.cur < e.at.length && (e.at[e.cur] as number) <= p) e.cur++
      if (e.cur < e.at.length) q = e.at[e.cur] as number
    }
    if (q < 0) {
      i = run[1]
      p++
      continue
    }
    const end = (runs[q] as [number, number])[1]
    spans.push([i, end])
    i = end
    p = q + 1
  }
  return { spans, escapes }
}

const WIKI_STICKY = new RegExp(WIKI_SOURCE, 'y')

/**
 * Where a wiki link `[[name|alias]]` that starts at `at` ends (exclusive), or -1. A table cell does not split at the bar
 * inside one; the app's renderer protects the same spans before the markdown reader splits cells (see `logic.ts`).
 */
export function wikiSpanEnd(text: string, at: number, limit = text.length): number {
  if (text.charCodeAt(at) !== 91 || text.charCodeAt(at + 1) !== 91) return -1
  WIKI_STICKY.lastIndex = at
  const m = WIKI_STICKY.exec(text)
  return m && at + m[0].length <= limit ? at + m[0].length : -1
}

/** Cells of one table row, as ranges: split at a `|` that is neither escaped nor inside `[[..]]`, empty first and last cell dropped. */
function cellRanges(text: string, a: number, b: number): Array<[number, number]> {
  while (a < b && isWs(text.charCodeAt(a))) a++
  while (b > a && isWs(text.charCodeAt(b - 1))) b--
  const out: Array<[number, number]> = []
  let from = a
  let escaped = false
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i)
    if (c === 91) {
      const e = wikiSpanEnd(text, i, b)
      if (e > 0) {
        i = e - 1
        escaped = false
        continue
      }
    }
    if (c === 124 && !escaped) {
      out.push([from, i])
      from = i + 1
    }
    escaped = c === 92
  }
  out.push([from, b])
  if (out.length && (out[0] as [number, number])[0] === (out[0] as [number, number])[1]) out.shift()
  if (out.length && (out[out.length - 1] as [number, number])[0] === (out[out.length - 1] as [number, number])[1])
    out.pop()
  return out
}

/** `| --- | :-: |` style delimiter row: how many columns, or 0 when the line is not one. */
function delimiterColumns(text: string, a: number, b: number): number {
  const s = text.slice(a, b)
  if (!/^[|:\- \t]+$/.test(s)) return 0
  const f = s.trimStart()
  if (!/^[|:-]/.test(f) || (f[0] === '-' && f.length > 1 && isWs(f.charCodeAt(1)))) return 0
  const cols = s.split('|')
  let n = 0
  for (let i = 0; i < cols.length; i++) {
    const t = (cols[i] as string).trim()
    if (!t) {
      if (i === 0 || i === cols.length - 1) continue
      return 0
    }
    if (!/^:?-+:?$/.test(t)) return 0
    n++
  }
  return n
}

type Cont = { quote: boolean; off: number }

/** How deep blocks nest before the rest is plain text: markdown-it's own `maxNesting`, so both sides give up at the same depth. */
export const MAX_NESTING = 100

/** Replaces everything that is not inline text with MASK; code spans and escapes inside inline text too. */
function maskNote(text: string): string {
  const n = text.length
  const m = new Uint16Array(n)
  for (let i = 0; i < n; i++) m[i] = text.charCodeAt(i) === 10 ? 10 : MASK

  /** Inline text: unmask the segments, then mask the escapes and code spans found in them. */
  const inline = (segs: Array<[number, number]>) => {
    if (!segs.length) return
    let v = ''
    const starts: number[] = []
    for (const [a, b] of segs) {
      starts.push(v.length)
      v += `${text.slice(a, b)}\n`
      for (let i = a; i < b; i++) m[i] = text.charCodeAt(i)
      // the characters just outside (a table's `|`, a list marker) end the unit: no link runs across them
      if (a > 0 && m[a - 1] === MASK) m[a - 1] = 10
      if (b < n && m[b] === MASK) m[b] = 10
    }
    const { spans, escapes } = inlineCode(v)
    let s = 0
    const maskV = (from: number, to: number) => {
      while (s > 0 && (starts[s] as number) > from) s--
      for (; s < segs.length; s++) {
        const [a, b] = segs[s] as [number, number]
        const vs = starts[s] as number
        const ve = vs + (b - a)
        if (vs >= to) break
        const lo = Math.max(from, vs)
        const hi = Math.min(to, ve)
        for (let i = lo; i < hi; i++) m[a + (i - vs)] = MASK
        if (ve >= to) break
      }
    }
    for (const [from, to] of spans) maskV(from, to)
    for (const e of escapes) maskV(e, e + 2)
  }

  const starts: number[] = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const lineEnd = (k: number) => {
    let e = k + 1 < starts.length ? (starts[k + 1] as number) - 1 : n
    if (e > (starts[k] as number) && text.charCodeAt(e - 1) === 13) e--
    return e
  }
  // A run of spaces and tabs is measured once per line, however many container levels look at it: the column of a
  // position in a line never depends on who asks, so later questions inside the same run are answered from the first.
  let runFrom = 0
  let runTo = 0
  let runCols: Int32Array | null = null // column at every position of the run, kept only when it holds a tab
  let runPlain = true
  /** First non-space at or after pos, with its column (tabs to the next multiple of 4). */
  const skip = (pos: number, end: number, col: number) => {
    if (pos >= end) return { pos, col }
    const c0 = text.charCodeAt(pos)
    if (c0 !== 32 && c0 !== 9) return { pos, col }
    if (!(pos >= runFrom && pos < runTo)) {
      let to = pos
      let plain = true
      while (to < end) {
        const c = text.charCodeAt(to)
        if (c === 9) plain = false
        else if (c !== 32) break
        to++
      }
      runFrom = pos
      runTo = to
      runPlain = plain
      runCols = null
      if (!plain && to - pos > 32) {
        const cols = new Int32Array(to - pos + 1)
        let k = col
        for (let i = pos; i < to; i++) {
          cols[i - pos] = k
          k += text.charCodeAt(i) === 9 ? 4 - (k % 4) : 1
        }
        cols[to - pos] = k
        runCols = cols
      }
    }
    if (runPlain) return { pos: runTo, col: col + (runTo - pos) }
    if (runCols) return { pos: runTo, col: runCols[runTo - runFrom] as number }
    for (; pos < runTo; pos++) col += text.charCodeAt(pos) === 9 ? 4 - (col % 4) : 1
    return { pos: runTo, col }
  }
  const fenceOpen = (pos: number, end: number): { ch: number; len: number } | null => {
    const ch = text.charCodeAt(pos)
    if (ch !== 96 && ch !== 126) return null
    let j = pos
    while (j < end && text.charCodeAt(j) === ch) j++
    if (j - pos < 3) return null
    if (ch === 96) for (let k = j; k < end; k++) if (text.charCodeAt(k) === 96) return null // that is a code span
    return { ch, len: j - pos }
  }
  const fenceClose = (pos: number, end: number, f: { ch: number; len: number }) => {
    let j = pos
    while (j < end && text.charCodeAt(j) === f.ch) j++
    if (j - pos < f.len) return false
    while (j < end && isWs(text.charCodeAt(j))) j++
    return j >= end
  }
  // `- - - x` asks "is the rest of this line a thematic break" once per marker. The answer comes from one look at the
  // line's tail (the stretch that is one repeated character plus blanks) and a counter that only moves forward.
  let hrLine = -1
  let hrCh = 0
  let hrTail = 0
  let hrCount = 0
  let hrAt = 0
  const isHr = (pos: number, end: number) => {
    const ch = text.charCodeAt(pos)
    if (ch !== 45 && ch !== 42 && ch !== 95) return false
    if (hrLine !== end) {
      // new line (its end offset names it): find the tail that could be a break
      hrLine = end
      let j = end
      while (j > 0 && isWs(text.charCodeAt(j - 1))) j--
      hrCh = j > 0 ? text.charCodeAt(j - 1) : 0
      if (hrCh === 45 || hrCh === 42 || hrCh === 95) {
        while (j > 0 && (text.charCodeAt(j - 1) === hrCh || isWs(text.charCodeAt(j - 1)))) j--
      }
      hrTail = j
      hrAt = -1
      hrCount = 0
    }
    if (ch !== hrCh || pos < hrTail) return false
    if (hrAt < 0 || pos < hrAt) {
      hrAt = hrTail
      hrCount = 0
      for (let j = hrTail; j < end; j++) if (text.charCodeAt(j) === hrCh) hrCount++
    }
    for (; hrAt < pos; hrAt++) if (text.charCodeAt(hrAt) === hrCh) hrCount--
    return hrCount >= 3
  }
  const isAtx = (pos: number, end: number) => {
    let j = pos
    while (j < end && text.charCodeAt(j) === 35) j++
    return j - pos >= 1 && j - pos <= 6 && (j >= end || isWs(text.charCodeAt(j))) ? j : -1
  }
  /** A list marker at pos: its width, the number (ordered) and whether anything follows it. */
  const marker = (pos: number, end: number) => {
    const c = text.charCodeAt(pos)
    let j = pos
    let num = -1
    if (c === 45 || c === 43 || c === 42) j++
    else if (c >= 48 && c <= 57) {
      while (j < end && j - pos < 9 && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++
      const d = text.charCodeAt(j)
      if (j >= end || (d !== 46 && d !== 41)) return null
      num = Number(text.slice(pos, j))
      j++
    } else return null
    if (j < end && !isWs(text.charCodeAt(j))) return null
    const rest = skip(j, end, 0)
    return { width: j - pos, num, empty: rest.pos >= end }
  }

  let stack: Cont[] = []
  let firstQuote = -1 // index of the first block quote in the stack, -1 when there is none
  let fence: { ch: number; len: number; depth: number } | null = null
  let para: Array<[number, number]> = []
  let table = 0 // columns of the table the next row belongs to, 0 when not in a table
  const flush = () => {
    if (para.length) inline(para)
    para = []
  }

  for (let k = 0; k < starts.length; k++) {
    const ls = starts[k] as number
    const le = lineEnd(k)
    if (ls === n && k > 0) break
    const blank = skip(ls, le, 0).pos >= le
    let pos = ls
    let col = 0
    let base = 0
    let matched = 0
    if (blank) {
      // an empty line keeps every list item and ends at the first block quote: no need to walk the levels one by one
      matched = firstQuote < 0 ? stack.length : firstQuote
      flush()
      table = 0
      if (matched < stack.length) {
        stack = stack.slice(0, matched)
        if (firstQuote >= matched) firstQuote = -1
        if (fence && fence.depth > matched) fence = null
      }
      continue
    }
    for (; matched < stack.length; matched++) {
      const c = stack[matched] as Cont
      const f = skip(pos, le, col)
      if (c.quote) {
        if (f.col - base > 3 || f.pos >= le || text.charCodeAt(f.pos) !== 62) break
        pos = f.pos + 1
        col = f.col + 1
        if (pos < le && text.charCodeAt(pos) === 32) {
          pos++
          col++
        }
        base = col
      } else {
        if (f.col < c.off) break
        // consume the item's indent
        while (pos < le && col < c.off && isWs(text.charCodeAt(pos))) {
          col += text.charCodeAt(pos) === 9 ? 4 - (col % 4) : 1
          pos++
        }
        base = c.off
      }
    }
    if (matched < stack.length) {
      // a paragraph keeps going on a line that only lacks the container marks, unless the line starts a block
      const f = skip(pos, le, col)
      const lazy =
        !fence &&
        para.length > 0 &&
        f.col - base < 4 &&
        !(
          text.charCodeAt(f.pos) === 62 ||
          fenceOpen(f.pos, le) ||
          isAtx(f.pos, le) >= 0 ||
          isHr(f.pos, le) ||
          marker(f.pos, le)
        )
      if (lazy) {
        para.push([f.pos, le])
        continue
      }
      flush()
      table = 0
      stack = stack.slice(0, matched)
      if (firstQuote >= matched) firstQuote = -1
      if (fence && fence.depth > matched) fence = null
    }
    if (fence) {
      const f = skip(pos, le, col)
      if (!blank && f.col - base <= 3 && fenceClose(f.pos, le, fence)) fence = null
      continue
    }
    const hadPara = para.length > 0
    // containers that start on this line
    for (;;) {
      const f = skip(pos, le, col)
      if (f.pos >= le || f.col - base >= 4 || stack.length >= MAX_NESTING) break
      const c = text.charCodeAt(f.pos)
      if (c === 62) {
        flush()
        table = 0
        if (firstQuote < 0) firstQuote = stack.length
        stack.push({ quote: true, off: 0 })
        pos = f.pos + 1
        col = f.col + 1
        if (pos < le && text.charCodeAt(pos) === 32) {
          pos++
          col++
        }
        base = col
        continue
      }
      if (isHr(f.pos, le)) break
      const mk = marker(f.pos, le)
      if (!mk) break
      if (hadPara && stack.length === matched && (mk.empty || (mk.num >= 0 && mk.num !== 1))) break
      flush()
      table = 0
      const mcol = f.col + mk.width
      const rest = skip(f.pos + mk.width, le, mcol)
      const gap = rest.col - mcol
      const off = mk.empty || gap >= 5 ? mcol + 1 : rest.col
      stack.push({ quote: false, off })
      pos = f.pos + mk.width
      col = mcol
      while (pos < le && col < off && isWs(text.charCodeAt(pos))) {
        col += text.charCodeAt(pos) === 9 ? 4 - (col % 4) : 1
        pos++
      }
      base = off
    }
    const f = skip(pos, le, col)
    if (f.pos >= le) {
      flush()
      table = 0
      continue
    }
    const rel = f.col - base
    const continuing = para.length > 0
    if (rel >= 4) {
      if (continuing) para.push([f.pos, le])
      else table = 0
      continue
    }
    const fo = fenceOpen(f.pos, le)
    if (fo) {
      flush()
      table = 0
      fence = { ch: fo.ch, len: fo.len, depth: stack.length }
      continue
    }
    const atx = isAtx(f.pos, le)
    if (atx >= 0) {
      flush()
      table = 0
      inline([[atx, le]])
      continue
    }
    if (isHr(f.pos, le) || (continuing && /^=+[ \t]*$/.test(text.slice(f.pos, le)))) {
      flush()
      table = 0
      continue
    }
    if (continuing) {
      const cols = delimiterColumns(text, f.pos, le)
      const head = para[para.length - 1] as [number, number]
      if (cols && text.slice(head[0], head[1]).includes('|')) {
        const cells = cellRanges(text, head[0], head[1])
        if (cells.length === cols) {
          para.pop()
          flush()
          for (const c of cells) inline([c])
          table = cols
          continue
        }
      }
    }
    if (table) {
      // a row: cells past the header's width are dropped, as the renderer drops them
      for (const c of cellRanges(text, f.pos, le).slice(0, table)) inline([c])
      continue
    }
    para.push([f.pos, le])
  }
  flush()

  let out = ''
  for (let i = 0; i < n; i += 8192) out += String.fromCharCode(...m.subarray(i, Math.min(n, i + 8192)))
  return out
}

/**
 * Every distinct link of a note, in the order it first appears: the properties first (values only), then the body.
 * `max` bounds the list. Links in code are not links.
 */
export function scanLinks(text: string, max = 5000): RawLink[] {
  const out: RawLink[] = []
  const seen = new Set<string>()
  const add = (l: RawLink | null) => {
    if (!l || out.length >= max) return
    const k = linkKey(l)
    if (seen.has(k)) return
    seen.add(k)
    out.push(l)
  }
  const { front, body } = splitNote(text)
  if (front) {
    for (const [, v] of frontmatterRows(front)) {
      for (const m of v.matchAll(new RegExp(WIKI_SOURCE, 'g'))) add(wikiLink(m[1] as string, m[2]))
    }
  }
  if (out.length >= max || !body) return out
  const masked = maskNote(body)
  const found: Array<{ at: number; link: RawLink | null }> = []
  for (const m of masked.matchAll(new RegExp(WIKI_SOURCE, 'g'))) {
    const at = m.index as number
    const nameEnd = at + 2 + (m[1] as string).length
    const name = body.slice(at + 2, nameEnd)
    const alias = m[2] === undefined ? undefined : body.slice(nameEnd + 1, nameEnd + 1 + m[2].length)
    found.push({ at, link: wikiLink(name, alias) })
  }
  for (const m of masked.matchAll(new RegExp(REL_SOURCE, 'g'))) {
    const at = m.index as number
    const label = body.slice(at + 1, at + 1 + (m[1] as string).length)
    const innerAt = at + 1 + label.length + 2
    found.push({ at, link: relLink(label, body.slice(innerAt, innerAt + (m[0] as string).length - label.length - 4)) })
  }
  found.sort((a, b) => a.at - b.at)
  for (const f of found) add(f.link)
  return out
}

// ---- matching the bridge's list ------------------------------------------------------------------------------------

/** What the app needs from one entry the bridge listed. */
export type ListedLink = { text: string; path: string | null }

const stem = (p: string) => p.toLowerCase().replace(/\.(md|markdown|txt)$/, '')
function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else out.push(part)
  }
  return out.join('/')
}
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')

/**
 * Could the bridge have resolved `want` to `listed.path`? A hidden or missing link is `path:null` and fits anything; a
 * resolved one has to carry the link's own file name. This is what stops an entry listed for a different link with the
 * same label (an older bridge, or a note that changed) from being handed to this one.
 */
function plausible(want: RawLink, listed: ListedLink, from: string): boolean {
  if (listed.path === null) return true
  if (want.kind === 'rel') return listed.path === normalize(`${dirOf(from)}/${want.target}`)
  const raw = want.target.replace(/\\/g, '/').replace(/^\/+/, '')
  const got = stem(listed.path)
  if (/^\.{1,2}(\/|$)/.test(raw)) return got === stem(normalize(`${dirOf(from)}/${raw}`))
  const s = stem(normalize(raw))
  return got === s || got.endsWith(`/${s}`)
}

export type LinkPlan = {
  /** The index into the bridge's list for this link, or -1 when the bridge did not list it (or it cannot be told apart). */
  slotOf(l: RawLink): number
}

/**
 * Pairs the links the app finds in a note with the entries the bridge listed.
 *  1. The same scanner ran on both sides: when the bridge's list is the same links in the same order (or the front of
 *     it, cut by the size cap), every entry takes its link's place and the text and file name agree, that is the answer.
 *  2. Otherwise (an older bridge that lists links in code, wiki links before relative ones; a note edited after it was
 *     read; text that is only the first chunk) a link takes an entry only when exactly one entry fits it by label and
 *     file name and no other link could claim that entry. Anything else stays plain text: never a guess.
 * `from` is the note's own path. `complete` is false while only the first chunk of the note is loaded.
 */
export function planLinks(text: string, listed: readonly ListedLink[], from: string, complete = true): LinkPlan {
  const want = scanLinks(text)
  const slots = new Map<string, number>()
  const fits = (w: RawLink, l: ListedLink) => l.text === w.text.slice(0, 200) && plausible(w, l, from)
  let positional = complete && listed.length <= want.length
  for (let i = 0; positional && i < listed.length; i++) positional = fits(want[i] as RawLink, listed[i] as ListedLink)
  if (positional) {
    for (let i = 0; i < listed.length; i++) slots.set(linkKey(want[i] as RawLink), i)
  } else {
    const claims = new Map<number, number>()
    const cands = want.map((w) => {
      const c: number[] = []
      listed.forEach((l, i) => {
        if (fits(w, l)) c.push(i)
      })
      for (const i of c) claims.set(i, (claims.get(i) ?? 0) + 1)
      return c
    })
    want.forEach((w, wi) => {
      const c = cands[wi] as number[]
      if (c.length === 1 && claims.get(c[0] as number) === 1) slots.set(linkKey(w), c[0] as number)
    })
  }
  return { slotOf: (l) => slots.get(linkKey(l)) ?? -1 }
}
