// Reading what a worker's pane is waiting on: the TypeScript port of the Mac's DialogReader.swift (the three known dialogs,
// read exactly so a tap can answer them) and PromptDetector.swift (any other prompt, found from its shape). Those files and
// their tests document where each rule came from (real 2.1.318 and 2.1.319 captures, apps/desktop/Tests/Fixtures). Pure
// functions over rows, built on screen.ts. Columns and lengths count code points, where the Swift counts characters: the
// captures have no combining marks, and a row that had them would only read as longer.
import { classify, clean, isFrameRule, liveDialog, STRINGS, stripEscapes } from './screen.ts'

// Swift's CharacterSet.whitespaces, .whitespacesAndNewlines and .controlCharacters, so a trim here trims what the Mac's does.
const WS = '\\p{Zs}\\t'
const WS_NL = `${WS}\\n\\v\\f\\r\\u0085\\u2028\\u2029`
const trimWS = (s: string) => s.replace(new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu'), '')
const trimWSNL = (s: string) => s.replace(new RegExp(`^[${WS_NL}]+|[${WS_NL}]+$`, 'gu'), '')
const CONTROL = /[\p{Cc}\p{Cf}]/u
const CONTROL_ALL = /[\p{Cc}\p{Cf}]/gu
const hasControl = (s: string) => CONTROL.test(s)
const len = (s: string) => [...s].length
const NBSP = ' '
const ESC = '\u001b'

// ---- the known dialogs --------------------------------------------------------------------------------------------------------

/** `dev_channels` is Main's own warning, published as `supervisor.main_dialog`: `readDialog` never reads it off a worker's pane. */
export type DialogKind = 'trust' | 'mcp_consent' | 'login' | 'dev_channels'

export type Dialog = {
  kind: DialogKind
  /**
   * The folder (trust) or the server name (MCP consent), only when it is on one row and so read whole. A path or name wrapped
   * over rows can't be rejoined exactly, and a half is never offered.
   */
  subject: string | null
  /** The option rows, top to bottom, as drawn. Empty for login. */
  options: string[]
  /** The row of the `❯` cursor in `options`; null for login. */
  cursor: number | null
}

const MAX_OPTIONS = 6
const MAX_LABEL = 120
const MAX_SUBJECT = 500
const MCP_HEADER = 'New MCP server found in this project'
/** An option row, with its indent, at or past this many characters may be the first row of a wrapped label. */
const MAX_ROW = 62

/**
 * One of the three known dialogs on a worker's pane, read EXACTLY so a tap can answer it; anything else is null and keeps the
 * "open Terminals" line. After the last frame rule the dialog is its text, then a Select whose rows are not numbered, one of
 * them carrying the `❯` cursor (which starts on a different row in each dialog, so it is always read, never assumed), every
 * sibling aligned under the cursor row's text, then `Enter to confirm · Esc to cancel` and nothing else. Login is no Select
 * (the input box stays): it has a kind and nothing else. With the escaped capture (`capture-pane -e`) given, it must show the
 * same screen, the cursor row must be the coloured one, every other option plain and none dim: the Select Claude draws, not
 * text that looks like one.
 */
export function readDialog(rows: string[], escapedRows?: string[]): Dialog | null {
  if (escapedRows !== undefined) {
    const a = normalized(rows)
    const b = normalized(escapedRows)
    if (a.length !== b.length || a.some((r, i) => r !== b[i])) return null
  }
  switch (liveDialog(rows).kind) {
    case 'login_expired':
      return { kind: 'login', subject: null, options: [], cursor: null }
    case 'trust':
      return readSelect('trust', rows, escapedRows)
    case 'mcp_consent':
      return readSelect('mcp_consent', rows, escapedRows)
    default:
      return null
  }
}

function readSelect(kind: 'trust' | 'mcp_consent', rows: string[], escaped: string[] | undefined): Dialog | null {
  const rule = rows.findLastIndex(isFrameRule)
  if (rule < 0) return null
  const top = rule + 1
  const block = rows.slice(top)
  const cursors = block.flatMap((r, i) => (cursorColumn(r) !== null ? [i] : []))
  if (cursors.length !== 1) return null
  const c = cursors[0] as number
  const labelCol = (cursorColumn(block[c] as string) as number) + 2
  let first = c
  let last = c
  while (first > 0 && !isBlank(block[first - 1] as string)) {
    if (label(block[first - 1] as string, labelCol) === null) return null
    first--
  }
  while (last + 1 < block.length && !isBlank(block[last + 1] as string)) {
    if (label(block[last + 1] as string, labelCol) === null) return null
    last++
  }
  const options: string[] = []
  for (let i = first; i <= last; i++) {
    const o = i === c ? cursorLabel(block[i] as string) : label(block[i] as string, labelCol)
    if (o !== null) options.push(o)
  }
  if (
    options.length !== last - first + 1 ||
    options.length < 2 ||
    options.length > MAX_OPTIONS ||
    new Set(options).size !== options.length ||
    !options.every((o) => len(o) >= 1 && len(o) <= MAX_LABEL && !hasControl(o))
  )
    return null
  // A label that wraps goes on a continuation row aligned like an option, which would read as one more option. The first row of
  // a wrapped label runs to the pane's width (80 columns at the least, in the Terminals viewer), and the longest real row is 56
  // characters: a longer row is a dialog nobody captured, and is refused.
  for (let i = first; i <= last; i++) if (len(block[i] as string) >= MAX_ROW) return null
  // the footer and nothing after it
  const after = block.slice(last + 1).filter((r) => !isBlank(r))
  if (after.length !== 1) return null
  const f = trimWS(after[0] as string)
  if (!f.startsWith('Enter to confirm') || !f.includes('Esc to cancel')) return null
  const header = block.slice(0, first)
  let subject: string | null
  if (kind === 'trust') {
    const h = header.findLastIndex((r) => trimWS(r) === 'Accessing workspace:')
    if (h < 0) return null
    subject = rowAfter(header, h)
  } else {
    const h = header.findIndex((r) => trimWS(r).startsWith(MCP_HEADER))
    if (h < 0) return null
    const t = trimWS(header[h] as string)
    if (t === MCP_HEADER) subject = null
    else if (t.startsWith(`${MCP_HEADER}: `)) {
      // the name is on this row; a wrapped one continues on the next, so the row below must be blank
      const name = trimWS(t.slice(MCP_HEADER.length + 2))
      subject = h + 1 < header.length && isBlank(header[h + 1] as string) ? valid(name) : null
    } else return null
  }
  if (escaped !== undefined && !intensityOK(escaped, top, first, last, c)) return null
  return { kind, subject, options, cursor: c - first }
}

/** "Accessing workspace:", a blank row, ONE row of text, a blank row: that row. Two rows are a wrapped path. */
function rowAfter(header: string[], h: number): string | null {
  if (h + 2 >= header.length || !isBlank(header[h + 1] as string)) return null
  const run: string[] = []
  let k = h + 2
  while (k < header.length && !isBlank(header[k] as string)) run.push(header[k++] as string)
  if (run.length !== 1 || k >= header.length) return null
  return valid(trimWS(run[0] as string))
}

const valid = (s: string): string | null =>
  len(s) >= 1 && len(s) <= MAX_SUBJECT && !hasControl(s) && !s.includes('…') ? s : null

const isBlank = (row: string) => trimWSNL(row) === ''

const leadingSpaces = (cp: string[]) => {
  let n = 0
  while (n < cp.length && cp[n] === ' ') n++
  return n
}

/** The column of the `❯` when the row is spaces, `❯`, a space and text. */
function cursorColumn(row: string): number | null {
  const cp = [...row]
  const n = leadingSpaces(cp)
  if (cp[n] !== STRINGS.pointer || cp[n + 1] !== ' ') return null
  const t = cp[n + 2]
  return t === undefined || t === ' ' || t === NBSP ? null : n
}

function cursorLabel(row: string): string | null {
  const cp = [...row]
  const t = trimWS(cp.slice(leadingSpaces(cp) + 2).join(''))
  return t === '' ? null : t
}

/** A sibling option: exactly `col` spaces, then text that is not another cursor. */
function label(row: string, col: number): string | null {
  const cp = [...row]
  if (cp.length < col || cp.slice(0, col).some((c) => c !== ' ')) return null
  const f = cp[col]
  if (f === undefined || f === ' ' || f === NBSP || f === STRINGS.pointer) return null
  const t = trimWS(cp.slice(col).join(''))
  return t === '' ? null : t
}

/** Escapes removed, trailing white space and trailing blank rows dropped: what both captures of one screen have in common. */
function normalized(rows: string[]): string[] {
  const out = rows.map((r) => trimWS(stripEscapes(r).replaceAll('\r', '')))
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * The cursor row coloured all the way, the other options (rows `top + first` to `top + last`) not at all, none dim. The state
 * is carried from row to row: tmux writes only the changes, so a row's first colour change may be a reset of the row above.
 */
function intensityOK(escaped: string[], top: number, first: number, last: number, cursor: number): boolean {
  const st = { fg: false, dim: false }
  for (let r = 0; r < escaped.length; r++) {
    const chars = [...(escaped[r] as string)]
    let visible = 0
    let coloured = 0
    let dimmed = 0
    let i = 0
    while (i < chars.length) {
      if (chars[i] === ESC) {
        if (i + 1 >= chars.length || chars[i + 1] !== '[') {
          i += 2
          continue
        }
        let j = i + 2
        let params = ''
        // a non-ASCII character ends the sequence, as the Swift's `asciiValue ?? true` does
        while (j < chars.length) {
          const v = (chars[j] as string).codePointAt(0) as number
          if (v > 0x7f || (v >= 0x40 && v <= 0x7e)) break
          params += chars[j]
          j++
        }
        if (chars[j] === 'm') applySGR(params, st)
        i = j + 1
        continue
      }
      if (chars[i] !== ' ' && chars[i] !== NBSP) {
        visible++
        if (st.fg) coloured++
        if (st.dim) dimmed++
      }
      i++
    }
    const k = r - top
    if (k < first || k > last) continue
    if (dimmed > 0) return false
    if (k === cursor) {
      if (visible === 0 || coloured !== visible) return false
    } else if (coloured > 0) return false
  }
  return true
}

/**
 * SGR codes: 0 resets, 2 and 22 are dim, 30-37, 90-97 and 38 set a foreground colour (38 takes `5;n` or `2;r;g;b`), 39 clears
 * it. Others change neither.
 */
function applySGR(params: string, st: { fg: boolean; dim: boolean }): void {
  const codes = params.split(/[;:]/).map((p) => (p === '' ? 0 : /^[+-]?\d+$/.test(p) ? Number(p) : -1))
  const skip = (i: number) => (i + 1 < codes.length ? (codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0) : 0)
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] as number
    if (c === 0) {
      st.fg = false
      st.dim = false
    } else if (c === 2) st.dim = true
    else if (c === 22) st.dim = false
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = true
    else if (c === 38) {
      st.fg = true
      i += skip(i)
    } else if (c === 48) i += skip(i)
    else if (c === 39) st.fg = false
  }
}

// ---- any other prompt ---------------------------------------------------------------------------------------------------------

export type PromptKind = 'bash_command' | 'file_create' | 'file_edit' | 'question' | 'other'

export type Prompt = {
  kind: PromptKind
  /**
   * The first line of the question, cleaned for a notice (one line, no control characters, at most 100 characters). Null when
   * the row above the options is transcript chrome (`✻ Worked for 2s`, `⏺ …`, `⎿ …`) and not a question.
   */
  question: string | null
  /** One of the CLI's footer lines was the last row. */
  footer: boolean
  /** The prompt's own rows (the stillness is measured on these, not on the transcript above them). */
  region: string[]
  /**
   * What the prompt is, with nothing that depends on the pane's width or the owner's keys: the region's text without its rules,
   * `╌` boxes, footer and option rows, all white space removed. A resize, a cursor move or typing leaves it as it was.
   */
  signature: string
  /** The signature as a short name, for records on disk that must not keep a command line. */
  hash: string
  /** The name in the owner's words; null when the kind can't be told. */
  title: string | null
  /**
   * Seconds left on Claude Code's own "will automatically block this request" countdown; null when the prompt has none. Read
   * from the frame, then masked: the ticking digits are in neither the region nor the signature.
   */
  autoBlockSeconds: number | null
  /** The last row is a tool permission's footer (`Esc to cancel …`; the agent's question and the pickers say `Enter to …`). */
  toolFooter: boolean
}

/**
 * A tool's ask (Bash, a file create or edit), not the owner's own question or picker: the phone must hear about it. Also one whose
 * header is not on the pane (a window shorter than the prompt cuts its top off, and the kind can't be told): `Do you want to …?`
 * over a tool permission's footer. The Mac's `Prompt.isTool`.
 */
export function isToolPrompt(p: Pick<Prompt, 'kind' | 'toolFooter' | 'question'>): boolean {
  if (p.kind === 'bash_command' || p.kind === 'file_create' || p.kind === 'file_edit') return true
  return p.kind === 'other' && p.toolFooter && (p.question?.startsWith('Do you want to ') ?? false)
}

const FOOTERS = [
  'Esc to cancel',
  'Esc to cancel · Tab to amend',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  'Enter to confirm · Esc to cancel',
  'Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents',
]
/** The idle input box's status bar, in every mode captured. */
const STATUS_BAR = ['? for shortcuts', 'mode on', 'shift+tab to cycle']
const SPACE = new Set([' ', NBSP])
const EDGE = new Set(['│', '┃', '║'])
const CHROME = new Set(['✻', '⏺', '⎿'])
const TITLES: Record<PromptKind, string | null> = {
  bash_command: 'Bash command',
  file_create: 'file create',
  file_edit: 'file edit',
  question: 'question',
  other: null,
}

/** FNV-1a (64 bits) over the signature's UTF-8, in hex: the Swift's `Prompt.hash`, so both name a prompt the same. */
export function promptHash(signature: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of Buffer.from(signature, 'utf8')) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
  return h.toString(16)
}

/** Column of the first character that is not padding or a box edge, and the text from there. */
function lead(row: string): { col: number; text: string[] } {
  const cp = [...row]
  let col = 0
  while (col < cp.length && (SPACE.has(cp[col] as string) || EDGE.has(cp[col] as string))) col++
  return { col, text: cp.slice(col) }
}

const blank = (row: string) => lead(row).text.length === 0
const isDashedBox = (row: string) => {
  const t = lead(row).text
  return t.length > 0 && t.every((c) => c === '╌')
}
const startsWith = (t: string[], s: string) => t.join('').startsWith(s)

/** The tab header of the agent's questions: `☐ Color`, or `← ☐ Color  ☐ Size  ✔ Submit →` for several. */
function isQuestionHeader(row: string): boolean {
  const t = lead(row).text
  return t[0] === '☐' || (t[0] === '←' && t.includes('☐'))
}

/** `❯ label`: the cursor column and the label's column; null when it is not a cursor row with something after it. */
function promptCursor(row: string): { col: number; label: number } | null {
  const l = lead(row)
  if (l.text[0] !== STRINGS.pointer) return null
  let k = 1
  let lab = l.col + 1
  while (k < l.text.length && SPACE.has(l.text[k] as string)) {
    k++
    lab++
  }
  if (lab <= l.col + 1 || k >= l.text.length) return null
  if (startsWith(l.text.slice(k), '✔ ')) lab += 2
  return { col: l.col, label: lab }
}

function isSibling(row: string, labelCol: number): boolean {
  const l = lead(row)
  if (l.col === labelCol) return !isDashedBox(row)
  return l.col === labelCol - 2 && startsWith(l.text, '✔ ')
}

const trimBlankTail = (rows: string[]) => {
  const t = [...rows]
  while (t.length > 0 && blank(t[t.length - 1] as string)) t.pop()
  return t
}

/** The mode line as 2.1.322 draws it once other items push its hint off (`⏵⏵ bypass permissions on · 3 shells`). Only ever looked
 * for right under an input box. */
const MODE_LINE = [...STATUS_BAR, 'permissions on', 'edits on']

/**
 * Claude's idle input box is on screen: whatever prompt was there is over. Its status bar is the last row, or (2.1.322, with
 * background agents running) the agents' rows stand under it: then the box itself is found (a rule, a `❯` row, a rule) with a
 * mode line in the rows right under it. Words like "mode on" anywhere else (a command inside a prompt) say nothing. The Mac's
 * `PromptDetector.isIdle`.
 */
export function isIdle(rows: string[]): boolean {
  const tail = trimBlankTail(rows)
  if (tail.length === 0) return false
  const bottom = clean(tail[tail.length - 1] as string)
  if (STATUS_BAR.some((s) => bottom.includes(s))) return true
  const lower = tail.findLastIndex(isFrameRule)
  if (lower < 0) return false
  const upper = tail.slice(0, lower).findLastIndex(isFrameRule)
  if (upper < 0 || lower - upper < 2) return false
  if (lead(tail[upper + 1] as string).text[0] !== STRINGS.pointer) return false
  if (tail.slice(upper + 1, lower).some(blank)) return false
  for (const row of tail.slice(lower + 1)) {
    if (blank(row)) break
    const c = clean(row)
    if (MODE_LINE.some((m) => c.includes(m))) return true
  }
  return false
}

/**
 * Several sub-agents asking at once: the prompt's header row (the one right under its frame rule) gains a right-aligned `1 of 3`
 * that counts up as more of them ask, while the prompt in front stays the same. It is taken off: the counter is neither the
 * prompt's region (its ticking would start the wait over) nor its signature (it would read as another prompt, announced again).
 */
export function maskQueueCounter(rows: string[]): string[] {
  return rows.map((row, i) => {
    if (i === 0 || !isFrameRule(rows[i - 1] as string)) return row
    const m = /\S {3,}\d+ of \d+\s*$/.exec(row)
    return m ? row.slice(0, m.index + 1) : row
  })
}

/**
 * The countdown row of Claude Code's own auto-block (` ⚠ Claude Code will automatically block this request in 1:54, …`): its
 * seconds, and the rows with its digits masked. Only a row that says "automatically block" is touched.
 */
/** The longest auto-block countdown taken from the screen as one (a day); anything longer is not a countdown Claude Code draws. */
export const MAX_COUNTDOWN_S = 24 * 3600

export function maskCountdown(rows: string[]): { rows: string[]; seconds: number | null } {
  let seconds: number | null = null
  const masked = rows.map((row) => {
    if (!row.includes('automatically block')) return row
    const mmss = /(\d+):(\d\d)/.exec(row)
    if (mmss) {
      // bounded before it is multiplied: the digits are screen text anyone can draw (a day is far more than any real countdown)
      const mins = mmss[1].length > 6 ? Number.POSITIVE_INFINITY : Number(mmss[1])
      seconds = mins * 60 + Number(mmss[2]) <= MAX_COUNTDOWN_S ? mins * 60 + Number(mmss[2]) : null
      return `${row.slice(0, mmss.index)}#:##${row.slice(mmss.index + mmss[0].length)}`
    }
    const secs = /(\d+) ?(seconds|s)\b/.exec(row)
    if (secs) {
      seconds = secs[1].length <= 6 && Number(secs[1]) <= MAX_COUNTDOWN_S ? Number(secs[1]) : null
      return `${row.slice(0, secs.index)}#s${row.slice(secs.index + secs[0].length)}`
    }
    return row
  })
  return { rows: masked, seconds }
}

/**
 * A prompt of the CLI's that Talos has no name for (a tool permission, the agent's own question, any Select waiting on a key),
 * found from its SHAPE, not its words; null for the known dialogs, so nothing is announced twice. The rule: one `❯` cursor row
 * with text after it and, in its block (no blank row or frame rule between), a sibling lined up with the cursor's text (a
 * cursor alone under a second rule finds them in the block above it); one `❯` in the region from the nearest rule above the
 * options to the bottom; the last row not Claude's status bar; the block not an input box (a rule right above AND below); and
 * none of the known dialogs. The footer is supporting evidence, never required.
 */
export function detectPrompt(rows: string[]): Prompt | null {
  let tail = trimBlankTail(rows)
  if (tail.length === 0) return null
  const counted = maskCountdown(tail)
  tail = maskQueueCounter(counted.rows)
  const at = (i: number) => tail[i] as string
  const cleaned = tail.map(clean)
  const bottom = cleaned[cleaned.length - 1] as string
  if (STATUS_BAR.some((s) => bottom.includes(s))) return null
  if (liveDialog(tail).kind !== 'none') return null
  // the dev-channels dialog has no rule above its title; on a short pane the title is gone but the options are not
  if (classify(tail).kind === 'dev_channels') return null
  if (cleaned.some((r) => r.includes(STRINGS.devConfirm))) return null

  for (let c = tail.length - 1; c >= 0; c--) {
    const cur = promptCursor(at(c))
    if (!cur) continue
    // the block of rows around the cursor: no blank row and no frame rule inside it
    let first = c
    let last = c
    while (first > 0 && !blank(at(first - 1)) && !isFrameRule(at(first - 1))) first--
    while (last + 1 < tail.length && !blank(at(last + 1)) && !isFrameRule(at(last + 1))) last++
    // an input box is its block between two rules
    if (first > 0 && last + 1 < tail.length && isFrameRule(at(first - 1)) && isFrameRule(at(last + 1))) continue
    let siblings: number[] = []
    for (let i = first; i <= last; i++) if (i !== c && isSibling(at(i), cur.label)) siblings.push(i)
    // the cursor alone under a second rule: its options are the block right above that rule
    let upper: number | null = null
    if (
      siblings.length === 0 &&
      first >= 2 &&
      isFrameRule(at(first - 1)) &&
      !blank(at(first - 2)) &&
      !isFrameRule(at(first - 2))
    ) {
      let uf = first - 2
      while (uf > 0 && !blank(at(uf - 1)) && !isFrameRule(at(uf - 1))) uf--
      const above: number[] = []
      for (let i = uf; i <= first - 2; i++) if (isSibling(at(i), cur.label)) above.push(i)
      if (above.length > 0) {
        siblings = above
        upper = uf
      }
    }
    if (siblings.length === 0) continue
    const min = Math.min(...siblings)
    const seed = upper !== null ? min : Math.min(min, c)
    const blockFirst = upper ?? first
    // where the options start: up from the first option while rows are options or their descriptions
    let top = seed
    while (top > blockFirst && (isSibling(at(top - 1), cur.label) || lead(at(top - 1)).col > cur.label)) top--
    // the question: the group of rows right above the options (blank rows skipped), its first row
    let q = top - 1
    while (q >= 0 && blank(at(q))) q--
    let questionRow: number | null = null
    while (q >= 0 && !blank(at(q)) && !isFrameRule(at(q)) && !isDashedBox(at(q)) && !isQuestionHeader(at(q)))
      questionRow = q--
    // the prompt's region: from the nearest frame rule above its options (or its question) to the bottom
    const rule = tail.slice(0, blockFirst).findLastIndex(isFrameRule)
    const start = rule >= 0 ? rule : (questionRow ?? 0)
    const region = tail.slice(start)
    if (region.filter((r) => lead(r).text[0] === STRINGS.pointer).length !== 1) continue
    if (['trust', 'mcp_consent', 'bypass_disclaimer', 'login_expired', 'dev_channels'].includes(classify(region).kind))
      return null
    const footer = FOOTERS.includes(cleaned[tail.length - 1] as string)
    const kind = kindOf(region, questionRow === null ? null : (cleaned[questionRow] as string))
    const signature = signatureOf(tail, start, top, cur.label, footer)
    return {
      kind,
      question: questionRow === null ? null : questionFrom(at(questionRow)),
      footer,
      region,
      signature,
      hash: promptHash(signature),
      title: TITLES[kind],
      autoBlockSeconds: region.some((r) => r.includes('automatically block')) ? counted.seconds : null,
      toolFooter: footer && (cleaned[tail.length - 1] as string).startsWith('Esc to cancel'),
    }
  }
  return null
}

function kindOf(region: string[], question: string | null): PromptKind {
  const rows = region.map(clean)
  // a header may say who asks: `Bash command · from the general-purpose agent`
  const header = (h: string) => rows.some((r) => r === h || r.startsWith(`${h} · `))
  if (header('Bash command')) return 'bash_command'
  if (header('Create file')) return 'file_create'
  if (header('Edit file') || question?.startsWith('Do you want to make this edit')) return 'file_edit'
  if (region.some(isQuestionHeader)) return 'question'
  return 'other'
}

/**
 * Screen text in a notice: one line, no control characters, no double quotes (the notice quotes it), 100 characters at most.
 * Null for transcript chrome, which is the agent's output and not the question.
 */
function questionFrom(row: string): string | null {
  const cleaned = clean(row)
  const f = [...cleaned][0]
  if (f !== undefined && CHROME.has(f)) return null
  const one = cleaned.replace(CONTROL_ALL, '').replaceAll('"', "'").split(/\s+/u).filter(Boolean).join(' ')
  if (one === '') return null
  const cp = [...one]
  return cp.length > 100 ? `${cp.slice(0, 100).join('')}…` : one
}

/**
 * From the first option on, the option rows (the cursor's, its siblings and their descriptions, wherever they stand) are left
 * out: which one the cursor is on, and what is typed into "Type something.", are not the prompt.
 */
function signatureOf(rows: string[], start: number, top: number, labelCol: number, footer: boolean): string {
  let keep = ''
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] as string
    if (isFrameRule(r) || isDashedBox(r)) continue
    if (footer && i === rows.length - 1) continue
    if (i >= top && (promptCursor(r) !== null || isSibling(r, labelCol) || lead(r).col > labelCol)) continue
    keep += lead(r).text.join('')
  }
  return keep.replace(/\s/gu, '')
}
