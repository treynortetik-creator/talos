// The top-level keys of a Markdown file's YAML frontmatter, read the one way all three readers read them: the Mac's
// FrontmatterScan.swift, the kit hook's frontmatter_keys (kit/hooks/permission-relay.py) and this one, each held to the shared
// cases in kit/scripts/frontmatter-cases.json. A key scan, not a YAML parser: uniform indentation, flow mappings, quotes and
// block scalars across lines are read; anything it cannot read for certain (an escape in a key, a tab in an indentation, an
// anchor, a quote or flow collection open at a top-level line, a `...` line, an odd character) is UNCLEAR, and an unclear file
// refuses, never guessed past. This is a line-for-line port of the hook's Python reader.

/** The reader could not tell the keys for certain: the file refuses (`why` says what it met). */
export class FrontmatterUnclear extends Error {}

const unclear = (why: string): never => {
  throw new FrontmatterUnclear(why)
}

/** The frontmatter's top-level keys ([] when the file has none); throws FrontmatterUnclear. */
export function frontmatterKeys(text: string): string[] {
  let t = text
  if (t.startsWith('﻿')) t = t.slice(1)
  t = t.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = t.split('\n')
  if (!(lines[0] ?? '').startsWith('---')) return []
  if (stripSpTab(lines[0] as string) !== '---')
    unclear('its first line starts a frontmatter block that is not plain ---')
  let end: number | null = null
  for (let k = 1; k < lines.length; k++) {
    const s = stripSpTab(lines[k] as string)
    if (s === '---') {
      end = k
      break
    }
    if (s === '...') unclear('its frontmatter has a ... line')
  }
  if (end === null) return unclear('its frontmatter has no closing ---')
  const body = lines.slice(1, end).join('\n')
  for (const c of body) {
    const o = c.codePointAt(0) as number
    if ((o < 0x20 && c !== '\t' && c !== '\n') || [0x7f, 0x85, 0x2028, 0x2029, 0xfeff].includes(o))
      unclear(`its frontmatter has the character U+${o.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  return new Reader(body).block()
}

const stripSpTab = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '')
const isSpTab = (c: string | undefined) => c === ' ' || c === '\t'

class Reader {
  private readonly n: number
  constructor(private readonly t: string) {
    this.n = t.length
  }

  private lineEnd(i: number): number {
    const j = this.t.indexOf('\n', i)
    return j < 0 ? this.n : j
  }

  private blank(a: number, b: number): boolean {
    for (let j = a; j < b; j++) if (!isSpTab(this.t[j])) return false
    return true
  }

  private restIsNothing(a: number, b: number): boolean {
    let j = a
    while (j < b && isSpTab(this.t[j])) j++
    return j === b || this.t[j] === '#'
  }

  block(): string[] {
    const t = this.t
    const keys: string[] = []
    let top: number | null = null
    let blockIndent: number | null = null
    let pos = 0
    while (pos <= this.n) {
      const le = this.lineEnd(pos)
      let k = pos
      while (k < le && t[k] === ' ') k++
      const indent = k - pos
      if (this.blank(pos, le)) {
        pos = le + 1
        continue
      }
      if (t[k] === '\t') unclear('its frontmatter has a tab in an indentation')
      if (blockIndent !== null) {
        if (indent > blockIndent) {
          pos = le + 1
          continue
        }
        blockIndent = null
      }
      if (t[k] === '#') {
        pos = le + 1
        continue
      }
      if (top === null) {
        top = indent
        if (t[k] === '{' || t[k] === '[') return this.flowDocument(k)
      }
      if (indent < top) unclear('its frontmatter has a line less indented than its first')
      let v: number
      if (indent === top) {
        const got = this.keyAt(k, le, true)
        if (got === null) return unclear('its frontmatter has a top-level line that is not a key')
        keys.push(got[0])
        v = got[1]
      } else {
        let q = k
        while (q < le && t[q] === '-' && (q + 1 === le || isSpTab(t[q + 1]))) {
          q++
          while (q < le && isSpTab(t[q])) q++
        }
        const got = this.keyAt(q, le, false)
        v = got ? got[1] : q
      }
      const [kind, last] = this.value(v, le, top)
      if (kind === 'block') {
        blockIndent = indent
        pos = le + 1
      } else if (kind === 'until') pos = (last as number) + 1
      else pos = le + 1
    }
    return keys
  }

  private keyAt(k: number, le: number, strict: boolean): [string, number] | null {
    const t = this.t
    if (k >= le) return null
    const c = t[k] as string
    if (c === '"' || c === "'") {
      let j = k + 1
      const key: string[] = []
      for (;;) {
        if (j >= le) return null
        if (c === '"' && t[j] === '\\') {
          if (strict) unclear('its frontmatter has a key with an escape')
          return null
        }
        if (t[j] === c) {
          if (c === "'" && j + 1 < le && t[j + 1] === "'") {
            key.push("'")
            j += 2
            continue
          }
          break
        }
        key.push(t[j] as string)
        j++
      }
      j++
      while (j < le && isSpTab(t[j])) j++
      if (j >= le || t[j] !== ':') return null
      return [key.join(''), j + 1]
    }
    const nxt = k + 1 < le ? t[k + 1] : undefined
    if ('-?:'.includes(c) && (nxt === undefined || isSpTab(nxt))) return null
    if (',[]{}#&*!|>%@`'.includes(c)) return null
    let j = k
    while (j < le) {
      if (t[j] === ':' && (j + 1 === le || isSpTab(t[j + 1]))) return [stripSpTab(t.slice(k, j)), j + 1]
      if (t[j] === '#' && j > k && isSpTab(t[j - 1])) return null
      j++
    }
    return null
  }

  private value(v0: number, le: number, top: number): ['line' | 'block' | 'until', number | null] {
    const t = this.t
    let v = v0
    while (v < le && isSpTab(t[v])) v++
    if (v === le || t[v] === '#') return ['line', null]
    const c = t[v] as string
    let close: number
    if (c === '"' || c === "'") close = this.quoted(v)
    else if (c === '[' || c === '{') close = this.flowNode(v, null) - 1
    else if (c === '|' || c === '>') {
      let j = v + 1
      while (j < le && '0123456789+-'.includes(t[j] as string)) j++
      if (!(j === le || (isSpTab(t[j]) && this.restIsNothing(j, le))))
        unclear('its frontmatter has a block scalar header it cannot read')
      return ['block', null]
    } else if ('&*!%@`'.includes(c)) return unclear('its frontmatter has an anchor, alias, tag or reserved character')
    else return ['line', null]
    if (close < le) return ['line', null]
    this.spanStaysRight(le, close, top)
    const last = this.lineEnd(close)
    if (!this.restIsNothing(close + 1, last)) unclear('its frontmatter has text after a value that spans lines')
    return ['until', last]
  }

  private spanStaysRight(start: number, end: number, top: number): void {
    const t = this.t
    for (let j = start; j < end; j++) {
      if (t[j] === '\n') {
        let k = j + 1
        while (k < this.n && t[k] === ' ') k++
        const le = this.lineEnd(j + 1)
        if (!this.blank(j + 1, le) && k - (j + 1) <= top)
          unclear('its frontmatter has a quote or a flow collection open at a top-level line')
      }
    }
  }

  private quoted(q: number): number {
    const t = this.t
    const c = t[q]
    let j = q + 1
    while (j < this.n) {
      if (c === '"' && t[j] === '\\') {
        j += 2
        continue
      }
      if (t[j] === c) {
        if (c === "'" && j + 1 < this.n && t[j + 1] === "'") {
          j += 2
          continue
        }
        return j
      }
      j++
    }
    return unclear('its frontmatter has a quote that never closes')
  }

  private flowDocument(k: number): string[] {
    if (this.t[k] !== '{') unclear('its frontmatter is a flow sequence, not a mapping')
    const keys: string[] = []
    const j = this.skipSpace(this.flowNode(k, keys))
    if (j < this.n) unclear('its frontmatter has text after its flow mapping')
    return keys
  }

  private skipSpace(j0: number): number {
    const t = this.t
    let j = j0
    while (j < this.n) {
      if (t[j] === ' ' || t[j] === '\t' || t[j] === '\n') j++
      else if (t[j] === '#' && (j === 0 || ' \t\n'.includes(t[j - 1] as string))) {
        while (j < this.n && t[j] !== '\n') j++
      } else return j
    }
    return j
  }

  /** One flow node at `j`; the index just past it. `keys`: a list for this mapping's own keys, or null. */
  private flowNode(j0: number, keys: string[] | null): number {
    const t = this.t
    const never = 'its frontmatter has a flow collection that never closes'
    let j = this.skipSpace(j0)
    if (j >= this.n) unclear(never)
    const c = t[j] as string
    if (c === '"' || c === "'") return this.quoted(j) + 1
    if (c === '[' || c === '{') {
      const closer = c === '[' ? ']' : '}'
      j++
      for (;;) {
        j = this.skipSpace(j)
        if (j >= this.n) unclear(never)
        if (t[j] === closer) return j + 1
        const start = j
        if (t[j] === '?' && j + 1 < this.n && ' \t\n'.includes(t[j + 1] as string))
          unclear('its frontmatter has an explicit key')
        j = this.flowNode(j, null)
        if (keys !== null) {
          const key = this.flowKeyText(start, j)
          if (key === null) unclear('its frontmatter has a flow key it cannot read')
          keys.push(key as string)
        }
        j = this.skipSpace(j)
        if (j < this.n && t[j] === ':') {
          j = this.skipSpace(j + 1)
          if (j < this.n && t[j] !== ',' && t[j] !== closer) j = this.flowNode(j, null)
          j = this.skipSpace(j)
        }
        if (j >= this.n) unclear(never)
        if (t[j] === ',') j++
        else if (t[j] !== closer) unclear('its frontmatter has a flow collection it cannot read')
      }
    }
    if ('&*!|>%@`],}'.includes(c)) unclear('its frontmatter has an anchor, alias, tag or reserved character')
    while (j < this.n) {
      const d = t[j] as string
      if (',[]{}'.includes(d)) return j
      if (d === ':' && (j + 1 >= this.n || ' \t\n,[]{}'.includes(t[j + 1] as string))) return j
      if (d === '#' && j > 0 && ' \t\n'.includes(t[j - 1] as string)) return j
      j++
    }
    return j
  }

  private flowKeyText(a: number, b: number): string | null {
    const t = this.t
    const c = t[a]
    if (c === '"' || c === "'") {
      const inner = t.slice(a + 1, b - 1)
      if (inner.includes('\n') || (c === '"' && inner.includes('\\'))) return null
      return c === "'" ? inner.replaceAll("''", "'") : inner
    }
    if (c === '[' || c === '{') return null
    const key = t.slice(a, b).replace(/^[ \t\n]+|[ \t\n]+$/g, '')
    return key.includes('\n') ? null : key
  }
}
