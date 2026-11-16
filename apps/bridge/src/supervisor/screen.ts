// Reading Claude Code's screen: the TypeScript port of the Mac's DialogMatcher.swift, the input-box rule of Workers.swift
// (PointerTyper.inputBox) and AutoConfirmGuard.swift. Those files document where each rule came from (real 2.1.312-2.1.322
// captures, apps/desktop/Tests/Fixtures). Pure functions: rows in, verdicts out. An unknown screen is never answered, only
// reported. Text is compared by code points, never by canonical equivalence.
import {
  AUTO_CONFIRM,
  type AutoConfirmInputs,
  DEV_CHANNEL_SCREEN,
  type DevChannelScreen,
  MAIN_START,
} from '@talos-app/protocol'
import { readUsageLimit, type UsageLimitInfo } from './usage-limit.ts'

export const STRINGS = {
  devTitle: DEV_CHANNEL_SCREEN.title,
  channelsPrefix: DEV_CHANNEL_SCREEN.channelsPrefix,
  devConfirm: DEV_CHANNEL_SCREEN.confirmRow,
  devExit: 'Exit',
  pointer: DEV_CHANNEL_SCREEN.cursor,
  resumeMissing: 'No session found with ID',
  resumeMissingConversation: 'No conversation found with session ID',
  trust: ['Yes, I trust this folder', 'Yes, I trust these settings'],
  mcpConsent: ['New MCP server found in this project', 'new MCP servers found in this project'],
  bypass: 'WARNING: Claude Code running in Bypass Permissions mode',
  login: ['Please run /login', 'Run /login', 'Not logged in', 'OAuth token has expired'],
} as const

/** The contract's DevChannelScreen. */
export type DevChannels = DevChannelScreen

export type Screen =
  | { kind: 'dev_channels'; dev: DevChannels }
  | { kind: 'trust' }
  | { kind: 'mcp_consent' }
  | { kind: 'bypass_disclaimer' }
  | { kind: 'login_expired' }
  | { kind: 'resume_missing' }
  /**
   * Claude Code's usage-limit screen (usage-limit.ts): one of its options spends usage credits, so it never gets a key of any kind,
   * and the owner is never told to "answer" it.
   */
  | { kind: 'usage_limit'; info: UsageLimitInfo }
  /** A selection cursor in front of a numbered option nobody named. */
  | { kind: 'unknown_selection' }
  | { kind: 'none' }

const BOX_EDGE = new Set(['│', '┃', '║', '╭', '╮', '╰', '╯', '─', '━', '┌', '┐', '└', '┘'])
const RULE_CHARS = new Set(['─', '━', '╭', '╮', '╰', '╯', '┌', '┐', '└', '┘', '═'])

/** Strips the borders and padding a dialog box may draw around a row. */
export function clean(row: string): string {
  const cp = [...row]
  let a = 0
  let b = cp.length
  const pad = (c: string | undefined) => c === ' ' || c === '\t' || (c !== undefined && BOX_EDGE.has(c))
  while (a < b && pad(cp[a])) a++
  while (b > a && pad(cp[b - 1])) b--
  return cp.slice(a, b).join('')
}

const isHighlighted = (cleaned: string) => cleaned.startsWith(STRINGS.pointer)

/** `❯ 2. Something`: a cursor in front of a numbered option. */
export function isIndexedCursor(cleaned: string): boolean {
  if (!isHighlighted(cleaned)) return false
  return /^\d+\./.test(cleaned.slice(STRINGS.pointer.length).replace(/^ +/, ''))
}

/** The highlighted row's label: cursor and a `1. ` index removed. */
function labelOfHighlighted(cleaned: string): string {
  return cleaned
    .slice(STRINGS.pointer.length)
    .replace(/^ +/, '')
    .replace(/^\d+\. */, '')
    .trim()
}

const trimRight = (rows: string[]) => {
  const t = [...rows]
  while (t.length > 0 && (t[t.length - 1] ?? '').trim() === '') t.pop()
  return t
}

export function classify(rows: string[]): Screen {
  const cleaned = rows.map(clean)
  const joined = cleaned.join('\n')
  if (joined.includes(STRINGS.resumeMissing) || joined.includes(STRINGS.resumeMissingConversation))
    return { kind: 'resume_missing' }
  const titles = cleaned.filter((r) => r.includes(STRINGS.devTitle)).length
  // the dialog is on screen only with its selection: a title alone is what an answered dialog leaves behind, or a quote
  if (titles > 0 && cleaned.some(isIndexedCursor)) {
    const channelRows = cleaned.filter((r) => r.startsWith(STRINGS.channelsPrefix))
    let channels: string[] | null = null
    if (channelRows.length === 1) {
      const at = cleaned.findIndex((r) => r.startsWith(STRINGS.channelsPrefix))
      // Ink hard-wraps the list at the pane width and `capture-pane -J` cannot re-join that: the rows after `Channels:` up to the
      // blank row belong to it. Empty entries are kept: a dangling comma never shortens the list.
      let text = (cleaned[at] as string).slice(STRINGS.channelsPrefix.length)
      for (let k = at + 1; k < cleaned.length && (cleaned[k] as string).trim() !== ''; k++) text += ` ${cleaned[k]}`
      const t = text.trim()
      channels = t === '' ? [] : t.split(',').map((c) => c.trim())
    }
    const hl = cleaned.filter(isHighlighted)
    return {
      kind: 'dev_channels',
      dev: {
        channels,
        highlighted: hl.length === 1 ? labelOfHighlighted(hl[0] as string) : null,
        titleCount: titles,
        channelsRowCount: channelRows.length,
      },
    }
  }
  if (STRINGS.trust.some((s) => joined.includes(s))) return { kind: 'trust' }
  if (STRINGS.mcpConsent.some((s) => joined.includes(s))) return { kind: 'mcp_consent' }
  if (joined.includes(STRINGS.bypass)) return { kind: 'bypass_disclaimer' }
  if (STRINGS.login.some((s) => joined.includes(s))) return { kind: 'login_expired' }
  const usage = readUsageLimit(rows)
  if (usage) return { kind: 'usage_limit', info: usage }
  if (cleaned.some(isIndexedCursor)) return { kind: 'unknown_selection' }
  return { kind: 'none' }
}

/** A rule row of a dialog's frame (`────`, or a box edge `╭───╮`): at least 10 non-blank characters, 80% box drawing. */
export function isFrameRule(row: string): boolean {
  const t = [...row].filter((c) => c !== ' ' && c !== '\t')
  if (t.length < MAIN_START.frameRuleMinChars) return false
  return t.filter((c) => RULE_CHARS.has(c)).length >= t.length * MAIN_START.frameRuleBoxShare
}

const isResumeError = (row: string) =>
  row.startsWith(STRINGS.resumeMissing) || row.startsWith(STRINGS.resumeMissingConversation)

/** `--session-id <id>` refused: Claude Code already has that session in this folder (seen on 2.1.322, exit 1). */
export const sessionInUse = (rows: string[]): boolean =>
  rows.map(clean).some((r) => /^Error: Session ID \S+ is already in use/.test(r))

/** `--resume` failed: the error on a line of its own (a sentence that mentions it is a conversation). */
export const resumeMissing = (rows: string[]): boolean => rows.map(clean).some(isResumeError)

/**
 * The development-channels warning is really on screen, not quoted: its footer is the last row with text, and above it, in the
 * bottom `region` rows, the title, the `Channels:` line and exactly one selection cursor, read as the warning.
 */
export function liveDevChannels(rows: string[], region = DEV_CHANNEL_SCREEN.titleWithinRows): boolean {
  const tail = trimRight(rows)
  const last = clean(tail[tail.length - 1] ?? '')
  if (!last.startsWith(DEV_CHANNEL_SCREEN.liveFooters[0]) && !last.includes(DEV_CHANNEL_SCREEN.liveFooters[1]))
    return false
  const bottom = tail.slice(-region)
  let title = -1
  for (let i = bottom.length - 1; i >= 0; i--)
    if (clean(bottom[i] as string).includes(STRINGS.devTitle)) {
      title = i
      break
    }
  if (title < 0) return false
  const block = bottom.slice(title)
  if (classify(block).kind !== 'dev_channels') return false
  return block.map(clean).filter(isHighlighted).length === 1
}

/**
 * A dialog really waiting on a session (trust, MCP consent, bypass, login), where any of their words may be quoted in a
 * conversation: the frame's rule row, one selection cursor below it and either the footer or numbered options, and the
 * dialog's phrase below the rule, all in the bottom `region` rows. The input box (rule, `❯` row, rule) is not one.
 */
export function liveDialog(rows: string[], region = 24): Screen {
  // the usage-limit screen has its own shape (no frame rule above its options), read on its own
  const usage = readUsageLimit(rows, region)
  if (usage) return { kind: 'usage_limit', info: usage }
  const bottom = trimRight(rows).slice(-region)
  let rule = -1
  for (let i = bottom.length - 1; i >= 0; i--)
    if (isFrameRule(bottom[i] as string)) {
      rule = i
      break
    }
  if (rule < 0) return { kind: 'none' }
  const block = bottom.slice(rule + 1)
  const cleaned = block.map(clean)
  // not logged in is no Select at all: the input box stays, and the row below its last rule ends with `· Run /login`
  if (!cleaned.some(isHighlighted) && cleaned.some((r) => STRINGS.login.some((l) => r.endsWith(`· ${l}`))))
    return { kind: 'login_expired' }
  if (cleaned.filter(isHighlighted).length !== 1) return { kind: 'none' }
  const footer = cleaned.some((r) => r.startsWith('Enter to confirm') || r.includes('Esc to cancel'))
  if (!footer && !cleaned.some(isIndexedCursor)) return { kind: 'none' }
  const s = classify(block)
  if (!['trust', 'mcp_consent', 'bypass_disclaimer', 'login_expired'].includes(s.kind)) return { kind: 'none' }
  const phrase = cleaned.some(
    (r) =>
      STRINGS.trust.some((p) => r.includes(p)) ||
      STRINGS.mcpConsent.some((p) => r.includes(p)) ||
      r.includes(STRINGS.bypass) ||
      STRINGS.login.some((p) => r.startsWith(p) || r.includes(`· ${p}`)),
  )
  return phrase ? s : { kind: 'none' }
}

/**
 * The rows between the two rules of Claude's input box (the first of them starts with `❯`): the LAST pair of rule rows with a
 * `❯` row first between them. A dialog's options (no rule after them) and a blank pane are not one. [start, end) or null.
 */
export function inputBox(rows: string[]): [number, number] | null {
  const rules = rows.flatMap((r, i) => (isFrameRule(r) ? [i] : []))
  for (let k = rules.length - 2; k >= 0; k--) {
    const a = rules[k] as number
    const b = rules[k + 1] as number
    if (b - a >= 2 && (rows[a + 1] ?? '').replace(/^ +/, '').startsWith(STRINGS.pointer)) return [a + 1, b]
  }
  return null
}

/** `ESC [ … <final>` (any CSI sequence, colour or not) removed: the text tmux's `capture-pane -e` drew. */
export function stripEscapes(row: string): string {
  let out = ''
  for (let i = 0; i < row.length; i++) {
    const ch = row[i] as string
    if (ch === '\u001b') {
      if (row[i + 1] === '[') {
        i += 2
        while (i < row.length && !isCsiFinal(row.charCodeAt(i))) i++
      } else i++
      continue
    }
    out += ch
  }
  return out
}
const isCsiFinal = (c: number) => c >= 0x40 && c <= 0x7e

type Cell = { ch: string; dim: boolean; reverse: boolean }

/** The visible characters of a row with the attributes they were drawn with; dim and reverse carry on across rows. */
function cells(row: string, st: { dim: boolean; reverse: boolean }): Cell[] {
  const out: Cell[] = []
  const chars = [...row]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (ch === '\u001b' && chars[i + 1] === '[') {
      let j = i + 2
      let params = ''
      while (j < chars.length && !isCsiFinal((chars[j] as string).charCodeAt(0))) params += chars[j++]
      if (chars[j] === 'm')
        for (const code of params.split(';')) {
          // only these are known (the Mac's InputBoxAttributes): any other code counts as "not dim", the safe side
          switch (code === '' ? '0' : code) {
            case '0':
              st.dim = false
              st.reverse = false
              break
            case '1':
            case '39':
              break
            case '2':
              st.dim = true
              break
            case '22':
              st.dim = false
              break
            case '7':
              st.reverse = true
              break
            case '27':
              st.reverse = false
              break
            default:
              st.dim = false
          }
        }
      i = j
      continue
    }
    out.push({ ch, dim: st.dim, reverse: st.reverse })
  }
  return out
}

/**
 * Is there a draft in Claude's input box? From `capture-pane -e` rows (the Mac's InputBoxAttributes, on the same real 2.1.318
 * captures): the idle placeholder (`❯` NBSP `Try "…"`) is dim apart from one reverse-video cursor cell, and anything drawn at
 * normal intensity is the owner's. null: no input box on screen. A pointer is typed only when this is false.
 */
export function draftPresent(escapedRows: string[]): boolean | null {
  const box = inputBox(escapedRows.map(stripEscapes))
  if (!box) return null
  const st = { dim: false, reverse: false }
  const all: Cell[] = []
  for (let r = box[0]; r < box[1]; r++) {
    let cs = cells(escapedRows[r] as string, st)
    if (r === box[0]) {
      // the glyph and the one separator after it are not the text
      const g = cs.findIndex((c) => c.ch === STRINGS.pointer)
      if (g >= 0) {
        cs = cs.slice(g + 1)
        if (cs[0] && (cs[0].ch === ' ' || cs[0].ch === ' ')) cs = cs.slice(1)
      }
    }
    all.push(...cs)
  }
  const visible = all.filter((c) => !/\s/u.test(c.ch) && c.ch !== ' ')
  const normal = visible.some((c) => !c.dim && !c.reverse)
  const reversed = visible.some((c) => !c.dim && c.reverse)
  const dimmed = visible.some((c) => c.dim)
  return normal || (reversed && !dimmed)
}

/** What the input box holds, white space runs made one space; null when no box is on screen. */
export function boxText(rows: string[]): string | null {
  const box = inputBox(rows)
  if (!box) return null
  const inner = rows.slice(box[0], box[1])
  const first = (inner[0] as string).replace(/^ +/, '').slice(STRINGS.pointer.length)
  return [first, ...inner.slice(1)].join(' ').split(/\s+/u).filter(Boolean).join(' ')
}

/** Claude is ready for typing: its input box is up, and no dialog (nor the warning) is live. A loading line is not ready. */
export function claudeIsReady(rows: string[]): boolean {
  return liveDialog(rows).kind === 'none' && !liveDevChannels(rows) && inputBox(rows) !== null
}

// ---- the auto-confirm guard ----------------------------------------------------------------------------------------------------

export type AutoConfirmRefusal =
  | 'disabled'
  | 'not_main'
  | 'already_confirmed_this_start'
  | 'no_dialog'
  | 'ambiguous_dialog'
  | 'channels_mismatch'
  | 'wrong_highlight'
  | 'launch_changed'
  | 'outside_window'
  | 'clients_may_be_typing'
  | 'rate_limited'
  /** The screen read right before the Enter was not the screen the decision was made on (the supervisor's own check). */
  | 'screen_changed'

export type { AutoConfirmInputs }

export type AutoConfirmDecision = { confirm: true } | { confirm: false; refusal: AutoConfirmRefusal }

const sameBytes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((s, i) => Buffer.from(s, 'utf8').equals(Buffer.from(b[i] as string, 'utf8')))

const refuse = (refusal: AutoConfirmRefusal): AutoConfirmDecision => ({ confirm: false, refusal })

/**
 * Enter on the development-channels warning only when every condition holds; otherwise the first that fails. Both the channels
 * on screen AND the ones this launch passed must be exactly `server:talos-app`, byte for byte: neither a file nor the argv
 * ever widens what is answered. The caller makes this decision twice, reads the screen again, then sends the one Enter.
 */
export function decideAutoConfirm(i: AutoConfirmInputs): AutoConfirmDecision {
  if (!i.enabled) return refuse('disabled')
  if (!i.isMain) return refuse('not_main')
  if (i.enterSentThisStart) return refuse('already_confirmed_this_start')
  const d = i.screen
  if (!d) return refuse('no_dialog')
  if (d.titleCount !== 1 || d.channelsRowCount !== 1) return refuse('ambiguous_dialog')
  const only = [DEV_CHANNEL_SCREEN.channel]
  if (!d.channels || !sameBytes(d.channels, only) || !sameBytes(i.launchChannels, only))
    return refuse('channels_mismatch')
  if (d.highlighted === null || !sameBytes([d.highlighted], [STRINGS.devConfirm])) return refuse('wrong_highlight')
  if (!i.sealVerified) return refuse('launch_changed')
  if (!(i.sinceSpawnMs >= 0 && i.sinceSpawnMs <= AUTO_CONFIRM_WINDOW_MS)) return refuse('outside_window')
  if (i.sinceClientKeyMs === null || i.sinceClientKeyMs < AUTO_CONFIRM_QUIET_MS) return refuse('clients_may_be_typing')
  if (!i.rateLimitOk) return refuse('rate_limited')
  return { confirm: true }
}

const AUTO_CONFIRM_WINDOW_MS = AUTO_CONFIRM.within_spawn_ms
const AUTO_CONFIRM_QUIET_MS = AUTO_CONFIRM.client_quiet_ms

/**
 * The channels an argv passes with `--dangerously-load-development-channels`: every value after the flag up to the next option,
 * and `--flag=value`, from every occurrence. One argv element is one channel, never split.
 */
export function channelsInArgv(args: string[]): string[] {
  const flag = '--dangerously-load-development-channels'
  const out: string[] = []
  let collecting = false
  for (const a of args) {
    if (a === flag) collecting = true
    else if (a.startsWith(`${flag}=`)) {
      collecting = false
      out.push(a.slice(flag.length + 1))
    } else if (a.startsWith('-')) collecting = false
    else if (collecting) out.push(a)
  }
  return out
}
