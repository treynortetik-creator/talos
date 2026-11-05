// The Heartbeat rows of a schedule card (docs/SCHEDULES.md S1.7): when the job checks, what it looks at, which programs it
// runs, what is muted and how often it may wake the agent, in plain words. Pure; schedules-card.ts places the section ahead
// of the full meta.
import { HEARTBEAT_META_KEY, type HeartbeatConfigT, heartbeatConfigFromMeta } from './heartbeat.ts'
import { visibleMetaText } from './schedules.ts'

const KIND_WORDS = {
  github: 'GitHub',
  'schedule-failures': 'Failed scheduled jobs',
  inbox: 'Inbox',
  command: 'Command',
} as const

const t = visibleMetaText
/**
 * One word of an argv, cwd or env value, shown JSON-quoted AFTER the escape: hidden and bidi characters become visible
 * `⟦U+XXXX⟧` markers, and spaces and quotes cannot blur two words into one. The approval card and the app's detail page both
 * use this one function, so what the owner approved is what they see afterwards.
 */
export const quoteVisible = (s: string): string => JSON.stringify(visibleMetaText(s))
const q = quoteVisible

type Src = HeartbeatConfigT['sources'][number]

function sourceWords(s: Src): string {
  const off = s.enabled ? '' : ' (off)'
  const repos = s.kind === 'github' ? ` (${s.args.repos.map(t).join(', ')})` : ''
  const work = s.class === 'work' ? ' [work content]' : ''
  return `${KIND_WORDS[s.kind]} "${t(s.id)}"${repos}${work}${off}`
}
function mutesWords(c: HeartbeatConfigT): string {
  if (c.mutes.length === 0) return 'nothing'
  return c.mutes
    .map((m) => `${t(m.source)} ${m.key === undefined ? '(whole source)' : t(m.key)} until ${t(m.until)}`)
    .join('; ')
}
const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'} a day`
function commandWords(s: Extract<Src, { kind: 'command' }>): string {
  const { argv, cwd, env } = s.args
  const parts = [argv.map(q).join(' ')]
  if (cwd !== undefined) parts.push(`in ${q(cwd)}`)
  const names = env ? Object.keys(env) : []
  if (env && names.length) parts.push(`with ${names.map((k) => `${t(k)}=${q(env[k] as string)}`).join(' ')}`)
  return parts.join(' ')
}
const MODE_WORDS = {
  shadow: 'shadow (it records and reports, and never wakes the agent)',
  live: 'live (it may wake the agent)',
} as const

/** Rows as [line start, text] so a change can be shown as `start before → after`. */
function rows(c: HeartbeatConfigT, slots: string): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['Mode: ', MODE_WORDS[c.mode]],
    ['Checks at: ', slots],
    ['Looks at: ', c.sources.map(sourceWords).join('; ')],
  ]
  for (const s of c.sources) if (s.kind === 'command') out.push([`Runs "${t(s.id)}": `, commandWords(s)])
  out.push(
    ['Gives up on a source after: ', c.sources.map((s) => `${t(s.id)} ${s.timeout_s}s`).join(', ')],
    ['Gives up on the whole run after: ', `${c.run_timeout_s}s`],
    ['Muted: ', mutesWords(c)],
    ['Wakes the agent ', `at most ${times(c.wake_cap_per_day)}`],
  )
  return out
}

export type HeartbeatCardInput = {
  op: 'create' | 'update' | 'adopt'
  /** The meta the job will have after the change (create, update that sets it, adopt: what is on disk). */
  after: unknown
  /**
   * What to compare with. Update: the meta the job has now. Adopt: the meta the scheduler last approved, only when it
   * recorded one (`undefined` when it didn't: Chronos keeps no approved copy of meta).
   */
  before?: unknown
  /** True when the change sets `meta` (so `after` is new). */
  metaSet: boolean
  /** "09:45, 12:15 (weekdays)" for the slots after the change, or a sentence when the job isn't a several-times job. */
  slotsAfter: string
  /** The same for the slots now, only when the change moves them. */
  slotsBefore?: string
}

const HEAD = 'Heartbeat: checks without waking the agent'

const rawOf = (m: unknown): string | null =>
  m !== null && typeof m === 'object' && !Array.isArray(m) && Object.hasOwn(m, HEARTBEAT_META_KEY)
    ? JSON.stringify((m as Record<string, unknown>)[HEARTBEAT_META_KEY])
    : null

/** The section, or null when neither the job now nor after the change is a heartbeat. */
export function heartbeatSection(i: HeartbeatCardInput): string | null {
  const after = heartbeatConfigFromMeta(i.after)
  const before = i.before === undefined || i.before === null ? null : heartbeatConfigFromMeta(i.before)
  if (!after) {
    return i.op === 'update' && i.metaSet && before
      ? `${HEAD}: removed from this job (it was set up as a heartbeat).`
      : null
  }
  if ('problem' in after)
    return `Heartbeat: the settings in this job are not readable (${after.problem}). The meta below is what will be approved.`
  const prior = before && !('problem' in before) ? before : null
  const afterRows = rows(after.config, i.slotsAfter)
  const beforeRows = prior ? rows(prior.config, i.slotsBefore ?? i.slotsAfter) : null
  // "unchanged" is a claim that the approval changes nothing here: only an update whose heartbeat is byte for byte what the
  // job has now, with its slots where they are. A create is new; an adopt shows what is on disk, never "unchanged".
  const bytesSame = i.op === 'update' && rawOf(i.after) !== null && rawOf(i.after) === rawOf(i.before)
  const unchanged = bytesSame && i.slotsBefore === undefined
  const isNew = i.op === 'create' || (i.op === 'update' && !prior)
  const lines = [isNew ? `${HEAD} (new)` : unchanged ? `${HEAD} (unchanged)` : HEAD]
  if (i.op === 'adopt' && !beforeRows)
    lines.push(
      'Last approved settings: not recorded by the scheduler, so every line below is what is on disk now. Check each one.',
    )
  for (const [start, text] of afterRows) {
    const was = beforeRows?.find(([s]) => s === start)?.[1]
    if (beforeRows && was === undefined) lines.push(`${start}${text} (new)`)
    else lines.push(`${start}${was !== undefined && was !== text ? `${was} → ${text}` : text}`)
  }
  // a program the heartbeat ran before and no longer will
  if (beforeRows)
    for (const [start, text] of beforeRows)
      if (start.startsWith('Runs "') && !afterRows.some(([s]) => s === start)) lines.push(`${start}${text} (removed)`)
  if (after.skipped > 0)
    lines.push(`Ignored: ${after.skipped} source${after.skipped === 1 ? '' : 's'} this version of Talos can't read`)
  return lines.join('\n')
}
