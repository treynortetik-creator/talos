// The files the hub and the desktop supervisor share under $TALOS_APP_HOME (docs/OPTION-C.md "Files"). The supervisor
// writes workers.json and each worker's nonce; the hub writes wake, control and ready. All 0600 in 0700 folders.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  readWorkersFile,
  WAKE_CAPPED_ACTIONS,
  WAKE_STATE_TAKEN_MAX,
  WakeFile,
  type WakeFileT,
  WakeState,
  WakeTaken,
  type WakeTakenT,
  WORKER_FILES,
  WorkerReady,
  type WorkerReadyT,
  type WorkersReadT,
} from '@talos-app/protocol'
import { ensureDir, readJsonFile, writeFileAtomic } from '../fsutil.ts'

export const workersJsonPath = (home: string) => join(home, 'workers.json')
export const workerDir = (home: string, threadId: string) => join(home, 'workers', threadId)
/** The live bridge's hub socket, in its own folder (config.ts `hubSock`); `hubSockLegacyPath` is where it was before. */
export const hubSockPath = (home: string) => join(home, 'run', 'hub.sock')
export const hubSockLegacyPath = (home: string) => join(home, 'hub.sock')

/**
 * workers.json, re-read only when its mtime or size changed. A torn or invalid file reads as null; an entry the hub cannot
 * read costs that thread only (`unavailable`, protocol audit O3). The hub never writes the file, so nothing is lost by it.
 */
export class WorkersReader {
  private key = ''
  private cached: WorkersReadT | null = null
  constructor(private readonly home: string) {}

  read(): WorkersReadT | null {
    const path = workersJsonPath(this.home)
    let k: string
    try {
      const s = statSync(path)
      k = `${s.mtimeMs}:${s.size}`
    } catch {
      this.key = ''
      this.cached = null
      return null
    }
    if (k === this.key) return this.cached
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    this.key = k
    this.cached = readWorkersFile(text)
    return this.cached
  }
}

/** Logs a bookkeeping failure that must not stop a wake (the caller's logger). */
export type WakeWarn = (msg: string, fields: Record<string, unknown>) => void

/** The bridge's record per thread, `workers/<thread>/wake-written.json`: the capped wakes it wrote, newest WAKE_STATE_TAKEN_MAX. */
function readWritten(dir: string): WakeTakenT[] {
  const kept = readJsonFile<{ v?: unknown; capped?: unknown }>(join(dir, WORKER_FILES.wakeWritten))
  if (kept?.v !== 1 || !Array.isArray(kept.capped)) return []
  return kept.capped
    .map((e) => WakeTaken.safeParse(e))
    .flatMap((r) => (r.success ? [r.data] : []))
    .slice(-WAKE_STATE_TAKEN_MAX)
}

const cappedEntry = (w: WakeFileT): WakeTakenT | undefined =>
  (WAKE_CAPPED_ACTIONS as readonly string[]).includes(w.action) && Number.isFinite(Date.parse(w.at))
    ? { at: Date.parse(w.at), action: w.action as WakeTakenT['action'] }
    : undefined

/** Writes `wake` into `file` (atomic replace, 0600); the record of a capped one follows, and its failure only goes to `warn`. */
function writeWakeShape(file: string, home: string, wake: WakeFileT, warn: WakeWarn): void {
  const dir = workerDir(home, wake.thread_id)
  ensureDir(join(home, 'workers'))
  ensureDir(dir)
  const { counter: _ignored, ...parsed } = WakeFile.parse(wake)
  writeFileAtomic(join(dir, file), `${JSON.stringify(parsed)}\n`, 0o600)
  const entry = cappedEntry(parsed)
  if (!entry) return
  try {
    const capped = [...readWritten(dir), entry].slice(-WAKE_STATE_TAKEN_MAX)
    writeFileAtomic(join(dir, WORKER_FILES.wakeWritten), `${JSON.stringify({ v: 1, capped })}\n`, 0o600)
  } catch (e) {
    warn('wake record not written', { thread: wake.thread_id, error: (e as Error).message })
  }
}

/**
 * Writes (replaces) a thread's message wake file: a `pointer`, never a control (those go through writeControl, so a message can
 * never replace an owner's tap, BSUP-5). The supervisor takes it by renaming, so a rewrite never loses a wake. A `counter` the
 * caller passes is dropped: nothing uses it any more.
 */
export function writeWake(home: string, wake: WakeFileT, warn: WakeWarn = () => {}): void {
  if (wake.action !== 'pointer') throw new Error('writeWake carries pointers only; a control goes through writeControl')
  writeWakeShape(WORKER_FILES.wake, home, wake, warn)
}

/** Does the supervisor say, in workers.json (`supervisor.reads_control`), that its reader takes `control`? Missing, torn or unreadable: no. */
export function supervisorReadsControl(home: string): boolean {
  try {
    return readWorkersFile(readFileSync(workersJsonPath(home), 'utf8'))?.supervisor.reads_control === true
  } catch {
    return false
  }
}

/**
 * Writes (replaces) a thread's control: the owner's tap (park, resume, restart, fresh; the governor's park too), the same JSON as a
 * wake, the same atomic replace and 0600. Only the control itself can fail the call; the record of a capped one (restart, fresh)
 * is written after it, and a failure there goes to `warn`.
 *
 * WHERE IT GOES is decided here, at write time, from workers.json: when the supervisor says it reads `control`
 * (`supervisor.reads_control`), the control goes to `workers/<id>/control`, a file a message pointer never touches (BSUP-5; the
 * newest control replaces an older one, the last tap wins). When the flag is absent, false, or workers.json is missing or
 * unreadable (an older supervisor, or a newer bridge running against a supervisor that was not restarted: a kit or hook release
 * restarts the bridge only), the control goes to `wake` exactly as before, so a tap is never left in a file nobody reads. So this
 * is safe to land before the Mac's reader: the old Swift supervisor never sets the flag, and the Mac keeps today's behaviour until
 * its reader ships and sets it.
 */
export function writeControl(home: string, wake: WakeFileT, warn: WakeWarn = () => {}): void {
  if (wake.action === 'pointer') throw new Error('writeControl carries controls only; a pointer goes through writeWake')
  writeWakeShape(supervisorReadsControl(home) ? WORKER_FILES.control : WORKER_FILES.wake, home, wake, warn)
}

/**
 * The capped wakes the reader will count for a thread, as the bridge best knows before it writes another (the `at` of each, in
 * ms). With the reader's own state file (WORKER_FILES.wakeState): what it took, plus the wake still waiting in the file if that
 * one is capped, so a double tap is refused up front. Without one (an older reader, or none yet): the bridge's record of the
 * capped wakes it wrote, which also counts any the reader then refused. The same wake is counted once (its `at` and action).
 */
export function wakeCapTimes(home: string, threadId: string): number[] {
  const dir = workerDir(home, threadId)
  const state = WakeState.safeParse(readJsonFile(join(dir, WORKER_FILES.wakeState)))
  // a capped wake still waiting: in `control` (where controls go now), or in `wake` (one an older bridge left there)
  const waiting = [readControl(home, threadId), readWake(home, threadId)].flatMap((p) => {
    const e = p ? cappedEntry(p) : undefined
    return e ? [e] : []
  })
  const entries = state.success ? [...state.data.taken, ...waiting] : readWritten(dir)
  const seen = new Map(entries.map((e) => [`${e.at}:${e.action}`, e.at]))
  return [...seen.values()]
}

export function readControl(home: string, threadId: string): WakeFileT | undefined {
  const r = WakeFile.safeParse(readJsonFile(join(workerDir(home, threadId), WORKER_FILES.control)))
  return r.success ? r.data : undefined
}

export function readWake(home: string, threadId: string): WakeFileT | undefined {
  const raw = readJsonFile(join(workerDir(home, threadId), WORKER_FILES.wake))
  const r = WakeFile.safeParse(raw)
  return r.success ? r.data : undefined
}

export function readNonce(home: string, threadId: string): string | undefined {
  try {
    const v = readFileSync(join(workerDir(home, threadId), WORKER_FILES.nonce), 'utf8').trim()
    return v.length >= 16 && v.length <= 64 ? v : undefined
  } catch {
    return undefined
  }
}

export function writeReady(home: string, ready: WorkerReadyT): void {
  const dir = workerDir(home, ready.thread_id)
  ensureDir(join(home, 'workers'))
  ensureDir(dir)
  writeFileAtomic(join(dir, WORKER_FILES.ready), `${JSON.stringify(WorkerReady.parse(ready))}\n`, 0o600)
}
