// Pure Schedules logic (docs/SCHEDULES.md S5). No React and no schedule maths: Chronos computes every time and plain-words
// text, this file only groups, labels and compares what the snapshot already says.
import type {
  DayStateT,
  HealthIssueT,
  ScheduleChangeT,
  ScheduleDetailT,
  ScheduleDraftT,
  SchedulerHealthT,
  ScheduleSnapshotT,
  ScheduleT,
} from '@talos-app/protocol'
import { dateOfRunKey, safeLine } from '@talos-app/protocol'
import { FAILED_DOT_WINDOW_MS } from './constants.ts'

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** A run key for a person: "2026-10-05" stays, a slot "2026-10-05T0945" reads "2026-10-05 09:45". */
export function runKeyLabel(ds: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})$/.exec(ds)
  return m ? `${m[1]} ${m[2]}:${m[3]}` : ds
}

export type Tone = 'ok' | 'danger' | 'accent' | 'warn' | 'muted'
export type RowStatus = { glyph: string; word: string; time: string | null; tone: Tone; running: boolean }

const SPACES = /[  ]/g

function fmt(opts: Intl.DateTimeFormatOptions, tz: string, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(ms).replace(SPACES, ' ')
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(ms).replace(SPACES, ' ')
  }
}

/** "7:31 AM" in `tz`. */
export function formatTime(iso: string, tz: string): string {
  return fmt({ hour: 'numeric', minute: '2-digit' }, tz, Date.parse(iso))
}

/** "YYYY-MM-DD" of an instant in `tz`. */
export function dayKey(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  try {
    return p.format(ms)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ms)
  }
}

const dayNumber = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000)

/** "today 7:30 AM", "tomorrow 7:30 AM", "Fri 5:00 PM", "Oct 9, 3:00 PM". */
export function whenLabel(iso: string, nowMs: number, tz: string): string {
  const t = formatTime(iso, tz)
  const diff = dayNumber(dayKey(Date.parse(iso), tz)) - dayNumber(dayKey(nowMs, tz))
  if (diff === 0) return `today ${t}`
  if (diff === 1) return `tomorrow ${t}`
  if (diff > 1 && diff < 7) return `${fmt({ weekday: 'short' }, tz, Date.parse(iso))} ${t}`
  return `${fmt({ month: 'short', day: 'numeric' }, tz, Date.parse(iso))}, ${t}`
}

/** "Tue Oct 6, 7:30 AM" in `tz`, with the zone only when it is not the device's. */
export function dateTimeLabel(iso: string, tz: string, deviceTz: string | null | undefined): string {
  const ms = Date.parse(iso)
  const day = `${fmt({ weekday: 'short' }, tz, ms)} ${fmt({ month: 'short', day: 'numeric' }, tz, ms)}`
  return `${day}, ${formatTime(iso, tz)}${zoneSuffix(iso, tz, deviceTz)}`
}

/** A zone suffix (" EDT") only when the scheduler's zone is not the owner's. */
export function zoneSuffix(iso: string, schedulerTz: string, ownerTz: string | null | undefined): string {
  if (!ownerTz || ownerTz === schedulerTz) return ''
  return ` ${fmt({ timeZoneName: 'short' }, schedulerTz, Date.parse(iso)).split(' ').pop() ?? ''}`
}

/** Offline, a row whose cached fire time has passed but whose catch-up window has not is waiting (a timestamp compare). */
export function waitingOffline(s: ScheduleT, nowMs: number, macOnline: boolean): boolean {
  if (macOnline || !s.next_run) return false
  if (s.paused || !s.enabled) return false
  if (!(s.today === 'not_due' || s.today === 'pending' || s.today === 'waiting')) return false
  const fire = Date.parse(s.next_run)
  return fire <= nowMs && nowMs < fire + s.catchup_min * 60_000
}

export function rowStatus(
  s: ScheduleT,
  o: { nowMs: number; tz: string; macOnline: boolean; ownerTz?: string | null },
): RowStatus {
  const when = (iso: string | undefined) => (iso ? `${formatTime(iso, o.tz)}${zoneSuffix(iso, o.tz, o.ownerTz)}` : null)
  const mk = (glyph: string, word: string, tone: Tone, time: string | null = null, running = false): RowStatus => ({
    glyph,
    word,
    time,
    tone,
    running,
  })
  if (s.today === 'held') return mk('⏸', 'On hold: changed outside the app', 'warn')
  if (s.paused) return mk('⏸', 'Paused', 'muted')
  if (waitingOffline(s, o.nowMs, o.macOnline)) return mk('⧗', "Waiting: agent session isn't running", 'warn')
  switch (s.today) {
    case 'running':
      return mk('', 'Running…', 'accent', null, true)
    case 'waiting':
      return s.wait_reason === 'no_session'
        ? mk('⧗', "Waiting: agent session isn't running", 'warn')
        : mk('⧗', 'Waiting for the agent', 'warn')
    case 'stalled':
      return mk('✕', 'Background run stuck', 'danger')
    case 'missed':
      return mk('!', 'Missed', 'warn')
    case 'failed':
      return mk('✕', 'Failed', 'danger', when(s.last_run?.started_at))
    case 'ran':
      return mk('✓', 'Ran', 'ok', when(s.last_run?.started_at))
    default: {
      const r = s.last_run
      if (r && (r.status === 'ok' || r.status === 'running')) return mk('✓', 'Ran', 'ok', when(r.started_at))
      if (r && r.status !== 'skipped') return mk('✕', 'Failed', 'danger', when(r.started_at))
      return mk('○', 'Pending', 'muted')
    }
  }
}

export type Groups = { today: ScheduleT[]; later: ScheduleT[]; off: ScheduleT[] }

export function isOff(s: ScheduleT, health: SchedulerHealthT): boolean {
  return !s.enabled || health.paused_all || s.kind === 'command' || s.when.type === 'events'
}

const byNext = (a: ScheduleT, b: ScheduleT) =>
  (a.next_run ? Date.parse(a.next_run) : Number.MAX_SAFE_INTEGER) -
    (b.next_run ? Date.parse(b.next_run) : Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)

export function groupSchedules(snap: ScheduleSnapshotT, nowMs: number): Groups {
  const tz = snap.health.tz
  const todayKey = dayKey(nowMs, tz)
  const g: Groups = { today: [], later: [], off: [] }
  for (const s of snap.schedules) {
    if (isOff(s, snap.health)) g.off.push(s)
    else if (
      s.today !== 'not_due' ||
      (s.last_run && dateOfRunKey(s.last_run.ds) === todayKey) ||
      (s.next_run && dayKey(Date.parse(s.next_run), tz) === todayKey)
    )
      g.today.push(s)
    else g.later.push(s)
  }
  g.today.sort(byNext)
  g.later.sort(byNext)
  g.off.sort((a, b) => a.name.localeCompare(b.name))
  return g
}

/** Words for the run kind: S5.3 "How it runs". */
export function runnerWords(runner: ScheduleT['runner']): string {
  if (runner === 'session') return 'In your live session (a sub-agent does the work)'
  if (runner === 'headless') return 'In the background, with no session'
  return 'Session, with a background backup (set outside Talos)'
}
export function permissionWords(s: Pick<ScheduleT, 'permissions' | 'allowed_tools' | 'runner'>): string {
  if (s.permissions === 'full')
    return s.runner === 'headless' ? 'Full permissions, nobody watching' : 'As your live session (its permissions)'
  if (s.permissions === 'command') return 'Runs a command (read-only here)'
  return `Only these tools: ${s.allowed_tools.length ? s.allowed_tools.join(', ') : 'no tools'}`
}

// ---- health banner ----------------------------------------------------------------------------------------------

export type BannerButton = 'fix' | 'resume' | 'review' | 'show' | 'retry'
export type Banner = {
  key: string
  code: HealthIssueT['code'] | 'no_session' | 'offline'
  text: string
  fix: string[] | null
  /** A sentence before the numbered steps, when the scheduler wrote one. */
  fixIntro?: string | null
  button: BannerButton
  /** `headless_blocked` also offers Retry. */
  retry?: boolean
  scheduleId?: string | null
  severity: HealthIssueT['severity']
}

/** Worst first. */
const ORDER: Array<HealthIssueT['code'] | 'no_session'> = [
  'session_runner_conflict',
  'registry_unreadable',
  'paused_all',
  'tick_missing',
  'no_session',
  'tcc_suspected',
  'headless_blocked',
  'launch_stalled',
  'run_hung',
  'adapter_timeout',
  'held_jobs',
  'registry_synced_folder',
  'legacy_both_runner',
  'missed_recently',
]

/**
 * `issue.fix` as plain text: optional lead-in, then steps. Chronos numbers steps inline ("... 1. At the Mac, ... 2. Or ...")
 * as well as on separate lines; both split the same way.
 */
export function fixParts(fix: string | null): { intro: string | null; steps: string[] } {
  if (!fix) return { intro: null, steps: [] }
  const text = fix.trim()
  const marks = [...text.matchAll(/(?:^|\s)(\d+)[.)]\s+/g)]
  if (marks.length >= 2 || (marks.length === 1 && marks[0]?.[1] === '1')) {
    const first = marks[0]?.index ?? 0
    const intro = text.slice(0, first).trim()
    const steps = text
      .slice(first)
      .split(/(?:^|\s)\d+[.)]\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
    return { intro: intro || null, steps }
  }
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  return { intro: null, steps: lines.length ? lines : [text] }
}
/** Just the steps (a lead-in counts as the first). */
export function fixSteps(fix: string | null): string[] {
  const p = fixParts(fix)
  return p.intro ? [p.intro, ...p.steps] : p.steps
}

const NO_SESSION_FIX = [
  'Open Claude Code on your Mac in your agent folder and start your session.',
  'Waiting jobs run as soon as it is back, as long as they are inside their catch-up window.',
]

export function pickBanner(snap: ScheduleSnapshotT): Banner | null {
  const issues = snap.health.issues
  const waitingNoSession = snap.schedules.filter(
    (s) => s.today === 'waiting' && s.wait_reason === 'no_session' && !s.paused,
  )
  const cand: Banner[] = issues.map((i) => {
    const parts = fixParts(i.fix)
    const base = {
      key: `${i.code}:${i.schedule_id ?? ''}`,
      code: i.code,
      fix: parts.steps,
      fixIntro: parts.intro,
      severity: i.severity,
    }
    const text = safeLine(i.text)
    switch (i.code) {
      case 'paused_all':
        return { ...base, text, fix: null, button: 'resume' as const }
      case 'held_jobs':
        return { ...base, text, fix: null, button: 'review' as const, scheduleId: i.schedule_id }
      case 'missed_recently':
        return { ...base, text, fix: null, button: 'show' as const, scheduleId: i.schedule_id }
      case 'headless_blocked':
      case 'tcc_suspected':
        // a real TCC stall reports both, and tcc_suspected's own steps end "Tap Retry background runs"
        return { ...base, text, button: 'fix' as const, retry: true }
      default:
        return { ...base, text, button: 'fix' as const, ...(snap.health.headless === 'blocked' ? { retry: true } : {}) }
    }
  })
  if (waitingNoSession.length > 0 && !issues.some((i) => i.code === 'session_runner_conflict'))
    cand.push({
      key: 'no_session',
      code: 'no_session',
      text: `Your agent session isn't running. ${waitingNoSession.length} ${waitingNoSession.length === 1 ? 'job is' : 'jobs are'} waiting.`,
      fix: NO_SESSION_FIX,
      button: 'fix',
      severity: 'warn',
    })
  const rank = (b: Banner) => {
    const i = ORDER.indexOf(b.code as never)
    return i === -1 ? ORDER.length : i
  }
  // not_installed / unsupported / off / truncated have their own screens or no banner
  const shown = cand.filter(
    (b) =>
      !['not_installed', 'version_unsupported', 'truncated'].includes(b.code) && !(b.code === 'registry_unreadable'),
  )
  shown.sort((a, b) => rank(a) - rank(b))
  return shown[0] ?? null
}

// ---- screens other than the list ----------------------------------------------------------------------------------

export type EmptyKind =
  | 'update_app'
  | 'update_mac'
  | 'update_relay'
  | 'no_answer'
  | 'mac_offline'
  | 'old_chronos'
  | 'not_installed'
  | 'off'
  | 'unreadable'
  | 'no_jobs'
  | 'error'
  | null

export function emptyKind(snap: ScheduleSnapshotT | null, error: string | null): EmptyKind {
  if (error === 'update_app') return 'update_app'
  if (error === 'update_mac') return 'update_mac'
  if (error === 'update_relay') return 'update_relay'
  if (!snap) {
    if (error === 'no_answer') return 'no_answer'
    if (error === 'mac_offline') return 'mac_offline'
    return error ? 'error' : null
  }
  const h = snap.health
  // A scheduler that did not answer in time is not a missing one: the banner carrying the time-out says so.
  if (h.issues.some((i) => i.code === 'adapter_timeout') && snap.schedules.length === 0) return 'no_answer'
  if (h.state === 'not_installed') return 'not_installed'
  if (h.state === 'unsupported') return 'old_chronos'
  if (h.state === 'off') return 'off'
  if (snap.schedules.length === 0) {
    if (snap.unreadable.length > 0 || h.issues.some((i) => i.code === 'registry_unreadable')) return 'unreadable'
    return 'no_jobs'
  }
  return null
}

/** The dot on the tab (S5.1): stuck/error health, a job failed in the last 24 h, or a job waiting with no session. */
export function navDot(snap: ScheduleSnapshotT | null, nowMs: number): boolean {
  if (!snap) return false
  if (snap.health.state === 'stuck' || snap.health.state === 'error') return true
  return snap.schedules.some(
    (s) =>
      (s.today === 'waiting' && s.wait_reason === 'no_session') ||
      (s.last_run?.status === 'failed' &&
        s.last_run.started_at !== undefined &&
        nowMs - Date.parse(s.last_run.started_at) < FAILED_DOT_WINDOW_MS) ||
      s.today === 'stalled',
  )
}

/** A `schedule.status` that names a row whose `etag|state_rev` differs from the cache, or a removed row, needs a re-fetch. */
export function needsRefetch(
  frame: { changed: Array<{ id: string; etag: string; state_rev: string }>; removed: string[] },
  revs: Record<string, string>,
): boolean {
  if (frame.removed.some((id) => id in revs)) return true
  return frame.changed.some((c) => revs[c.id] !== `${c.etag}|${c.state_rev}`)
}

export const revsOf = (snap: ScheduleSnapshotT): Record<string, string> =>
  Object.fromEntries(snap.schedules.map((s) => [s.id, `${s.etag}|${s.state_rev}`]))

// ---- run now ------------------------------------------------------------------------------------------------------

export type RunNowAsk = {
  lines: string[]
  again: boolean
  offerSession: boolean
}
export function runNowAsk(s: ScheduleT, h: SchedulerHealthT, nowMs: number): RunNowAsk {
  const lines: string[] = []
  const tz = h.tz
  if (s.permissions === 'full') lines.push(`Run ${s.name} now? It runs with full permissions.`)
  else lines.push(`Run ${s.name} now?`)
  let again = false
  // `ds` is a run key: a date, or a slot (2026-10-05T0945) for a job with several fire times (HB1)
  const ranToday =
    s.today === 'ran' ||
    (s.last_run !== null && dateOfRunKey(s.last_run.ds) === dayKey(nowMs, tz) && s.last_run.status === 'ok')
  if (s.when.type === 'times') {
    // Run now on a job with several fire times is an extra run: it never takes one of its slots, so there is nothing to "run again"
    lines.push("This is an extra run. It doesn't use up any of its scheduled times.")
  } else if (ranToday) {
    again = true
    const at = s.last_run?.started_at ? formatTime(s.last_run.started_at, tz) : 'earlier'
    lines.push(`It already ran today at ${at}. Run again?`)
  } else if (s.next_run && Date.parse(s.next_run) > nowMs && dayKey(Date.parse(s.next_run), tz) === dayKey(nowMs, tz)) {
    lines.push(`This counts as today's run; the ${formatTime(s.next_run, tz)} run won't happen.`)
  }
  const offerSession =
    s.runner === 'headless' &&
    s.permissions !== 'restricted' &&
    (h.headless === 'blocked' || h.issues.some((i) => i.code === 'headless_blocked' || i.code === 'tcc_suspected'))
  return { lines, again, offerSession }
}

// ---- the form -----------------------------------------------------------------------------------------------------

export type WhenKind = 'daily' | 'weekdays' | 'days' | 'monthdays' | 'once'
export type FormState = {
  name: string
  kind: WhenKind
  time: string
  days: Weekday[]
  monthdays: string
  onceDate: string
  prompt: string
  threadId: string | null
  runner: 'session' | 'headless'
  permissions: 'full' | 'restricted'
  allowedTools: string
  notify: 'failure' | 'always' | 'never'
  catchup: string
  model: string
  description: string
}

export function whenFromForm(f: FormState): ScheduleDraftT['when'] | null {
  switch (f.kind) {
    case 'daily':
      return { type: 'daily', time: f.time }
    case 'weekdays':
      return { type: 'weekdays', time: f.time }
    case 'days':
      return f.days.length ? { type: 'days', days: f.days, time: f.time } : null
    case 'monthdays': {
      const days = f.monthdays
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
      if (!days.length || days.some((n) => !Number.isInteger(n) || n < 1 || n > 31)) return null
      return { type: 'monthdays', days: [...new Set(days)].sort((a, b) => a - b), time: f.time }
    }
    case 'once':
      return f.onceDate ? { type: 'once', at: `${f.onceDate}T${f.time}` } : null
  }
}

export function formFromSchedule(s: ScheduleT, prompt: string): FormState {
  const w = s.when
  const kind: WhenKind = w.type === 'events' || w.type === 'times' ? 'daily' : w.type
  return {
    name: s.name,
    kind,
    time: w.type === 'once' ? w.at.slice(11, 16) : 'time' in w ? w.time : '09:00',
    days: w.type === 'days' ? w.days : [],
    monthdays: w.type === 'monthdays' ? w.days.join(', ') : '',
    onceDate: w.type === 'once' ? w.at.slice(0, 10) : '',
    prompt,
    threadId: s.thread_id,
    runner: s.runner === 'headless' ? 'headless' : 'session',
    permissions: s.permissions === 'restricted' ? 'restricted' : 'full',
    allowedTools: s.allowed_tools.join('\n'),
    notify: s.notify,
    catchup: String(s.catchup_min),
    model: s.model ?? '',
    description: s.description,
  }
}

export const blankForm = (threadId: string | null): FormState => ({
  name: '',
  kind: 'daily',
  time: '09:00',
  days: [],
  monthdays: '',
  onceDate: '',
  prompt: '',
  threadId,
  runner: 'session',
  permissions: 'full',
  allowedTools: '',
  notify: 'failure',
  catchup: '180',
  model: '',
  description: '',
})

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const toolsOf = (t: string) =>
  t
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

/** The `set` of an update: ONLY what differs from the form the owner opened (S5.4). Nothing from the cached detail is resent. */
export function touchedSet(before: FormState, after: FormState): Extract<ScheduleChangeT, { op: 'update' }>['set'] {
  const set: Record<string, unknown> = {}
  if (after.name !== before.name) set.name = after.name.trim()
  if (after.description !== before.description) set.description = after.description
  if (after.prompt !== before.prompt) set.prompt = after.prompt
  if (
    after.kind !== before.kind ||
    after.time !== before.time ||
    !same(after.days, before.days) ||
    after.monthdays !== before.monthdays ||
    after.onceDate !== before.onceDate
  ) {
    const w = whenFromForm(after)
    if (w) set.when = w
  }
  if (after.threadId !== before.threadId) set.thread_id = after.threadId
  if (after.runner !== before.runner) set.runner = after.runner
  if (after.permissions !== before.permissions) set.permissions = after.permissions
  if (after.allowedTools !== before.allowedTools) set.allowed_tools = toolsOf(after.allowedTools)
  if (after.notify !== before.notify) set.notify = after.notify
  if (after.catchup !== before.catchup) set.catchup_min = Number(after.catchup)
  if (after.model !== before.model) set.model = after.model.trim() === '' ? null : after.model.trim()
  return set as never
}

export function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'job'
  let id = base.length >= 2 ? base : `${base}-job`
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(0, 40)
  return id
}

export function draftFromForm(f: FormState, id: string): ScheduleDraftT | null {
  const when = whenFromForm(f)
  if (!when) return null
  return {
    id,
    name: f.name.trim(),
    description: f.description,
    when,
    catchup_min: Number(f.catchup),
    enabled: true,
    runner: f.runner,
    permissions: f.permissions,
    allowed_tools: f.permissions === 'restricted' ? toolsOf(f.allowedTools) : [],
    model: f.model.trim() === '' ? null : f.model.trim(),
    notify: f.notify,
    thread_id: f.threadId,
    prompt: f.prompt,
  }
}

export const utf8Len = (s: string) => new TextEncoder().encode(s).length

/** Which field a `schedule_invalid` path belongs to ("draft.name", "set.prompt", "when.time"). */
export function fieldOfPath(path: string): string {
  const parts = path.split('.').filter((p) => p !== 'draft' && p !== 'set' && p !== 'change')
  return parts[0] ?? path
}

export type { DayStateT, ScheduleDetailT }
