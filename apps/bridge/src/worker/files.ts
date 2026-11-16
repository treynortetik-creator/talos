// The files the hub and the desktop supervisor share under $TALOS_APP_HOME (docs/OPTION-C.md "Files"). The supervisor
// writes workers.json and each worker's nonce; the hub writes wake and ready. All 0600 in 0700 folders.
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

/**
 * Writes (replaces) a thread's wake file. The supervisor takes it by renaming, so a rewrite never loses a wake. Only the wake
 * itself can fail the call: the bridge's record of a capped wake is written after it, and a failure there goes to `warn`, so a
 * pointer wake or a park never waits on bookkeeping. A `counter` the caller passes is dropped: nothing uses it any more.
 */
export function writeWake(home: string, wake: WakeFileT, warn: WakeWarn = () => {}): void {
  const dir = workerDir(home, wake.thread_id)
  ensureDir(join(home, 'workers'))
  ensureDir(dir)
  const { counter: _ignored, ...parsed } = WakeFile.parse(wake)
  writeFileAtomic(join(dir, WORKER_FILES.wake), `${JSON.stringify(parsed)}\n`, 0o600)
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
 * The capped wakes the reader will count for a thread, as the bridge best knows before it writes another (the `at` of each, in
 * ms). With the reader's own state file (WORKER_FILES.wakeState): what it took, plus the wake still waiting in the file if that
 * one is capped, so a double tap is refused up front. Without one (an older reader, or none yet): the bridge's record of the
 * capped wakes it wrote, which also counts any the reader then refused. The same wake is counted once (its `at` and action).
 */
export function wakeCapTimes(home: string, threadId: string): number[] {
  const dir = workerDir(home, threadId)
  const state = WakeState.safeParse(readJsonFile(join(dir, WORKER_FILES.wakeState)))
  const pending = readWake(home, threadId)
  const waiting = pending ? cappedEntry(pending) : undefined
  const entries = state.success ? [...state.data.taken, ...(waiting ? [waiting] : [])] : readWritten(dir)
  const seen = new Map(entries.map((e) => [`${e.at}:${e.action}`, e.at]))
  return [...seen.values()]
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
