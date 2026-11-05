// HB1b: a Heartbeat job's cards say, in plain words, when it checks, what it looks at, which programs it runs, what is
// muted and how often it may wake the agent. These tests compare the WHOLE Heartbeat block, line for line: a header prefix
// check let a wrong "(unchanged)" through in review.
import { describe, expect, it } from 'vitest'
import {
  Card,
  type ComposeScheduleCardOpts,
  composeScheduleCard,
  HEARTBEAT_META_KEY,
  type ScheduleChangeT,
  type ScheduleT,
  scheduleCardRisk,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const snap = (loadFixtures()['schedules.snapshot'] as { snapshot: { schedules: ScheduleT[] } }).snapshot
const plain = snap.schedules.find((s) => s.id === 'daily-digest') as ScheduleT
const ETAG = `sha256:${'2'.repeat(64)}`
const NOW = '2026-10-05T11:45:00.000Z'
const SLOTS = ['09:45', '12:15', '14:45', '17:15']
const SLOTS_TEXT = '09:45, 12:15, 14:45, 17:15 (weekdays)'
const gh = { id: 'gh-main', kind: 'github', enabled: true, args: { repos: ['acme/widgets'] }, timeout_s: 30 }
const inbox = { id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 20 }
const cmd = (argv: string[], extra: Record<string, unknown> = {}) => ({
  id: 'work-watch',
  kind: 'command',
  enabled: true,
  args: { argv, ...extra },
  timeout_s: 60,
})
const WATCH = ['/usr/bin/python3', '/home/alex/watch.py', 'check']
const hb = (over: Record<string, unknown> = {}) => ({
  schema: 'talos.heartbeat/1',
  mode: 'shadow',
  sources: [gh, inbox],
  mutes: [{ source: 'gh-main', key: 'pr:acme/widgets#7', until: '2026-10-12T00:00:00.000Z' }],
  wake_cap_per_day: 3,
  run_timeout_s: 120,
  ...over,
})
const meta = (over: Record<string, unknown> = {}) => ({ [HEARTBEAT_META_KEY]: hb(over) })
const job = (over: Partial<ScheduleT> = {}): ScheduleT => ({
  ...plain,
  id: 'heartbeat',
  etag: ETAG as never,
  content_hash: ETAG as never,
  when: { type: 'times', days: 'weekdays', times: SLOTS },
  when_text: 'Weekdays at 9:45 AM, 12:15 PM, 2:45 PM and 5:15 PM',
  meta: meta() as never,
  ...over,
})
const preview = {
  when_text: 'Weekdays at 9:45 AM and more',
  next_runs: ['2026-10-06T09:45:00-04:00'],
  tz: 'America/New_York',
}
const opts = (base: ScheduleT | null, over: Partial<ComposeScheduleCardOpts> = {}): ComposeScheduleCardOpts => ({
  cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
  threadId: 'general',
  now: NOW,
  origin: 'chat',
  proposedBy: 'agent',
  agentName: 'Talos',
  expectedEtag: ETAG,
  clientRef: null,
  threadName: () => 'General',
  base: base ? { schedule: base, prompt: 'Run the heartbeat.\n', guard: null } : null,
  ...over,
})
const draft = (over: Record<string, unknown> = {}) =>
  ({
    id: 'heartbeat',
    name: 'Heartbeat',
    description: '',
    when: { type: 'times', days: 'weekdays', times: SLOTS },
    catchup_min: 60,
    enabled: true,
    runner: 'headless',
    permissions: 'restricted',
    allowed_tools: ['Read'],
    model: null,
    notify: 'failure',
    thread_id: null,
    prompt: 'Run the heartbeat.\n',
    meta: meta(),
    ...over,
  }) as never
const update = (base: ScheduleT, set: Record<string, unknown>): ScheduleChangeT =>
  ({ op: 'update', id: base.id, base_etag: base.etag, set }) as ScheduleChangeT
const baseOf = (s: ScheduleT) => ({ schedule: s, prompt: 'Run the heartbeat.\n', guard: null })

/** The Heartbeat block of a card, exactly: from its first line to the blank line before the next section. */
function block(c: { body?: string }): string {
  const b = c.body ?? ''
  const at = b.indexOf('Heartbeat:')
  if (at < 0) return ''
  const end = b.indexOf('\n\n', at)
  return b.slice(at, end < 0 ? undefined : end)
}
const create = (m: unknown, when?: unknown) =>
  composeScheduleCard({ op: 'create', draft: draft({ meta: m, ...(when ? { when } : {}) }) }, preview, null, opts(null))
const upd = (j: ScheduleT, set: Record<string, unknown>, slots?: string[]) =>
  composeScheduleCard(update(j, set), preview, null, opts(j))

const ROWS = {
  mode: 'Mode: shadow (it records and reports, and never wakes the agent)',
  checks: `Checks at: ${SLOTS_TEXT}`,
  looks: 'Looks at: GitHub "gh-main" (acme/widgets); Inbox "inbox"',
  gives: 'Gives up on a source after: gh-main 30s, inbox 20s',
  run: 'Gives up on the whole run after: 120s',
  muted: 'Muted: gh-main pr:acme/widgets#7 until 2026-10-12T00:00:00.000Z',
  wakes: 'Wakes the agent at most 3 times a day',
}
const lines = (...l: string[]) => l.join('\n')

describe('BUG 1: (new), (unchanged) and the adopt view are true', () => {
  it('create says (new), and the rows are the whole config in plain words', () => {
    const c = create(meta())
    expect(Card.safeParse(c).success).toBe(true)
    expect(block(c)).toBe(
      lines(
        'Heartbeat: checks without waking the agent (new)',
        ROWS.mode,
        ROWS.checks,
        ROWS.looks,
        ROWS.gives,
        ROWS.run,
        ROWS.muted,
        ROWS.wakes,
      ),
    )
    expect(c.risk).toBe('high')
  })
  it('create never says unchanged, with or without mutes', () => {
    expect(block(create(meta({ mutes: [] })))).toContain('(new)')
    expect(block(create(meta({ mutes: [] })))).not.toContain('unchanged')
    expect(block(create(meta({ mutes: [] })))).toContain('Muted: nothing')
  })
  it('update that does not touch meta or slots: (unchanged), same rows', () => {
    const j = job()
    expect(block(upd(j, { name: 'Renamed' }))).toBe(
      lines(
        'Heartbeat: checks without waking the agent (unchanged)',
        ROWS.mode,
        ROWS.checks,
        ROWS.looks,
        ROWS.gives,
        ROWS.run,
        ROWS.muted,
        ROWS.wakes,
      ),
    )
  })
  it('update that sets byte-equal meta: (unchanged)', () => {
    const j = job()
    expect(block(upd(j, { meta: meta() })).split('\n')[0]).toBe(
      'Heartbeat: checks without waking the agent (unchanged)',
    )
  })
  it('update that sets the same settings in a different byte order is NOT called unchanged', () => {
    const j = job()
    const reordered = { [HEARTBEAT_META_KEY]: Object.fromEntries(Object.entries(hb()).reverse()) }
    expect(block(upd(j, { meta: reordered })).split('\n')[0]).toBe('Heartbeat: checks without waking the agent')
  })
  it('update that moves the slots but not the meta is not "unchanged" and shows the move', () => {
    const j = job()
    const c = upd(j, { when: { type: 'times', days: 'weekdays', times: ['10:00', '13:00'] } })
    expect(block(c).split('\n').slice(0, 3)).toEqual([
      'Heartbeat: checks without waking the agent',
      ROWS.mode,
      `Checks at: ${SLOTS_TEXT} → 10:00, 13:00 (weekdays)`,
    ])
  })
  it('update that changes the meta shows old → new on the row and is plain-headed', () => {
    const j = job()
    expect(block(upd(j, { meta: meta({ wake_cap_per_day: 5 }) }))).toBe(
      lines(
        'Heartbeat: checks without waking the agent',
        ROWS.mode,
        ROWS.checks,
        ROWS.looks,
        ROWS.gives,
        ROWS.run,
        ROWS.muted,
        'Wakes the agent at most 3 times a day → at most 5 times a day',
      ),
    )
  })
  it('update that turns a plain job into a heartbeat says (new)', () => {
    const j = job({ meta: { other: 1 } as never })
    expect(block(upd(j, { meta: meta() })).split('\n')[0]).toBe('Heartbeat: checks without waking the agent (new)')
  })
  it('adopt of an outside edit that ADDED a command source is not "(unchanged)": it shows the command', () => {
    const j = job({ meta: meta({ sources: [gh, inbox, cmd(WATCH)] }) as never })
    const c = composeScheduleCard({ op: 'adopt', id: j.id, content_hash: j.content_hash }, preview, null, opts(j))
    const b = block(c)
    expect(b.split('\n')[0]).toBe('Heartbeat: checks without waking the agent')
    expect(b).not.toContain('unchanged')
    expect(b).toContain('Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check"')
    expect(c.risk).toBe('high')
  })
  it('adopt: the scheduler records no approved heartbeat, and the card says every line is what is on disk', () => {
    const j = job()
    const c = composeScheduleCard({ op: 'adopt', id: j.id, content_hash: j.content_hash }, preview, null, opts(j))
    expect(block(c)).toBe(
      lines(
        'Heartbeat: checks without waking the agent',
        'Last approved settings: not recorded by the scheduler, so every line below is what is on disk now. Check each one.',
        ROWS.mode,
        ROWS.checks,
        ROWS.looks,
        ROWS.gives,
        ROWS.run,
        ROWS.muted,
        ROWS.wakes,
      ),
    )
  })
  it('adopt when the approved heartbeat is known: what differs is marked old → new, a new program is (new)', () => {
    const approvedMeta = meta()
    const j = job({ meta: meta({ wake_cap_per_day: 6, sources: [gh, inbox, cmd(WATCH)] }) as never })
    const c = composeScheduleCard(
      { op: 'adopt', id: j.id, content_hash: j.content_hash },
      preview,
      { prompt: 'Run the heartbeat.\n', guard: null, meta: approvedMeta },
      opts(j),
    )
    expect(block(c)).toBe(
      lines(
        'Heartbeat: checks without waking the agent',
        ROWS.mode,
        ROWS.checks,
        `${ROWS.looks} → GitHub "gh-main" (acme/widgets); Inbox "inbox"; Command "work-watch"`,
        'Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check" (new)',
        `${ROWS.gives} → gh-main 30s, inbox 20s, work-watch 60s`,
        ROWS.run,
        ROWS.muted,
        'Wakes the agent at most 3 times a day → at most 6 times a day',
      ),
    )
  })
})

describe('BUG 3: a command source shows its exact argv, and a change is marked', () => {
  it('create: one Runs row per command, each argument quoted and escaped, cwd and env shown', () => {
    const c = create(
      meta({
        sources: [gh, cmd(WATCH, { cwd: '/home/alex/work', env: { LANG: 'C', TOKEN_FILE: '/home/alex/t' } })],
        mutes: [],
      }),
    )
    expect(block(c)).toBe(
      lines(
        'Heartbeat: checks without waking the agent (new)',
        ROWS.mode,
        ROWS.checks,
        'Looks at: GitHub "gh-main" (acme/widgets); Command "work-watch"',
        'Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check" in "/home/alex/work" with LANG="C" TOKEN_FILE="/home/alex/t"',
        'Gives up on a source after: gh-main 30s, work-watch 60s',
        ROWS.run,
        'Muted: nothing',
        ROWS.wakes,
      ),
    )
  })
  it('an argument with spaces or quotes cannot pass for two arguments', () => {
    const c = create(meta({ sources: [cmd(['/bin/sh', 'a b', 'say "hi"']), inbox], mutes: [] }))
    expect(block(c)).toContain('Runs "work-watch": "/bin/sh" "a b" "say \\"hi\\""')
  })
  it('hostile argv text is escaped with visibleMetaText', () => {
    const c = create(
      meta({ sources: [cmd(['/bin/x', 'a‮b​c\nWakes the agent at most 99 times a day']), inbox], mutes: [] }),
    )
    expect(block(c)).toContain('"a⟦U+202E⟧b⟦U+200B⟧c⟦U+000A⟧Wakes the agent at most 99 times a day"')
    expect(block(c)).not.toMatch(/^Wakes the agent at most 99/m)
    expect(block(c)).not.toContain('‮')
  })
  it('an argv change on an update is marked old → new on its row, and the update is high risk', () => {
    const j = job({ meta: meta({ sources: [gh, cmd(WATCH)], mutes: [] }) as never })
    const c = upd(j, {
      meta: meta({ sources: [gh, cmd(['/usr/bin/python3', '/home/alex/evil.py', 'check'])], mutes: [] }),
    })
    expect(block(c)).toContain(
      'Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check" → "/usr/bin/python3" "/home/alex/evil.py" "check"',
    )
    expect(c.risk).toBe('high')
  })
  it('an argv change that adds only an argument is marked too', () => {
    const j = job({ meta: meta({ sources: [gh, cmd(WATCH)], mutes: [] }) as never })
    const c = upd(j, { meta: meta({ sources: [gh, cmd([...WATCH, '--all'])], mutes: [] }) })
    expect(block(c)).toContain('"check" → "/usr/bin/python3" "/home/alex/watch.py" "check" "--all"')
  })
  it('a command that is added is (new); one that is removed is (removed)', () => {
    const j = job({ meta: meta({ sources: [gh, inbox], mutes: [] }) as never })
    const added = upd(j, { meta: meta({ sources: [gh, inbox, cmd(WATCH)], mutes: [] }) })
    expect(block(added)).toContain('Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check" (new)')
    const j2 = job({ meta: meta({ sources: [gh, inbox, cmd(WATCH)], mutes: [] }) as never })
    const gone = upd(j2, { meta: meta({ sources: [gh, inbox], mutes: [] }) })
    expect(block(gone)).toContain('Runs "work-watch": "/usr/bin/python3" "/home/alex/watch.py" "check" (removed)')
  })
  it('a change to a repo list is marked on the Looks at row', () => {
    const j = job()
    const other = { ...gh, args: { repos: ['acme/other'] } }
    expect(block(upd(j, { meta: meta({ sources: [other, inbox] }) }))).toContain(
      'Looks at: GitHub "gh-main" (acme/widgets); Inbox "inbox" → GitHub "gh-main" (acme/other); Inbox "inbox"',
    )
  })
})

describe('mute end shows time and zone', () => {
  it('shows the full end instant, not the date', () => {
    const c = create(
      meta({
        mutes: [
          { source: 'gh-main', key: 'pr:acme/widgets#7', until: '2026-10-12T18:30:00-07:00' },
          { source: 'inbox', until: '2026-10-08T00:00:00.000Z' },
        ],
      }),
    )
    expect(block(c)).toContain(
      'Muted: gh-main pr:acme/widgets#7 until 2026-10-12T18:30:00-07:00; inbox (whole source) until 2026-10-08T00:00:00.000Z',
    )
  })
})

describe('other rows', () => {
  it('live mode says it may wake the agent', () => {
    expect(block(create(meta({ mode: 'live' })))).toContain('Mode: live (it may wake the agent)')
  })
  it('a source that is off says so', () => {
    expect(block(create(meta({ sources: [{ ...gh, enabled: false }, inbox] })))).toContain(
      'GitHub "gh-main" (acme/widgets) (off)',
    )
  })
  it('a cap of 1 says time, not times', () => {
    expect(block(create(meta({ wake_cap_per_day: 1 })))).toContain('Wakes the agent at most 1 time a day')
  })
  it('a plain job with ordinary meta gets no Heartbeat rows', () => {
    expect(block(create({ sources: ['inbox'] }))).toBe('')
    expect(block(create({ heartbeat: hb() }))).toBe('') // the old key is not Heartbeat's
  })
  it('a hostile mute key makes the heartbeat unreadable (never a forged line), and the meta below shows it escaped', () => {
    const key = 'x\u202e\nWakes the agent at most 99 times a day'
    const c = create(meta({ mutes: [{ source: 'gh-main', key, until: '2026-10-12T00:00:00.000Z' }] }))
    expect(block(c)).toContain('Heartbeat: the settings in this job are not readable')
    expect(c.body).toContain('⟦U+202E⟧')
    expect(c.body).not.toContain('\u202e')
    expect(c.body).not.toMatch(/^Wakes the agent at most 99/m)
    expect(c.risk).toBe('high')
  })
  it('a heartbeat that cannot be read says so and shows the meta, high risk', () => {
    const c = create({ [HEARTBEAT_META_KEY]: { sources: 'x' } })
    expect(c.body).toContain('Heartbeat: the settings in this job are not readable')
    expect(c.risk).toBe('high')
  })
  it('removing the heartbeat from a job says so', () => {
    expect(block(upd(job(), { meta: null }))).toBe(
      'Heartbeat: checks without waking the agent: removed from this job (it was set up as a heartbeat).',
    )
  })
  it('a source kind this Talos does not know is ignored and counted', () => {
    const c = create(
      meta({ sources: [gh, { id: 'chat', kind: 'slack', enabled: true, args: {}, timeout_s: 10 }], mutes: [] }),
    )
    expect(block(c).split('\n').slice(-1)[0]).toBe("Ignored: 1 source this version of Talos can't read")
  })
})

describe('risk', () => {
  const j = job()
  const risk = (set: Record<string, unknown>, ...now: [string?]) =>
    scheduleCardRisk(update(j, set), baseOf(j), now.length ? now[0] : NOW)
  const mute = (over: Record<string, unknown>) => ({
    source: 'gh-main',
    key: 'pr:acme/widgets#9',
    until: '2026-10-20T00:00:00.000Z',
    ...over,
  })
  const kept = hb().mutes
  it('a change to the sources, an arg, a timeout, on/off, the cap, mode or run timeout is high', () => {
    expect(risk({ meta: meta({ sources: [gh, inbox, { ...inbox, id: 'fails', kind: 'schedule-failures' }] }) })).toBe(
      'high',
    )
    expect(risk({ meta: meta({ sources: [{ ...gh, args: { repos: ['acme/other'] } }, inbox] }) })).toBe('high')
    expect(risk({ meta: meta({ sources: [{ ...gh, timeout_s: 60 }, inbox] }) })).toBe('high')
    expect(risk({ meta: meta({ sources: [{ ...gh, enabled: false }, inbox] }) })).toBe('high')
    expect(risk({ meta: meta({ wake_cap_per_day: 5 }) })).toBe('high')
    expect(risk({ meta: meta({ mode: 'live' }) })).toBe('high')
    expect(risk({ meta: meta({ run_timeout_s: 90 }) })).toBe('high')
  })
  it('BUG 2: removing a mute, or muting one exact key for under 30 days, is low', () => {
    expect(risk({ meta: meta({ mutes: [] }) })).toBe('low')
    expect(risk({ meta: meta({ mutes: [...kept, mute({})] }) })).toBe('low')
  })
  it('BUG 2: a whole-source mute, or a mute over 30 days, is high', () => {
    const { key: _k, ...whole } = mute({})
    expect(risk({ meta: meta({ mutes: [...kept, whole] }) })).toBe('high')
    expect(risk({ meta: meta({ mutes: [...kept, mute({ until: '2026-12-01T00:00:00.000Z' })] }) })).toBe('high')
  })
  it('BUG 2: an unknown key riding along with a mute change is high', () => {
    expect(risk({ meta: { [HEARTBEAT_META_KEY]: { ...hb({ mutes: [] }), future_cap: 99 } } })).toBe('high')
    expect(risk({ meta: { ...meta({ mutes: [] }), extra: 1 } })).toBe('high')
  })
  it('BUG 2: the card uses its own clock, so a mute is judged against the card time', () => {
    const base = job()
    const ch = update(base, { meta: meta({ mutes: [...kept, mute({ until: '2026-10-20T00:00:00.000Z' })] }) })
    const early = composeScheduleCard(ch, preview, null, opts(base, { now: '2026-10-05T11:45:00.000Z' }))
    const late = composeScheduleCard(ch, preview, null, opts(base, { now: '2026-08-01T00:00:00.000Z' }))
    expect([early.risk, late.risk]).toEqual(['low', 'high'])
  })
  it('without a clock a new mute is high', () => {
    expect(risk({ meta: meta({ mutes: [...kept, mute({})] }) }, undefined)).toBe('high')
  })
  it('replacing a heartbeat with unreadable meta is high; clearing the meta is high', () => {
    expect(risk({ meta: { [HEARTBEAT_META_KEY]: { sources: 'x' } } })).toBe('high')
    expect(risk({ meta: null })).toBe('high')
  })
})

describe('HB2 review: a source marked work says so on the card', () => {
  it('the Looks at row names the work content', () => {
    const m = meta()
    const raw = JSON.parse(JSON.stringify(m))
    raw['talos.heartbeat'].sources[0].class = 'work'
    expect(block(create(raw))).toContain('Looks at: GitHub "gh-main" (acme/widgets) [work content]; Inbox "inbox"')
  })
})
