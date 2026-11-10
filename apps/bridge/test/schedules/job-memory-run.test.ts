// The service's three touch points for job memory (docs/SCHEDULES.md "Job memory"): what a run is offered, what a finished run may
// keep, and what a card changes. A run is bound to the memory it was offered by an epoch that moves whenever the memory is wiped
// or switched on, so a run that finishes late can never write into a memory that is not the one it was given.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import {
  HEARTBEAT_META_KEY,
  ScheduleChange,
  type ScheduleChangeT,
  type ScheduleT,
  toChronosChange,
} from '@talos-app/protocol'
import snapshotFixture from '@talos-app/protocol/fixtures/frames/schedules.snapshot.json'
import { JobMemory } from '../../src/schedules/job-memory.ts'
import { applyTalosFields, memoryForRun, memoryProblem, rememberRun } from '../../src/schedules/job-memory-run.ts'
import { Sidecar } from '../../src/schedules/sidecar.ts'
import { tempHome } from '../helpers.ts'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const P = 'Summarise yesterday and post it.\n'
const ETAG = `sha256:${'a'.repeat(64)}`

function rig() {
  const home = tempHome('talos-job-memory-run-')
  homes.push(home)
  const sidecar = new Sidecar(home, () => true)
  const mem = new JobMemory(
    home,
    () => true,
    (id) => sidecar.bumpEpoch(id),
  )
  let n = 0
  /** The offer of a run: what the service records when it sends the notification. */
  const offer = (job: string, prompt = P) => {
    const runId = `r_${++n}`
    const m = memoryForRun(mem, sidecar, job, prompt)
    sidecar.recordOffer({
      id: job,
      ds: `2026-11-${String(n).padStart(2, '0')}`, // one offer per (job, day): another day keeps the earlier offer
      run_id: runId,
      fire_at: null,
      window_ends: null,
      trigger: 'run_now',
      again: false,
      instance: 'bi_test',
      at: 0,
      ...(m ? { memory_binding: m.binding, memory_epoch: m.epoch } : {}),
    })
    return { runId, block: m?.block ?? null }
  }
  const done = (job: string, runId: string, notepad?: string, summary = 'Posted.') =>
    rememberRun(mem, sidecar, { jobId: job, runId, ds: '2026-11-01', ok: true, summary, notepad })
  const apply = (job: string, change: ScheduleChangeT) =>
    applyTalosFields(mem, sidecar, job, change, toChronosChange(change))
  const notepadOf = (job: string, prompt = P) => {
    const m = memoryForRun(mem, sidecar, job, prompt)
    return m?.block ?? null
  }
  return { home, sidecar, mem, offer, done, apply, notepadOf }
}

const draftOf = (over: Record<string, unknown> = {}) => ({
  id: 'a-job',
  name: 'A Job',
  description: '',
  when: { type: 'daily', time: '07:30' },
  catchup_min: 180,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: null,
  prompt: P,
  ...over,
})
const create = (over: Record<string, unknown> = {}) => ScheduleChange.parse({ op: 'create', draft: draftOf(over) })
const update = (set: Record<string, unknown>) =>
  ScheduleChange.parse({ op: 'update', id: 'a-job', base_etag: ETAG, set })
const del = () => ScheduleChange.parse({ op: 'delete', id: 'a-job', base_etag: ETAG })
const adopt = () => ScheduleChange.parse({ op: 'adopt', id: 'a-job', content_hash: ETAG })

describe('the epoch', () => {
  test('a job with memory off has none, and a run of it is offered no memory', () => {
    const { sidecar, offer } = rig()
    expect(sidecar.memoryEpoch('a-job')).toBeUndefined()
    expect(offer('a-job').block).toBeNull()
  })

  test('switching memory on gives it one, switching it off removes it, and on again gives a different one', () => {
    const { sidecar } = rig()
    sidecar.setMemory('a-job', true)
    const first = sidecar.memoryEpoch('a-job')
    expect(first).toMatch(/\S/)
    sidecar.setMemory('a-job', false)
    expect(sidecar.memoryEpoch('a-job')).toBeUndefined()
    sidecar.setMemory('a-job', true)
    expect(sidecar.memoryEpoch('a-job')).not.toBe(first)
  })

  test('every wipe moves it', () => {
    const { sidecar, mem } = rig()
    sidecar.setMemory('a-job', true)
    const first = sidecar.memoryEpoch('a-job')
    mem.wipe('a-job')
    expect(sidecar.memoryEpoch('a-job')).not.toBe(first)
    expect(sidecar.memoryOf('a-job')).toBe(true) // a wipe does not switch memory off
  })

  test('the epoch is kept in the sidecar file, so a restart does not hand a late run a matching one', () => {
    const { home, sidecar } = rig()
    sidecar.setMemory('a-job', true)
    const again = new Sidecar(home, () => true)
    expect(again.memoryEpoch('a-job')).toBe(sidecar.memoryEpoch('a-job'))
    expect(again.memoryOf('a-job')).toBe(true)
  })
})

describe('a finished run keeps its result and its notepad', () => {
  test('with memory on: saved, and the next run is shown it', () => {
    const { sidecar, offer, done } = rig()
    sidecar.setMemory('a-job', true)
    const r = offer('a-job')
    expect(done('a-job', r.runId, 'my notes')).toMatch(/Notepad saved/)
    expect(offer('a-job').block).toContain('my notes')
  })

  test('with memory off: nothing is kept and the answer says so', () => {
    const { offer, done, mem } = rig()
    const r = offer('a-job')
    expect(done('a-job', r.runId, 'my notes')).toMatch(/memory is off/)
    expect(mem.read('a-job', 'x')).toBeNull()
  })
})

describe('a run that finishes late writes nothing into a memory that is not the one it was given', () => {
  test('text edited away and back (two wipes), a newer run saved: the older run cannot overwrite the newer memory', () => {
    const { sidecar, offer, done, apply, notepadOf } = rig()
    sidecar.setMemory('a-job', true)
    const old = offer('a-job')
    apply('a-job', update({ prompt: 'Something else.\n' }))
    apply('a-job', update({ prompt: P })) // the same text again: the hash alone would match
    const newer = offer('a-job')
    expect(done('a-job', newer.runId, 'newer notes')).toMatch(/Notepad saved/)
    expect(done('a-job', old.runId, 'older notes')).toMatch(/nothing was kept/)
    const block = notepadOf('a-job') ?? ''
    expect(block).toContain('newer notes')
    expect(block).not.toContain('older notes')
  })

  test('memory switched off and on again while a run is in flight: the run leaves the new memory empty', () => {
    const { sidecar, offer, done, apply, notepadOf } = rig()
    sidecar.setMemory('a-job', true)
    const inflight = offer('a-job')
    apply('a-job', update({ memory: false }))
    apply('a-job', update({ memory: true }))
    expect(done('a-job', inflight.runId, 'stale notes', 'Stale result.')).toMatch(/nothing was kept/)
    const block = notepadOf('a-job') ?? ''
    expect(block).toContain('No earlier results yet')
    expect(block).not.toContain('stale notes')
    expect(block).not.toContain('Stale result.')
  })

  test("job deleted and made again with the same text: the old run's finish writes nothing", () => {
    const { sidecar, offer, done, apply, notepadOf } = rig()
    sidecar.setMemory('a-job', true)
    const inflight = offer('a-job')
    apply('a-job', del())
    apply('a-job', create({ memory: true })) // same id, same text
    expect(done('a-job', inflight.runId, 'old job notes', 'Old job result.')).toMatch(/nothing was kept/)
    const block = notepadOf('a-job') ?? ''
    expect(block).not.toContain('old job notes')
    expect(block).not.toContain('Old job result.')
  })

  test('a late run does not even bring the file back after a wipe', () => {
    const { sidecar, mem, offer, done, apply } = rig()
    sidecar.setMemory('a-job', true)
    const inflight = offer('a-job')
    apply('a-job', update({ prompt: 'Something else.\n' }))
    done('a-job', inflight.runId, 'notes')
    expect(existsSync(mem.path('a-job'))).toBe(false)
  })
})

describe('what a card changes', () => {
  const withNotes = () => {
    const x = rig()
    x.sidecar.setMemory('a-job', true)
    x.done('a-job', x.offer('a-job').runId, 'my notes')
    return x
  }
  const kept = (x: ReturnType<typeof rig>) => (x.notepadOf('a-job') ?? '').includes('my notes')

  test('changing the text wipes; so does adopting a file edited on disk and switching memory either way', () => {
    for (const c of [update({ prompt: 'New.\n' }), adopt(), update({ memory: false }), update({ memory: true })]) {
      const x = withNotes()
      expect(kept(x)).toBe(true)
      x.apply('a-job', c)
      expect(existsSync(x.mem.path('a-job'))).toBe(false)
    }
  })

  test('changing the name, the time or the notify setting keeps it', () => {
    const x = withNotes()
    x.apply('a-job', update({ name: 'New name', notify: 'always', when: { type: 'daily', time: '08:00' } }))
    expect(kept(x)).toBe(true)
  })

  test("moving the result thread wipes it: a notepad written for one thread's session never reaches another's", () => {
    const x = withNotes()
    x.apply('a-job', update({ thread_id: 'inbox' }))
    expect(kept(x)).toBe(false)
    expect(x.sidecar.threadOf('a-job')).toBe('inbox')
    expect(x.sidecar.memoryOf('a-job')).toBe(true) // memory stays on
  })

  test('saying the thread it already has is not a move', () => {
    const x = withNotes()
    x.apply('a-job', update({ thread_id: 'inbox' }))
    x.done('a-job', x.offer('a-job').runId, 'my notes')
    expect(kept(x)).toBe(true)
    x.apply('a-job', update({ thread_id: 'inbox' }))
    expect(kept(x)).toBe(true)
  })

  test('moving it back to the default thread is a move too', () => {
    const x = withNotes()
    x.apply('a-job', update({ thread_id: 'inbox' }))
    x.done('a-job', x.offer('a-job').runId, 'my notes')
    x.apply('a-job', update({ thread_id: null }))
    expect(kept(x)).toBe(false)
  })

  test('deleting forgets the job and removes the file', () => {
    const x = withNotes()
    x.apply('a-job', del())
    expect(existsSync(x.mem.path('a-job'))).toBe(false)
    expect(x.sidecar.memoryOf('a-job')).toBe(false)
    expect(x.sidecar.jobThreads()['a-job']).toBeUndefined()
  })

  test('a new job takes its memory switch from its draft alone: a leftover entry for the same id does not carry memory in', () => {
    const x = rig()
    x.sidecar.setMemory('a-job', true) // left behind: the job was removed outside the app, the sidecar never heard
    x.apply('a-job', create({ thread_id: 'inbox' }))
    expect(x.sidecar.memoryOf('a-job')).toBe(false)
    expect(x.sidecar.memoryEpoch('a-job')).toBeUndefined()
    expect(x.sidecar.threadOf('a-job')).toBe('inbox')
    expect(x.offer('a-job').block).toBeNull()
  })

  test('a new job with memory in its draft has it on, with a fresh epoch, and starts empty', () => {
    const x = rig()
    x.sidecar.setMemory('a-job', true)
    const old = x.sidecar.memoryEpoch('a-job')
    x.apply('a-job', create({ memory: true }))
    expect(x.sidecar.memoryOf('a-job')).toBe(true)
    expect(x.sidecar.memoryEpoch('a-job')).not.toBe(old)
    expect(x.offer('a-job').block).toContain('No earlier results yet')
  })

  test('a failed save of the memory switch is reported on its own, apart from the thread', () => {
    const home = tempHome('talos-job-memory-run-')
    homes.push(home)
    const sidecar = new Sidecar(home, () => false) // the bridge is not live
    const mem = new JobMemory(home, () => false)
    const c = update({ memory: true })
    const r = applyTalosFields(mem, sidecar, 'a-job', c, toChronosChange(c))
    expect(r.memory).toMatch(/not live/)
    expect(r.thread).toBe('')
    const t = update({ thread_id: 'inbox' })
    const r2 = applyTalosFields(mem, sidecar, 'a-job', t, toChronosChange(t))
    expect(r2.thread).toMatch(/not live/)
    expect(r2.memory).toBe('')
  })
})

describe('memory for every kind of job but a heartbeat', () => {
  const plain = (snapshotFixture as { snapshot: { schedules: ScheduleT[] } }).snapshot.schedules[0] as ScheduleT
  const base = (over: Partial<ScheduleT> = {}) => ({
    schedule: { ...plain, ...over } as ScheduleT,
    prompt: P,
    guard: null,
  })
  const hb = { [HEARTBEAT_META_KEY]: { schema: 'talos.heartbeat/1', mode: 'shadow', sources: [], mutes: [] } }

  test('a plain session job is fine, with memory on or off', () => {
    expect(memoryProblem(create({ memory: true }), null)).toBeNull()
    expect(memoryProblem(update({ memory: true }), base())).toBeNull()
    expect(memoryProblem(update({ memory: false }), base())).toBeNull()
    expect(memoryProblem(update({ name: 'x' }), base())).toBeNull()
  })

  test('a heartbeat job is refused, new or existing, in words that say why and what to do', () => {
    const p = memoryProblem(create({ memory: true, meta: hb }), null)
    expect(p).toMatch(/heartbeat/i)
    expect(p).toMatch(/Nothing was saved/)
    expect(memoryProblem(update({ memory: true }), base({ meta: hb }))).toMatch(/heartbeat/i)
    expect(memoryProblem(create({ meta: hb }), null)).toBeNull() // without memory it is just a heartbeat
  })

  test('a job that already has memory on cannot be turned into a heartbeat', () => {
    expect(memoryProblem(update({ meta: hb }), base({ memory: true }))).toMatch(/heartbeat/i)
    expect(memoryProblem(update({ meta: hb, memory: false }), base({ memory: true }))).toBeNull()
  })

  test('a command job may have memory now (it runs in the background and gets files)', () => {
    expect(memoryProblem(update({ memory: true }), base({ kind: 'command' }))).toBeNull()
    expect(memoryProblem(update({ memory: false }), base({ kind: 'command' }))).toBeNull()
  })
})
