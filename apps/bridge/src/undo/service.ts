// Takes the undo point for a turn before its message is delivered (the router and the backlog call `before`, then
// deliver). Delivery waits until the point is recorded, but never longer than UNDO_HOLD_MS: then it goes ahead, the
// snapshot is stopped, and a point that still came is thrown away (it may already hold the turn's own edits), so the row
// says not_saved. Nothing here ever throws into delivery.
//
// Points for one thread are taken, recorded and pruned one at a time (KeyedChain): a copy's folder is named by thread
// and turn only, so a prune running beside a record could remove a fresh copy (points.ts).
import type { Clock } from '../clock.ts'
import { KeyedChain } from '../keyed-chain.ts'
import type { Logger } from '../log.ts'
import { runCommandAsync } from '../run-command.ts'
import { type PointLocation, releasePoint, type UNDO_RETENTION, type UndoPointRow, type UndoPoints } from './points.ts'
import { cleanEnv, inside, realpathOrAncestor, type Snapshot, type SnapshotOpts, snapshotFolder } from './snapshot.ts'

export const UNDO_HOLD_MS = 5000
const RELEASE_TIMEOUT_MS = 10_000

export type UndoDeps = {
  points: UndoPoints
  /** `paths(home).undo` */
  undoDir: string
  clock: Clock
  log: Logger
  env?: Record<string, string | undefined>
  snapshot?: (o: SnapshotOpts) => Promise<Snapshot>
  keep?: typeof UNDO_RETENTION
  /** Points were recorded for these messages (their row is written): marks.ts tells the app of a late one. */
  recorded?: (messageIds: readonly string[]) => void
}

/** One turn: the owner messages it answers (the last one names the point) and the folder it runs in. */
export type UndoTurn = {
  messages: ReadonlyArray<{ id: string; thread: string }>
  /** Undefined when the folder is not known: the rows say not_saved. */
  folder: string | undefined
  /**
   * The turn moved to another folder (main took it after the worker's point was taken): this point wins. 'elsewhere':
   * only when the point already recorded is of another folder (a route seen twice; main may have run it before).
   */
  replace?: boolean | 'elsewhere'
}

export class UndoService {
  private readonly chain = new KeyedChain()

  constructor(readonly deps: UndoDeps) {}

  /** Runs `fn` on these threads' chain: no point is taken, recorded or pruned for them until it ends. */
  exclusive<T>(threads: readonly string[], fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void this.chain.run(threads, () => fn().then(resolve, reject))
    })
  }

  /**
   * Resolves once the point is recorded, or after the hold; retention runs after that, off the delivery path. Never
   * rejects. With no folder there is nothing to wait for: it resolves at once and the rows say not_saved.
   */
  before(t: UndoTurn): Promise<void> {
    const last = t.messages.at(-1)
    if (!last) return Promise.resolve()
    const ac = new AbortController()
    let late = false
    let recorded = () => {}
    const held = new Promise<void>((res) => {
      recorded = res
    })
    const threads = [...new Set(t.messages.map((m) => m.thread))]
    const work = this.chain.run(threads, () =>
      this.take(t, last, { signal: ac.signal, isLate: () => late, recorded }).catch((e) =>
        this.deps.log.warn('undo point not recorded', { error: (e as Error).message }),
      ),
    )
    void work.then(() => recorded())
    if (!t.folder) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = this.deps.clock.setTimeout(() => {
        late = true
        ac.abort()
        resolve()
      }, UNDO_HOLD_MS)
      void held.then(() => {
        this.deps.clock.clearTimeout(timer)
        resolve()
      })
    })
  }

  private async take(
    t: UndoTurn,
    last: { id: string; thread: string },
    o: { signal: AbortSignal; isLate: () => boolean; recorded: () => void },
  ): Promise<void> {
    const { points, clock } = this.deps
    const at = clock.now()
    const had = t.messages.map((m) => points.get(m.id))
    // a point is taken once per message: one that has a row was handed over before (a replay after a crash, a route
    // seen twice), and its turn may have run since. Only a move to another folder takes a new one.
    if (t.replace === 'elsewhere' && t.folder) {
      const here = await realpathOrAncestor(t.folder)
      // both sides resolved: a not_saved row can carry the folder as it was given, links and all
      const roots = await Promise.all(had.map((r) => (r && r.root !== '' ? realpathOrAncestor(r.root) : undefined)))
      if (roots.every((root) => root !== undefined && inside(here, root))) return
    } else if (!t.replace && had.some((r) => r)) {
      // the others in the same turn: a point taken now could hold edits of a turn that already ran
      t.messages.forEach((m, i) => {
        if (!had[i])
          points.record({
            message_id: m.id,
            thread_id: m.thread,
            turn: last.id,
            snapshot: { state: 'not_saved', kind: 'copy', root: t.folder ?? '', why: 'handed over before' },
            at,
          })
      })
      this.deps.recorded?.(t.messages.filter((_, i) => !had[i]).map((m) => m.id))
      return
    }
    const env = cleanEnv(this.deps.env ?? process.env)
    const store = await realpathOrAncestor(this.deps.undoDir)
    const release = (p: PointLocation) =>
      releasePoint(p, { run: runCommandAsync, env, store, timeoutMs: RELEASE_TIMEOUT_MS }).catch(() => false)
    let s: Snapshot
    if (!t.folder) s = { state: 'not_saved', kind: 'copy', root: '', why: 'the folder is not known' }
    else {
      try {
        s = await (this.deps.snapshot ?? snapshotFolder)({
          folder: t.folder,
          thread: last.thread,
          turn: last.id,
          undoDir: this.deps.undoDir,
          env,
          signal: o.signal,
        })
      } catch (e) {
        s = { state: 'not_saved', kind: 'copy', root: t.folder, why: (e as Error).message }
      }
    }
    if (o.isLate()) {
      // delivery went ahead without it: the turn may already have changed the folder
      if (s.state === 'ready') await release(location(s, last.id))
      s = { state: 'not_saved', kind: s.kind, root: s.root, why: 'not saved in time' }
    }
    const before = t.replace ? had : []
    // the point's time is when the snapshot ended: a file born after it is the turn's (restore.ts reads birth times)
    const takenAt = clock.now()
    for (const m of t.messages)
      points.record(
        { message_id: m.id, thread_id: m.thread, turn: last.id, snapshot: s, at: takenAt },
        { replace: Boolean(t.replace) },
      )
    o.recorded() // delivery goes ahead now; what follows is clean-up
    this.deps.recorded?.(t.messages.map((m) => m.id))
    // a replaced point that this one did not overwrite (another folder, or this one failed) would be left behind
    const released = new Set<string>()
    for (const old of before) {
      if (old?.state !== 'ready' || overwrites(s, old)) continue
      const key = `${old.root}\0${old.ref}\0${old.path}`
      if (released.has(key)) continue
      released.add(key)
      await release(old)
    }
    for (const thread of new Set(t.messages.map((m) => m.thread)))
      await points
        .prune(thread, { undoDir: this.deps.undoDir, env, ...(this.deps.keep ? { keep: this.deps.keep } : {}) })
        .catch((e) => this.deps.log.warn('undo points not pruned', { error: (e as Error).message }))
  }
}

function location(s: Snapshot & { state: 'ready' }, turn: string): PointLocation {
  return s.kind === 'git'
    ? { kind: 'git', root: s.root, ref: s.ref, commit_id: s.commit, path: null, turn }
    : { kind: 'copy', root: s.root, ref: null, commit_id: null, path: s.path, turn }
}

/** The new point took the old one's place on disk (same ref in the same repo, or the same copy folder). */
function overwrites(s: Snapshot, old: UndoPointRow): boolean {
  if (s.state !== 'ready' || s.kind !== old.kind) return false
  return s.kind === 'git' ? s.root === old.root && s.ref === old.ref : s.path === old.path
}
