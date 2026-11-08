// A small shell lexer for the floor (explain-floor.ts). It does not run or expand anything: it cuts a command line into simple
// commands (words with their quotes removed, redirections, pipe links, here-document bodies) and hands every `$(...)`, backtick
// and `<(...)` it meets to `onNested`, so a delete hidden inside a substitution is still found. Anything it cannot cut cleanly
// (an unterminated quote or substitution) returns null and the caller falls back to a coarse scan.
export type Word = {
  /** The word with quotes and backslashes removed; an expansion stays in it as written (`$HOME`, `$(date)`). */
  text: string
  /** The word contains an expansion, so its real value is unknown. */
  dyn: boolean
  /** An unquoted `*`, `?` or `[` is in it: the shell picks the real name from the files that exist. */
  glob: boolean
  /** An unquoted `{a,b}` or `{1..3}` is in it: the shell turns it into several words. */
  brace: boolean
  /** Any quote or backslash was used (the delimiter of a here-document: quoted means its body is not expanded). */
  quoted: boolean
}
export type Redir = { op: string; target: Word | undefined }
export type Seg = { words: Word[]; redirs: Redir[]; piped: boolean; bodies: string[] }

const NAME_CHAR = /[A-Za-z0-9_]/
const START_NAME = /[A-Za-z_0-9@*#?!$-]/
const newSeg = (piped: boolean): Seg => ({ words: [], redirs: [], piped, bodies: [] })

/** The text of `$'...'`: C escapes decoded. `sure` is false when an escape was not understood (the word then counts as unread). */
export function decodeAnsiC(raw: string): { text: string; sure: boolean } {
  let out = ''
  let sure = true
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string
    if (c !== '\\') {
      out += c
      continue
    }
    const n = raw[++i] ?? ''
    const simple: Record<string, string> = {
      a: '\x07',
      b: '\b',
      e: '\x1b',
      E: '\x1b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '?': '?',
    }
    if (n in simple) out += simple[n]
    else if (n === 'x' || n === 'u' || n === 'U') {
      const max = n === 'x' ? 2 : n === 'u' ? 4 : 8
      let hex = ''
      while (hex.length < max && /[0-9a-fA-F]/.test(raw[i + 1] ?? '')) hex += raw[++i]
      if (hex === '') sure = false
      else out += String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
    } else if (/[0-7]/.test(n)) {
      let oct = n
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i]
      out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff)
    } else {
      sure = false
      out += `\\${n}`
    }
  }
  return { text: out, sure }
}

/** Calls `onNested` with the inside of every `$(...)` and backtick pair in plain text (a here-document body, a `${...}`). */
export function scanSubstitutions(text: string, onNested: (inner: string) => void): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(') {
      const e = matchParen(text, i + 1)
      if (e < 0) return
      if (text[i + 2] === '(') scanSubstitutions(text.slice(i + 2, e), onNested)
      else onNested(text.slice(i + 2, e))
      i = e
    } else if (text[i] === '`') {
      const e = matchBacktick(text, i)
      if (e < 0) return
      onNested(text.slice(i + 1, e))
      i = e
    }
  }
}

/** The index of the `}` that closes the `${` at `open`, counting nested braces; -1 when there is none. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') i++
    else if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** Index of the `)` that closes the `(` at `open`, skipping quoted text and nested parentheses; -1 when there is none. */
function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === "'") {
      const e = src.indexOf("'", i + 1)
      if (e < 0) return -1
      i = e
    } else if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++
        i++
      }
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

function matchBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++
    else if (src[i] === '`') return i
  }
  return -1
}

export function lex(src: string, onNested: (inner: string) => void): Seg[] | null {
  const segs: Seg[] = []
  let cur = newSeg(false)
  let w: Word | null = null
  /** Only the characters of `w` that were typed unquoted and literal, the rest as a placeholder: what globbing and braces act on. */
  let plain = ''
  let redirOp: string | null = null
  const heredocs: { word: Word; dash: boolean; seg: Seg }[] = []
  const n = src.length
  let i = 0

  const finishWord = () => {
    if (!w) return
    const word = w
    word.glob = /[*?]|\[[^\]]*\]/.test(plain) // a lone `[` is the test command, not a glob
    word.brace = /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(plain)
    w = null
    plain = ''
    if (redirOp === null) return void cur.words.push(word)
    cur.redirs.push({ op: redirOp, target: word })
    if (redirOp === '<<' || redirOp === '<<-') heredocs.push({ word, dash: redirOp === '<<-', seg: cur })
    else if (redirOp === '<<<') cur.bodies.push(word.text) // a here-string is the script a shell or interpreter reads
    redirOp = null
  }
  const endSeg = (nextPiped: boolean) => {
    finishWord()
    if (redirOp !== null) cur.redirs.push({ op: redirOp, target: undefined })
    redirOp = null
    if (cur.words.length > 0 || cur.redirs.length > 0) segs.push(cur)
    cur = newSeg(nextPiped)
  }
  /** kind: literal typed unquoted, quoted (or escaped) text, or text that comes from an expansion. */
  const add = (text: string, kind: 'plain' | 'quoted' | 'dyn' = 'quoted') => {
    w ??= { text: '', dyn: false, glob: false, brace: false, quoted: false }
    w.text += text
    if (kind === 'dyn') w.dyn = true
    if (kind !== 'plain') w.quoted = true
    plain += kind === 'plain' ? text : '\u0001'
  }
  const readHeredocs = () => {
    for (const h of heredocs.splice(0)) {
      const lines: string[] = []
      while (i < n) {
        let e = src.indexOf('\n', i)
        if (e < 0) e = n
        const line = src.slice(i, e)
        i = Math.min(n, e + 1)
        if ((h.dash ? line.replace(/^\t+/, '') : line) === h.word.text) break
        lines.push(line)
      }
      const body = lines.join('\n')
      h.seg.bodies.push(body)
      if (!h.word.quoted) scanSubstitutions(body, onNested) // an unquoted delimiter: the body is expanded like a double-quoted string
    }
  }
  /** `${...}` and `$((...))` can hold `$()` and backticks: they run too. Returns the index just past the construct, or -1. */
  const braceExpansion = (at: number): number => {
    const e = matchBrace(src, at + 1)
    if (e < 0) return -1
    scanSubstitutions(src.slice(at + 2, e), onNested)
    add(src.slice(at, e + 1), 'dyn')
    return e + 1
  }

  while (i < n) {
    const c = src[i] as string
    if (c === ' ' || c === '\t') {
      finishWord()
      i++
    } else if (c === '\n') {
      endSeg(false)
      i++
      if (heredocs.length > 0) readHeredocs()
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') add(src[i + 1] ?? '')
      i += 2
    } else if (c === '#' && !w) {
      while (i < n && src[i] !== '\n') i++
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1)
      if (e < 0) return null
      add(src.slice(i + 1, e))
      i = e + 1
    } else if (c === '"') {
      i++
      add('')
      for (;;) {
        if (i >= n) return null
        const d = src[i] as string
        if (d === '"') break
        if (d === '\\') {
          const nx = src[i + 1] ?? ''
          add('$`"\\\n'.includes(nx) ? (nx === '\n' ? '' : nx) : `\\${nx}`)
          i += 2
        } else if (d === '$' && src[i + 1] === '(') {
          const e = matchParen(src, i + 1)
          if (e < 0) return null
          if (src[i + 2] === '(') scanSubstitutions(src.slice(i + 2, e), onNested)
          else onNested(src.slice(i + 2, e))
          add(src.slice(i, e + 1), 'dyn')
          i = e + 1
        } else if (d === '`') {
          const e = matchBacktick(src, i)
          if (e < 0) return null
          onNested(src.slice(i + 1, e))
          add(src.slice(i, e + 1), 'dyn')
          i = e + 1
        } else if (d === '$' && START_NAME.test(src[i + 1] ?? '')) {
          let e = i + 1
          while (e < n && NAME_CHAR.test(src[e] as string)) e++
          if (e === i + 1) e++
          add(src.slice(i, e), 'dyn')
          i = e
        } else if (d === '$' && src[i + 1] === '{') {
          const next = braceExpansion(i)
          if (next < 0) return null
          i = next
        } else {
          add(d)
          i++
        }
      }
      i++
    } else if (c === '$' && src[i + 1] === "'") {
      let e = i + 2
      while (e < n && src[e] !== "'") {
        if (src[e] === '\\') e++
        e++
      }
      if (e >= n) return null
      const decoded = decodeAnsiC(src.slice(i + 2, e))
      add(decoded.text, decoded.sure ? 'quoted' : 'dyn') // an escape we do not understand: the word is unread
      i = e + 1
    } else if (c === '$' && src[i + 1] === '(') {
      const e = matchParen(src, i + 1)
      if (e < 0) return null
      if (src[i + 2] === '(') scanSubstitutions(src.slice(i + 2, e), onNested)
      else onNested(src.slice(i + 2, e))
      add(src.slice(i, e + 1), 'dyn')
      i = e + 1
    } else if (c === '$' && src[i + 1] === '{') {
      const next = braceExpansion(i)
      if (next < 0) return null
      i = next
    } else if (c === '$' && START_NAME.test(src[i + 1] ?? '')) {
      let e = i + 1
      while (e < n && NAME_CHAR.test(src[e] as string)) e++
      if (e === i + 1) e++
      add(src.slice(i, e), 'dyn')
      i = e
    } else if (c === '`') {
      const e = matchBacktick(src, i)
      if (e < 0) return null
      onNested(src.slice(i + 1, e))
      add(src.slice(i, e + 1), 'dyn')
      i = e + 1
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const e = matchParen(src, i + 1)
      if (e < 0) return null
      onNested(src.slice(i + 2, e))
      add(src.slice(i, e + 1), 'dyn')
      i = e + 1
    } else if (c === '<' || c === '>') {
      // a lone number just before the operator is the file descriptor (`2>file`), not a word
      if (w && /^\d+$/.test((w as Word).text)) {
        w = null
        plain = ''
      } else finishWord()
      let op = c
      i++
      if (c === '>' && (src[i] === '>' || src[i] === '|')) op += src[i++]
      else if (c === '<' && src[i] === '<') {
        op += src[i++]
        if (src[i] === '<' || src[i] === '-') op += src[i++]
      }
      if (c === '>' && src[i] === '&' && /[\d-]/.test(src[i + 1] ?? '')) {
        i += 2 // 2>&1, >&2, >&-: a file descriptor copy, no file
        while (/\d/.test(src[i] ?? '')) i++
      } else {
        if (src[i] === '&' && (c === '>' || c === '<')) i++ // `>& file`
        redirOp = op
      }
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        finishWord()
        i += 2
        if (src[i] === '>') i++
        redirOp = '&>'
      } else {
        endSeg(false)
        i += src[i + 1] === '&' ? 2 : 1
      }
    } else if (c === '|') {
      const both = src[i + 1] === '&'
      endSeg(true)
      i += src[i + 1] === '|' ? 2 : both ? 2 : 1
      if (src[i - 1] === '|' && src[i - 2] === '|') cur.piped = false
    } else if (c === ';' || c === '(' || c === ')') {
      endSeg(false)
      i++
    } else {
      add(c, 'plain')
      i++
    }
  }
  endSeg(false)
  return segs
}
