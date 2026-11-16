// Claude Code's usage-limit menu (the Mac's UsageLimitScreen.swift, 94f1d16b, ported and widened after Fable's review of the
// port, which read the installed CLI 2.1.323): when the session hits a limit, Claude Code shows a select titled "What do you want
// to do?" whose options include ways to wait ("Stop and wait for limit to reset", "Wait here, then continue automatically ...")
// and ways that cost money or a plan change ("Add funds to continue with usage credits", "Switch to usage ...", "Adjust monthly
// spend limit", "Upgrade your plan ...", "Ask your admin for more usage"). Talos never sends that menu a key of any kind, and,
// failing safe, no key goes to ANY select Talos cannot name (key-guard.ts). The owner is told what kind of limit it is, when it
// resets if the screen says so, and how to go on.
//
// Recognised by its structure, not its headline (which varies: a model's limit, the weekly or 5-hour limit, a team's shared
// budget, a trial that ended): in the bottom rows, the title row, below it numbered options from 1 with the one cursor on one of
// them, at least one option of a known paying or waiting form (wrapped rows joined), and below them anything but Claude's input
// box (a conversation that quotes the menu ends in that box). The headline above the title, when there is one, gives the kind.
// No real capture is in the fixtures yet: apps/desktop/Tests/Fixtures/synthetic/usage-limit*.txt are built from the CLI's own
// strings and say SYNTHETIC.
import type { MainNeedsYou } from '@talos-app/protocol'
import { ruleAtColumn0 } from './box-frame.ts'
import { detectPrompt } from './dialog-reader.ts'
import { clean, isFrameRule, liveDialog, STRINGS } from './screen.ts'

/** The reset as the screen gives it, each part optional (at least a day or a time): what `resetsAt` turns into a moment. */
export type ResetParts = {
  month?: number
  day?: number
  hour?: number
  minute?: number
  /** The clock time in Talos's spelling ("4pm", "3:10pm", "15:10"). */
  clock?: string
  zone?: string
}

/**
 * What kind of limit the headline names, in Talos's words: a model's own limit (`/model` helps), one for every model (the
 * weekly or 5-hour limit: another model does not help), a team's shared budget, a monthly spend limit, a trial that ended, or
 * none named.
 */
export type LimitKind = 'model' | 'weekly' | 'five_hour' | 'team_budget' | 'spend' | 'trial' | 'unnamed'

/**
 * What the screen says, in Talos's own words: `model`, `kind` and `resets` are rebuilt from fixed lists and from numbers, never
 * copied from the screen, so a line built from them may be posted as the supervisor's own row.
 */
export type UsageLimitInfo = { model: string | null; kind: LimitKind; resets: string | null; parts: ResetParts | null }

/** The needs-you name of the screen (`needs_you.kind` in workers.json), the Mac's words. */
export const USAGE_LIMIT_KIND = 'usage limit'
const MODELS = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'Mythos']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TITLE = 'what do you want to do'
/** The option forms that wait, pay or change the plan (the CLI's own words, lower-cased, matched as parts of an option's text). */
const OPTION_FORMS = [
  'wait for limit to reset',
  'stop and wait',
  'wait here',
  'usage credits',
  'add funds',
  'switch to usage',
  'continue with usage',
  'spend limit',
  'upgrade your plan',
  'upgrade to',
  'ask your admin',
]

const isHighlighted = (cleaned: string) => cleaned.startsWith(STRINGS.pointer)

/** The screen on these rows, or null. `region`: the bottom rows looked at (a narrow pane wraps the menu over more rows). */
export function readUsageLimit(rows: readonly string[], region = 40): UsageLimitInfo | null {
  const raw = [...rows]
  while (raw.length > 0 && (raw[raw.length - 1] as string).trim() === '') raw.pop()
  const tail = raw.slice(-region)
  const bottom = tail.map(clean)
  if (bottom.length === 0) return null
  // the anchor: the last title row, else (a menu drawn without its title) the last headline row; the numbered options are below
  // it (a numbered list in the conversation above is not one of them)
  const lastWhere = (f: (l: string) => boolean) => {
    for (let i = bottom.length - 1; i >= 0; i--) if (f((bottom[i] as string).toLowerCase())) return i
    return -1
  }
  const titled = lastWhere((l) => l.includes(TITLE))
  const title = titled >= 0 ? titled : lastWhere(isHeadline)
  if (title < 0) return null
  // the options run from the title to the end, or to the next solid rule (a frame drawn below the menu is not part of it)
  let end = bottom.length
  for (let i = title + 1; i < bottom.length; i++)
    if (isFrameRule(tail[i] as string)) {
      end = i
      break
    }
  const options: number[] = []
  for (let i = title + 1; i < end; i++) if (optionNumber(bottom[i] as string) !== null) options.push(i)
  if (options.length < 2) return null
  if (options.some((r, k) => optionNumber(bottom[r] as string) !== k + 1)) return null
  // the one cursor from the title to the last option, on an option (an input box drawn under the menu has its own cursor row,
  // below the options: it neither hides the menu nor counts; the owner's messages above it are drawn with the pointer too)
  const last = options[options.length - 1] as number
  const cursors: number[] = []
  for (let i = title; i <= last; i++) if (isHighlighted(bottom[i] as string)) cursors.push(i)
  if (cursors.length !== 1 || !options.includes(cursors[0] as number)) return null
  // each option's text with its wrapped rows (the rows up to the next option, or a blank row)
  const texts = options.map((r, k) => {
    const end = options[k + 1] ?? bottom.length
    const parts: string[] = []
    for (let i = r; i < end && (i === r || (bottom[i] as string) !== ''); i++) parts.push(bottom[i] as string)
    return parts.join(' ').toLowerCase()
  })
  if (!texts.some((t) => OPTION_FORMS.some((f) => t.includes(f)))) return null
  // the headline: the text rows above the title (or the headline row itself when there is no title), back to a blank row or a
  // rule (a line quoted above is not part of it)
  let h = titled >= 0 ? title - 1 : title
  while (h >= 0 && (bottom[h] as string) === '') h--
  const lines: string[] = []
  const isRule = (k: number) => isFrameRule(tail[k] as string) || /^[─━═╌┄┈-]{3,}$/.test(bottom[k] as string)
  for (; h >= 0 && (bottom[h] as string) !== '' && !isRule(h); h--) lines.unshift(bottom[h] as string)
  // recognised with or without a rule above it (the Mac's reader needs none). A menu quoted in the conversation is the other way
  // round: Claude's input box is live BELOW it (its frame, only status rows under it) and the menu's rows sit above that box's
  // top rule (Fable R4-1)
  // decided by the menu's own position against Claude's real box, never by the rows under the box (Fable R1-3 on the pair: a user's
  // status row under it made a quoted menu read live): the FIRST full frame below the menu's last option, drawn from column 0 as
  // Claude Code draws its box (a status line is drawn indented, so a frame it prints never counts)
  if (realBoxBelow(tail, last)) return null
  // and a prompt or dialog live in a frame of its own below the menu (a tool's permission prompt, a select) is what is live: the
  // menu above it is quoted, and must not mask it (Fable R5-2). Read on the rows from the last solid rule, which hold no menu.
  if (end < bottom.length) {
    const below = tail.slice(tail.findLastIndex((r) => isFrameRule(r)))
    if (detectPrompt(below) !== null || liveDialog(below).kind !== 'none') return null
  }
  const headline = lines.join(' ')
  const parts = resetParts(headline)
  const model = modelIn(headline)
  return { model, kind: limitKind(headline, model), resets: parts ? resetWords(parts) : null, parts }
}

/** A headline the menu may be drawn under: "hit your" or "reached your", and a limit or a budget. */
const isHeadline = (l: string) =>
  (l.includes('hit your') || l.includes('reached your')) && (l.includes('limit') || l.includes('budget'))

/** The menu is on these rows (takesNoKeys for this menu alone; key-guard.ts adds every select Talos cannot name). */
export const isUsageLimit = (rows: readonly string[] | null | undefined): boolean =>
  rows !== null && rows !== undefined && readUsageLimit(rows) !== null

/** The kind of limit a headline names (modelIn has read the model, if any). */
export function limitKind(headline: string, model: string | null): LimitKind {
  const l = headline.toLowerCase()
  if (l.includes('trial')) return 'trial'
  if (l.includes('budget')) return 'team_budget'
  if (l.includes('spend')) return 'spend'
  if (model) return 'model'
  if (l.includes('weekly')) return 'weekly'
  if (l.includes('5-hour') || l.includes('five-hour') || l.includes('session limit')) return 'five_hour'
  return 'unnamed'
}

/** `❯ 2. Wait…` or `2. Wait…`: the option's number, or null. */
export function optionNumber(cleaned: string): number | null {
  let s = cleaned
  if (s.startsWith(STRINGS.pointer)) s = s.slice(STRINGS.pointer.length)
  s = s.replace(/^ +/, '')
  const m = /^(\d{1,2})\. (.+)$/.exec(s)
  return m ? Number(m[1]) : null
}

/** The model the headline names, between "your" and "limit": a family from MODELS, with a version of digits after it if any. */
export function modelIn(headline: string): string | null {
  const l = headline.toLowerCase()
  const your = l.indexOf('your ')
  if (your < 0) return null
  const after = l.slice(your + 5)
  const limit = after.indexOf('limit')
  if (limit < 0) return null
  const words = after
    .slice(0, limit)
    .split(/[ '’]/)
    .filter((w) => w !== '')
  for (let i = 0; i < words.length; i++) {
    const family = MODELS.find((m) => m.toLowerCase() === words[i])
    if (!family) continue
    const next = words[i + 1]
    return next !== undefined && isVersion(next) ? `${family} ${next}` : family
  }
  return null
}

const isVersion = (w: string) => {
  const parts = w.split('.')
  return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d{1,3}$/.test(p))
}

/**
 * After "resets": an optional "at"/"on", an optional day (a month's name or its first three letters, a day of 1 or 2 digits), an
 * optional clock time (12-hour with am/pm, or 24-hour with minutes), an optional `(Area/City)`. The Mac's resetsPattern.
 */
const RESETS =
  /^\s*(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?\s+(\d{1,2})(?!\d),?\s*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(\d{1,2}):(\d{2})\b)?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})\))?/i

/** The reset's parts read from the text after "resets", or null (nothing readable, or a number out of range). */
export function resetParts(text: string): ResetParts | null {
  const r = text.toLowerCase().indexOf('resets')
  if (r < 0) return null
  const m = RESETS.exec(text.slice(r + 'resets'.length).slice(0, 120))
  if (!m) return null
  const out: ResetParts = {}
  const day = m[2] === undefined ? Number.NaN : Number(m[2])
  if (m[1] !== undefined && day >= 1 && day <= 31) {
    out.month = MONTHS.findIndex((n) => n.toLowerCase() === (m[1] as string).toLowerCase())
    out.day = day
  }
  const h12 = m[3] === undefined ? Number.NaN : Number(m[3])
  if (h12 >= 1 && h12 <= 12 && m[5] !== undefined) {
    let minute = 0
    if (m[4] !== undefined) {
      minute = Number(m[4])
      if (minute > 59) return null
    }
    out.hour = (h12 % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0)
    out.minute = minute
    out.clock = m[4] !== undefined ? `${h12}:${m[4]}${m[5].toLowerCase()}` : `${h12}${m[5].toLowerCase()}`
  } else if (m[6] !== undefined && m[7] !== undefined) {
    const h = Number(m[6])
    const mi = Number(m[7])
    if (h <= 23 && mi <= 59) {
      out.hour = h
      out.minute = mi
      out.clock = `${String(h).padStart(2, '0')}:${m[7]}`
    }
  }
  if (out.day === undefined && out.hour === undefined) return null
  const zone = m[8] !== undefined ? knownZone(m[8]) : null
  if (zone) out.zone = zone
  return out
}

/** The system's own name for a zone it knows, or null: the screen's spelling is never copied. */
function knownZone(z: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The reset in Talos's own spelling, the Mac's: "Aug 8, 3:10pm (Europe/Paris)", "4pm", "15:10". */
export function resetWords(p: ResetParts): string {
  const parts: string[] = []
  if (p.month !== undefined && p.day !== undefined) parts.push(`${MONTHS[p.month]} ${p.day}`)
  if (p.clock) parts.push(p.clock)
  return parts.join(', ') + (p.zone ? ` (${p.zone})` : '')
}

/**
 * The reset as a moment (ISO, UTC): the NEXT time after `nowMs` the screen's day and clock time come round, in its zone when it
 * names one the system knows, else `localZone` (the supervisor's own). No day: today or tomorrow. A day: this year, or next if
 * it has passed. No time: the start of that day. Null when it cannot be worked out (needs_you.resets_at is then absent).
 */
export function resetsAt(p: ResetParts | null, nowMs: number, localZone: string): string | null {
  if (!p) return null
  const zone = p.zone ?? knownZone(localZone)
  if (!zone) return null
  const now = wallIn(zone, nowMs)
  const hour = p.hour ?? 0
  const minute = p.minute ?? 0
  const candidates: Array<[number, number, number]> =
    p.month !== undefined && p.day !== undefined
      ? [
          [now.year, p.month, p.day],
          [now.year + 1, p.month, p.day],
        ]
      : [
          [now.year, now.month, now.day],
          [now.year, now.month, now.day + 1],
        ]
  for (const [y, mo, d] of candidates) {
    // a day the month does not have (Feb 30) is no day: Date.UTC would roll it into the next month
    if (p.day !== undefined && new Date(Date.UTC(y, mo, d)).getUTCMonth() !== mo) continue
    const at = utcOf(zone, y, mo, d, hour, minute)
    // a wall time the zone skips (a clock change's gap) is no moment: none, never a guess an hour off (Fable R1-6)
    const back = wallIn(zone, at)
    if (back.hour !== hour || back.minute !== minute) return null
    // a reset that has only just passed (the menu is still up a little after it) is that moment, never the next day's
    if (at > nowMs || nowMs - at < JUST_PASSED_MS) return new Date(at).toISOString()
    // a day that is today, read after its time (or a day with no time, read on that day): not next year's; unknown (Fable R2-6)
    if (p.day !== undefined && y === now.year && mo === now.month && d === now.day) return null
  }
  return null
}

/** A reset this recently past is still the one the screen means (it has not been redrawn yet), not tomorrow's. */
const JUST_PASSED_MS = 60 * 60 * 1000

/** The wall clock in `zone` at `ms`: year, month (0-11), day. */
function wallIn(
  zone: string,
  ms: number,
): { year: number; month: number; day: number; hour: number; minute: number; offsetMs: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const g = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(
    Number(g.year),
    Number(g.month) - 1,
    Number(g.day),
    Number(g.hour),
    Number(g.minute),
    Number(g.second),
  )
  return {
    year: Number(g.year),
    month: Number(g.month) - 1,
    day: Number(g.day),
    hour: Number(g.hour),
    minute: Number(g.minute),
    offsetMs: asUtc - Math.floor(ms / 1000) * 1000,
  }
}

/** The instant whose wall clock in `zone` reads y-mo-d h:mi (two passes over the zone's offset, for a change in between). */
function utcOf(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  let at = guess - wallIn(zone, guess).offsetMs
  at = guess - wallIn(zone, at).offsetMs
  return at
}

// ---- the lines: the Mac's words, with Linux's way to the pane ------------------------------------------------------------------

/** What was hit, in Talos's words, for "<who> <this>." */
function hitWords(i: Pick<UsageLimitInfo, 'model' | 'kind'>): string {
  switch (i.kind) {
    case 'model':
      return `hit the usage limit for ${i.model}`
    case 'weekly':
      return 'hit its weekly limit, which covers every model'
    case 'five_hour':
      return 'hit its 5-hour limit, which covers every model'
    case 'team_budget':
      return "hit the team's shared budget"
    case 'spend':
      return 'hit the monthly spend limit'
    case 'trial':
      return 'reached the end of the Claude Code trial'
    default:
      return 'hit a usage limit'
  }
}

/** How the owner goes on, for the pane named in `pane` ("this thread's pane (attach ...)", "its pane (view)"). */
function wayOn(i: Pick<UsageLimitInfo, 'kind'>, pane: string): string {
  switch (i.kind) {
    case 'model':
      return `To go on now, press Esc in ${pane}, then /model <another model>.`
    case 'weekly':
    case 'five_hour':
      return `Another model will not help with this one: press Esc in ${pane} to close the menu, and the session goes on after the reset.`
    case 'team_budget':
      return `Press Esc in ${pane} to close the menu; more needs your admin.`
    case 'spend':
      return `Press Esc in ${pane} to close the menu; changing the spend limit is yours to do there.`
    case 'trial':
      return `Press Esc in ${pane} to close the menu; going on needs a plan.`
    default:
      return `Press Esc in ${pane} to close the menu; if the limit is one model's, /model <another model> goes on now.`
  }
}

/**
 * The owner's line for the menu, `who` being "This thread's session" or Main's name: what was hit, when it resets, that Talos
 * pressed nothing, and the way on. Nothing in it is screen text, and it never says to answer the menu.
 */
export function usageLimitWords(
  i: Pick<UsageLimitInfo, 'model' | 'kind' | 'resets'>,
  who: string,
  pane: string,
): string {
  const reset = i.resets ? ` It resets ${i.resets}.` : ''
  return `${who} ${hitWords(i)}.${reset} Talos pressed nothing on that screen: some of its options spend money or change your plan. ${wayOn(i, pane)}`
}

/** The thread's line, posted into the thread it is about. */
export const usageLimitThreadLine = (i: UsageLimitInfo, attach: string, windows = false): string =>
  usageLimitWords(
    i,
    "This thread's session",
    // the Windows PC opens the pane from the tray (Titan's "Open a thread's session..."), where Linux attaches
    windows
      ? "this thread's pane (on the PC: the Talos icon by the clock, Open a thread's session..., this thread)"
      : `this thread's pane (${attach})`,
  )

/**
 * One line per appearance of the screen, at most one an hour per session (the Mac's UsageLimitWatch). An appearance ends only when
 * the looks have missed it for GONE_AFTER_S (one torn frame is not the screen gone). Times are monotonic seconds.
 */
export class UsageLimitWatch {
  static readonly WINDOW_S = 3600
  static readonly GONE_AFTER_S = 2
  showing = false
  private absentSince: number | null = null
  private toldAt: number | null = null

  look(onScreen: boolean, now: number): 'none' | 'appeared' | 'still' | 'fading' | 'gone' {
    if (onScreen) {
      this.absentSince = null
      if (this.showing) return 'still'
      this.showing = true
      return 'appeared'
    }
    if (!this.showing) return 'none'
    if (this.absentSince === null || now < this.absentSince) {
      this.absentSince = now
      return 'fading'
    }
    if (now - this.absentSince < UsageLimitWatch.GONE_AFTER_S) return 'fading'
    this.showing = false
    this.absentSince = null
    return 'gone'
  }

  /** Whether the owner's line may go for this appearance; when it may, it counts as told. */
  mayTellOwner(now: number): boolean {
    if (this.toldAt !== null && now - this.toldAt < UsageLimitWatch.WINDOW_S && this.toldAt <= now + 60) return false
    this.toldAt = now
    return true
  }
}

/** Main's needs-you for the menu: the model, the limit and the reset in Talos's words, and the reset as a moment when it reads. */
export function usageNeedsYou(i: UsageLimitInfo, wallMs: number): MainNeedsYou {
  const at = resetsAt(i.parts, wallMs, Intl.DateTimeFormat().resolvedOptions().timeZone)
  return { kind: 'usage_limit', model: i.model, limit: i.kind, resets: i.resets, ...(at ? { resets_at: at } : {}) }
}

/**
 * Claude's own input box below row `after`: a solid rule there that starts at column 0, then a row starting at column 0 with the
 * pointer, then another solid rule at column 0. Rows a status line prints are indented, so they can never make one. A column-0
 * rule that does not open such a frame (one in the conversation) is passed over, and the scan goes on (Fable R2-3).
 */
function realBoxBelow(rows: readonly string[], after: number): boolean {
  for (let i = after + 1; i < rows.length; i++) {
    if (!ruleAtColumn0(rows[i]) || !(rows[i + 1] ?? '').startsWith(STRINGS.pointer)) continue
    for (let k = i + 2; k < rows.length; k++) if (ruleAtColumn0(rows[k])) return true
  }
  return false
}
