// The supervisor's side of the files it shares with the hub (docs/OPTION-C.md "Files"; the Mac's WorkerManager, WorkerWakes and
// WorkerPublished): workers.json, which the supervisor publishes; each worker's nonce, written before every start; the ready
// file the hub writes after a verified hello; and the wake file the hub drops to ask for something. All 0600 in 0700 folders.
// Pure apart from the files under the given Talos home; the manager that uses them is workers.ts.
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  NONCE_BYTES,
  ThreadId,
  WakeFile,
  type WakeFileT,
  WORKER_CRASH_LOOP,
  WORKER_FILES,
  WORKER_LIVE_STATES,
  WORKER_TRANSITIONS,
  WorkerReady,
  type WorkerReadyT,
  type WorkerStateT,
  WorkersFile,
  type WorkersFileT,
} from '@talos-app/protocol'
import { ensureDir, writeFileAtomic } from '../fsutil.ts'
import { workerDir, workersJsonPath } from '../worker/files.ts'

/** workers.json as this supervisor publishes it. Thread sessions are on unless the owner turned them off; sub-threads stay off until proven here. */
export function buildWorkersFile(o: {
  pid: number
  nowMs: number
  mainPanePid: number
  /** Tests only; none: the owner's switch (setWorkersOn). */
  workersSupported?: boolean
  threads: Record<string, Record<string, unknown> & { state: WorkerStateT }>
  /** This supervisor's own fields per thread (the owed pointer): kept in its copy of the file, read by nobody else. */
  own?: Record<
    string,
    {
      pointer_owed_until?: string
      enter_owed?: true
      pointer_unseen?: true
      turn_wait_until?: string
      turn_wait_end?: 'parked' | 'off'
      turn_wait_why?: string
      turn_wait_after?: 'restart' | 'fresh'
    }
  >
}): WorkersFileT {
  const threads: Record<string, unknown> = {}
  // only a session that holds a slot has a pane the hub may match a hello against
  for (const [id, e] of Object.entries(o.threads))
    threads[id] =
      WORKER_LIVE_STATES.includes(e.state) || e.state === 'parking' || e.state === 'stopping'
        ? e
        : { ...e, pane_pid: 0 }
  // parsed, not cast: an entry the hub would refuse makes the hub drop the whole file, so it is a bug here, loudly
  const file = WorkersFile.parse({
    v: 1,
    supervisor: {
      pid: o.pid,
      heartbeat_at: new Date(o.nowMs).toISOString(),
      workers_supported: (o.workersSupported ?? workersOn()) === true,
      // sub-threads start here by the Mac's rules (worker-subthreads.ts, P3d5); as on the Mac, said whatever the switch
      subthreads_supported: true,
      // and, as on the Mac (c24c01f8), a dedicated sub-thread may keep its own existing folder outside its parent's
      subthreads_own_folder: true,
      // and one with no folder, or its parent's own, runs in the parent's folder (the agent folder when it has none)
      subthreads_shared_folder: true,
      // and one with a folder of its own under a parent with none: judged against the agent folder, where that parent runs
      subthreads_folderless_parent: true,
      // this supervisor's reader takes `control` before `wake` (wake-reader.ts): the bridge may write the owner's taps there (BSUP-5)
      reads_control: true,
      main_pane_pid: o.mainPanePid,
    },
    threads,
  })
  // the shared schema strips what only this supervisor reads; put back after the check (the hub's own parse drops them again)
  for (const [id, extra] of Object.entries(o.own ?? {}))
    if (file.threads[id]) Object.assign(file.threads[id] as object, extra)
  return file
}

/**
 * Does this supervisor host thread sessions now? The owner's switch (supervisor.json `workers`, read by the supervisor and handed
 * here once at start as a reader): on unless they turned it off. Proven end to end in the sandbox (scripts/sandbox-workers.test.ts).
 */
let workersOn: () => boolean = () => true
export function setWorkersOn(read: () => boolean): void {
  workersOn = read
}

export function writeWorkersFile(home: string, file: WorkersFileT): void {
  ensureDir(home)
  writeFileAtomic(workersJsonPath(home), `${JSON.stringify(file, null, 2)}\n`, 0o600)
}

const isThread = (id: string) => ThreadId.safeParse(id).success

/** NONCE_BYTES random bytes as lowercase hex: a new one before every start. */
export const newNonce = (): string => randomBytes(NONCE_BYTES).toString('hex')

/** The nonce the hub checks the worker's hello against (the same value goes into the worker's env). */
export function writeNonce(home: string, threadId: string, nonce: string): void {
  if (!isThread(threadId)) throw new Error(`not a thread id: ${threadId}`)
  const dir = workerDir(home, threadId)
  ensureDir(dir)
  writeFileAtomic(join(dir, WORKER_FILES.nonce), nonce, 0o600)
}

/** The hub's ready file for this thread, or null (none yet, torn, or another thread's). */
export function readReady(home: string, threadId: string): WorkerReadyT | null {
  if (!isThread(threadId)) return null
  try {
    const r = WorkerReady.safeParse(
      JSON.parse(readFileSync(join(workerDir(home, threadId), WORKER_FILES.ready), 'utf8')),
    )
    return r.success && r.data.thread_id === threadId ? r.data : null
  } catch {
    return null
  }
}

/** Removes the ready file: before a start (a stale one must not pass for this start's), and when a session ends. */
export function clearReady(home: string, threadId: string): void {
  if (isThread(threadId)) rmSync(join(workerDir(home, threadId), WORKER_FILES.ready), { force: true })
}

/** When a session ends: its nonce and ready go (the launch file deletes itself). The wake and control stay: the hub may be writing one. */
export function releaseWorkerFiles(home: string, threadId: string): void {
  if (!isThread(threadId)) return
  for (const f of [WORKER_FILES.nonce, WORKER_FILES.ready]) rmSync(join(workerDir(home, threadId), f), { force: true })
}

/**
 * Takes this thread's pending request, once: the `control` file first, else the `wake` file (the reader takes both in a tick,
 * wake-reader.ts; this one-at-a-time form is what the tests use). Renamed aside first (one the hub writes meanwhile is a new
 * file, kept for the next take), then read and deleted. One that does not parse or names another thread is dropped, never acted on.
 */
export function takeWake(home: string, threadId: string): WakeFileT | null {
  if (!isThread(threadId)) return null
  const dir = workerDir(home, threadId)
  for (const file of [WORKER_FILES.control, WORKER_FILES.wake]) {
    const taken = join(dir, `${file}.taken`)
    try {
      renameSync(join(dir, file), taken)
    } catch {
      continue // none in this file
    }
    let got: WakeFileT | null = null
    try {
      const r = WakeFile.safeParse(JSON.parse(readFileSync(taken, 'utf8')))
      got =
        r.success && r.data.thread_id === threadId && !(file === WORKER_FILES.control && r.data.action === 'pointer')
          ? r.data
          : null
    } catch {
      got = null
    } finally {
      rmSync(taken, { force: true })
    }
    if (got) return got // a dropped control goes on to the wake, as the real reader does
  }
  return null
}

/** A move the shared state machine allows; anything else is a bug in the manager. */
export const legalMove = (from: WorkerStateT, to: WorkerStateT): boolean => WORKER_TRANSITIONS[from].includes(to)

/** WORKER_CRASH_LOOP.count restarts inside its window: the worker fails `crash_loop` instead of starting again. */
export function crashLooping(restarts: readonly string[], nowMs: number): boolean {
  const since = nowMs - WORKER_CRASH_LOOP.window_s * 1000
  const recent = restarts.map((r) => Date.parse(r)).filter((t) => Number.isFinite(t) && t > since && t <= nowMs)
  return recent.length >= WORKER_CRASH_LOOP.count
}

/** This supervisor's own fields for one thread in its copy of workers.json (the hub's parse strips them). */
export type OwnFields = {
  pointer_owed_until?: string
  enter_owed?: true
  pointer_unseen?: true
  turn_wait_until?: string
  turn_wait_end?: 'parked' | 'off'
  turn_wait_why?: string
  turn_wait_after?: 'restart' | 'fresh'
}

/**
 * How a session the last supervisor was ending must end: off for the owner's stop (a stop with no wait for a turn, or one
 * written as ending off), else parked. Read for an entry adopted as stopping or parking.
 */
export function adoptedEnd(
  state: string,
  raw: { turn_wait_end?: unknown; turn_wait_until?: unknown },
): 'parked' | 'off' {
  if (raw.turn_wait_end === 'off') return 'off'
  if (state === 'stopping' && raw.turn_wait_end !== 'parked') return 'off'
  return 'parked'
}

/** The restart a park was waiting to run, as the last supervisor wrote it (null: none). */
export function restartAfter(raw: { turn_wait_after?: unknown }): { fresh: boolean } | null {
  return raw.turn_wait_after === 'restart' || raw.turn_wait_after === 'fresh'
    ? { fresh: raw.turn_wait_after === 'fresh' }
    : null
}

/**
 * What one thread's own fields are now: the owed pointer, and a wait for the turn with its deadline as a wall time (so a
 * supervisor started meanwhile waits no longer than this one would). A thread still being adopted keeps what the last
 * supervisor wrote for it, never dropped by a write in between. Null when there is nothing to keep.
 */
export function ownFields(o: {
  owed: { pointer_owed_until?: string; enter_owed?: true; pointer_unseen?: true }
  state: WorkerStateT
  turnWait: { why: string; deadline: number | null } | null
  endAs: 'parked' | 'off' | null
  afterPark: { fresh: boolean } | null
  nowS: number
  wallMs: number
  adopting: boolean
  before: Record<string, unknown>
}): OwnFields | null {
  const mine: OwnFields = o.owed.pointer_owed_until ? { ...o.owed } : {}
  if (o.state === 'stopping' && o.turnWait?.deadline != null) {
    mine.turn_wait_until = new Date(o.wallMs + Math.max(0, o.turnWait.deadline - o.nowS) * 1000).toISOString()
    mine.turn_wait_end = o.endAs === 'parked' ? 'parked' : 'off'
    mine.turn_wait_why = o.turnWait.why
    // a restart the owner's stop has overtaken (it ends off) is not kept: the next supervisor must not start it
    if (o.afterPark && o.endAs !== 'off') mine.turn_wait_after = o.afterPark.fresh ? 'fresh' : 'restart'
  } else if (o.state === 'parking' && o.endAs === 'off') {
    // the owner's stop came while it was parking: it ends off, and a supervisor started meanwhile must end it off too (parked,
    // the next message would start it again, against the stop)
    mine.turn_wait_end = 'off'
  } else if (o.state === 'parking' && o.afterPark) {
    // a restart waiting on the park itself (no turn to wait for): kept too, so a supervisor started meanwhile still runs it
    mine.turn_wait_after = o.afterPark.fresh ? 'fresh' : 'restart'
  } else if (o.adopting) {
    for (const k of ['turn_wait_until', 'turn_wait_end', 'turn_wait_why', 'turn_wait_after'] as const)
      if (typeof o.before[k] === 'string') (mine as Record<string, string>)[k] = o.before[k] as string
  }
  return Object.keys(mine).length > 0 ? mine : null
}
