// Claude's own input box, positively: its frame (a solid rule, the `❯` row, a solid rule), drawn from column 0 as Claude Code draws
// it, with only the status rows Claude Code draws under it. Shared by the key guard (key-guard.ts: typing goes only into this box)
// and the usage-limit reader (usage-limit.ts realBoxBelow: a menu above Claude's real box is quoted in the conversation, not live).
// A status line is drawn indented, so rows it prints can never make a frame at column 0 (Fable R2-4 on the key-guard pair).
import { clean, inputBox, isFrameRule, STRINGS } from './screen.ts'

/**
 * One part of a status row under Claude's input box (rows are split on runs of two or more spaces and on " · "), digits read as
 * N. Taken from every real capture with an input box (apps/desktop/Tests/Fixtures/real-*): the permission mode, its hints, the
 * effort, the sign-in reminder. (Talos's own row in a thread session is RECORDER_ROW.)
 */
const STATUS_PARTS = [
  // the permission mode, as the real captures show it (enumerated: an unknown mode is read exactly, so refused; Fable R3-4)
  /^(?:⏸ manual mode on|⏸ plan mode on|⏵⏵ accept edits on|⏵⏵ auto mode on|⏵⏵ bypass permissions on)(?: \(shift\+tab(?: to cycle\))?)?$/,
  /^\? for shortcuts$/,
  /^← for agents$/,
  /^\/tasks to see subagents$/,
  /^esc to interrupt$/,
  /^↓ to manage$/,
  /^Not logged in$/,
  /^Run \/login$/,
  /^[◐◑◒◓○●◔◕] (?:low|medium|high|xhigh|max)$/,
  /^\/effort$/,
  // Claude Code's own rows from real 2.1.318 captures (Delphi): the paste hint and the tmux focus-events notice
  /^Ctrl\+Y to paste deleted text$/,
  /^tmux focus-events off$/,
  /^add 'set -g focus-events on' to ~\/\.tmux\.conf and reattach for focus tracking$/,
  // a background shell (real-2.1.325-queued: `⏸ manual mode on · 1 shell · esc to interrupt · ↓ to manage`)
  /^N shells?$/,
  // the todo list's hint (real-2.1.325-status)
  /^ctrl\+t to hide tasks$/,
]

/**
 * Talos's own status line in a thread session (packages/protocol usage-readings.ts USAGE_RECORDER_PY, the same program as the
 * Mac's WorkerUsage.recorderSource; its --settings replaces the user's statusLine): `Talos`, or `Talos: <model>`, or
 * `Talos: <model> | 7d: N%`. The recorder sanitises the model's name to exactly this pattern's set (letters, digits, space, dot,
 * parentheses, plus, hyphen; a letter or digit first; cut at 8, a trailing space or dot dropped) and clamps N to 0..100, so the
 * longest row, `Talos: Sonnet 4 | 7d: 100%`, is 26 characters: what Claude Code shows whole at 30 columns (measured on 2.1.325:
 * it cuts a longer row with an ellipsis; real-2.1.323-statusline/thread-long-30), so whatever Claude Code names a model,
 * what it prints is this shape (tested on the real program's output for awkward names); a percentage needs a model. Matched on
 * the row's first part as drawn; at most ONE such row under the box (strangeRowUnder). Any change to what the recorder prints
 * needs a new capture (apps/desktop/Tests/Fixtures/real-2.1.323-statusline/README.md) and the Mac's pattern changed with it.
 */
const RECORDER_ROW = /^Talos(?:: [A-Za-z0-9][A-Za-z0-9 .()+-]{0,7}(?: \| 7d: (?:100|[1-9]?[0-9])%)?)?$/
/**
 * TRANSITION, remove after the release following this one: the recorder program is inlined in each thread session's --settings,
 * so a session started before this release keeps printing the OLD row until it restarts. Only its form WITH the percentage is
 * allowed (`<model> | 7d: N%`), and the model must start with one of Claude's model words, Opus, Sonnet, Haiku, Fable or Claude,
 * then a space or the end (Pantheon on Fable's probes: `Approve (y) or deny (n) | 7d: 0%` was let through). The old bare
 * model-only form stays refused. It counts as the one recorder row: never an old one and a new one together, never two old ones.
 */
const OLD_RECORDER_ROW = /^(?:Opus|Sonnet|Haiku|Fable|Claude)(?: [A-Za-z0-9 .()+-]{0,32})? \| 7d: (?:100|[1-9]?[0-9])%$/
/**
 * The agents panel Claude Code draws under the footer (real-2.1.322/idle-agents-panel, real-2.1.325-status, real-2.1.329), read by its
 * BLOCK, never by a row's tail (the tail is the agent's task text and takes any form): an exact unfocused `⏺ main` straight under the
 * box or under a status row, then contiguous agent rows (at most PANEL_AGENTS_MAX), then at most one `↓ N more`, last, and only after
 * an agent row. An agent row is an optional tree connector (├ └), `◯ ` and printable text: no hidden character, no `❯` (focus always
 * draws it), no `⏺`, no option number first ("◯ 1."). Viewing an agent turns the first row into `◯ main`, which opens no block. A row
 * of these shapes anywhere else refuses, and its shape goes to the audit as `panel <shape>`. BoxFrame.swift, the same.
 */
const PANEL_AGENTS_MAX = 5
const PANEL_MORE = /^↓ N more$/
function panelRow(row: string): 'main' | 'agent' | 'more' | null {
  const raw = clean(row)
  if (HIDDEN.test(raw)) return null
  if (raw === '⏺ main') return 'main'
  if (PANEL_MORE.test(raw.replace(/\d+/g, 'N'))) return 'more'
  const t = /^[├└] /.test(raw) ? raw.slice(2) : raw
  if (!t.startsWith('◯ ')) return null
  const body = t.slice(2)
  return body === '' || body.includes('❯') || body.includes('⏺') || /^[0-9]+[.)]/.test(body) ? null : 'agent'
}
/** A row that starts like the panel's (`◯ `, `⏺ `, `↓ `, a tree connector): when it refuses its shape is audited. */
const startsLikePanel = (row: string): boolean => ['◯ ', '⏺ ', '↓ ', '├ ', '└ '].some((g) => clean(row).startsWith(g))

/**
 * A status row cut at the pane's edge (real-2.1.325-queued at 30 columns: `⏸ manual mode on · esc to…`): only a row's LAST part
 * may be cut, and then it is "…" after at least two characters that are a strict start of one of these parts (digits as N).
 */
const CUT_PARTS = [
  'esc to interrupt',
  '? for shortcuts',
  '← for agents',
  '/tasks to see subagents',
  '↓ to manage',
  'N shell',
  'N shells',
  'Not logged in',
  'Run /login',
  '/effort',
  'ctrl+t to hide tasks',
]
function cutPart(p: string): boolean {
  const t = p.trim().replace(/\d+/g, 'N')
  if (!t.endsWith('…')) return false
  const head = t.slice(0, -1)
  return [...head].length >= 2 && CUT_PARTS.some((c) => c !== head && c.startsWith(head))
}

/**
 * The next part Claude Code adds should not hold every thread's messages until it is captured (Pantheon, 2026-11-14). After
 * Fable's round 3 a POSITIVE shape, the same on the Mac (Fixtures/key-guard-vectors.json status_row_vectors, status_row_probes):
 * on a row whose first part is a known permission mode or Talos's own row (never the old recorder row), a part after the first
 * that is not known may be unknown only when it is plain ASCII of lowercase letters, digits, spaces and / + . : , - , at most 24
 * characters, and not one word of four letters or fewer (an answer: yes, no, ok, sure, skip). At most two such parts on a row,
 * one such row under the box. A part that fails is audited `status_part_refused` by its shape once per run: capture it and add it.
 */
const UNKNOWN_SHAPE = /^[a-z0-9 /+.:,-]{1,24}$/
const UNKNOWN_PER_ROW = 2
/**
 * Characters that hide (controls, bidi and zero-width marks, a lone surrogate) and the replacement character (a Swift string
 * holds one where a lone surrogate was: both sides refuse it alike): a row holding one is never a status row.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}�]/u
/**
 * The artifact part Claude Code 2.1.330 draws on the footer row once an Artifact canvas is open (real-2.1.330-canvas: `⏵⏵ bypass
 * permissions on (shift+tab to cycle) · ⧉ canvas · esc to interrupt`): `⧉` and the artifact's name (file name without its extension,
 * or its title, cut at 24 characters), or `⧉ N` with several. So the name is any text: 1 to 24 characters (code points; the cut "…"
 * counts), no hidden character (the row is refused whole for one), and no " · " or double space (a part ends there). Read only on
 * the row of a mode part (after it, at any place, cut or not), once, never as a row of its own. BoxFrame.swift, the same.
 */
const artifactPart = (p: string): boolean => {
  const t = p.trim()
  const n = [...t].length - 2
  return t.startsWith('⧉ ') && n >= 1 && n <= 24
}
/**
 * The symbols that may open an unknown part, an allowlist of the footer symbols seen in 2.1.330 (the artifact mark and the warning
 * sign): every other symbol refuses and is audited, so a selection list's marks and pointers can never open one.
 */
const NEUTRAL_GLYPH = /^[\u29c9\u26a0] /
/**
 * Pantheon's narrow refusals on top of the shape (2026-11-14, on Fable's probes): not one word of four letters or fewer (an
 * answer), no option number at its start (a digit then `.` or `)`), no `y/n`, and not the word `enter` (the key a prompt asks
 * for; "entering" is another word). Hints shaped "x to y" stay allowed.
 */
const unknownPart = (p: string): boolean => {
  if (!NEUTRAL_GLYPH.test(p) || [...p].length <= 2) return narrowPart(p)
  // after a symbol an answer word anywhere in it ("⚠ low yes") refuses as well
  const t = [...p].slice(2).join('')
  return !/(?<![a-z0-9])(?:yes|no|ok|y|n)(?![a-z0-9])/.test(t) && narrowPart(t)
}
const narrowPart = (t: string): boolean =>
  UNKNOWN_SHAPE.test(t) &&
  !/^[a-z]{1,4}$/.test(t) &&
  !/^[0-9]+[.)]/.test(t) &&
  !t.includes('y/n') &&
  !/\benter\b/.test(t)
/** An allowed unknown part's shape for the audit: ASCII letters as a, digits as N, the rest as it is; never the text. */
export const partShape = (p: string): string => p.replace(/[a-z]/gi, 'a').replace(/[0-9]/g, 'N').slice(0, 40)
/**
 * A refused part's shape: its length in code points and the kinds of character in it (a lowercase, A uppercase, N digit, s space,
 * p ASCII punctuation, u anything else), never the text.
 */
export function refusedShape(p: string): string {
  const cp = [...p]
  const kinds = new Set<string>(
    cp.map((c) =>
      /[a-z]/.test(c)
        ? 'a'
        : /[A-Z]/.test(c)
          ? 'A'
          : /[0-9]/.test(c)
            ? 'N'
            : c === ' '
              ? 's'
              : /[!-~]/.test(c)
                ? 'p'
                : 'u',
    ),
  )
  return `${cp.length}:${['a', 'A', 'N', 's', 'p', 'u'].filter((k) => kinds.has(k)).join('')}`
}

type RowKind = { kind: 'claude' | 'recorder'; unknown: string[] } | { kind: null; refused?: string }
/**
 * Claude Code's own status row (or blank), the usage recorder's row (its first part; Claude's parts may follow), or neither (with
 * the refused part's shape when the row was open to unknown parts and one failed the shape).
 */
function rowKind(row: string): RowKind {
  const raw = clean(row)
  if (HIDDEN.test(raw.replace(/\t/g, ' '))) return { kind: null }
  const c = raw.replace(/\d+/g, 'N')
  if (c === '') return { kind: 'claude', unknown: [] }
  const parts = raw.split(/\s{2,}| · /).map((p) => p.trim())
  const head = parts[0] as string
  const known = (p: string, i: number) =>
    STATUS_PARTS.some((r) => r.test(p.replace(/\d+/g, 'N'))) || (i === parts.length - 1 && cutPart(p))
  const recorder = RECORDER_ROW.test(head)
  const old = !recorder && OLD_RECORDER_ROW.test(head)
  if (!recorder && !old && !known(head, 0))
    // a permission mode nobody has captured is read exactly (refused), and its shape said: capture it and add it
    return /^(?:⏸|⏵⏵) /.test(head) ? { kind: null, refused: `mode ${refusedShape(head)}` } : { kind: null }
  // only a row that is positively a status row may hold parts nobody has captured yet: a known mode, or Talos's own row
  const open = recorder || (!old && known(head, 0) && /^(?:⏸|⏵⏵) /.test(head))
  const unknown: string[] = []
  let sawMode = open && !recorder
  let sawArtifact = false
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i] as string
    if (STATUS_PARTS[0]?.test(p.replace(/\d+/g, 'N'))) sawMode = true
    if (known(p, i)) continue
    // the artifact part: only after a mode part, once
    if (open && sawMode && !sawArtifact && artifactPart(p)) {
      sawArtifact = true
      continue
    }
    if (!open) return { kind: null }
    if (!unknownPart(p)) return { kind: null, refused: refusedShape(p) }
    unknown.push(p)
  }
  if (unknown.length > UNKNOWN_PER_ROW) return { kind: null }
  return { kind: recorder || old ? 'recorder' : 'claude', unknown }
}

/**
 * The first row under the box that is not one Claude Code or Talos draws there (its cleaned text), or null when every row is
 * one: Claude's own status rows, at most one usage-recorder row, and at most one row with parts not yet known. `notes`, when
 * given, gets the shapes of the unknown parts allowed, and of a part refused for its shape.
 */
export function strangeRowUnder(
  rows: readonly string[],
  bottomRule: number,
  notes?: { unknown: string[]; refused: string[] },
): string | null {
  let recorder = 0
  let open = 0
  // the agents panel as one block (`panelRow`): `⏺ main` (none yet), its agent rows, "↓ N more" last
  let inPanel = false
  let panelDone = false
  let agents = 0
  const refuse = (r: string, panelRelated: boolean): string => {
    if (panelRelated || startsLikePanel(r)) notes?.refused.push(`panel ${refusedShape(clean(r))}`)
    return clean(r)
  }
  for (let i = bottomRule + 1; i < rows.length; i++) {
    const r = rows[i] as string
    const p = panelRow(r)
    if (p !== null) {
      // directly under the box or under a status row, with the blank spacer Claude Code draws between them passed over
      let j = i - 1
      while (j > bottomRule && clean(rows[j] as string) === '') j--
      const after = j === bottomRule || rowKind(rows[j] as string).kind !== null
      if (p === 'main') {
        if (inPanel || panelDone || !after) return refuse(r, false)
        inPanel = true
      } else if (p === 'agent') {
        if (!inPanel || panelDone || ++agents > PANEL_AGENTS_MAX) return refuse(r, true)
      } else {
        if (!inPanel || panelDone || agents < 1) return refuse(r, true)
        panelDone = true
      }
      continue
    }
    const inBlock = inPanel && !panelDone
    if (inPanel) {
      inPanel = false
      panelDone = true
    }
    // a solid rule (another frame; `clean` would read it as blank) is never a status row
    if (isFrameRule(r)) return [...r.trim()].slice(0, 20).join('')
    const k = rowKind(r)
    if (k.kind === null) {
      if (k.refused) notes?.refused.push(k.refused)
      return refuse(r, inBlock)
    }
    if (k.kind === 'recorder' && ++recorder > 1) return clean(r)
    if (k.unknown.length > 0) {
      if (++open > 1) return clean(r)
      notes?.unknown.push(...k.unknown.map(partShape))
    }
  }
  return null
}

/** A solid rule that starts at column 0, as Claude Code draws its box's (a row without escapes). */
export const ruleAtColumn0 = (r: string | undefined): boolean =>
  r !== undefined && r.length > 0 && r[0] !== ' ' && isFrameRule(r)

/** The box `inputBox` found is drawn from column 0: both rules and the pointer row. */
export const boxAtColumn0 = (rows: readonly string[], box: [number, number]): boolean =>
  ruleAtColumn0(rows[box[0] - 1]) && (rows[box[0]] ?? '').startsWith(STRINGS.pointer) && ruleAtColumn0(rows[box[1]])

/**
 * The text in the box EXACTLY as typed, or null when it is not drawn the way Claude Code draws typed text: the first row is the
 * pointer and one space then the text, each wrapped row two spaces then the text, rows broken at single spaces, no run of spaces inside.
 */
export function exactBoxText(rows: readonly string[], box: [number, number]): string | null {
  const parts: string[] = []
  for (let i = box[0]; i < box[1]; i++) {
    const r = (rows[i] as string).replace(/ +$/, '')
    // the first row: the pointer and ONE space (Claude Code draws a no-break space); a wrapped row: two spaces
    const prefix =
      i === box[0] ? [`${STRINGS.pointer}\u00a0`, `${STRINGS.pointer} `].find((p) => r.startsWith(p)) : '  '
    if (prefix === undefined || !r.startsWith(prefix)) return null
    const t = r.slice(prefix.length)
    if (t === '' || /^\s|\s{2,}|[\t\u00a0]/u.test(t)) return null
    parts.push(t)
  }
  return parts.join(' ')
}
