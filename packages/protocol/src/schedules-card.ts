// composeScheduleCard() (docs/SCHEDULES.md S8.2, S9 N4): the whole `kind:'schedule'` Card from its inputs. Pure: the
// bridge calls it to mint the card, the web tests render its output directly, and the capture step asserts that the
// real bridge's `card.create` equals it for the same inputs.
import { payloadHash } from './canonical.ts'
import { riskForTrust } from './config.ts'
import { heartbeatMuteOnlyChange } from './heartbeat.ts'
import { heartbeatSection } from './heartbeat-card.ts'
import { bindingFrom, type CardT } from './models.ts'
import {
  type JobMetaT,
  metaForDisplay,
  SCHEDULE_CARD_SCHEMA,
  type ScheduleCardPayloadT,
  type ScheduleChangeT,
  type SchedulePreviewT,
  type ScheduleT,
  type ScheduleWhenT,
  safeLine,
} from './schedules.ts'

export const SCHEDULE_CARD_BODY_MAX_BYTES = 16 * 1024
export const SCHEDULE_CARD_TRUNCATED = '… full text under Details'
export const SCHEDULE_FULL_WARNING = 'Runs unattended with full permissions: it can do anything you can on this Mac.'
// Owner call O2: a background card lives a day, like a chat card (it used to be 30 minutes, unseen).
const EXPIRY_S = { chat: 86_400, background: 86_400 } as const

/**
 * The job as it is now (update, delete, adopt), from ONE `detail` call: its `schedule.etag` must be the change's
 * `base_etag` (update, delete) and its `schedule.content_hash` the adopt's `content_hash`, or the composer refuses (F4).
 * For adopt, `prompt`/`guard` are what's on disk.
 */
export type ScheduleCardBase = { schedule: ScheduleT; prompt: string; guard: string | null }

/**
 * What Chronos's approved record holds (N7). `fields` are the hashed record fields as approved; when the scheduler
 * doesn't record them (Chronos 0.3.0-rc1 keeps only prompt and guard) the adopt card lists today's values instead.
 */
export type ScheduleApproved = {
  prompt: string
  guard: string | null
  fields?: Partial<Pick<ScheduleT, 'kind' | 'runner' | 'permissions' | 'allowed_tools' | 'model'>> & {
    command?: string | null
  }
  /** The meta as approved, if the scheduler ever records it (Chronos 0.4 does not). Lets an adopt card show what moved. */
  meta?: unknown
}

/** Thrown when the card would show one version and bind another (F4). The bridge re-reads and retries; never mints. */
export class ScheduleCardBindingError extends Error {}

const ADOPT_FIELDS = ['kind', 'runner', 'permissions', 'allowed_tools', 'model'] as const

/**
 * Does this job run in a Claude session? Only a session-runner job with its permissions not restricted: a restricted job is
 * always headless (read-only, no session), whatever its runner says. The one rule behind "own session" everywhere: which jobs a
 * thread session may touch, which runs the router hands it, what its card says, and what the app shows.
 */
export function runsInSession(j: { runner: string; permissions: string }): boolean {
  return j.runner === 'session' && j.permissions !== 'restricted'
}

export type ComposeScheduleCardOpts = {
  cardId: string
  /** Thread the card is posted in. */
  threadId: string
  /** created_at, ISO. */
  now: string
  /** 'chat' for form-minted cards and agent proposals that answer an owner message; 'background' otherwise. */
  origin: 'chat' | 'background'
  proposedBy: 'agent' | 'owner_form'
  agentName: string
  /** From the adapter's validate (null for delete). */
  expectedEtag: string | null
  /** The `schedule.patch` frame id for form-minted cards, else null. */
  clientRef: string | null
  /** Label for a result thread; `null` means the default thread. */
  threadName: (threadId: string | null) => string
  /** The current job. Required for update, delete and adopt; null for create. */
  base: ScheduleCardBase | null
  /** The agent's reason, shown as the summary. */
  reason?: string
  supersedes?: string
  /** Trust mode on at the Mac: the card is low (no passkey). Absent = the S8.2 rule, byte-identical to before. */
  trust?: boolean
  /**
   * The proposal came from a thread's own session (docs/OPTION-C.md "Thread schedules"): its thread's name. The card then names
   * that session, says where the job runs, and uses the Approve / Not now buttons. Absent = the card is byte-identical to before.
   */
  sessionName?: string
}

type Effective = Pick<
  ScheduleT,
  | 'name'
  | 'runner'
  | 'permissions'
  | 'allowed_tools'
  | 'model'
  | 'enabled'
  | 'thread_id'
  | 'catchup_min'
  | 'notify'
  | 'memory'
>

function effective(change: ScheduleChangeT, base: ScheduleCardBase | null): Effective {
  const cur: Partial<Effective> = base ? base.schedule : {}
  const fallback: Effective = {
    name: change.op === 'create' ? change.draft.name : change.id,
    runner: 'session',
    permissions: 'full',
    allowed_tools: [],
    model: null,
    enabled: true,
    thread_id: null,
    catchup_min: 180,
    notify: 'failure',
    memory: false,
  }
  const now = { ...fallback, ...cur }
  if (change.op === 'create') return { ...now, ...pickEffective(change.draft) }
  if (change.op === 'update') return { ...now, ...pickEffective(change.set) }
  return now
}

function pickEffective(o: Partial<Record<keyof Effective, unknown>>): Partial<Effective> {
  const out: Record<string, unknown> = {}
  for (const k of [
    'name',
    'runner',
    'permissions',
    'allowed_tools',
    'model',
    'enabled',
    'thread_id',
    'catchup_min',
    'notify',
    'memory',
  ] as const) {
    if (o[k] !== undefined) out[k] = o[k]
  }
  return out as Partial<Effective>
}

/**
 * What a job with memory on keeps (docs/SCHEDULES.md S3.8). It is a line of the card's body, not a row of its destination: a
 * schedule card already fills the six destination rows a card can have, and a job without memory has no such line, so its card
 * is as it always was.
 */
const MEMORY_ON = 'on (keeps its last 3 results and a notepad of up to 2 KB between runs)'
const MEMORY_BACKGROUND = 'but this job runs in the background, which does not get memory yet'
/** What switching memory on does, in the card's own words: it widens every future prompt. */
const MEMORY_WIDENS = "Future runs will see the last 3 results and this job's notepad."
export function permissionWords(p: ScheduleT['permissions'], tools: readonly string[]): string {
  if (p === 'full') return 'Full permissions, nobody watching'
  if (p === 'restricted') return `Read-only: ${tools.length ? tools.join(', ') : 'no tools'}`
  return 'A command (edited on the Mac)'
}

export function runnerWords(r: ScheduleT['runner']): string {
  if (r === 'session') return 'In your live session'
  if (r === 'headless') return 'In the background'
  return 'Session, with a background backup (set outside Talos)'
}

/**
 * S8.2 risk rule. High when the change creates, deletes, adopts or turns a job on; changes the prompt, model or runner;
 * sets permissions to full; or adds an allowed tool. Everything else narrows or moves approved behaviour: low.
 * An update with no base to compare against is high (fail closed).
 */
export function scheduleCardRisk(
  change: ScheduleChangeT,
  base: ScheduleCardBase | null,
  /** The card's clock (ISO). A heartbeat mute is low risk only when it ends within 30 days of it; without one it is high. */
  now?: string,
): 'low' | 'high' {
  if (change.op !== 'update') return 'high'
  if (!base) return 'high'
  const s = change.set
  const cur = base.schedule
  if (s.enabled === true && !cur.enabled) return 'high'
  // switching memory on widens everything every future prompt carries: always the owner's card, like turning a job on
  if (s.memory === true && cur.memory !== true) return 'high'
  if (s.prompt !== undefined && s.prompt !== base.prompt) return 'high'
  if (s.model !== undefined && s.model !== cur.model) return 'high'
  if (s.runner !== undefined && s.runner !== cur.runner) return 'high'
  if (s.permissions === 'full' && cur.permissions !== 'full') return 'high'
  if (s.allowed_tools?.some((t) => !cur.allowed_tools.includes(t))) return 'high'
  // several fire times replaced by one: a silent loss of runs the owner approved
  if (s.when !== undefined && cur.when.type === 'times' && s.when.type !== 'times') return 'high'
  // meta is in content_hash (Chronos holds the job when it changes), so a change to it is never "just a setting"
  // (a heartbeat change that only adds short, exact-key mutes or removes mutes can only quiet items, so it is low: HB1b)
  if (
    s.meta !== undefined &&
    JSON.stringify(s.meta) !== JSON.stringify(cur.meta ?? null) &&
    !heartbeatMuteOnlyChange(cur.meta, s.meta, now)
  )
    return 'high'
  return 'low'
}

/** "09:45, 12:15, 14:45, 17:15 (weekdays)" for a times job, else null. Days as Chronos prints them: words or integers. */
function slotsWords(w: ScheduleWhenT | undefined | null): string | null {
  if (!w || w.type !== 'times') return null
  const days =
    typeof w.days === 'string'
      ? w.days
      : w.days.every((d) => typeof d === 'string')
        ? w.days.map((d) => safeLine(String(d))).join(', ')
        : `days ${w.days.map((d) => safeLine(String(d))).join(', ')}`
  return `${w.times.join(', ')} (${days})`
}

/** "4 a day: 09:45, 12:15, 14:45, 17:15 (weekdays)" for a times job, else null. */
function timesWords(w: ScheduleWhenT | undefined | null): string | null {
  const s = slotsWords(w)
  return s === null || !w || w.type !== 'times' ? null : `${w.times.length} a day: ${s}`
}

function whenOf(change: ScheduleChangeT, base: ScheduleCardBase | null): ScheduleWhenT | undefined {
  if (change.op === 'create') return change.draft.when
  if (change.op === 'update' && change.set.when !== undefined) return change.set.when
  return base?.schedule.when
}

/** The `Times:` line of a card: the list the owner is approving, in full (the destination row holds only Chronos's words). */
function timesLine(change: ScheduleChangeT, base: ScheduleCardBase | null): string | null {
  const after = timesWords(whenOf(change, base))
  const was = base?.schedule.when
  if (after === null) {
    // a job that fired several times a day is being given one time: say so plainly
    if (change.op === 'update' && change.set.when !== undefined && was?.type === 'times')
      return `Times: replaces ${was.times.length} times a day with one (was ${timesWords(was)})`
    return null
  }
  const before = change.op === 'update' && change.set.when !== undefined ? timesWords(was) : null
  return before !== null && before !== after ? `Times: ${before} → ${after}` : `Times: ${after}`
}

const META_HEAD = 'Meta (approved with the job'
/** Compact when the indented form would crowd the prompt out of the body. */
function metaPretty(m: JobMetaT): string {
  const c = metaForDisplay(m)
  const pretty = JSON.stringify(c, null, 2)
  return utf8(pretty) > 8000 ? JSON.stringify(c) : pretty
}

/**
 * `meta` is part of content_hash, so every card that approves, changes, removes or adopts a job shows it, ahead of the
 * prompt so a long prompt can't push it off the card. Its strings are untrusted: every control, hidden and bidi character
 * shows as a visible `⟦U+XXXX⟧` escape (never dropped, never a space) and the text is JSON-quoted, so nothing in one can start a
 * line of the card or pass for another key.
 */
function metaOnlySection(change: ScheduleChangeT, base: ScheduleCardBase | null): string | null {
  const cur = base?.schedule.meta
  if (change.op === 'update' && change.set.meta !== undefined) {
    if (change.set.meta === null) return cur ? `Meta: removed. It was:\n${metaPretty(cur)}` : null
    const after = metaPretty(change.set.meta)
    const d = lineDiff(cur ? metaPretty(cur) : '', after)
    // the whole new meta, then what moved: a diff alone shows only the lines near a change, and all of it is approved
    return d ? `${META_HEAD}):\n${after}\nChanged in the meta:\n${d}` : `${META_HEAD}, unchanged):\n${after}`
  }
  const m = change.op === 'create' ? change.draft.meta : cur
  if (!m) return null
  return `${META_HEAD}${change.op === 'update' ? ', unchanged' : ''}):\n${metaPretty(m)}`
}

/** The Heartbeat rows (if any), then the whole meta they summarise. */
function metaSection(
  change: ScheduleChangeT,
  base: ScheduleCardBase | null,
  approved: ScheduleApproved | null = null,
): string | null {
  const parts = [heartbeatRows(change, base, approved), metaOnlySection(change, base)].filter((p) => p !== null)
  return parts.length ? parts.join('\n\n') : null
}

/** The Heartbeat rows (HB1b) when the job is or becomes a heartbeat: placed ahead of the full meta they summarise. */
function heartbeatRows(
  change: ScheduleChangeT,
  base: ScheduleCardBase | null,
  approved: ScheduleApproved | null,
): string | null {
  if (change.op === 'delete') return null
  const cur = base?.schedule
  const metaSet = change.op === 'update' && change.set.meta !== undefined
  const after =
    change.op === 'create' ? change.draft.meta : metaSet ? (change as { set: { meta?: unknown } }).set.meta : cur?.meta
  const moved = change.op === 'update' && change.set.when !== undefined
  const none = '(this job does not fire several times a day)'
  return heartbeatSection({
    op: change.op,
    after,
    before: change.op === 'update' ? (cur?.meta ?? null) : change.op === 'adopt' ? approved?.meta : undefined,
    metaSet,
    slotsAfter: slotsWords(whenOf(change, base)) ?? none,
    slotsBefore: moved ? (slotsWords(cur?.when) ?? none) : undefined,
  })
}

const utf8 = (s: string) => new TextEncoder().encode(s).length

/** Caps text at `max` UTF-8 bytes, ending with "… full text under Details" when cut. */
export function capBody(text: string, max = SCHEDULE_CARD_BODY_MAX_BYTES): string {
  if (utf8(text) <= max) return text
  const tail = `\n${SCHEDULE_CARD_TRUNCATED}`
  const room = max - utf8(tail)
  let out = ''
  let used = 0
  for (const ch of text) {
    const b = utf8(ch)
    if (used + b > room) break
    out += ch
    used += b
  }
  return `${out}${tail}`
}

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { t: ' ' | '-' | '+'; line: string }

function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const mid: Op[] = []
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) mid.push({ t: '-', line: l })
    for (const l of bm) mid.push({ t: '+', line: l })
  } else {
    // LCS table over the differing middle only
    const n = am.length
    const m = bm.length
    const L = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * (m + 1) + j] =
          am[i] === bm[j]
            ? (L[(i + 1) * (m + 1) + j + 1] as number) + 1
            : Math.max(L[(i + 1) * (m + 1) + j] as number, L[i * (m + 1) + j + 1] as number)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ t: ' ', line: am[i] as string })
        i++
        j++
      } else if ((L[(i + 1) * (m + 1) + j] as number) >= (L[i * (m + 1) + j + 1] as number)) {
        mid.push({ t: '-', line: am[i++] as string })
      } else {
        mid.push({ t: '+', line: bm[j++] as string })
      }
    }
    while (i < n) mid.push({ t: '-', line: am[i++] as string })
    while (j < m) mid.push({ t: '+', line: bm[j++] as string })
  }
  return [
    ...a.slice(0, pre).map((line) => ({ t: ' ' as const, line })),
    ...mid,
    ...a.slice(a.length - suf).map((line) => ({ t: ' ' as const, line })),
  ]
}

/** Unified line diff (3 lines of context, `@@ -a,b +c,d @@` hunks). '' when the texts are equal. */
export function lineDiff(before: string, after: string, context = 3): string {
  const ops = diffOps(splitLines(before), splitLines(after))
  if (!ops.some((o) => o.t !== ' ')) return ''
  // old/new line numbers before each op
  const oldNo: number[] = []
  const newNo: number[] = []
  let on = 1
  let nn = 1
  for (const o of ops) {
    oldNo.push(on)
    newNo.push(nn)
    if (o.t !== '+') on++
    if (o.t !== '-') nn++
  }
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0)
  const hunks: Array<[number, number]> = []
  for (const c of changed) {
    const lo = Math.max(0, c - context)
    const hi = Math.min(ops.length - 1, c + context)
    const last = hunks[hunks.length - 1]
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
    else hunks.push([lo, hi])
  }
  const out: string[] = []
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1)
    const oldLen = slice.filter((o) => o.t !== '+').length
    const newLen = slice.filter((o) => o.t !== '-').length
    const oldStart = oldLen === 0 ? (oldNo[lo] as number) - 1 : (oldNo[lo] as number)
    const newStart = newLen === 0 ? (newNo[lo] as number) - 1 : (newNo[lo] as number)
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)
    for (const o of slice) out.push(`${o.t}${o.line}`)
  }
  return out.join('\n')
}

function changeLines(
  change: ScheduleChangeT & { op: 'update' },
  base: ScheduleCardBase | null,
  opts: ComposeScheduleCardOpts,
  preview: SchedulePreviewT,
): string[] {
  const cur = base?.schedule
  const s = change.set
  const lines: string[] = []
  const row = (label: string, before: string | undefined, after: string) =>
    lines.push(`${label}: ${before ?? '(unknown)'} → ${after}`)
  const yes = (b: boolean) => (b ? 'on' : 'off')
  if (s.name !== undefined) row('Name', cur?.name, s.name)
  if (s.description !== undefined) row('Description', cur?.description, s.description || '(none)')
  if (s.when !== undefined) row('Schedule', cur?.when_text, preview.when_text)
  const tl = s.when === undefined ? null : timesLine(change, base)
  if (tl) lines.push(tl)
  if (s.catchup_min !== undefined) row('Catch-up', cur ? `${cur.catchup_min} min` : undefined, `${s.catchup_min} min`)
  if (s.enabled !== undefined) row('On', cur ? yes(cur.enabled) : undefined, yes(s.enabled))
  if (s.runner !== undefined) row('Runs', cur ? runnerWords(cur.runner) : undefined, runnerWords(s.runner))
  if (s.permissions !== undefined || s.allowed_tools !== undefined) {
    const p = s.permissions ?? cur?.permissions ?? 'full'
    const t = s.allowed_tools ?? cur?.allowed_tools ?? []
    row('As', cur ? permissionWords(cur.permissions, cur.allowed_tools) : undefined, permissionWords(p, t))
  }
  if (s.model !== undefined) row('Model', cur ? (cur.model ?? 'default') : undefined, s.model ?? 'default')
  if (s.notify !== undefined) row('Notify', cur?.notify, s.notify)
  if (s.thread_id !== undefined)
    row('Posts to', cur ? opts.threadName(cur.thread_id) : undefined, opts.threadName(s.thread_id))
  if (s.memory !== undefined) {
    const background = !runsInSession(effective(change, base))
    const head = `Memory: ${cur ? yes(cur.memory === true) : '(unknown)'} → ${yes(s.memory)}`
    lines.push(s.memory && background ? `${head}, ${MEMORY_BACKGROUND}` : head)
    if (s.memory && !background && cur?.memory !== true) lines.push(MEMORY_WIDENS)
  }
  return lines
}

/** The create card's lines about memory: what it keeps and what it widens, or that this job cannot use it. */
function memoryLines(d: { runner?: string | undefined; permissions?: string | undefined }): string[] {
  const background =
    d.runner !== undefined &&
    d.permissions !== undefined &&
    !runsInSession({ runner: d.runner, permissions: d.permissions })
  return background ? [`Memory: on, ${MEMORY_BACKGROUND}`] : [`Memory: ${MEMORY_ON}`, MEMORY_WIDENS]
}

function settingsLines(d: {
  description: string
  enabled: boolean
  model: string | null
  notify: string
  catchup_min: number
  memory?: boolean | undefined
  runner?: string | undefined
  permissions?: string | undefined
}): string[] {
  return [
    `On: ${d.enabled ? 'on' : 'off (created switched off; turning it on needs another card)'}`,
    `Model: ${d.model ?? 'default'}`,
    `Notify: ${d.notify}`,
    `Catch-up: ${d.catchup_min} min`,
    ...(d.memory ? memoryLines(d) : []),
    `Description: ${d.description || '(none)'}`,
  ]
}

function fieldWords(k: (typeof ADOPT_FIELDS)[number], s: Pick<ScheduleT, (typeof ADOPT_FIELDS)[number]>): string {
  if (k === 'model') return s.model ?? 'default'
  if (k === 'runner') return runnerWords(s.runner)
  if (k === 'permissions' || k === 'allowed_tools') return permissionWords(s.permissions, s.allowed_tools)
  return s.kind
}
const FIELD_LABEL = { kind: 'Kind', runner: 'Runs', permissions: 'As', allowed_tools: 'As', model: 'Model' } as const

function guardAndJob(guard: string | null, prompt: string): string {
  return guard ? `--- standing rules (guard) ---\n${guard}\n--- job ---\n${prompt}` : prompt
}

function body(
  change: ScheduleChangeT,
  preview: SchedulePreviewT,
  approved: ScheduleApproved | null,
  opts: ComposeScheduleCardOpts,
): string {
  const base = opts.base
  switch (change.op) {
    case 'create': {
      // the normalized record exactly as it will be written (S8.2): settings first, then the meta, then the prompt
      const head = [timesLine(change, base), ...settingsLines(change.draft)].filter((l) => l !== null).join('\n')
      const meta = metaSection(change, base)
      return `${head}\n\n${meta ? `${meta}\n\n` : ''}Prompt:\n${change.draft.prompt}`
    }
    case 'update': {
      const parts: string[] = []
      const lines = changeLines(change, base, opts, preview)
      const tl = change.set.when === undefined ? timesLine(change, base) : null // a moved schedule has it in its own row
      if (tl) lines.unshift(tl)
      if (lines.length) parts.push(lines.join('\n'))
      const meta = metaSection(change, base)
      if (meta) parts.push(meta)
      if (change.set.prompt !== undefined) {
        const d = base ? lineDiff(base.prompt, change.set.prompt) : ''
        parts.push(d ? `Prompt:\n${d}` : base ? 'Prompt: unchanged' : `Prompt:\n${change.set.prompt}`)
      }
      return parts.join('\n\n') || 'No visible change.'
    }
    case 'delete': {
      const head = ['Deletes this job. Its run history stays on the Mac.', timesLine(change, base)].filter(
        (l) => l !== null,
      )
      const meta = metaSection(change, base)
      return `${head.join('\n')}${meta ? `\n\n${meta}` : ''}${base ? `\n\n${guardAndJob(null, base.prompt)}` : ''}`
    }
    case 'adopt': {
      if (!base) return 'Never approved.'
      const cur = base.schedule
      // Adopt approves everything content_hash covers (kind, command, permissions, tools, model, runner), not just text
      const settings = ADOPT_FIELDS.filter((k) => k !== 'allowed_tools') // the As row shows permissions and tools
      const now = settings.map((k) => `${FIELD_LABEL[k]}: ${fieldWords(k, cur)}`)
      const tl = timesLine(change, base)
      if (tl) now.push(tl)
      const meta = metaSection(change, base, approved)
      if (meta) now.push('', meta)
      if (cur.kind === 'command') now.push('Command: edited at the Mac (not shown here; review it at the Mac first)')
      if (!approved)
        return `Never approved. This is what's on disk now, and what approving makes runnable:\n\n${now.join('\n')}\n\n${guardAndJob(base.guard, base.prompt)}`
      const parts: string[] = ['Changed outside the app. Approved → what is on disk now.']
      if (approved.fields) {
        const was = { ...cur, ...approved.fields } as ScheduleT
        const moved = settings
          .filter((k) => fieldWords(k, was) !== fieldWords(k, cur))
          .map((k) => `${FIELD_LABEL[k]}: ${fieldWords(k, was)} → ${fieldWords(k, cur)}`)
        if (approved.fields.command !== undefined && cur.kind === 'command')
          moved.push('Command: changed at the Mac (not shown here; review it at the Mac first)')
        parts.push(moved.length ? `Settings:\n${moved.join('\n')}` : 'Settings: unchanged')
        // times and meta are in content_hash too, and the scheduler records no approved copy of them: show what is on disk
        if (tl) parts.push(tl)
        if (meta) parts.push(meta)
      } else {
        parts.push(
          `Settings approved with it (the scheduler doesn't record their approved values, so check them):\n${now.join('\n')}`,
        )
      }
      const g = lineDiff(approved.guard ?? '', base.guard ?? '')
      if (g) parts.push(`Standing rules:\n${g}`)
      if (cur.kind !== 'command') {
        const p = lineDiff(approved.prompt, base.prompt)
        parts.push(p ? `Prompt:\n${p}` : 'Prompt: unchanged')
      }
      return parts.join('\n\n')
    }
  }
}

const LABELS = {
  create: { title: 'New scheduled job', primary: 'Create job', kill: 'Kill new job' },
  update: { title: 'Change scheduled job', primary: 'Save change', kill: 'Kill change' },
  delete: { title: 'Delete scheduled job', primary: 'Delete job', kill: 'Keep the job' },
  adopt: { title: 'Review outside change', primary: 'Approve as it is', kill: 'Keep it on hold' },
} as const

const SESSION_RUNS_IN = "This thread's own session (wakes it if parked), or Main if that session can't take it"
const SESSION_VERB = { create: 'schedule', update: 'change', delete: 'delete', adopt: 'review' } as const

/** The first line of what the job does, for the "Does" row of a thread session's card. */
function doesLine(change: ScheduleChangeT, base: ScheduleCardBase | null): string {
  const text =
    change.op === 'create'
      ? change.draft.prompt
      : change.op === 'update'
        ? (change.set.prompt ?? base?.prompt ?? '')
        : (base?.prompt ?? '')
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l) ?? ''
  const cut = line.length > 200 ? `${line.slice(0, 199)}…` : line
  if (change.op === 'delete') return `Stops running${cut ? `: ${cut}` : ''}`.slice(0, 500)
  return cut || 'Runs the job as it stands'
}

export function composeScheduleCard(
  change: ScheduleChangeT,
  preview: SchedulePreviewT,
  approved: ScheduleApproved | null,
  opts: ComposeScheduleCardOpts,
): CardT {
  // F4: the card shows `opts.base`; it must bind that exact revision, or what's approved isn't what's shown
  if (change.op !== 'create') {
    const b = opts.base
    if (!b || b.schedule.id !== change.id)
      throw new ScheduleCardBindingError(`a ${change.op} card needs the current job ${change.id} as its base`)
    if ((change.op === 'update' || change.op === 'delete') && b.schedule.etag !== change.base_etag)
      throw new ScheduleCardBindingError('base_etag is not the revision the card shows; re-read the job')
    if (change.op === 'adopt' && b.schedule.content_hash !== change.content_hash)
      throw new ScheduleCardBindingError('content_hash is not the on-disk version the card shows; re-read the job')
  }
  const eff = effective(change, opts.base)
  const labels = LABELS[change.op]
  const payload: ScheduleCardPayloadT = {
    schema: SCHEDULE_CARD_SCHEMA,
    change,
    expected_etag: opts.expectedEtag,
    proposed_by: opts.proposedBy,
    client_ref: opts.clientRef,
    preview,
  }
  const session = opts.sessionName
  const destination = session
    ? [
        // the claim is only made for a job that runs in a session; any other runner says what it really is
        { label: 'Runs in', value: runsInSession(eff) ? SESSION_RUNS_IN : runnerWords(eff.runner) },
        { label: 'When', value: preview.when_text },
        { label: 'Does', value: doesLine(change, opts.base) },
        { label: 'As', value: permissionWords(eff.permissions, eff.allowed_tools) },
        { label: 'Posts to', value: opts.threadName(eff.thread_id).slice(0, 500) },
        { label: 'Proposed by', value: `${session}'s session`.slice(0, 500) },
      ]
    : [
        { label: 'Runs', value: preview.when_text },
        { label: 'Next', value: preview.next_runs[0] ?? 'Not scheduled' },
        { label: 'As', value: permissionWords(eff.permissions, eff.allowed_tools) },
        { label: 'Where', value: runnerWords(eff.runner) },
        { label: 'Posts to', value: opts.threadName(eff.thread_id).slice(0, 500) },
        { label: 'Proposed by', value: opts.proposedBy === 'agent' ? opts.agentName : 'your form' },
      ]
  const fullBody = body(change, preview, approved, opts)
  // F8: when the body is cut, the full new text still travels in the bound card (a read-only field = "Details")
  const newText = change.op === 'update' ? change.set.prompt : change.op === 'create' ? change.draft.prompt : undefined
  const overflowPrompt =
    newText !== undefined && new TextEncoder().encode(fullBody).length > SCHEDULE_CARD_BODY_MAX_BYTES ? newText : null
  const created = Date.parse(opts.now)
  const card: CardT = {
    id: opts.cardId,
    thread_id: opts.threadId,
    kind: 'schedule',
    title: (session
      ? `${session}'s session wants to ${SESSION_VERB[change.op]} ${eff.name}`
      : `${labels.title}: ${eff.name}`
    ).slice(0, 120),
    destination,
    body: capBody(fullBody),
    body_format: 'plain',
    fields: overflowPrompt
      ? [
          {
            key: 'new_prompt',
            label: 'New prompt (full text)',
            value: overflowPrompt,
            editable: false,
            multiline: true,
          },
        ]
      : [],
    attachments: [],
    primary_label: session ? 'Approve' : labels.primary,
    kill_label: session ? 'Not now' : labels.kill,
    allow_edit: false,
    allow_revise: true,
    risk: riskForTrust(opts.trust === true, 'schedule', scheduleCardRisk(change, opts.base, opts.now)),
    origin: opts.origin,
    payload,
    payload_hash: '',
    state: 'pending',
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + EXPIRY_S[opts.origin] * 1000).toISOString(),
  }
  if (opts.reason) card.summary = opts.reason.slice(0, 280)
  if (eff.permissions === 'full' && change.op !== 'delete') card.warning = SCHEDULE_FULL_WARNING
  if (opts.supersedes) card.supersedes = opts.supersedes
  card.payload_hash = payloadHash(bindingFrom(card))
  return card
}
