// The guard against real-vs-fake drift (SCHEDULES S9, WP-S0 acceptance): every golden the real Chronos CLI printed
// parses with the protocol schema for its verb. A new golden that nobody mapped fails here too.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHRONOS_API,
  ChronosError,
  type ChronosVerb,
  parseChronosSnapshot,
  ScheduleSnapshot,
  scheduleFromChronos,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', 'testkit', 'fixtures', 'chronos-0.3')
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
const load = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'))

/** Golden file name -> the verb that printed it. */
function verbOf(file: string): ChronosVerb | null {
  const name = file.replace(/\.json$/, '')
  if (name === 'version') return 'version'
  if (name.startsWith('snapshot-')) return 'snapshot'
  if (name === 'detail') return 'detail'
  if (name.startsWith('validate-')) return 'validate'
  if (name.startsWith('apply-')) return 'apply'
  if (name.startsWith('approved')) return 'approved'
  if (name.startsWith('config-set')) return 'config_set'
  if (name === 'disable') return 'disable'
  if (name.startsWith('pause-')) return 'pause'
  if (name.startsWith('due-session')) return 'due_session'
  if (name === 'session-beat') return 'session_beat'
  if (name === 'migrate') return 'migrate'
  if (name.startsWith('error-')) return 'any'
  if (name.startsWith('claim-')) return 'claim'
  if (name.startsWith('finish-')) return 'finish'
  if (name === 'orphans') return 'orphans'
  if (name.startsWith('start-')) return 'start'
  if (name.startsWith('session-prompt')) return 'session_prompt'
  if (name.startsWith('probe')) return 'probe'
  if (name === 'health') return 'health'
  return null
}

describe('Chronos 0.3 goldens (vendored from the real CLI)', () => {
  it('are present (40 files at v0.3.0)', () => {
    expect(files.length).toBeGreaterThanOrEqual(40)
  })

  for (const f of files) {
    it(`${f} maps to a verb and parses with its protocol schema`, () => {
      const verb = verbOf(f)
      expect(verb, `no verb mapping for ${f}; add one here and a schema in schedules-chronos.ts`).not.toBeNull()
      const res = CHRONOS_API[verb as ChronosVerb].safeParse(load(f))
      expect(res.success, res.success ? '' : JSON.stringify(res.error.issues, null, 2)).toBe(true)
    })
  }

  it('error goldens are the error shape, and success goldens are not', () => {
    for (const f of files) {
      const isError = ChronosError.safeParse(load(f)).success
      expect(isError, f).toBe(/^(validate-error|apply-conflict|config-set-refused|error-|session-prompt-held)/.test(f))
    }
  })

  it("an update refused on a held job (rc1 review fix, chronos_write.py) is the error shape with code 'held'", () => {
    // Not a golden yet: the shape chronos_write.WriteError prints, as of v0.3.0-rc1.
    const held = {
      error: {
        code: 'held',
        message: 'this job is held: its files changed outside Chronos. Review them and send an adopt change',
        fields: [{ path: 'id', message: 'held' }],
      },
    }
    expect(CHRONOS_API.apply.safeParse(held).success).toBe(true)
    expect(ChronosError.parse(held).error.code).toBe('held')
  })

  it('every snapshot golden maps to a Talos ScheduleSnapshot schedule list without loss', () => {
    for (const f of files.filter((x) => x.startsWith('snapshot-'))) {
      const parsed = parseChronosSnapshot(load(f))
      if (!parsed.ok) throw new Error(parsed.message)
      expect(parsed.unreadable).toEqual([])
      const snap = { ...parsed.head, schedules: parsed.jobs }
      const schedules = snap.schedules.map((j) => scheduleFromChronos(j, { thread_id: null, offerAgeS: null }))
      const talos = ScheduleSnapshot.safeParse({
        protocol: 1,
        health: {
          state: 'ok',
          adapter: { id: 'chronos', version: snap.chronos, api: snap.api },
          tz: snap.tz,
          host_label: 'Example Mac',
          session_runner: snap.session_runner,
          paused_all: snap.paused_all,
          headless: 'unknown',
          tick_age_s: snap.tick_age_s,
          issues: [],
          checked_at: snap.as_of,
        },
        schedules,
        unreadable: [],
        as_of: snap.as_of,
      })
      expect(talos.success, talos.success ? '' : JSON.stringify(talos.error.issues, null, 2)).toBe(true)
      for (const [i, j] of snap.schedules.entries()) {
        const s = schedules[i]
        expect(s?.etag).toBe(j.etag)
        expect(s?.content_hash).toBe(j.content_hash)
        expect(s?.when_text).toBe(j.when_text)
      }
    }
  })

  it('wait_reason comes from the adapter (N6): no_session past 180 s, offered under 2 min, else agent_busy', () => {
    const p = parseChronosSnapshot(load('snapshot-held.json'))
    if (!p.ok) throw new Error(p.message)
    const snap = { schedules: p.jobs }
    const waiting = snap.schedules.find((j) => j.today === 'waiting')
    expect(waiting).toBeDefined()
    if (!waiting) return
    const at = (beat: number | null, offer: number | null) =>
      scheduleFromChronos(waiting, { thread_id: null, offerAgeS: offer, sessionBeatAgeS: beat }).wait_reason
    expect(at(null, null)).toBe('no_session')
    expect(at(181, 10)).toBe('no_session')
    expect(at(0, 10)).toBe('offered')
    expect(at(0, 120)).toBe('agent_busy')
    expect(at(0, null)).toBe('agent_busy')
    const notWaiting = snap.schedules.find((j) => j.today !== 'waiting')
    if (notWaiting) expect(scheduleFromChronos(notWaiting, { thread_id: null, offerAgeS: 1 }).wait_reason).toBeNull()
  })
})
