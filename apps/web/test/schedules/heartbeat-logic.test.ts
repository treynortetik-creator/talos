// Pure Heartbeat logic for the Schedules tab (HB5): outcome words, report lines, the job's config, mutes and setup.
import { HEARTBEAT_META_KEY, ScheduleChange } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  blankSetup,
  configFromSetup,
  draftFromSetup,
  heartbeatView,
  metaWithMutes,
  newMute,
  outcomeOfRun,
  parseReportSources,
  rowOutcome,
  slotTimes,
} from '../../src/features/schedules/heartbeat/logic.ts'
import { hbConfig, hbJob } from './variants.ts'

const run = (status: string, summary?: string) => ({ status, ...(summary !== undefined ? { summary } : {}) }) as never

describe('outcomeOfRun', () => {
  it.each([
    ['Nothing new', 'silent', 'ok'],
    ['3 updates posted', 'fyi', 'ok'],
    ['1 update posted', 'fyi', 'ok'],
    ['Checked in, 2 items', 'woke', 'accent'],
    ['Wake limit reached', 'capped', 'warn'],
    ['Quiet hours', 'quiet', 'muted'],
    ["Couldn't check Jira", 'partial', 'warn'],
    ['Some items could not be read', 'partial', 'warn'],
    ['Check failed', 'failed', 'danger'],
    ['Busy: the last wake is still open', 'busy', 'warn'],
  ])('%s reads as %s', (summary, key, tone) => {
    expect(outcomeOfRun(run('ok', summary))).toMatchObject({ key, tone })
  })

  it('the slot the bridge could not start (recorded as skipped, summary "Busy: ...") reads as busy; any other skipped run stays Skipped (HB5 R1-7)', () => {
    // the exact words the bridge writes: apps/bridge/src/heartbeat/run-parts.ts BUSY_SUMMARY
    const written = 'Busy: the earlier check-in is still running, so this one did not run'
    expect(outcomeOfRun(run('skipped', written))).toMatchObject({ key: 'busy', tone: 'warn' })
    expect(outcomeOfRun(run('skipped', 'Nothing new'))).toMatchObject({ key: 'stopped', word: 'Skipped' })
    expect(outcomeOfRun(run('skipped', undefined))).toMatchObject({ key: 'stopped', word: 'Skipped' })
  })

  it('a run that did not finish OK is never a quiet outcome, whatever its summary says', () => {
    for (const status of ['failed', 'timed_out', 'launch_stalled'])
      expect(outcomeOfRun(run(status, 'Nothing new'))).toMatchObject({ key: 'failed', tone: 'danger' })
    expect(outcomeOfRun(run('session_ended', 'Nothing new')).word).not.toBe('Nothing new')
  })

  it('a word from a newer Mac is a neutral "Unknown", never good news', () => {
    expect(outcomeOfRun(run('ok', 'Reticulating splines'))).toEqual({ key: 'unknown', word: 'Unknown', tone: 'muted' })
    expect(outcomeOfRun(run('ok')).word).toBe('Unknown')
    expect(outcomeOfRun(run('from_the_future', 'Nothing new')).word).toBe('Unknown')
  })

  it('no run yet says so', () => {
    expect(outcomeOfRun(null).word).toBe('No check yet')
  })

  it('the row puts the job state before the last outcome', () => {
    const j = hbJob()
    expect(rowOutcome(j, false).word).toBe('Nothing new')
    expect(rowOutcome({ ...j, paused: true }, false).word).toBe('Paused')
    expect(rowOutcome(j, true).word).toBe('Paused')
    expect(rowOutcome({ ...j, enabled: false }, false).word).toBe('Off')
    expect(rowOutcome({ ...j, today: 'held' }, false).word).toMatch(/On hold/)
  })
})

describe('parseReportSources', () => {
  it('reads the runner report lines, with unreadable counts, and skips lines it does not know', () => {
    const rows = parseReportSources(
      'partial: x\ngithub: failed, 900 ms\ninbox: ok, 800 ms, 2 unreadable\nweird line\nseen 3 (act 1)\ndisk: ok, 300 ms',
    )
    expect(rows).toEqual([
      { id: 'github', ok: false, ms: 900, unreadable: 0 },
      { id: 'inbox', ok: true, ms: 800, unreadable: 2 },
      { id: 'disk', ok: true, ms: 300, unreadable: 0 },
    ])
  })
  it('nothing readable is an empty list, not a throw', () => {
    expect(parseReportSources(null)).toEqual([])
    expect(parseReportSources('')).toEqual([])
  })
})

describe('heartbeatView', () => {
  it('a strict config is exact and hashed', () => {
    const v = heartbeatView(hbJob())
    expect(v).toMatchObject({ kind: 'config', exact: true, skipped: 0 })
    expect(v?.kind === 'config' && v.hash).toMatch(/^sha256:/)
  })
  it('a source kind from a newer Talos is skipped, counted, and makes the config not exact (no test, no edit)', () => {
    const meta = {
      [HEARTBEAT_META_KEY]: { ...hbConfig(), sources: [...hbConfig().sources, { id: 'cal', kind: 'calendar-v9' }] },
    }
    const v = heartbeatView({ meta } as never)
    expect(v).toMatchObject({ kind: 'config', skipped: 1, exact: false, hash: null })
  })
  it('an unreadable heartbeat is a problem, not a throw; a job without one is null', () => {
    expect(heartbeatView({ meta: { [HEARTBEAT_META_KEY]: 5 } } as never)).toMatchObject({ kind: 'problem' })
    expect(heartbeatView({ meta: undefined } as never)).toBeNull()
    expect(heartbeatView({ meta: { other: 1 } } as never)).toBeNull()
  })
})

describe('metaWithMutes', () => {
  it('replaces only the mutes and keeps every other key, inside and beside the heartbeat', () => {
    const j = hbJob({ meta: { keep: { me: 1 }, [HEARTBEAT_META_KEY]: hbConfig() } as never })
    const r = metaWithMutes(j, [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.meta.keep).toEqual({ me: 1 })
    expect((r.meta[HEARTBEAT_META_KEY] as { mutes: unknown[] }).mutes).toEqual([])
    expect((r.meta[HEARTBEAT_META_KEY] as { sources: unknown[] }).sources).toHaveLength(3)
  })
  it('refuses a heartbeat it cannot write back whole (a newer source would be lost)', () => {
    const meta = {
      [HEARTBEAT_META_KEY]: { ...hbConfig(), sources: [...hbConfig().sources, { id: 'cal', kind: 'calendar-v9' }] },
    }
    expect(metaWithMutes({ meta } as never, []).ok).toBe(false)
  })
  it('refuses a mute for a source that is not there', () => {
    expect(metaWithMutes(hbJob(), [newMute('nope', 'k', 1, 0)]).ok).toBe(false)
  })
  it('a blank key mutes the whole source; a key mutes exactly that key', () => {
    expect(newMute('github', '  ', 7, 0)).toEqual({ source: 'github', until: '1970-01-08T00:00:00.000Z' })
    expect(newMute('github', ' k ', 1, 0)).toMatchObject({ key: 'k' })
  })
})

describe('setup', () => {
  const ok = () => ({ ...blankSetup(), threadId: 'heartbeat' })

  it('fills the fire times from the first to the last at the step', () => {
    expect(slotTimes('09:45', '18:45', 150)).toEqual(['09:45', '12:15', '14:45', '17:15'])
    expect(slotTimes('09:45', '09:00', 150)).toEqual([])
    expect(slotTimes('nine', '18:00', 60)).toEqual([])
  })

  it('builds a valid config and a draft that is a valid create change, in shadow, with its own thread', () => {
    const b = configFromSetup(ok())
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.config.mode).toBe('shadow')
    const draft = draftFromSetup(ok(), b.config, b.times, 'heartbeat')
    expect(draft.thread_id).toBe('heartbeat')
    expect(draft.runner).toBe('session')
    expect(ScheduleChange.safeParse({ op: 'create', draft }).success).toBe(true)
  })

  it('needs a thread of its own', () => {
    const b = configFromSetup({ ...ok(), threadId: null })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.errors.thread).toMatch(/thread/i)
  })

  it('says what is wrong under each field', () => {
    const b = configFromSetup({
      ...ok(),
      first: 'x',
      wakes: '9',
      github: true,
      repos: '',
      failures: false,
      inbox: false,
    })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(Object.keys(b.errors).sort()).toEqual(['first', 'repos', 'sources', 'wakes'].sort())
    const none = configFromSetup({ ...ok(), failures: false, inbox: false })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.errors.sources).toBeTruthy()
  })

  it('a last check before the first is refused', () => {
    const b = configFromSetup({ ...ok(), first: '18:00', last: '09:00' })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.errors.last).toBeTruthy()
  })

  it('a bad repo name is refused, not written', () => {
    const b = configFromSetup({ ...ok(), github: true, repos: 'not a repo/..' })
    expect(b.ok).toBe(false)
  })
})
