// The Linux wake reader (supervisor/wake-reader.ts): the shared decision vectors (packages/protocol/fixtures/wake-decision) run
// through the real reader, its state on disk and its clock, and the file handling a vector cannot show (one take, a link, a FIFO,
// a big file, another thread's wake, unreadable or unwritable state).
import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WAKE_STATE_TAKEN_MAX, type WakeFileT, WORKER_FILES, wakeLimitText } from '@talos-app/protocol'
import {
  takeWakeFile,
  WAKE_NOTICE_BACKOFF_MS,
  WAKE_NOTICE_TRIES,
  WAKE_REFUSAL_LINE_GAP_MS,
  WakeReader,
  type WakeSession,
} from '../../src/supervisor/wake-reader.ts'
import type { PostOutcome } from '../../src/supervisor/worker-notices.ts'
import { workerDir } from '../../src/worker/files.ts'

const VECTORS = join(import.meta.dir, '../../../../packages/protocol/fixtures/wake-decision')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', d])
    rmSync(d, { recursive: true, force: true })
  }
})

function rig(now = Date.parse('2026-11-13T12:00:00.000Z')) {
  const home = mkdtempSync(join(tmpdir(), 'talos-wake-'))
  dirs.push(home)
  const audit: Array<[string, Record<string, string> | undefined]> = []
  const posts: Array<[string, string]> = []
  const clock = { now }
  const relay = { outcome: 'sent' as PostOutcome }
  const reader = new WakeReader({
    home,
    audit: (e, f) => audit.push([e, f]),
    wallMs: () => clock.now,
    post: (t, x) => {
      posts.push([t, x])
      return Promise.resolve(relay.outcome)
    },
  })
  /** One take: `act` stands for onWake; `effect` false: it carried nothing out (a start held, a park of a resting session). */
  const take = async (id: string, s: WakeSession, effect = true): Promise<WakeFileT | null> => {
    let acted: WakeFileT | null = null
    let cur = s
    await reader.take(
      id,
      () => cur,
      async (w) => {
        acted = w
        if (effect) cur = { entry: { state: 'stopping' }, turnWait: { why: w.action } }
      },
    )
    await new Promise((r) => setTimeout(r, 0)) // the post's outcome is noted
    return acted
  }
  const dir = (id: string) => {
    const d = workerDir(home, id)
    mkdirSync(d, { recursive: true })
    return d
  }
  const wake = (id: string, w: Record<string, unknown>) =>
    writeFileSync(
      join(dir(id), WORKER_FILES.wake),
      JSON.stringify({ v: 1, thread_id: id, message_ids: ['m_01ARZ3NDEKTSV4RRFFQ69G5FAV'], ...w }),
    )
  const state = (id: string) => JSON.parse(readFileSync(join(dir(id), WORKER_FILES.wakeState), 'utf8'))
  const idle = { entry: { state: 'live' } }
  const busy = { entry: { state: 'busy' } }
  return { home, audit, posts, clock, relay, reader, take, dir, wake, state, idle, busy }
}

const at = (ms: number) => new Date(ms).toISOString()

describe('the shared vectors through the Linux reader', () => {
  const files = readdirSync(VECTORS).filter((f) => f.endsWith('.json'))
  it('there are vectors to run', () => expect(files.length).toBeGreaterThanOrEqual(30))
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(VECTORS, f), 'utf8'))
    const i = v.input
    // a transcript path is not known to the Linux reader yet (it says "kept on this computer"; a follow-up)
    if (i.transcriptPath !== undefined) continue
    it(f, async () => {
      const x = rig(i.now)
      const id = i.wake.thread_id as string
      const taken = (i.recentTaken as number[]).slice(-WAKE_STATE_TAKEN_MAX).map((t) => ({ at: t, action: 'restart' }))
      if (taken.length) writeFileSync(join(x.dir(id), WORKER_FILES.wakeState), JSON.stringify({ v: 1, taken }))
      writeFileSync(join(x.dir(id), WORKER_FILES.wake), JSON.stringify(i.wake))
      const got = await x.take(id, i.threadIdle ? x.idle : x.busy)
      const o = v.output
      expect(got !== null).toBe(o.take)
      const events = x.audit.filter(([e]) => e !== 'wake_notice')
      if (!o.take) expect(events).toEqual([[o.audit, expect.objectContaining({ why: o.why, thread: id })]])
      else expect(events).toEqual([])
      expect(x.posts.map(([, t]) => t)).toEqual(o.notice ? [o.notice] : [])
      const statePath = join(x.dir(id), WORKER_FILES.wakeState)
      if (o.take && o.counted) {
        const s = x.state(id)
        expect(s.taken.at(-1)).toEqual({ at: Date.parse(i.wake.at), action: i.wake.action })
        expect(s.taken.length).toBe(Math.min(taken.length + 1, WAKE_STATE_TAKEN_MAX))
        expect(statSync(statePath).mode & 0o777).toBe(0o600)
      } else if (!taken.length) expect(existsSync(statePath)).toBe(false)
      else expect(x.state(id)).toEqual({ v: 1, taken }) // refused or uncounted: the state as it was (Fable R1-5)
      expect(existsSync(join(x.dir(id), WORKER_FILES.wake))).toBe(false)
    })
  }
})

describe('wake reader (supervisor/wake-reader.ts)', () => {
  it('a restart is taken once, said once, counted by its own time; a second inside the gap is refused with the limit line', async () => {
    const x = rig()
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    expect((await x.take('trip', x.idle))?.action).toBe('restart')
    expect(await x.take('trip', x.idle)).toBeNull() // taken: nothing left
    expect(x.posts).toEqual([['trip', "Talos restarted this thread's session (a session control)."]])
    expect(x.state('trip')).toEqual({ v: 1, taken: [{ at: x.clock.now, action: 'restart' }] })
    x.clock.now += 1000
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    expect(await x.take('trip', x.idle)).toBeNull()
    expect(x.audit.filter(([e]) => e !== 'wake_notice').at(-1)?.[0]).toBe('wake_refused')
    expect(x.posts.at(-1)).toEqual(['trip', wakeLimitText('restart')])
  })
  it('the state keeps the newest 16 entries: one more restart past a full list of old ones drops the oldest', async () => {
    const x = rig()
    const old = Array.from({ length: WAKE_STATE_TAKEN_MAX }, (_, k) => ({
      at: x.clock.now - 7_200_000 + k,
      action: 'restart',
    }))
    writeFileSync(join(x.dir('trip'), WORKER_FILES.wakeState), JSON.stringify({ v: 1, taken: old }))
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'fresh' })
    expect((await x.take('trip', x.idle))?.action).toBe('fresh')
    expect(x.state('trip').taken).toEqual([...old.slice(1), { at: x.clock.now, action: 'fresh' }])
  })
  it('a restart of a session in a turn says it will restart after the turn', async () => {
    const x = rig()
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    expect((await x.take('trip', x.busy))?.action).toBe('restart')
    expect(x.posts).toEqual([
      ['trip', "Talos will restart this thread's session after its current turn (a session control)."],
    ])
  })
  it('a fresh start is refused while the session is in a turn, or a park waits for its turn to end', async () => {
    for (const w of [{ entry: { state: 'busy' } }, { entry: { state: 'live' }, turnWait: { since: 1 } }]) {
      const x = rig()
      x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'fresh' })
      expect(await x.take('trip', w)).toBeNull()
      expect(x.audit.find(([e]) => e === 'wake_refused')?.[1]?.why).toBe('busy')
    }
    const x = rig()
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'fresh' })
    expect((await x.take('trip', undefined))?.action).toBe('fresh') // no session: idle
    expect(x.posts[0]?.[1]).toContain('its transcript is kept on this computer')
  })
  it('parks and resumes are never capped and write no state; a pointer is taken with no line', async () => {
    const x = rig()
    for (let k = 0; k < 20; k++)
      for (const action of ['park', 'resume'] as const) {
        x.wake('trip', { at: at(x.clock.now), reason: 'governor', action })
        expect((await x.take('trip', x.busy))?.action).toBe(action)
      }
    x.wake('trip', { at: at(x.clock.now), reason: 'message', action: 'pointer' })
    expect((await x.take('trip', x.busy))?.action).toBe('pointer')
    expect(existsSync(join(x.dir('trip'), WORKER_FILES.wakeState))).toBe(false)
    expect(x.posts.every(([, t]) => !t.includes('did not'))).toBe(true)
  })
  it('state that does not parse reads as none, audited: a restart is taken and the state written again', async () => {
    for (const text of ['{', '{"v":2,"taken":[]}', '{"v":1,"last_counter":3,"taken":[1]}', 'x'.repeat(5000)]) {
      const x = rig()
      writeFileSync(join(x.dir('trip'), WORKER_FILES.wakeState), text)
      x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
      expect((await x.take('trip', x.idle))?.action, text.slice(0, 20)).toBe('restart')
      expect(x.audit.map(([e]) => e).filter((e) => e !== 'wake_notice')).toEqual(['wake_state_unreadable'])
      expect(x.state('trip').taken).toHaveLength(1)
    }
  })
  it('a count that cannot be written refuses only a restart or fresh start; a park is taken', async () => {
    const x = rig()
    mkdirSync(join(x.dir('trip'), WORKER_FILES.wakeState)) // a folder where the state goes: unreadable, and unwritable
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    expect(await x.take('trip', x.idle)).toBeNull()
    expect(x.audit.map(([e]) => e)).toEqual(['wake_state_unreadable', 'wake_state_not_written'])
    x.audit.length = 0
    x.wake('trip', { at: at(x.clock.now), reason: 'governor', action: 'park' })
    expect((await x.take('trip', x.idle))?.action).toBe('park')
    expect(x.posts.map(([, t]) => t)).toEqual(["Talos parked this thread's session (plan limits are close)."])
  })
})

describe('the notice of record says what was carried out (Fable R1-1..R1-3 on the reader)', () => {
  it('nothing carried out (a start held, a park of a resting session): no line, audited wake_no_effect; still counted', async () => {
    const x = rig()
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    expect((await x.take('trip', { entry: { state: 'parked' } }, false))?.action).toBe('restart')
    expect(x.posts).toEqual([])
    expect(x.audit).toEqual([['wake_no_effect', { thread: 'trip', action: 'restart', state: 'parked' }]])
    expect(x.state('trip').taken).toHaveLength(1)
    x.wake('trip', { at: at(x.clock.now), reason: 'governor', action: 'park' })
    await x.take('trip', undefined, false)
    expect(x.posts).toEqual([])
    expect(x.audit.at(-1)).toEqual(['wake_no_effect', { thread: 'trip', action: 'park', state: 'off' }])
  })
  it('a start that failed is not "restarted": its own line says why', async () => {
    const x = rig()
    let cur: WakeSession = { entry: { state: 'parked' } }
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'resume' })
    await x.reader.take(
      'trip',
      () => cur,
      async () => {
        cur = { entry: { state: 'failed' } }
      },
    )
    expect(x.posts).toEqual([])
    expect(x.audit.at(-1)?.[0]).toBe('wake_no_effect')
  })
  it('a line the relay refused is tried again after a growing wait, at most WAKE_NOTICE_TRIES times; unknown is never resent (R2-2)', async () => {
    const x = rig()
    x.relay.outcome = 'failed'
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'park' })
    await x.take('trip', x.idle)
    await x.take('trip', x.idle) // at once: not yet
    expect(x.posts).toHaveLength(1)
    for (const wait of WAKE_NOTICE_BACKOFF_MS) {
      x.clock.now += wait
      await x.take('other', x.idle) // whichever thread is taken: the owed line is said (one that left the list too)
    }
    x.clock.now += 3_600_000
    await x.take('trip', x.idle)
    expect(x.posts.map(([t]) => t)).toEqual(Array(WAKE_NOTICE_TRIES).fill('trip'))
    expect(x.audit.filter(([e]) => e === 'wake_notice').map(([, f]) => f?.tries)).toEqual(['1', '2', '3', '4', '5'])
    const y = rig()
    y.relay.outcome = 'unknown'
    y.wake('trip', { at: at(y.clock.now), reason: 'control', action: 'park' })
    await y.take('trip', y.idle)
    y.clock.now += 3_600_000
    await y.take('trip', y.idle)
    expect(y.posts).toHaveLength(1)
    expect(y.audit.at(-1)).toEqual(['wake_notice', { thread: 'trip', action: 'park', outcome: 'unknown', tries: '1' }])
  })
  it('refusal lines: at most one per thread a minute, the rest audited only', async () => {
    const x = rig()
    for (let k = 0; k < 5; k++) {
      x.wake('trip', { at: at(x.clock.now - 600_000), reason: 'control', action: 'resume' }) // stale each time
      await x.take('trip', x.idle)
      x.clock.now += 1000
    }
    expect(x.posts).toHaveLength(1)
    expect(x.audit.filter(([, f]) => f?.outcome === 'not_said_again')).toHaveLength(4)
    x.clock.now += WAKE_REFUSAL_LINE_GAP_MS
    x.wake('trip', { at: at(x.clock.now - 600_000), reason: 'control', action: 'resume' })
    await x.take('trip', x.idle)
    expect(x.posts).toHaveLength(2)
  })
  it('a start held for a slot whose hold is dropped without a start says nothing was changed (R2-1)', async () => {
    const x = rig()
    let cur: WakeSession = { entry: { state: 'parked' } }
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'restart' })
    await x.reader.take(
      'trip',
      () => cur,
      async () => {
        cur = { entry: { state: 'parked' }, held: { since: 1 } }
      },
    )
    await x.reader.take(
      'trip',
      () => cur,
      async () => {},
    ) // still held: nothing more
    cur = { entry: { state: 'parked' } } // the hold ran out (worker_cap_dropped)
    await x.reader.take(
      'trip',
      () => cur,
      async () => {},
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(x.posts.map(([, t]) => t)).toEqual([
      "Talos will restart this thread's session once a session slot is free (a session control).",
      "Talos did not restart this thread's session: it was dropped before it could start. Nothing was changed.",
    ])
  })
  it('a held start that then failed says nothing more here: its failure has its own line (R3-2)', async () => {
    const x = rig()
    let cur: WakeSession = { entry: { state: 'parked' } }
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'fresh' })
    await x.reader.take(
      'trip',
      () => cur,
      async () => {
        cur = { entry: { state: 'parked' }, held: { fresh: true, forPointer: false } }
      },
    )
    cur = { entry: { state: 'failed' } }
    await x.reader.take(
      'trip',
      () => cur,
      async () => {},
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(x.posts.map(([, t]) => t)).toEqual([
      'Talos will start a fresh conversation for this thread once a session slot is free (a session control).',
    ])
    expect(x.audit.at(-1)?.[0]).toBe('wake_no_effect')
  })
  it('a tap’s park that shortens a governor park’s wait is carried out, and said (R2-3)', async () => {
    const x = rig()
    let cur: WakeSession = { entry: { state: 'stopping' }, turnWait: { why: 'governor', deadline: 900 } }
    x.wake('trip', { at: at(x.clock.now), reason: 'control', action: 'park' })
    await x.reader.take(
      'trip',
      () => cur,
      async () => {
        cur = { entry: { state: 'stopping' }, turnWait: { why: 'governor', deadline: 60 } }
      },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(x.posts).toEqual([['trip', "Talos parked this thread's session (a session control)."]])
  })
  it('a wake that is dropped is audited with why, never acted on', async () => {
    const x = rig()
    writeFileSync(join(x.dir('trip'), WORKER_FILES.wake), '{')
    expect(await x.take('trip', x.idle)).toBeNull()
    expect(x.audit).toEqual([['wake_dropped', { thread: 'trip', why: 'not_json' }]])
  })
})

describe('takeWakeFile: the file itself', () => {
  it('a link (to a valid wake), a FIFO, a folder, a big file, another thread’s wake: dropped, removed, the target untouched', async () => {
    const x = rig()
    const good = JSON.stringify({ v: 1, thread_id: 'trip', at: at(x.clock.now), action: 'restart', reason: 'control' })
    const target = join(x.home, 'elsewhere.json')
    writeFileSync(target, good)
    const p = join(x.dir('trip'), WORKER_FILES.wake)
    symlinkSync(target, p)
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'unreadable' })
    expect(readFileSync(target, 'utf8')).toBe(good)
    expect(spawnSync('mkfifo', [p]).status).toBe(0)
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'unreadable' }) // no reader blocks on it
    mkdirSync(p)
    writeFileSync(join(p, 'x'), good)
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'unreadable' })
    writeFileSync(p, good.replace('}', `,"pad":"${'x'.repeat(5000)}"}`))
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'unreadable' })
    writeFileSync(p, '{')
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'not_json' })
    writeFileSync(p, good.replace('"restart"', '"explode"').replace('"control"', '"a newer reason"'))
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'bad_shape', fields: 'reason,action' })
    x.wake('other', { at: at(x.clock.now) })
    writeFileSync(p, readFileSync(join(x.dir('other'), WORKER_FILES.wake)))
    expect(takeWakeFile(x.home, 'trip')).toEqual({ dropped: 'other_thread' })
    expect(readdirSync(x.dir('trip'))).toEqual([])
  })
  it('a wake written while one is read is a new file, kept for the next take', async () => {
    const x = rig()
    x.wake('trip', { at: at(x.clock.now) })
    expect(takeWakeFile(x.home, 'trip')).toMatchObject({ wake: { action: 'pointer' } })
    x.wake('trip', { at: at(x.clock.now), action: 'park', reason: 'control' })
    expect(takeWakeFile(x.home, 'trip')).toMatchObject({ wake: { action: 'park' } })
  })
  it('a folder it cannot rename in: nothing taken, nothing thrown', async () => {
    const x = rig()
    x.wake('trip', { at: at(x.clock.now) })
    chmodSync(x.dir('trip'), 0o500)
    expect(takeWakeFile(x.home, 'trip')).toBeNull()
  })
})
