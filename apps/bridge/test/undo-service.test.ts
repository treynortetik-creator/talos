// UndoService (service.ts): the point is taken before the message is delivered. `before` resolves only once the point is
// recorded, or after the 5 s hold; a point that came too late is thrown away and the row says not_saved; a failure never
// blocks. Points for one thread are taken, recorded and pruned one at a time, so a prune never removes a fresh copy.
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { RestoringRoots } from '../src/undo/busy.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { UNDO_HOLD_MS, UndoService } from '../src/undo/service.ts'
import { type Snapshot, type SnapshotOpts, snapshotFolder } from '../src/undo/snapshot.ts'

const root = mkdtempSync(join(tmpdir(), 'talos-undo-service-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (name: string) => {
  const d = join(root, `${name}-${n++}`)
  mkdirSync(d, { recursive: true })
  return d
}
const home = fresh('home')
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home }
const gitEnv = {
  ...env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  return { code: r.status, out: r.stdout.trim() }
}
const repo = () => {
  const r = fresh('repo')
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  return r
}
const plain = () => {
  const d = fresh('plain')
  writeFileSync(join(d, 'a.txt'), 'a\n')
  return d
}
/** A snapshot the test lets finish: the real one runs, its result waits for `release`. */
function gated() {
  const gates: Array<() => void> = []
  const started: string[] = []
  const snapshot = async (o: SnapshotOpts): Promise<Snapshot> => {
    started.push(o.turn)
    const s = await snapshotFolder(o)
    await new Promise<void>((res) => gates.push(res))
    return s
  }
  return { snapshot, started, release: () => gates.shift()?.(), waiting: () => gates.length }
}
// generous on purpose: real git runs under a loaded machine (CI beside it); this waits for a condition, it times nothing
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 7500 && !until(); i++) await Bun.sleep(2)
  if (!until()) throw new Error('condition never held')
}
function service(o: { snapshot?: UndoService['deps']['snapshot']; keep?: { git: number; copy: number } } = {}) {
  const clock = fakeClock()
  const points = new UndoPoints(new Database(':memory:'))
  const undoDir = fresh('store')
  const recorded: string[][] = []
  const svc = new UndoService({
    points,
    undoDir,
    clock,
    log: nullLogger,
    env,
    ...(o.snapshot ? { snapshot: o.snapshot } : {}),
    ...(o.keep ? { keep: o.keep } : {}),
    recorded: (ids) => recorded.push([...ids]),
  })
  return { svc, points, clock, undoDir, recorded }
}

describe('UndoService.before', () => {
  setDefaultTimeout(30_000)
  test('the hold is 5 seconds', () => {
    expect(UNDO_HOLD_MS).toBe(5000)
  })

  test('resolves only once the point is recorded', async () => {
    const g = gated()
    const { svc, points } = service({ snapshot: g.snapshot })
    const r = repo()
    let done = false
    const p = svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r }).then(() => {
      done = true
    })
    await settle(() => g.waiting() === 1)
    expect(done).toBe(false)
    expect(points.get('m_1')).toBeUndefined()
    g.release()
    await p
    expect(points.get('m_1')).toMatchObject({ state: 'ready', kind: 'git', root: realpathSync(r) })
  })

  test('after the hold it resolves anyway; the late point is thrown away and the row says not_saved', async () => {
    const g = gated()
    const { svc, points, clock } = service({ snapshot: g.snapshot })
    const r = repo()
    const p = svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r })
    await settle(() => g.waiting() === 1)
    clock.advance(UNDO_HOLD_MS)
    await p // delivery goes ahead
    g.release()
    await settle(() => points.get('m_1') !== undefined)
    expect(points.get('m_1')?.state).toBe('not_saved')
    await settle(() => git(r, 'rev-parse', '-q', '--verify', 'refs/talos/undo/main/m_1').code !== 0)
  })

  test('a snapshot that throws never blocks: not_saved', async () => {
    const { svc, points } = service({
      snapshot: async () => {
        throw new Error('boom')
      },
    })
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: repo() })
    expect(points.get('m_1')?.state).toBe('not_saved')
  })

  test('no folder known: not_saved, and nothing runs', async () => {
    let ran = false
    const { svc, points } = service({
      snapshot: async (o) => {
        ran = true
        return snapshotFolder(o)
      },
    })
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: undefined })
    await settle(() => points.get('m_1') !== undefined)
    expect(points.get('m_1')?.state).toBe('not_saved')
    expect(ran).toBe(false)
  })

  test('several messages in one turn share one point', async () => {
    const { svc, points } = service()
    const r = repo()
    await svc.before({
      messages: [
        { id: 'm_1', thread: 'main' },
        { id: 'm_2', thread: 'trip' },
      ],
      folder: r,
    })
    expect(points.get('m_1')).toMatchObject({ state: 'ready', ref: 'refs/talos/undo/trip/m_2' })
    expect(points.get('m_2')).toMatchObject({ state: 'ready', ref: 'refs/talos/undo/trip/m_2' })
  })

  test('replace: the point taken for where the turn really ran wins over an earlier one', async () => {
    const { svc, points } = service()
    const worker = repo()
    const main = repo()
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: worker })
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: main, replace: true })
    expect(points.get('m_1')).toMatchObject({ state: 'ready', root: realpathSync(main) })
    // the worker folder's point is not left behind (released right after the record)
    await settle(() => git(worker, 'rev-parse', '-q', '--verify', 'refs/talos/undo/trip/m_1').code !== 0)
  })

  test('replace with a point that failed still marks the row not_saved (it is not the folder the turn ran in)', async () => {
    const calls: string[] = []
    const { svc, points } = service({
      snapshot: async (o) => {
        calls.push(o.folder)
        return calls.length === 1 ? snapshotFolder(o) : { state: 'not_saved', kind: 'git', root: o.folder, why: 'x' }
      },
    })
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: repo() })
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: repo(), replace: true })
    expect(points.get('m_1')?.state).toBe('not_saved')
  })

  test('record and prune for one thread never overlap: a queued point waits, and the fresh copy survives', async () => {
    const g = gated()
    const { svc, points } = service({ snapshot: g.snapshot, keep: { git: 50, copy: 1 } })
    const folder = plain()
    const p1 = svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder })
    await settle(() => g.waiting() === 1)
    const p2 = svc.before({ messages: [{ id: 'm_2', thread: 'main' }], folder })
    await Bun.sleep(20)
    expect(g.started).toEqual(['m_1']) // the second waits for the first's record and prune
    g.release()
    await p1
    await settle(() => g.waiting() === 1)
    g.release()
    await p2
    await settle(() => points.get('m_1') === undefined) // m_2's own prune, after its record
    const r2 = points.get('m_2')
    expect(r2?.state).toBe('ready')
    expect(existsSync(r2?.path ?? '')).toBe(true)
  })

  test('no folder known: resolves at once, even while the thread has a point in progress', async () => {
    const g = gated()
    const { svc, points } = service({ snapshot: g.snapshot })
    void svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: repo() })
    await settle(() => g.waiting() === 1)
    let done = false
    void svc.before({ messages: [{ id: 'm_2', thread: 'main' }], folder: undefined }).then(() => {
      done = true
    })
    await settle(() => done)
    g.release()
    await settle(() => points.get('m_2')?.state === 'not_saved')
  })

  test('delivery waits for the record, not for retention', async () => {
    let releasePrune = () => {}
    class SlowPrune extends UndoPoints {
      override prune() {
        return new Promise<number>((res) => {
          releasePrune = () => res(0)
        })
      }
    }
    const points = new SlowPrune(new Database(':memory:'))
    const svc = new UndoService({ points, undoDir: fresh('store'), clock: fakeClock(), log: nullLogger, env })
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: repo() }) // returns with the prune still running
    expect(points.get('m_1')?.state).toBe('ready')
    releasePrune()
  })

  test('a message that already has a point is not snapshotted again (a replay after its turn may have run)', async () => {
    let calls = 0
    const { svc, points } = service({
      snapshot: async (o) => {
        calls++
        return snapshotFolder(o)
      },
    })
    const r = repo()
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r })
    const first = points.get('m_1')?.commit_id
    writeFileSync(join(r, 'a.txt'), 'changed by the turn\n')
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r })
    expect(calls).toBe(1)
    expect(points.get('m_1')?.commit_id).toBe(first as string)
  })

  test('a turn where only some messages already have a point: the others say not_saved', async () => {
    let calls = 0
    const { svc, points } = service({
      snapshot: async (o) => {
        calls++
        return snapshotFolder(o)
      },
    })
    const r = repo()
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r })
    await svc.before({
      messages: [
        { id: 'm_1', thread: 'main' },
        { id: 'm_2', thread: 'main' },
      ],
      folder: r,
    })
    await settle(() => points.get('m_2') !== undefined)
    expect(calls).toBe(1)
    expect(points.get('m_1')?.state).toBe('ready')
    expect(points.get('m_2')?.state).toBe('not_saved')
  })

  test('elsewhere: a new point only when the earlier one was of another folder', async () => {
    const { svc, points } = service()
    const worker = repo()
    const main = repo()
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: main })
    const first = points.get('m_1')?.commit_id
    writeFileSync(join(main, 'a.txt'), 'changed by the turn\n')
    await svc.before({ messages: [{ id: 'm_1', thread: 'trip' }], folder: main, replace: 'elsewhere' })
    expect(points.get('m_1')?.commit_id).toBe(first as string) // same folder: kept
    await svc.before({ messages: [{ id: 'm_2', thread: 'trip' }], folder: worker })
    await svc.before({ messages: [{ id: 'm_2', thread: 'trip' }], folder: main, replace: 'elsewhere' })
    expect(points.get('m_2')).toMatchObject({ state: 'ready', root: realpathSync(main) })
  })

  test('elsewhere: an earlier point recorded under a linked path counts as the same folder', async () => {
    let calls = 0
    const { svc, points } = service({
      snapshot: async (o) => {
        calls++
        return snapshotFolder(o)
      },
    })
    const main = repo()
    const link = join(fresh('links'), 'main-link')
    symlinkSync(main, link)
    points.record({
      message_id: 'm_1',
      thread_id: 'main',
      turn: 'm_1',
      snapshot: { state: 'not_saved', kind: 'git', root: link, why: 'stopped' },
      at: 1,
    })
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: link, replace: 'elsewhere' })
    expect(calls).toBe(0)
  })

  test("a point's time is taken after its snapshot: a file born during the snapshot is not taken for new", async () => {
    const { svc, points, clock } = service({
      snapshot: async (o) => {
        const s = await snapshotFolder(o)
        clock.advance(1000) // the snapshot took a while
        return s
      },
    })
    const before = clock.now()
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: repo() })
    expect(points.get('m_1')?.created_at).toBe(before + 1000)
  })

  test('other threads do not wait for each other', async () => {
    const g = gated()
    const { svc } = service({ snapshot: g.snapshot })
    void svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: repo() })
    void svc.before({ messages: [{ id: 'm_2', thread: 'trip' }], folder: repo() })
    await settle(() => g.started.length === 2)
    g.release()
    g.release()
  })
})

describe('RestoringRoots', () => {
  test('two restores whose folders overlap never run at once', async () => {
    const roots = new RestoringRoots()
    const order: string[] = []
    let open = () => {}
    const gate = new Promise<void>((r) => {
      open = r
    })
    const outer = roots.hold('/w/repo', async () => {
      order.push('repo start')
      await gate
      order.push('repo end')
    })
    const inner = roots.hold('/w/repo/sub', async () => {
      order.push('sub')
    })
    await Bun.sleep(20)
    open()
    await Promise.all([outer, inner])
    expect(order).toEqual(['repo start', 'repo end', 'sub'])
  })
})

describe('UndoService tells the app of each point it records (marks.ts)', () => {
  setDefaultTimeout(30_000)
  test('a point taken, and the not_saved rows of a turn whose other message was handed over before', async () => {
    const { svc, recorded } = service()
    const r = repo()
    await svc.before({ messages: [{ id: 'm_1', thread: 'main' }], folder: r })
    await settle(() => recorded.length === 1)
    expect(recorded).toEqual([['m_1']])
    // m_1 has a row (handed over before): only m_2 gets one now, as not_saved, and the app is told of it
    await svc.before({
      messages: [
        { id: 'm_1', thread: 'main' },
        { id: 'm_2', thread: 'main' },
      ],
      folder: undefined,
    })
    await settle(() => recorded.length === 2)
    expect(recorded[1]).toEqual(['m_2'])
  })
})
